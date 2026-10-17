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
