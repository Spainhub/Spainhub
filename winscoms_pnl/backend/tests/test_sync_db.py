import json
import uuid
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pytest
from sqlalchemy import func, select, text

from app.core.crypto import encrypt
from app.db.session import set_rls_context
from app.integrations.base import Page
from app.integrations.errors import AuthError, ParseError, RateLimited, TemporaryError
from app.jobs.sync_runner import process_next
from app.models import Organization, RawRecord, SellerAccount, SyncJob
from tests.conftest import needs_db

pytestmark = needs_db

SAMPLE = json.loads((Path(__file__).parent / "fixtures" / "wb_sample.json").read_text(encoding="utf-8"))[0]
T0 = datetime.now(timezone.utc) + timedelta(minutes=1)   # «сейчас» для воркера; позже scheduled_at по умолчанию
STEP = timedelta(seconds=120)   # больше интервала лимита (65 с)


class FakeClient:
    source_endpoint = "fake:sales"

    def __init__(self, script):
        self.script, self.cursors = list(script), []

    async def fetch_page(self, token, *, date_from, date_to, cursor, limit):
        self.cursors.append(cursor)
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        return Page(records=item)

    def record_id(self, record):
        if not isinstance(record.get("rrdId"), int):
            raise ParseError("нет rrdId")
        return record["rrdId"]

    async def validate(self, token):
        return None


def recs(*ids):
    return [{**SAMPLE, "rrdId": i} for i in ids]


@pytest.fixture
async def acct(maker):
    """Новая организация + аккаунт продавца + активное задание. Возвращает (org_id, account_id, job_id)."""
    async with maker() as db:
        await set_rls_context(db, platform_admin=True)
        # воркер берёт задания всех организаций, поэтому гасим хвосты предыдущих тестов
        await db.execute(text("UPDATE sync_jobs SET status='cancelled' WHERE status IN ('queued','running')"))
        org = Organization(name=f"o-{uuid.uuid4().hex[:6]}")
        db.add(org)
        await db.flush()
        a = SellerAccount(organization_id=org.id, marketplace="wildberries", name="t", encrypted_token=encrypt("tok"), token_hint="tok")
        db.add(a)
        await db.flush()
        j = SyncJob(organization_id=org.id, seller_account_id=a.id, kind="initial",
                    period_from=date(2026, 7, 1), period_to=date(2026, 10, 19))
        db.add(j)
        await db.commit()
        return org.id, a.id, j.id


async def state(maker, job_id, account_id=None):
    async with maker() as db:
        await set_rls_context(db, platform_admin=True)
        job = await db.get(SyncJob, job_id)
        acc = await db.get(SellerAccount, account_id or job.seller_account_id)
        n = (await db.execute(select(func.count()).select_from(RawRecord).where(RawRecord.seller_account_id == acc.id))).scalar_one()
        return job, acc, n


async def run_all(maker, client, steps=20, start=None):
    now = start or T0
    for _ in range(steps):
        if not await process_next(maker, client, now=now):
            now += STEP
            if not await process_next(maker, client, now=now):
                break
        now += STEP


async def test_pagination_until_204_with_checkpoints(maker, acct):
    _, a, j = acct
    client = FakeClient([recs(1, 2, 3), recs(4, 5), []])     # короткая страница НЕ означает конец
    await run_all(maker, client)
    job, acc, n = await state(maker, j)
    assert client.cursors == [0, 3, 5]
    assert (job.status, job.pages_fetched, job.records_fetched, job.records_saved, job.cursor_rrd_id) == ("succeeded", 2, 5, 5, 5)
    assert n == 5 and acc.last_sync_at is not None and job.finished_at is not None


async def test_rate_limit_slot_is_respected(maker, acct):
    _, a, j = acct
    client = FakeClient([recs(1), recs(2), []])
    assert await process_next(maker, client, now=T0) is True
    assert await process_next(maker, client, now=T0 + timedelta(seconds=10)) is False   # слишком рано
    assert await process_next(maker, client, now=T0 + timedelta(seconds=64)) is False
    assert await process_next(maker, client, now=T0 + timedelta(seconds=66)) is True
    assert client.cursors == [0, 1]


async def test_duplicate_records_are_not_saved_twice(maker, acct):
    org, a, j = acct
    await run_all(maker, FakeClient([recs(1, 2, 3, 3), []]))       # дубль внутри страницы
    job, _, n = await state(maker, j)
    assert (n, job.records_saved, job.records_fetched) == (3, 3, 4)

    # повторная загрузка тех же данных новым заданием — новых строк нет
    async with maker() as db:
        await set_rls_context(db, platform_admin=True)
        db.add(SyncJob(organization_id=org, seller_account_id=a, kind="manual", period_from=date(2026, 7, 1), period_to=date(2026, 10, 19)))
        await db.commit()
    await run_all(maker, FakeClient([recs(1, 2, 3), []]))
    _, _, n2 = await state(maker, j)
    assert n2 == 3


async def test_resume_from_checkpoint_after_restart(maker, acct):
    _, a, j = acct
    c1 = FakeClient([recs(1, 2)])
    await process_next(maker, c1, now=T0)                       # «воркер» умирает после первой страницы
    c2 = FakeClient([recs(3), []])                              # новый процесс продолжает с курсора 2
    await run_all(maker, c2)
    assert c2.cursors == [2, 3]
    job, _, n = await state(maker, j)
    assert job.status == "succeeded" and n == 3


async def test_abandoned_running_job_is_reclaimed(maker, acct):
    _, a, j = acct
    async with maker() as db:
        await set_rls_context(db, platform_admin=True)
        job = await db.get(SyncJob, j)
        job.status, job.heartbeat_at = "running", T0 - timedelta(minutes=30)
        await db.commit()
    c = FakeClient([recs(1), []])
    await run_all(maker, c)
    assert (await state(maker, j))[0].status == "succeeded"


async def test_429_backs_off_and_does_not_retry_immediately(maker, acct):
    _, a, j = acct
    c = FakeClient([RateLimited("лимит", retry_after=300), recs(1), []])
    await process_next(maker, c, now=T0)
    job, acc, _ = await state(maker, j)
    assert job.status == "queued" and job.attempts == 1 and job.error_code == "rate_limited"
    assert job.scheduled_at >= T0 + timedelta(seconds=300) and acc.next_request_at >= T0 + timedelta(seconds=300)
    assert await process_next(maker, c, now=T0 + timedelta(seconds=200)) is False
    assert await process_next(maker, c, now=T0 + timedelta(seconds=301)) is True


async def test_temporary_errors_retry_with_backoff_then_fail(maker, acct):
    _, a, j = acct
    c = FakeClient([TemporaryError("5xx")] * 5)
    now = T0
    for _ in range(5):
        assert await process_next(maker, c, now=now) is True
        now += timedelta(hours=2)
    job, _, _ = await state(maker, j)
    assert job.status == "failed" and job.attempts == 5 and job.error_code == "temporary_error"


async def test_failure_after_progress_is_partial_and_retry_resumes(maker, acct):
    org, a, j = acct
    c = FakeClient([recs(1, 2), TemporaryError("x")])
    await process_next(maker, c, now=T0)
    # исчерпываем повторы
    c2 = FakeClient([TemporaryError("x")] * 5)
    now = T0 + STEP
    for _ in range(5):
        await process_next(maker, c2, now=now)
        now += timedelta(hours=2)
    job, _, n = await state(maker, j)
    assert job.status == "partial" and job.records_saved == 2 and n == 2
    async with maker() as db:                                   # ручной retry: курсор сохраняется
        await set_rls_context(db, org_id=org)
        from app.services.seller_accounts import retry_job
        jb = await db.get(SyncJob, j)
        acc = await db.get(SellerAccount, a)
        await retry_job(db, acc, jb, user_id=None, ip=None)
        await db.commit()
    c3 = FakeClient([recs(3), []])
    await run_all(maker, c3, start=T0 + timedelta(days=2))   # после всех задержек повтора
    assert c3.cursors == [2, 3] and (await state(maker, j))[0].status == "succeeded"


async def test_auth_error_stops_job_and_disables_account(maker, acct):
    _, a, j = acct
    c = FakeClient([AuthError("401")])
    await process_next(maker, c, now=T0)
    job, acc, _ = await state(maker, j)
    assert job.status == "failed" and job.error_code == "auth_error" and acc.status == "auth_error"
    assert await process_next(maker, FakeClient([[]]), now=T0 + timedelta(days=1)) is False   # аккаунт не активен


async def test_record_without_rrd_id_fails_job_and_saves_nothing(maker, acct):
    _, a, j = acct
    bad = [dict(SAMPLE, rrdId=1), {k: v for k, v in SAMPLE.items() if k != "rrdId"}]
    await process_next(maker, FakeClient([bad]), now=T0)
    job, _, n = await state(maker, j)
    assert job.status == "failed" and job.error_code == "parse_error" and n == 0


async def test_non_advancing_cursor_stops_job(maker, acct):
    _, a, j = acct
    c = FakeClient([recs(5), recs(5)])
    await run_all(maker, c)
    job, _, _ = await state(maker, j)
    assert job.status == "partial" and job.error_code == "pagination_stuck"


async def test_only_one_active_job_per_account(maker, acct):
    org, a, j = acct
    from sqlalchemy.exc import IntegrityError
    async with maker() as db:
        await set_rls_context(db, platform_admin=True)
        db.add(SyncJob(organization_id=org, seller_account_id=a, kind="manual", period_from=date(2026, 1, 1), period_to=date(2026, 1, 2)))
        with pytest.raises(IntegrityError):
            await db.flush()


async def test_rls_on_marketplace_tables(maker, acct):
    org, a, j = acct
    await run_all(maker, FakeClient([recs(1), []]))
    other = uuid.uuid4()
    async with maker() as db:
        for t in ("seller_accounts", "sync_jobs", "raw_records"):
            assert (await db.execute(text(f"SELECT count(*) FROM {t}"))).scalar_one() == 0          # без контекста
        await set_rls_context(db, org_id=other)
        for t in ("seller_accounts", "sync_jobs", "raw_records"):
            assert (await db.execute(text(f"SELECT count(*) FROM {t}"))).scalar_one() == 0          # чужая организация
        await set_rls_context(db, org_id=org)
        assert (await db.execute(text("SELECT count(*) FROM raw_records"))).scalar_one() == 1
