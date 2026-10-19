"""Один шаг синхронизации = один HTTP-запрос к маркетплейсу.

Между шагами состояние (курсор rrdId, счётчики, время следующего запроса) лежит в БД, поэтому
перезапуск воркера в любой момент безопасен: задание продолжится с последнего чекпоинта.
Лимит API соблюдается через seller_accounts.next_request_at: слот резервируется ДО запроса,
так что падение посреди запроса не приводит к немедленному повтору.
"""
import logging
from datetime import datetime, timedelta, timezone

from sqlalchemy import and_, or_, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.core.config import get_settings
from app.core.crypto import DecryptionError, decrypt
from app.db.session import set_rls_context
from app.integrations.base import SalesReportClient
from app.integrations.errors import AuthError, MarketplaceError, RateLimited, TemporaryError
from app.models import RawRecord, SellerAccount, SyncJob
from app.services.normalization import normalize_pending

log = logging.getLogger("winscoms.sync")

STALE_AFTER = timedelta(minutes=10)     # running без heartbeat дольше — считаем брошенным
MAX_TEMP_ATTEMPTS = 5
MAX_RATE_ATTEMPTS = 10
INSERT_CHUNK = 4000


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _fail(job: SyncJob, now: datetime, code: str, message: str) -> None:
    job.status = "partial" if job.records_saved > 0 else "failed"
    job.error_code, job.error_message, job.finished_at = code, message, now


async def _claim(maker: async_sessionmaker[AsyncSession], now: datetime):
    interval = timedelta(seconds=get_settings().wb_min_interval_seconds)
    async with maker() as db:
        await set_rls_context(db, platform_admin=True)   # воркер видит задания всех организаций
        q = (
            select(SyncJob)
            .join(SellerAccount, SellerAccount.id == SyncJob.seller_account_id)
            .where(
                SellerAccount.status == "active",
                or_(
                    and_(
                        SyncJob.status == "queued",
                        SyncJob.scheduled_at <= now,
                        or_(SellerAccount.next_request_at.is_(None), SellerAccount.next_request_at <= now),
                    ),
                    and_(SyncJob.status == "running", SyncJob.heartbeat_at < now - STALE_AFTER),
                ),
            )
            .order_by(SyncJob.scheduled_at)
            .limit(1)
            .with_for_update(skip_locked=True, of=SyncJob)
        )
        job = (await db.execute(q)).scalar_one_or_none()
        if job is None:
            return None
        account = await db.get(SellerAccount, job.seller_account_id)
        job.status, job.heartbeat_at = "running", now
        job.started_at = job.started_at or now
        account.next_request_at = now + interval
        claimed = {
            "job_id": job.id, "org_id": job.organization_id, "account_id": account.id,
            "ciphertext": account.encrypted_token, "date_from": job.period_from, "date_to": job.period_to,
            "cursor": job.cursor_rrd_id,
        }
        await db.commit()
        return claimed


async def _finish_error(maker, c: dict, now: datetime, exc: MarketplaceError | None, *, code=None, message=None) -> None:
    cfg = get_settings()
    interval = timedelta(seconds=cfg.wb_min_interval_seconds)
    async with maker() as db:
        await set_rls_context(db, org_id=c["org_id"], platform_admin=False)
        job = await db.get(SyncJob, c["job_id"])
        account = await db.get(SellerAccount, c["account_id"])
        if exc is None:
            _fail(job, now, code or "internal_error", message or "Внутренняя ошибка синхронизации")
        elif isinstance(exc, AuthError):
            account.status = "auth_error"
            _fail(job, now, exc.code, exc.message)
        elif isinstance(exc, (RateLimited, TemporaryError)):
            job.attempts += 1
            limit = MAX_RATE_ATTEMPTS if isinstance(exc, RateLimited) else MAX_TEMP_ATTEMPTS
            if job.attempts >= limit:
                _fail(job, now, exc.code, f"{exc.message} Исчерпано число повторов ({limit}).")
            else:
                base = max(exc.retry_after or 0.0, interval.total_seconds())
                delay = timedelta(seconds=min(base * (2 ** (job.attempts - 1)), 3600))
                job.status, job.scheduled_at, job.heartbeat_at = "queued", now + delay, now
                job.error_code, job.error_message = exc.code, exc.message
                account.next_request_at = max(account.next_request_at or now, now + delay)
        else:
            _fail(job, now, exc.code, exc.message)
        await db.commit()
    log.warning("sync step failed", extra={"ctx": {"job": str(c["job_id"]), "code": getattr(exc, "code", code)}})


async def _finish_ok(maker, client: SalesReportClient, c: dict, now: datetime, records: list[dict]) -> None:
    interval = timedelta(seconds=get_settings().wb_min_interval_seconds)
    async with maker() as db:
        await set_rls_context(db, org_id=c["org_id"], platform_admin=False)
        job = await db.get(SyncJob, c["job_id"])
        account = await db.get(SellerAccount, c["account_id"])
        if not records:                                   # 204: все страницы получены
            await normalize_pending(db, org_id=job.organization_id, account_id=job.seller_account_id)  # добор, если версия изменилась
            job.status, job.finished_at, job.attempts = "succeeded", now, 0
            job.error_code = job.error_message = None
            account.last_sync_at = now
            await db.commit()
            log.info("sync finished", extra={"ctx": {"job": str(job.id), "saved": job.records_saved}})
            return

        ids = [client.record_id(r) for r in records]      # ParseError обрабатывает вызывающий код
        new_cursor = ids[-1]
        if new_cursor <= job.cursor_rrd_id:
            _fail(job, now, "pagination_stuck", "Курсор rrdId не продвигается — остановлено, чтобы не зациклиться.")
            await db.commit()
            return
        saved = 0
        for i in range(0, len(records), INSERT_CHUNK):
            rows = [
                {
                    "organization_id": job.organization_id, "seller_account_id": job.seller_account_id,
                    "source_endpoint": client.source_endpoint, "source_id": ids[i + k],
                    "sync_job_id": job.id, "payload": rec,
                }
                for k, rec in enumerate(records[i : i + INSERT_CHUNK])
            ]
            res = await db.execute(
                pg_insert(RawRecord).values(rows).on_conflict_do_nothing(constraint="uq_raw_records_source").returning(RawRecord.id)
            )
            saved += len(res.fetchall())
        await normalize_pending(db, org_id=job.organization_id, account_id=job.seller_account_id)
        job.cursor_rrd_id = new_cursor
        job.pages_fetched += 1
        job.records_fetched += len(records)
        job.records_saved += saved
        job.attempts = 0
        job.error_code = job.error_message = None
        job.status, job.scheduled_at, job.heartbeat_at = "queued", now + interval, now
        await db.commit()
        log.info("sync page saved", extra={"ctx": {"job": str(job.id), "fetched": len(records), "saved": saved}})


async def process_next(maker: async_sessionmaker[AsyncSession], client: SalesReportClient, *, now: datetime | None = None) -> bool:
    """Выполняет не более одного запроса. Возвращает True, если задание было взято в работу."""
    now = now or _now()
    c = await _claim(maker, now)
    if c is None:
        return False
    try:
        token = decrypt(c["ciphertext"]) if c["ciphertext"] else None
        if token is None:
            await _finish_error(maker, c, now, None, code="no_token", message="У аккаунта нет токена. Подключите его заново.")
            return True
        page = await client.fetch_page(
            token, date_from=c["date_from"], date_to=c["date_to"], cursor=c["cursor"],
            limit=get_settings().wb_page_limit,
        )
        await _finish_ok(maker, client, c, now, page.records)
    except DecryptionError:
        await _finish_error(maker, c, now, None, code="token_decrypt", message="Не удалось расшифровать токен. Подключите аккаунт заново.")
    except MarketplaceError as e:
        await _finish_error(maker, c, now, e)
    except Exception:                                      # ошибка в коде: логируем без данных запроса
        log.exception("sync step crashed")
        await _finish_error(maker, c, now, None)
    return True
