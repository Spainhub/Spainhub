"""Тесты с реальным PostgreSQL (нужен для RLS).

Запуск: TEST_DATABASE_URL=postgresql+asyncpg://postgres@localhost:5432/postgres pytest
URL — суперпользователь, который может создавать БД. Без переменной DB-тесты пропускаются.
Для каждого запуска создаётся новая БД; миграции применяются настоящей командой alembic.
"""
import os
import subprocess
import sys
import uuid
from pathlib import Path

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.core.throttle import login_throttle
from app.db.session import get_session, session_scope, set_rls_context
from app.main import create_app
from app.services.auth import create_user

BACKEND_DIR = Path(__file__).resolve().parents[1]
APP_PASSWORD = "test-app-role-password-123"
USER_PASSWORD = "correct-horse-battery"

TEST_URL = os.environ.get("TEST_DATABASE_URL")
needs_db = pytest.mark.skipif(TEST_URL is None, reason="TEST_DATABASE_URL не задан")


@pytest_asyncio.fixture(scope="session", loop_scope="session")
async def db_urls():
    if TEST_URL is None:
        pytest.skip("TEST_DATABASE_URL не задан")
    admin_url = make_url(TEST_URL)
    name = f"winscoms_test_{uuid.uuid4().hex[:8]}"
    admin_engine = create_async_engine(admin_url, isolation_level="AUTOCOMMIT")
    async with admin_engine.connect() as c:
        await c.execute(text(f'CREATE DATABASE "{name}"'))
    owner_url = admin_url.set(database=name)
    app_url = owner_url.set(username="winscoms_app", password=APP_PASSWORD)
    env = {
        **os.environ,
        "APP_ENV": "test",
        "DATABASE_URL": owner_url.render_as_string(hide_password=False),
        "MIGRATION_DATABASE_URL": owner_url.render_as_string(hide_password=False),
        "APP_DB_PASSWORD": APP_PASSWORD,
    }
    subprocess.run([sys.executable, "-m", "alembic", "upgrade", "head"], cwd=BACKEND_DIR, env=env, check=True)
    yield owner_url, app_url
    async with admin_engine.connect() as c:
        await c.execute(text(f'DROP DATABASE "{name}" WITH (FORCE)'))
    await admin_engine.dispose()


@pytest_asyncio.fixture(scope="session", loop_scope="session")
async def maker(db_urls):
    engine = create_async_engine(db_urls[1])
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


@pytest_asyncio.fixture(scope="session", loop_scope="session")
async def owner_maker(db_urls):
    engine = create_async_engine(db_urls[0])
    yield async_sessionmaker(engine, expire_on_commit=False)
    await engine.dispose()


@pytest_asyncio.fixture(loop_scope="session")
async def app(maker):
    login_throttle._failures.clear()
    application = create_app()

    async def override():
        async for s in session_scope(maker):
            yield s

    application.dependency_overrides[get_session] = override
    return application


@pytest_asyncio.fixture(loop_scope="session")
async def client(app):
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        yield c


@pytest_asyncio.fixture(loop_scope="session")
async def make_user(maker):
    async def _make(email=None, *, platform_admin=False, password=USER_PASSWORD):
        email = email or f"u{uuid.uuid4().hex[:8]}@example.com"
        async with maker() as db:
            await set_rls_context(db, platform_admin=True)
            user = await create_user(db, email=email, password=password, is_platform_admin=platform_admin)
            await db.commit()
        return user

    return _make


async def login(client, email, password=USER_PASSWORD):
    r = await client.post("/api/v1/auth/login", json={"email": email, "password": password})
    return r


def csrf(r):
    return {"X-CSRF-Token": r.json()["csrf_token"]}


@pytest_asyncio.fixture(loop_scope="session")
async def admin(client, make_user):
    """Клиент-администратор платформы: (client, csrf-заголовки)."""
    u = await make_user(platform_admin=True)
    r = await login(client, u.email)
    assert r.status_code == 200
    return client, csrf(r), u
