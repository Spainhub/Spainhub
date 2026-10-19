import asyncio

from alembic import context
from sqlalchemy.ext.asyncio import create_async_engine

from app.core.config import get_settings
import app.models  # noqa: F401  (регистрирует модели в metadata)
from app.db.base import Base

target_metadata = Base.metadata


def _url() -> str:
    s = get_settings()
    # Миграции идут от владельца схемы; приложение работает под ограниченной ролью.
    return s.migration_database_url or s.database_url


def _run(connection) -> None:
    context.configure(connection=connection, target_metadata=target_metadata, compare_type=True)
    with context.begin_transaction():
        context.run_migrations()


async def _run_online() -> None:
    engine = create_async_engine(_url())
    async with engine.connect() as conn:
        await conn.run_sync(_run)
    await engine.dispose()


if context.is_offline_mode():
    context.configure(url=_url(), target_metadata=target_metadata, literal_binds=True)
    with context.begin_transaction():
        context.run_migrations()
else:
    asyncio.run(_run_online())
