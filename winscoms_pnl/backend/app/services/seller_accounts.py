import uuid
from datetime import datetime, timedelta, timezone

from fastapi import HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.crypto import encrypt
from app.jobs.periods import daily_period, initial_period
from app.models import SellerAccount, SyncJob
from app.services import audit

ACTIVE_JOB = ("queued", "running")
_CONFLICT = HTTPException(status.HTTP_409_CONFLICT, "Для этого аккаунта уже выполняется синхронизация")


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def get_account(db: AsyncSession, org_id: uuid.UUID, account_id: uuid.UUID) -> SellerAccount:
    """Аккаунт ищется ТОЛЬКО внутри организации: чужой выглядит как несуществующий."""
    acc = (
        await db.execute(
            select(SellerAccount).where(SellerAccount.id == account_id, SellerAccount.organization_id == org_id)
        )
    ).scalar_one_or_none()
    if acc is None or acc.status == "disconnected":
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Аккаунт не найден")
    return acc


def set_token(acc: SellerAccount, token: str) -> None:
    acc.encrypted_token = encrypt(token)
    acc.token_hint = token[-4:]
    acc.status = "active"


async def create_account(db: AsyncSession, *, org_id, user_id, marketplace: str, name: str, token: str, ip) -> SellerAccount:
    acc = SellerAccount(organization_id=org_id, marketplace=marketplace, name=name, created_by=user_id)
    set_token(acc, token)
    db.add(acc)
    await db.flush()
    audit.record(db, "seller_account.created", actor=user_id, org=org_id, ip=ip, account_id=str(acc.id), marketplace=marketplace)
    return acc


async def disconnect(db: AsyncSession, acc: SellerAccount, *, user_id, ip) -> None:
    acc.status, acc.encrypted_token, acc.token_hint = "disconnected", None, None
    jobs = (await db.execute(select(SyncJob).where(SyncJob.seller_account_id == acc.id, SyncJob.status.in_(ACTIVE_JOB)))).scalars()
    for j in jobs:
        j.status, j.finished_at = "cancelled", _now()
    audit.record(db, "seller_account.disconnected", actor=user_id, org=acc.organization_id, ip=ip, account_id=str(acc.id))


async def start_sync(db: AsyncSession, acc: SellerAccount, *, kind: str, months: int | None, user_id, ip) -> SyncJob:
    if acc.status != "active" or acc.encrypted_token is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Аккаунт не готов к синхронизации: проверьте токен")
    if kind == "initial":
        p_from, p_to = initial_period(months or get_settings().history_months)
    else:
        p_from, p_to = daily_period()
    job = SyncJob(
        organization_id=acc.organization_id, seller_account_id=acc.id, kind=kind,
        period_from=p_from, period_to=p_to, created_by=user_id,
    )
    try:
        async with db.begin_nested():
            db.add(job)
            await db.flush()
    except IntegrityError:
        raise _CONFLICT
    audit.record(db, "sync.started", actor=user_id, org=acc.organization_id, ip=ip, job_id=str(job.id), kind=kind)
    return job


async def retry_job(db: AsyncSession, acc: SellerAccount, job: SyncJob, *, user_id, ip) -> SyncJob:
    if job.status not in ("failed", "partial"):
        raise HTTPException(status.HTTP_409_CONFLICT, "Повторить можно только неудавшееся задание")
    if acc.status != "active":
        raise HTTPException(status.HTTP_409_CONFLICT, "Сначала обновите токен аккаунта")
    try:
        async with db.begin_nested():
            job.status, job.attempts = "queued", 0
            job.error_code = job.error_message = job.finished_at = None
            job.scheduled_at = _now()                  # курсор сохраняется — продолжаем с места остановки
            await db.flush()
    except IntegrityError:
        raise _CONFLICT
    audit.record(db, "sync.retried", actor=user_id, org=acc.organization_id, ip=ip, job_id=str(job.id))
    return job


def slot_wait_seconds(acc: SellerAccount) -> float:
    if acc.next_request_at and acc.next_request_at > _now():
        return (acc.next_request_at - _now()).total_seconds()
    return 0.0


def reserve_slot(acc: SellerAccount) -> None:
    acc.next_request_at = _now() + timedelta(seconds=get_settings().wb_min_interval_seconds)
