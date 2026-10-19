import uuid
from dataclasses import dataclass

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.security import tokens_equal
from app.db.session import get_session, set_rls_context
from app.models import Membership, Role
from app.services.auth import AuthContext, resolve_session

SESSION_COOKIE = "wc_session"
SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}

_UNAUTH = HTTPException(status.HTTP_401_UNAUTHORIZED, "Требуется вход")


def client_ip(request: Request) -> str | None:
    # X-Real-IP задаёт доверенный nginx; бэкенд снаружи напрямую недоступен.
    return request.headers.get("x-real-ip") or (request.client.host if request.client else None)


async def current_auth(request: Request, db: AsyncSession = Depends(get_session)) -> AuthContext:
    """Аутентификация по cookie + CSRF для изменяющих запросов + контекст RLS."""
    token = request.cookies.get(SESSION_COOKIE)
    if not token:
        raise _UNAUTH
    ctx = await resolve_session(db, token)
    if ctx is None:
        raise _UNAUTH
    if request.method not in SAFE_METHODS:
        sent = request.headers.get("x-csrf-token", "")
        if not tokens_equal(sent, ctx.session.csrf_token):
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Неверный CSRF-токен")
    await set_rls_context(db, user_id=ctx.user.id, platform_admin=ctx.user.is_platform_admin)
    return ctx


async def require_platform_admin(ctx: AuthContext = Depends(current_auth)) -> AuthContext:
    if not ctx.user.is_platform_admin:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Недостаточно прав")
    return ctx


@dataclass
class OrgContext:
    org_id: uuid.UUID
    role: str
    auth: AuthContext


async def org_context(
    org_id: uuid.UUID,
    ctx: AuthContext = Depends(current_auth),
    db: AsyncSession = Depends(get_session),
) -> OrgContext:
    """Доступ к организации только для её участников. Чужая организация выглядит как 404."""
    role = (
        await db.execute(
            select(Membership.role).where(
                Membership.organization_id == org_id, Membership.user_id == ctx.user.id
            )
        )
    ).scalar_one_or_none()
    if role is None:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "Организация не найдена")
    await set_rls_context(db, org_id=org_id)
    return OrgContext(org_id=org_id, role=role, auth=ctx)


def require_org_role(*roles: Role):
    allowed = {r.value for r in roles}

    async def dep(oc: OrgContext = Depends(org_context)) -> OrgContext:
        if oc.role not in allowed:
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Недостаточно прав")
        return oc

    return dep
