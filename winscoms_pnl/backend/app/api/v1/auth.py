from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import SESSION_COOKIE, client_ip, current_auth
from app.core.config import get_settings
from app.core.throttle import login_throttle
from app.db.session import get_session, set_rls_context
from app.repositories import memberships as members_repo
from app.schemas.auth import LoginRequest, MeOut, UserOut
from app.services import audit
from app.services.auth import AuthContext, authenticate, create_session, get_user_by_email, revoke_session

router = APIRouter(prefix="/auth", tags=["auth"])

_BAD_LOGIN = HTTPException(status.HTTP_401_UNAUTHORIZED, "Неверный email или пароль")


def _set_cookie(response: Response, token: str) -> None:
    cfg = get_settings()
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=cfg.session_ttl_hours * 3600,
        httponly=True,
        secure=cfg.app_env == "production",
        samesite="lax",
        path="/",
    )


async def _me(db: AsyncSession, ctx: AuthContext) -> MeOut:
    ms = await members_repo.list_for_user(db, ctx.user.id)
    return MeOut.model_validate(
        {"user": ctx.user, "memberships": ms, "csrf_token": ctx.session.csrf_token}, from_attributes=True
    )


@router.post("/login", response_model=MeOut)
async def login(
    body: LoginRequest, request: Request, response: Response, db: AsyncSession = Depends(get_session)
) -> MeOut:
    ip = client_ip(request) or "unknown"
    email = body.email.lower()
    keys = (f"ip:{ip}", f"email:{email}")
    if login_throttle.is_blocked(*keys):
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Слишком много попыток. Попробуйте позже")

    user = await authenticate(db, email, body.password)
    if user is None:
        login_throttle.record_failure(*keys)
        known = await get_user_by_email(db, email)
        audit.record(db, "auth.login_failed", actor=known.id if known else None, ip=ip)
        await db.commit()  # событие нужно сохранить, хотя запрос завершится ошибкой
        raise _BAD_LOGIN

    login_throttle.reset(*keys)
    await set_rls_context(db, user_id=user.id, platform_admin=user.is_platform_admin)
    token, session = await create_session(db, user)
    audit.record(db, "auth.login", actor=user.id, ip=ip)
    _set_cookie(response, token)
    return await _me(db, AuthContext(user=user, session=session))


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(
    request: Request,
    response: Response,
    ctx: AuthContext = Depends(current_auth),
    db: AsyncSession = Depends(get_session),
) -> None:
    await revoke_session(db, ctx.session)
    audit.record(db, "auth.logout", actor=ctx.user.id, ip=client_ip(request))
    response.delete_cookie(SESSION_COOKIE, path="/")


@router.get("/me", response_model=MeOut)
async def me(ctx: AuthContext = Depends(current_auth), db: AsyncSession = Depends(get_session)) -> MeOut:
    return await _me(db, ctx)
