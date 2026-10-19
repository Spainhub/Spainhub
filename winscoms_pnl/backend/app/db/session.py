from collections.abc import AsyncIterator

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import get_settings

_engine: AsyncEngine | None = None
_sessionmaker: async_sessionmaker[AsyncSession] | None = None


def get_engine() -> AsyncEngine:
    global _engine, _sessionmaker
    if _engine is None:
        _engine = create_async_engine(get_settings().database_url, pool_pre_ping=True)
        _sessionmaker = async_sessionmaker(_engine, expire_on_commit=False)
    return _engine


async def session_scope(maker: async_sessionmaker[AsyncSession]) -> AsyncIterator[AsyncSession]:
    """Одна транзакция на запрос: commit при успехе, rollback при исключении."""
    async with maker() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def get_session() -> AsyncIterator[AsyncSession]:
    get_engine()
    assert _sessionmaker is not None
    async for session in session_scope(_sessionmaker):
        yield session


async def set_rls_context(
    session: AsyncSession,
    *,
    user_id: object | None = None,
    org_id: object | None = None,
    platform_admin: bool = False,
) -> None:
    """Передаёт контекст запроса политикам RLS. Действует до конца текущей транзакции."""
    for key, value in (
        ("app.current_user", user_id),
        ("app.current_org", org_id),
        ("app.is_platform_admin", "on" if platform_admin else ""),
    ):
        if value is not None:
            await session.execute(text("SELECT set_config(:k, :v, true)"), {"k": key, "v": str(value)})


async def dispose_engine() -> None:
    global _engine, _sessionmaker
    if _engine is not None:
        await _engine.dispose()
        _engine = _sessionmaker = None
