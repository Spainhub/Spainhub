from collections.abc import Callable

from app.financial.model import NormalizedRecord
from app.integrations.wildberries import mapper as wb_mapper

# source_endpoint сырой записи → функция нормализации. Новый маркетплейс = новая строка здесь + свой mapper.
NORMALIZERS: dict[str, Callable[[dict], NormalizedRecord]] = {
    "wb:sales-reports/detailed": wb_mapper.normalize,
}
