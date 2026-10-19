import uuid

import pytest
from sqlalchemy import text

from app.core.crypto import decrypt
from app.db.session import set_rls_context
from app.integrations.errors import AuthError
from app.integrations.wildberries.client import get_wb_client
from tests.conftest import needs_db, setup_org

pytestmark = needs_db
TOKEN = "eyJ-SUPER-SECRET-token-0123456789-abcd"


class FakeWB:
    def __init__(self, error=None):
        self.error, self.calls = error, 0

    async def validate(self, token):
        self.calls += 1
        assert token == TOKEN
        if self.error:
            raise self.error


@pytest.fixture
async def world(admin, login_as, app):
    tag = uuid.uuid4().hex[:6]
    a = await setup_org(admin, f"A-{tag}", [(f"adm-{tag}@example.com", "admin"), (f"mem-{tag}@example.com", "member"), (f"vw-{tag}@example.com", "viewer")])
    b = await setup_org(admin, f"B-{tag}", [(f"b-{tag}@example.com", "admin")])
    fake = FakeWB()
    app.dependency_overrides[get_wb_client] = lambda: fake
    yield {
        "a": a, "b": b, "fake": fake, "tag": tag, "admin": admin,
        "adm": await login_as(f"adm-{tag}@example.com"), "mem": await login_as(f"mem-{tag}@example.com"),
        "vw": await login_as(f"vw-{tag}@example.com"), "bad": await login_as(f"b-{tag}@example.com"),
    }
    app.dependency_overrides.pop(get_wb_client, None)


async def create(w, who="adm", org="a", name="Магазин", token=TOKEN):
    c, h = w[who]
    return await c.post(f"/api/v1/orgs/{w[org]['id']}/seller-accounts", headers=h, json={"name": name, "token": token})


async def test_create_encrypts_token_and_never_returns_it(world, maker):
    r = await create(world)
    assert r.status_code == 201
    body = r.json()
    assert TOKEN not in r.text and body["token_hint"] == TOKEN[-4:] and "token" not in body and "encrypted_token" not in body
    c, _ = world["adm"]
    lst = await c.get(f"/api/v1/orgs/{world['a']['id']}/seller-accounts")
    assert TOKEN not in lst.text and len(lst.json()) == 1
    async with maker() as db:
        await set_rls_context(db, org_id=world["a"]["id"])
        blob = (await db.execute(text("SELECT encrypted_token FROM seller_accounts WHERE id=:i"), {"i": body["id"]})).scalar_one()
        audit = (await db.execute(text("SELECT details::text FROM audit_events WHERE action='seller_account.created'"))).scalars().all()
    assert TOKEN.encode() not in bytes(blob) and decrypt(bytes(blob)) == TOKEN
    assert all(TOKEN not in d for d in audit)


async def test_invalid_token_422_does_not_echo_input(world):
    r = await create(world, token="LeakMe-9")
    assert r.status_code == 422 and "LeakMe" not in r.text


async def test_only_org_admin_can_manage_but_members_can_read(world):
    assert (await create(world, who="mem")).status_code == 403
    assert (await create(world, who="vw")).status_code == 403
    assert (await create(world)).status_code == 201
    for who in ("mem", "vw"):
        c, _ = world[who]
        assert (await c.get(f"/api/v1/orgs/{world['a']['id']}/seller-accounts")).status_code == 200


async def test_other_organization_cannot_see_or_touch_account(world):
    acc = (await create(world)).json()
    c, h = world["bad"]
    a_org, aid = world["a"]["id"], acc["id"]
    base = f"/api/v1/orgs/{a_org}/seller-accounts"
    assert (await c.get(base)).status_code == 404                                    # чужая организация
    # своя организация, чужой id аккаунта
    mine = f"/api/v1/orgs/{world['b']['id']}/seller-accounts/{aid}"
    assert (await c.get(f"{mine}/sync-jobs")).status_code == 404
    assert (await c.post(f"{mine}/sync", headers=h)).status_code == 404
    assert (await c.post(f"{mine}/validate", headers=h)).status_code == 404
    assert (await c.put(f"{mine}/token", headers=h, json={"token": "x" * 20})).status_code == 404
    assert (await c.delete(mine, headers=h)).status_code == 404
    assert (await c.get(f"{mine}/normalization")).status_code == 404
    assert (await c.get(f"/api/v1/orgs/{world['b']['id']}/seller-accounts")).json() == []


async def test_start_sync_one_active_job_and_retry_rules(world):
    acc = (await create(world)).json()
    c, h = world["adm"]
    base = f"/api/v1/orgs/{world['a']['id']}/seller-accounts/{acc['id']}"
    r = await c.post(f"{base}/sync", headers=h, json={"months": 3})
    assert r.status_code == 202 and r.json()["status"] == "queued" and r.json()["kind"] == "initial"
    assert (await c.post(f"{base}/sync", headers=h)).status_code == 409             # параллельный job запрещён
    job_id = r.json()["id"]
    assert (await c.post(f"{base}/sync-jobs/{job_id}/retry", headers=h)).status_code == 409   # не failed
    assert (await world["mem"][0].post(f"{base}/sync", headers=world["mem"][1])).status_code == 403
    jobs = (await c.get(f"{base}/sync-jobs")).json()
    assert [j["id"] for j in jobs] == [job_id]


async def test_validate_ok_then_rate_limited_then_auth_error(world):
    acc = (await create(world)).json()
    c, h = world["adm"]
    url = f"/api/v1/orgs/{world['a']['id']}/seller-accounts/{acc['id']}/validate"
    r = await c.post(url, headers=h)
    assert r.status_code == 200 and r.json()["valid"] is True
    again = await c.post(url, headers=h)                                             # проверка тоже тратит лимит WB
    assert again.status_code == 429 and "Retry-After" in again.headers and world["fake"].calls == 1

    acc2 = (await create(world, name="Второй")).json()
    world["fake"].error = AuthError("Токен недействителен")
    r2 = await c.post(f"/api/v1/orgs/{world['a']['id']}/seller-accounts/{acc2['id']}/validate", headers=h)
    assert r2.json() == {"valid": False, "message": "Токен недействителен"}
    lst = (await c.get(f"/api/v1/orgs/{world['a']['id']}/seller-accounts")).json()
    assert {a["name"]: a["status"] for a in lst}["Второй"] == "auth_error"
    # синхронизацию нельзя запустить, пока токен не заменён
    sync = await c.post(f"/api/v1/orgs/{world['a']['id']}/seller-accounts/{acc2['id']}/sync", headers=h)
    assert sync.status_code == 409
    rep = await c.put(f"/api/v1/orgs/{world['a']['id']}/seller-accounts/{acc2['id']}/token", headers=h, json={"token": "N" * 30})
    assert rep.status_code == 200 and rep.json()["status"] == "active" and rep.json()["token_hint"] == "NNNN"


async def test_disconnect_wipes_token_and_cancels_jobs(world, maker):
    acc = (await create(world)).json()
    c, h = world["adm"]
    base = f"/api/v1/orgs/{world['a']['id']}/seller-accounts/{acc['id']}"
    job = (await c.post(f"{base}/sync", headers=h)).json()
    assert (await c.delete(base, headers=h)).status_code == 204
    assert (await c.get(f"/api/v1/orgs/{world['a']['id']}/seller-accounts")).json() == []
    assert (await c.post(f"{base}/sync", headers=h)).status_code == 404
    async with maker() as db:
        await set_rls_context(db, org_id=world["a"]["id"])
        tok = (await db.execute(text("SELECT encrypted_token FROM seller_accounts WHERE id=:i"), {"i": acc["id"]})).scalar_one()
        st = (await db.execute(text("SELECT status FROM sync_jobs WHERE id=:i"), {"i": job["id"]})).scalar_one()
    assert tok is None and st == "cancelled"


async def test_admin_sync_jobs_overview_is_platform_admin_only(world):
    acc = (await create(world)).json()
    await world["adm"][0].post(f"/api/v1/orgs/{world['a']['id']}/seller-accounts/{acc['id']}/sync", headers=world["adm"][1])
    c, _, _ = world["admin"]
    r = await c.get("/api/v1/admin/sync-jobs")
    assert r.status_code == 200 and any(j["seller_account_id"] == acc["id"] for j in r.json())
    assert (await world["adm"][0].get("/api/v1/admin/sync-jobs")).status_code == 403
