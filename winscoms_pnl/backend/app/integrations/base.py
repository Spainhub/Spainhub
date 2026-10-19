from dataclasses import dataclass
from datetime import date
from typing import Protocol


@dataclass(frozen=True)
class Page:
    records: list[dict]          # пустой список = конец данных (для WB — HTTP 204)

    @property
    def is_end(self) -> bool:
        return not self.records


class SalesReportClient(Protocol):
    """Интерфейс адаптера маркетплейса для загрузки финансовых отчётов.

    Движок P&L не знает про форматы конкретных маркетплейсов: он работает с нормализованными
    записями, а адаптеры отвечают за запросы, пагинацию и разбор ответов.
    """

    source_endpoint: str

    async def validate(self, token: str) -> None: ...

    async def fetch_page(self, token: str, *, date_from: date, date_to: date, cursor: int, limit: int) -> Page: ...

    def record_id(self, record: dict) -> int: ...
