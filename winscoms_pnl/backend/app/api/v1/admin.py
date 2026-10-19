import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import client_ip, require_platform_admin
from app.core.security import hash_password
from app.db.session import get_session
from app.models import Membership, Organization, SyncJob, User
from app.schemas.marketplace import SyncJobOut
from app.schemas.auth import (
    MemberAdd,
    OrganizationCreate,
    OrganizationOut,
    UserCreate,
    UserOut,
    UserUpdate,
)
from app.services import audit
from app.services.auth import AuthContext, create_user, get_user_by_email, revoke_all_user_sessions

router = APIRouter(prefix="/admin", tags=["admin"])


@router.post("/organizations", response_model=OrganizationOut, status_code=status.HTTP_201_CREATED)
async def create_organization(
    body: OrganizationCreate,
    request: Request,
    ctx: AuthContext = Depends(require_platform_admin),
    db: AsyncSession = Depends(get_session),
) -> Organization:
    org = Organization(name=body.name)
    db.add(org)
    await db.flush()
    audit.record(db, "organization.created", actor=ctx.user.id, org=org.id, ip=client_ip(request))
    return org


@router.get("/organizations", response_model=list[OrganizationOut])
async def list_organizations(
    _: AuthContext = Depends(require_platform_admin), db: AsyncSession = Depends(get_session)
) -> list[Organization]:
    return list((await db.execute(select(Organization).order_by(Organization.name))).scalars())


@router.post("/users", response_model=UserOut, status_code=status.HTTP_201_CREATED)
async def admin_create_user(
    body: UserCreate,
    request: Request,
    ctx: AuthContext = Depends(require_platform_admin),
    db: AsyncSession = Depends(get_session),
) -> User:
    if await get_user_by_email(db, body.email):
        raise HTTPException(status.HTTP_409_CONFLICT, "Пользователь с таким email уже существует")
    if body.organization_id and await db.get(Organization, body.organization_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Организация не найдена")
    user = await create_user(
        db, email=body.email, password=body.password, full_name=body.full_name,
        actor=ctx.user.id, ip=client_ip(request),
    )
    if body.organization_id:
        db.add(Membership(organization_id=body.organization_id, user_id=user.id, role=body.role))
        audit.record(db, "membership.added", actor=ctx.user.id, org=body.organization_id,
                     ip=client_ip(request), user_id=str(user.id), role=body.role)
    return user


@router.get("/users", response_model=list[UserOut])
async def list_users(
    _: AuthContext = Depends(require_platform_admin), db: AsyncSession = Depends(get_session)
) -> list[User]:
    return list((await db.execute(select(User).order_by(User.email))).scalars())


@router.patch("/users/{user_id}", response_model=UserOut)
async def update_user(
    user_id: uuid.UUID,
    body: UserUpdate,
    request: Request,
    ctx: AuthContext = Depends(require_platform_admin),
    db: AsyncSession = Depends(get_session),
) -> User:
    user = await db.get(User, user_id)
    if user is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Пользователь не найден")
    if body.is_active is not None:
        if user.id == ctx.user.id and not body.is_active:
            raise HTTPException(status.HTTP_400_BAD_REQUEST, "Нельзя отключить самого себя")
        user.is_active = body.is_active
        audit.record(db, "user.active_changed", actor=ctx.user.id, ip=client_ip(request),
                     user_id=str(user.id), is_active=body.is_active)
    if body.password is not None:
        user.password_hash = hash_password(body.password)
        audit.record(db, "user.password_reset", actor=ctx.user.id, ip=client_ip(request), user_id=str(user.id))
    if body.password is not None or body.is_active is False:
        await revoke_all_user_sessions(db, user.id)
    return user


@router.post("/organizations/{org_id}/members", status_code=status.HTTP_201_CREATED)
async def add_member(
    org_id: uuid.UUID,
    body: MemberAdd,
    request: Request,
    ctx: AuthContext = Depends(require_platform_admin),
    db: AsyncSession = Depends(get_session),
) -> dict[str, str]:
    if await db.get(Organization, org_id) is None or await db.get(User, body.user_id) is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Организация или пользователь не найдены")
    db.add(Membership(organization_id=org_id, user_id=body.user_id, role=body.role))
    try:
        await db.flush()
    except IntegrityError:
        raise HTTPException(status.HTTP_409_CONFLICT, "Пользователь уже состоит в организации")
    audit.record(db, "membership.added", actor=ctx.user.id, org=org_id, ip=client_ip(request),
                 user_id=str(body.user_id), role=body.role)
    return {"status": "ok"}


@router.get("/sync-jobs", response_model=list[SyncJobOut])
async def recent_sync_jobs(
    limit: int = 50, _: AuthContext = Depends(require_platform_admin), db: AsyncSession = Depends(get_session)
) -> list[SyncJob]:
    """Последние задания синхронизации всех организаций (для мониторинга)."""
    q = select(SyncJob).order_by(SyncJob.created_at.desc()).limit(min(max(limit, 1), 200))
    return list((await db.execute(q)).scalars())
