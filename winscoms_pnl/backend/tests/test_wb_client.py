import json
from datetime import date
from pathlib import Path

import httpx
import pytest

from app.core import crypto
from app.core.config import Settings
from app.integrations.errors import (
    AuthError, BadRequest, ParseError, PaymentRequired, RateLimited, TemporaryError,
)
from app.integrations.wildberries.client import ENDPOINT_PATH, WildberriesClient
from app.jobs.periods import daily_period, initial_period

SAMPLE = json.loads((Path(__file__).parent / "fixtures" / "wb_sample.json").read_text(encoding="utf-8"))
TOKEN = "SECRET-TOKEN-value-1234567890"


def make_client(handler):
    return WildberriesClient(httpx.AsyncClient(transport=httpx.MockTransport(handler)))


async def fetch(client, cursor=0):
    return await client.fetch_page(TOKEN, date_from=date(2026, 3, 1), date_to=date(2026, 3, 31), cursor=cursor, limit=1000)


async def test_200_returns_records_and_sends_token_only_in_header():
    seen = {}

    def handler(req: httpx.Request):
        seen["req"] = req
        return httpx.Response(200, json=SAMPLE)

    page = await fetch(make_client(handler), cursor=0)
    req = seen["req"]
    assert req.method == "POST" and req.url.path == ENDPOINT_PATH
    assert req.headers["Authorization"] == TOKEN
    body = json.loads(req.content)
    assert body == {"dateFrom": "2026-03-01", "dateTo": "2026-03-31", "limit": 1000, "rrdId": 0, "period": "daily"}
    assert TOKEN not in req.content.decode() and str(req.url).find(TOKEN) == -1
    assert len(page.records) == 1 and not page.is_end


async def test_204_means_end_of_data():
    page = await fetch(make_client(lambda r: httpx.Response(204)))
    assert page.is_end and page.records == []


@pytest.mark.parametrize("status,exc", [
    (400, BadRequest), (401, AuthError), (402, PaymentRequired), (403, AuthError),
    (429, RateLimited), (500, TemporaryError), (503, TemporaryError),
])
async def test_status_mapping_and_messages_have_no_secrets(status, exc):
    with pytest.raises(exc) as ei:
        await fetch(make_client(lambda r: httpx.Response(status, text=f"echo {TOKEN}")))
    assert TOKEN not in ei.value.message


async def test_429_uses_retry_after_header():
    with pytest.raises(RateLimited) as ei:
        await fetch(make_client(lambda r: httpx.Response(429, headers={"Retry-After": "42"})))
    assert ei.value.retry_after == 42.0
    with pytest.raises(RateLimited) as ei:
        await fetch(make_client(lambda r: httpx.Response(429, headers={"X-Ratelimit-Retry": "7"})))
    assert ei.value.retry_after == 7.0


async def test_bad_payloads_are_parse_errors():
    for resp in (httpx.Response(200, text="<html>"), httpx.Response(200, json={"a": 1}), httpx.Response(200, json=[1, 2])):
        with pytest.raises(ParseError):
            await fetch(make_client(lambda r, resp=resp: resp))


async def test_network_errors_are_temporary():
    def boom(req):
        raise httpx.ConnectError("down")

    with pytest.raises(TemporaryError):
        await fetch(make_client(boom))

    def slow(req):
        raise httpx.ReadTimeout("slow")

    with pytest.raises(TemporaryError):
        await fetch(make_client(slow))


def test_record_id_requires_integer_rrd_id():
    c = make_client(lambda r: httpx.Response(204))
    assert c.record_id(SAMPLE[0]) == 1232610467
    for bad in ({}, {"rrdId": "123"}, {"rrdId": None}, {"rrdId": True}):
        with pytest.raises(ParseError):
            c.record_id(bad)


async def test_validate_accepts_200_and_204_rejects_auth():
    await make_client(lambda r: httpx.Response(204)).validate(TOKEN)
    await make_client(lambda r: httpx.Response(200, json=[])).validate(TOKEN)
    with pytest.raises(AuthError):
        await make_client(lambda r: httpx.Response(401)).validate(TOKEN)


def test_sample_money_fields_are_strings_and_parse_as_decimal():
    """Фиксируем наблюдение: деньги приходят строками — дальше только Decimal, никакого float."""
    from decimal import Decimal
    assert isinstance(SAMPLE[0]["retailPriceWithDisc"], str)
    assert Decimal(SAMPLE[0]["retailPriceWithDisc"]) == Decimal("399.68")


def test_periods():
    assert initial_period(3, date(2026, 10, 19)) == (date(2026, 7, 1), date(2026, 10, 19))
    assert initial_period(3, date(2026, 2, 10)) == (date(2025, 11, 1), date(2026, 2, 10))
    assert initial_period(1, date(2026, 1, 5)) == (date(2025, 12, 1), date(2026, 1, 5))
    assert daily_period(date(2026, 10, 19)) == (date(2026, 10, 12), date(2026, 10, 19))


def test_crypto_roundtrip_rotation_and_wrong_key(monkeypatch):
    from cryptography.fernet import Fernet
    k1, k2, k3 = (Fernet.generate_key().decode() for _ in range(3))

    def use(keys):
        monkeypatch.setattr(crypto, "get_settings", lambda: Settings(_env_file=None, encryption_keys=keys))

    use(k1)
    blob = crypto.encrypt(TOKEN)
    assert TOKEN.encode() not in blob and crypto.decrypt(blob) == TOKEN
    use(f"{k2},{k1}")                      # ротация: новый ключ первым, старый остаётся для чтения
    assert crypto.decrypt(blob) == TOKEN
    use(k3)
    with pytest.raises(crypto.DecryptionError):
        crypto.decrypt(blob)
