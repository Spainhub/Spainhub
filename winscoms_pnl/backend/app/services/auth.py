import uuid
import asyncio
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import get_settings
from app.core.security import hash_password, hash_token, new_token, verify_password
from app.models import AuthSession, User
from app.services import audit


@dataclass
class AuthContext:
    user: User
    session: AuthSession


def _now() -> datetime:
    return datetime.now(timezone.utc)


async def get_user_by_email(db: AsyncSession, email: str) -> User | None:
    return (await db.execute(select(User).where(User.email == email.lower()))).scalar_one_or_none()


async def authenticate(db: AsyncSession, email: str, password: str) -> User | None:
    user = await get_user_by_email(db, email)
    # Argon2 намеренно медленный — выносим из event loop
    ok = await asyncio.to_thread(verify_password, password, user.password_hash if user else None)
    return user if (ok and user is not None and user.is_active) else None


async def create_session(db: AsyncSession, user: User) -> tuple[str, AuthSession]:
    token = new_token()
    s = AuthSession(
        user_id=user.id,
        token_hash=hash_token(token),
        csrf_token=new_token(),
        expires_at=_now() + timedelta(hours=get_settings().session_ttl_hours),
    )
    db.add(s)
    await db.flush()
    return token, s


async def resolve_session(db: AsyncSession, token: str) -> AuthContext | None:
    cfg = get_settings()
    now = _now()
    row = (
        await db.execute(
            select(AuthSession, User)
            .join(User, User.id == AuthSession.user_id)
            .where(AuthSession.token_hash == hash_token(token))
        )
    ).first()
    if row is None:
        return None
    s, user = row
    idle_limit = s.last_seen_at + timedelta(hours=cfg.session_idle_hours)
    if s.revoked_at is not None or s.expires_at <= now or idle_limit <= now or not user.is_active:
        return None
    if now - s.last_seen_at > timedelta(minutes=1):
        s.last_seen_at = now
    return AuthContext(user=user, session=s)


async def revoke_session(db: AsyncSession, session: AuthSession) -> None:
    session.revoked_at = _now()


async def revoke_all_user_sessions(db: AsyncSession, user_id: uuid.UUID) -> None:
    await db.execute(
        update(AuthSession)
        .where(AuthSession.user_id == user_id, AuthSession.revoked_at.is_(None))
        .values(revoked_at=_now())
    )


async def create_user(
    db: AsyncSession,
    *,
    email: str,
    password: str,
    full_name: str | None = None,
    is_platform_admin: bool = False,
    actor: uuid.UUID | None = None,
    ip: str | None = None,
) -> User:
    user = User(
        email=email.lower(),
        password_hash=hash_password(password),
        full_name=full_name,
        is_platform_admin=is_platform_admin,
    )
    db.add(user)
    await db.flush()
    audit.record(db, "user.created", actor=actor, ip=ip, user_id=str(user.id), platform_admin=is_platform_admin)
    return user
