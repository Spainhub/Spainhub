import uuid
from datetime import datetime, timezone

from pydantic import BaseModel, Field, SecretStr
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import OrgContext, client_ip, org_context, require_org_role
from app.db.session import get_session, set_rls_context
from app.integrations.errors import AuthError, MarketplaceError
from app.integrations.wildberries.client import get_wb_client
from app.core.crypto import decrypt
from app.models import Role, SellerAccount, SyncJob
from app.schemas.marketplace import (
    SellerAccountCreate, SellerAccountOut, SyncJobOut, SyncStart, ValidateOut,
)
from app.services import audit
from app.services import normalization
from app.services import seller_accounts as svc

router = APIRouter(prefix="/orgs/{org_id}/seller-accounts", tags=["marketplace"])
_manage = require_org_role(Role.admin)


class TokenUpdate(BaseModel):
    token: SecretStr = Field(min_length=10, max_length=4096)


@router.get("", response_model=list[SellerAccountOut])
async def list_accounts(oc: OrgContext = Depends(org_context), db: AsyncSession = Depends(get_session)):
    q = select(SellerAccount).where(SellerAccount.organization_id == oc.org_id, SellerAccount.status != "disconnected")
    return list((await db.execute(q.order_by(SellerAccount.created_at))).scalars())


@router.post("", response_model=SellerAccountOut, status_code=status.HTTP_201_CREATED)
async def create_account(body: SellerAccountCreate, request: Request, oc: OrgContext = Depends(_manage), db: AsyncSession = Depends(get_session)):
    return await svc.create_account(
        db, org_id=oc.org_id, user_id=oc.auth.user.id, marketplace=body.marketplace, name=body.name,
        token=body.token.get_secret_value(), ip=client_ip(request),
    )


@router.put("/{account_id}/token", response_model=SellerAccountOut)
async def replace_token(account_id: uuid.UUID, body: TokenUpdate, request: Request, oc: OrgContext = Depends(_manage), db: AsyncSession = Depends(get_session)):
    acc = await svc.get_account(db, oc.org_id, account_id)
    svc.set_token(acc, body.token.get_secret_value().strip())
    acc.last_validated_at = None
    audit.record(db, "seller_account.token_replaced", actor=oc.auth.user.id, org=oc.org_id, ip=client_ip(request), account_id=str(acc.id))
    return acc


@router.delete("/{account_id}", status_code=status.HTTP_204_NO_CONTENT)
async def disconnect_account(account_id: uuid.UUID, request: Request, oc: OrgContext = Depends(_manage), db: AsyncSession = Depends(get_session)):
    acc = await svc.get_account(db, oc.org_id, account_id)
    await svc.disconnect(db, acc, user_id=oc.auth.user.id, ip=client_ip(request))
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/{account_id}/validate", response_model=ValidateOut)
async def validate_account(account_id: uuid.UUID, oc: OrgContext = Depends(_manage), db: AsyncSession = Depends(get_session), client=Depends(get_wb_client)):
    acc = await svc.get_account(db, oc.org_id, account_id)
    wait = svc.slot_wait_seconds(acc)
    if wait > 0:  # проверка тоже расходует лимит API — не нарушаем его
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, f"Лимит запросов WB: повторите через {int(wait) + 1} с",
                            headers={"Retry-After": str(int(wait) + 1)})
    svc.reserve_slot(acc)
    await db.commit()                       # слот резервируется до запроса
    await set_rls_context(db, org_id=oc.org_id)
    try:
        await client.validate(decrypt(acc.encrypted_token))
    except AuthError as e:
        acc.status = "auth_error"
        return ValidateOut(valid=False, message=e.message)
    except MarketplaceError as e:
        return ValidateOut(valid=False, message=e.message)
    finally:
        if hasattr(client, "aclose"):
            await client.aclose()
    acc.status, acc.last_validated_at = "active", datetime.now(timezone.utc)
    return ValidateOut(valid=True, message="Подключение работает")


@router.post("/{account_id}/sync", response_model=SyncJobOut, status_code=status.HTTP_202_ACCEPTED)
async def start_sync(account_id: uuid.UUID, request: Request, body: SyncStart | None = None, oc: OrgContext = Depends(_manage), db: AsyncSession = Depends(get_session)):
    acc = await svc.get_account(db, oc.org_id, account_id)
    return await svc.start_sync(db, acc, kind="initial", months=(body.months if body else None), user_id=oc.auth.user.id, ip=client_ip(request))


@router.get("/{account_id}/sync-jobs", response_model=list[SyncJobOut])
async def list_jobs(account_id: uuid.UUID, oc: OrgContext = Depends(org_context), db: AsyncSession = Depends(get_session)):
    acc = await svc.get_account(db, oc.org_id, account_id)
    q = select(SyncJob).where(SyncJob.seller_account_id == acc.id, SyncJob.organization_id == oc.org_id)
    return list((await db.execute(q.order_by(SyncJob.created_at.desc()).limit(50))).scalars())


@router.post("/{account_id}/sync-jobs/{job_id}/retry", response_model=SyncJobOut)
async def retry(account_id: uuid.UUID, job_id: uuid.UUID, request: Request, oc: OrgContext = Depends(_manage), db: AsyncSession = Depends(get_session)):
    acc = await svc.get_account(db, oc.org_id, account_id)
    job = (await db.execute(select(SyncJob).where(SyncJob.id == job_id, SyncJob.seller_account_id == acc.id, SyncJob.organization_id == oc.org_id))).scalar_one_or_none()
    if job is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Задание не найдено")
    return await svc.retry_job(db, acc, job, user_id=oc.auth.user.id, ip=client_ip(request))


@router.get("/{account_id}/normalization")
async def normalization_summary(account_id: uuid.UUID, oc: OrgContext = Depends(org_context), db: AsyncSession = Depends(get_session)):
    """Полнота данных: сколько строк разобрано, сколько требует внимания (review/inconsistent/unclassified)."""
    acc = await svc.get_account(db, oc.org_id, account_id)
    return await normalization.summary(db, org_id=oc.org_id, account_id=acc.id)
