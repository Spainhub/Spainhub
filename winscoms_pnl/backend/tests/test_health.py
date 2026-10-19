from fastapi.testclient import TestClient

from app.db.session import get_session
from app.main import create_app


class _OkSession:
    async def execute(self, *_a, **_k):
        return None


class _BrokenSession:
    async def execute(self, *_a, **_k):
        raise ConnectionError("db down")


def _client(session_cls) -> TestClient:
    app = create_app()

    async def override():
        yield session_cls()

    app.dependency_overrides[get_session] = override
    return TestClient(app)


def test_liveness():
    r = _client(_OkSession).get("/api/v1/health")
    assert r.status_code == 200 and r.json() == {"status": "ok"}


def test_readiness_ok():
    r = _client(_OkSession).get("/api/v1/health/ready")
    assert r.status_code == 200 and r.json()["database"] == "up"


def test_readiness_db_down_returns_503():
    r = _client(_BrokenSession).get("/api/v1/health/ready")
    assert r.status_code == 503 and r.json()["database"] == "down"


def test_unhandled_error_returns_request_id_without_internals(caplog):
    app = create_app()

    async def broken():
        raise RuntimeError("secret internal detail: password=hunter2")
        yield  # pragma: no cover

    app.dependency_overrides[get_session] = broken
    client = TestClient(app, raise_server_exceptions=False)
    with caplog.at_level("ERROR"):
        r = client.get("/api/v1/auth/me", cookies={"wc_session": "x"})
    body = r.json()
    assert r.status_code == 500 and body["detail"] == "Внутренняя ошибка сервера"
    assert len(body["request_id"]) == 12 and r.headers["X-Request-ID"] == body["request_id"]
    assert "hunter2" not in r.text and "Traceback" not in r.text            # наружу — только код
    assert any(getattr(rec, "ctx", {}).get("request_id") == body["request_id"] for rec in caplog.records)   # в логе тот же код
