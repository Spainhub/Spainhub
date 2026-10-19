import uuid

import pytest
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from app.db.session import set_rls_context
from tests.conftest import USER_PASSWORD, csrf, login, needs_db

pytestmark = needs_db


async def _setup_org(admin, name, users):
    """Создаёт организацию и пользователей (email, role) через API администратора."""
    c, h, _ = admin
    org = (await c.post("/api/v1/admin/organizations", json={"name": name}, headers=h)).json()
    for email, role in users:
        r = await c.post("/api/v1/admin/users", headers=h, json={
            "email": email, "password": USER_PASSWORD, "organization_id": org["id"], "role": role})
        assert r.status_code == 201, r.text
    return org


async def test_regular_user_cannot_use_admin_api(client, make_user):
    u = await make_user()
    r = await login(client, u.email)
    h = csrf(r)
    assert (await client.get("/api/v1/admin/users")).status_code == 403
    assert (await client.post("/api/v1/admin/organizations", json={"name": "X"}, headers=h)).status_code == 403


async def test_admin_mutation_requires_csrf(admin):
    c, h, _ = admin
    assert (await c.post("/api/v1/admin/organizations", json={"name": "NoCsrf"})).status_code == 403
    assert (await c.post("/api/v1/admin/organizations", json={"name": "Ok"}, headers=h)).status_code == 201


async def test_admin_creates_user_validations(admin):
    c, h, _ = admin
    e = f"{uuid.uuid4().hex[:6]}@example.com"
    body = {"email": e, "password": USER_PASSWORD}
    assert (await c.post("/api/v1/admin/users", json=body, headers=h)).status_code == 201
    assert (await c.post("/api/v1/admin/users", json=body, headers=h)).status_code == 409
    assert (await c.post("/api/v1/admin/users", json={"email": "x@example.com", "password": "short"}, headers=h)).status_code == 422
    assert (await c.post("/api/v1/admin/users", json={"email": "bad", "password": USER_PASSWORD}, headers=h)).status_code == 422
    r = await c.post("/api/v1/admin/users", headers=h, json={**body, "email": "z@example.com", "role": "owner"})
    assert r.status_code == 422


async def test_deactivating_user_revokes_sessions(admin, app):
    from httpx import ASGITransport, AsyncClient
    c, h, _ = admin
    e = f"{uuid.uuid4().hex[:6]}@example.com"
    uid = (await c.post("/api/v1/admin/users", json={"email": e, "password": USER_PASSWORD}, headers=h)).json()["id"]
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as other:
        assert (await login(other, e)).status_code == 200
        assert (await other.get("/api/v1/auth/me")).status_code == 200
        assert (await c.patch(f"/api/v1/admin/users/{uid}", json={"is_active": False}, headers=h)).status_code == 200
        assert (await other.get("/api/v1/auth/me")).status_code == 401


async def test_admin_cannot_deactivate_self(admin):
    c, h, me = admin
    assert (await c.patch(f"/api/v1/admin/users/{me.id}", json={"is_active": False}, headers=h)).status_code == 400


async def test_password_reset_invalidates_old_password(admin, app):
    from httpx import ASGITransport, AsyncClient
    c, h, _ = admin
    e = f"{uuid.uuid4().hex[:6]}@example.com"
    uid = (await c.post("/api/v1/admin/users", json={"email": e, "password": USER_PASSWORD}, headers=h)).json()["id"]
    await c.patch(f"/api/v1/admin/users/{uid}", json={"password": "brand-new-password-1"}, headers=h)
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as other:
        assert (await login(other, e, USER_PASSWORD)).status_code == 401
        assert (await login(other, e, "brand-new-password-1")).status_code == 200


# ----------------------------- изоляция тенантов -----------------------------

async def test_member_sees_only_own_organization(admin, app):
    from httpx import ASGITransport, AsyncClient
    tag = uuid.uuid4().hex[:6]
    org1 = await _setup_org(admin, f"A-{tag}", [(f"a1-{tag}@example.com", "admin"), (f"a2-{tag}@example.com", "viewer")])
    org2 = await _setup_org(admin, f"B-{tag}", [(f"b1-{tag}@example.com", "admin")])

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as a:
        await login(a, f"a1-{tag}@example.com")
        own = await a.get(f"/api/v1/orgs/{org1['id']}/members")
        assert own.status_code == 200
        assert {m["email"] for m in own.json()} == {f"a1-{tag}@example.com", f"a2-{tag}@example.com"}

        foreign = await a.get(f"/api/v1/orgs/{org2['id']}/members")
        assert foreign.status_code == 404                                   # а не 403: существование не раскрываем
        assert (await a.get(f"/api/v1/orgs/{uuid.uuid4()}/members")).status_code == 404
        assert (await a.get("/api/v1/admin/organizations")).status_code == 403


async def test_viewer_role_can_read_members(admin, app):
    from httpx import ASGITransport, AsyncClient
    tag = uuid.uuid4().hex[:6]
    org = await _setup_org(admin, f"V-{tag}", [(f"v-{tag}@example.com", "viewer")])
    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as v:
        await login(v, f"v-{tag}@example.com")
        assert (await v.get(f"/api/v1/orgs/{org['id']}/members")).status_code == 200


async def test_rls_blocks_cross_org_reads_even_without_app_filters(admin, maker):
    """Второй рубеж: запрос БЕЗ WHERE по организации всё равно не видит чужие строки."""
    tag = uuid.uuid4().hex[:6]
    org1 = await _setup_org(admin, f"R1-{tag}", [(f"r1-{tag}@example.com", "member")])
    org2 = await _setup_org(admin, f"R2-{tag}", [(f"r2-{tag}@example.com", "member")])

    async with maker() as db:                                  # без контекста — ничего не видно
        assert (await db.execute(text("SELECT count(*) FROM memberships"))).scalar_one() == 0
    async with maker() as db:
        await set_rls_context(db, org_id=org1["id"])
        orgs = (await db.execute(text("SELECT DISTINCT organization_id::text FROM memberships"))).scalars().all()
        assert orgs == [org1["id"]]
    async with maker() as db:
        await set_rls_context(db, platform_admin=True)
        orgs = set((await db.execute(text("SELECT DISTINCT organization_id::text FROM memberships"))).scalars())
        assert {org1["id"], org2["id"]} <= orgs


async def test_rls_blocks_cross_org_writes(admin, maker):
    tag = uuid.uuid4().hex[:6]
    org1 = await _setup_org(admin, f"W1-{tag}", [(f"w1-{tag}@example.com", "member")])
    org2 = await _setup_org(admin, f"W2-{tag}", [])
    uid = (await admin[0].get("/api/v1/admin/users")).json()
    uid = next(u["id"] for u in uid if u["email"] == f"w1-{tag}@example.com")
    async with maker() as db:
        await set_rls_context(db, org_id=org1["id"])
        with pytest.raises(DBAPIError):
            await db.execute(
                text("INSERT INTO memberships (organization_id, user_id, role) VALUES (:o, :u, 'member')"),
                {"o": org2["id"], "u": uid},
            )


async def test_app_role_is_not_privileged(maker):
    async with maker() as db:
        row = (await db.execute(text(
            "SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user"))).one()
        assert tuple(row) == (False, False)
        with pytest.raises(DBAPIError):
            await db.execute(text("SELECT * FROM alembic_version"))
