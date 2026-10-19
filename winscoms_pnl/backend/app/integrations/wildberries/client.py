"""Клиент Wildberries: отчёт о продажах по реализации.

ПОДТВЕРЖДЕНО заказчиком: POST https://finance-api.wildberries.ru/api/finance/v1/sales-reports/detailed,
заголовок Authorization: <token>, параметры dateFrom, dateTo, limit (до 100000), rrdId, period.
Первый запрос rrdId=0, следующие — rrdId последней записи, конец — HTTP 204.

НЕ ПОДТВЕРЖДЕНО по официальной документации (она недоступна из среды разработки) — проверить
на первом реальном запросе, все эти места собраны в build_body() и _parse():
  * формат dateFrom/dateTo (здесь ISO-даты YYYY-MM-DD, как поля dateFrom/dateTo в ответе);
  * допустимые значения period (здесь settings.wb_report_period);
  * что тело ответа — JSON-массив объектов (как в присланном примере);
  * смысл HTTP 402.
"""
import logging
from datetime import date

import httpx

from app.core.config import get_settings
from app.integrations.base import Page
from app.integrations.errors import (
    AuthError, BadRequest, MarketplaceError, ParseError, PaymentRequired, RateLimited, TemporaryError,
)

log = logging.getLogger("winscoms.wb")

ENDPOINT_PATH = "/api/finance/v1/sales-reports/detailed"


def _retry_after(resp: httpx.Response) -> float | None:
    for h in ("Retry-After", "X-Ratelimit-Retry"):
        v = resp.headers.get(h)
        if v:
            try:
                return max(0.0, float(v))
            except ValueError:
                pass
    return None


class WildberriesClient:
    source_endpoint = "wb:sales-reports/detailed"

    def __init__(self, http: httpx.AsyncClient | None = None) -> None:
        cfg = get_settings()
        self._base = cfg.wb_finance_api_url.rstrip("/")
        self._period = cfg.wb_report_period
        self._http = http or httpx.AsyncClient(timeout=cfg.wb_request_timeout_seconds)

    def build_body(self, *, date_from: date, date_to: date, cursor: int, limit: int) -> dict:
        return {
            "dateFrom": date_from.isoformat(),
            "dateTo": date_to.isoformat(),
            "limit": limit,
            "rrdId": cursor,
            "period": self._period,
        }

    async def _post(self, token: str, body: dict) -> httpx.Response:
        try:
            # token передаётся только в заголовке и нигде не логируется
            return await self._http.post(self._base + ENDPOINT_PATH, json=body, headers={"Authorization": token})
        except httpx.TimeoutException as e:
            raise TemporaryError("Таймаут запроса к Wildberries") from e
        except httpx.HTTPError as e:
            raise TemporaryError("Сетевая ошибка при обращении к Wildberries") from e

    @staticmethod
    def _error_for(resp: httpx.Response) -> MarketplaceError:
        s = resp.status_code
        if s == 400:
            return BadRequest("Wildberries отклонил параметры запроса (400). Проверьте период и параметры.")
        if s == 401:
            return AuthError("Токен недействителен или просрочен (401). Выпустите новый токен и подключите заново.")
        if s == 402:
            return PaymentRequired("Wildberries вернул 402 (требуется оплата/подписка). Уточните статус доступа в кабинете WB.")
        if s == 403:
            return AuthError("Нет доступа (403): у токена нет права на категорию «Финансы» или он другого типа.")
        if s == 429:
            return RateLimited("Превышен лимит запросов Wildberries (429). Повтор будет позже.", retry_after=_retry_after(resp))
        if s >= 500:
            return TemporaryError(f"Временная ошибка Wildberries ({s}). Повтор будет позже.")
        return BadRequest(f"Неожиданный ответ Wildberries ({s}).")

    @staticmethod
    def _parse(resp: httpx.Response) -> list[dict]:
        try:
            data = resp.json()
        except ValueError as e:
            raise ParseError("Ответ Wildberries не является JSON") from e
        if not isinstance(data, list) or not all(isinstance(x, dict) for x in data):
            raise ParseError("Ответ Wildberries имеет неожиданную структуру (ожидался массив объектов)")
        return data

    def record_id(self, record: dict) -> int:
        rid = record.get("rrdId")
        if isinstance(rid, bool) or not isinstance(rid, int):
            raise ParseError("В записи Wildberries нет числового rrdId — дедупликация невозможна")
        return rid

    async def fetch_page(self, token: str, *, date_from: date, date_to: date, cursor: int, limit: int) -> Page:
        resp = await self._post(token, self.build_body(date_from=date_from, date_to=date_to, cursor=cursor, limit=limit))
        log.info("wb response", extra={"ctx": {"status": resp.status_code, "cursor": cursor}})
        if resp.status_code == 204:
            return Page(records=[])
        if resp.status_code != 200:
            raise self._error_for(resp)
        return Page(records=self._parse(resp))

    async def validate(self, token: str) -> None:
        """Проверка токена одним минимальным запросом (расходует лимит так же, как обычный)."""
        d = date.today()
        resp = await self._post(token, self.build_body(date_from=d, date_to=d, cursor=0, limit=1))
        if resp.status_code in (200, 204):
            return
        raise self._error_for(resp)

    async def aclose(self) -> None:
        await self._http.aclose()


def get_wb_client() -> WildberriesClient:
    """Фабрика клиента (зависимость FastAPI; в тестах подменяется)."""
    return WildberriesClient()
