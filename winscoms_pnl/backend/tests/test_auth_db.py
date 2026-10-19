from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import text

from app.api.deps import SESSION_COOKIE
from app.core.throttle import login_throttle
from app.db.session import set_rls_context
from tests.conftest import USER_PASSWORD, csrf, login, needs_db

pytestmark = needs_db


async def test_login_sets_httponly_cookie_and_me_works(client, make_user):
    u = await make_user()
    r = await login(client, u.email)
    assert r.status_code == 200
    cookie = r.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=lax" in cookie
    assert "password" not in r.text.lower()
    me = await client.get("/api/v1/auth/me")
    assert me.status_code == 200 and me.json()["user"]["email"] == u.email
    assert "password_hash" not in me.text


async def test_email_is_case_insensitive(client, make_user):
    u = await make_user("MixedCase@Example.com")
    assert u.email == "mixedcase@example.com"
    assert (await login(client, "MIXEDCASE@example.COM")).status_code == 200


async def test_wrong_password_and_unknown_user_look_identical(client, make_user):
    u = await make_user()
    a = await login(client, u.email, "wrong-password-xx")
    b = await login(client, "nobody@example.com", "wrong-password-xx")
    assert a.status_code == b.status_code == 401
    assert a.json() == b.json()
    assert SESSION_COOKIE not in a.cookies


async def test_inactive_user_cannot_login(client, make_user, maker):
    u = await make_user()
    async with maker() as db:
        await set_rls_context(db, platform_admin=True)
        await db.execute(text("UPDATE users SET is_active=false WHERE id=:i"), {"i": u.id})
        await db.commit()
    assert (await login(client, u.email)).status_code == 401


async def test_unauthenticated_requests_are_rejected(client):
    assert (await client.get("/api/v1/auth/me")).status_code == 401
    assert (await client.get("/api/v1/admin/users")).status_code == 401


async def test_password_and_token_are_not_stored_in_plaintext(client, make_user, maker):
    u = await make_user()
    r = await login(client, u.email)
    token = r.cookies[SESSION_COOKIE]
    async with maker() as db:
        h = (await db.execute(text("SELECT password_hash FROM users WHERE id=:i"), {"i": u.id})).scalar_one()
        hashes = (await db.execute(text("SELECT token_hash FROM auth_sessions"))).scalars().all()
    assert h.startswith("$argon2id$") and USER_PASSWORD not in h
    assert token not in hashes and len(hashes) >= 1


async def test_logout_revokes_session_and_requires_csrf(client, make_user):
    u = await make_user()
    r = await login(client, u.email)
    assert (await client.post("/api/v1/auth/logout")).status_code == 403          # без CSRF
    assert (await client.post("/api/v1/auth/logout", headers={"X-CSRF-Token": "bad"})).status_code == 403
    assert (await client.post("/api/v1/auth/logout", headers=csrf(r))).status_code == 204
    assert (await client.get("/api/v1/auth/me")).status_code == 401


async def test_expired_and_idle_sessions_are_rejected(client, make_user, maker):
    u = await make_user()
    await login(client, u.email)
    long_ago = datetime.now(timezone.utc) - timedelta(days=30)
    async with maker() as db:
        await db.execute(text("UPDATE auth_sessions SET expires_at=:t WHERE user_id=:i"), {"t": long_ago, "i": u.id})
        await db.commit()
    assert (await client.get("/api/v1/auth/me")).status_code == 401

    u2 = await make_user()
    await login(client, u2.email)
    async with maker() as db:
        await db.execute(text("UPDATE auth_sessions SET last_seen_at=:t WHERE user_id=:i"), {"t": long_ago, "i": u2.id})
        await db.commit()
    assert (await client.get("/api/v1/auth/me")).status_code == 401


async def test_login_is_throttled_after_repeated_failures(client, make_user):
    u = await make_user()
    for _ in range(5):
        assert (await login(client, u.email, "bad-password-xyz")).status_code == 401
    assert (await login(client, u.email, USER_PASSWORD)).status_code == 429   # даже верный пароль
    login_throttle._failures.clear()
    assert (await login(client, u.email, USER_PASSWORD)).status_code == 200


async def test_failed_login_is_audited_without_secrets(client, make_user, maker):
    u = await make_user()
    await login(client, u.email, "super-secret-wrong-pw")
    async with maker() as db:
        rows = (await db.execute(text("SELECT action, details::text FROM audit_events WHERE actor_user_id=:i"), {"i": u.id})).all()
    assert any(a == "auth.login_failed" for a, _ in rows)
    assert all("super-secret-wrong-pw" not in d for _, d in rows)


def test_cookie_is_secure_in_production(monkeypatch):
    from fastapi import Response
    from app.api.v1 import auth as auth_mod
    from app.core.config import Settings

    prod = Settings(_env_file=None, app_env="production", secret_key="s" * 48, encryption_keys="k" * 44,
                    database_url="postgresql+asyncpg://u:strongpw@db:5432/x")
    monkeypatch.setattr(auth_mod, "get_settings", lambda: prod)
    resp = Response()
    auth_mod._set_cookie(resp, "tok")
    assert "secure" in resp.headers["set-cookie"].lower()
