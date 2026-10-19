"""Общая (не зависящая от маркетплейса) финансовая модель.

Адаптеры маркетплейсов превращают свои ответы в NormalizedRecord. Движок P&L работает только с
financial_entries (line_type + amount) и ничего не знает про поля Wildberries.

Знак: сумма хранится так, как её понимает line_type (см. LINE_TYPES). Расходные типы положительны, когда
это расход; отрицательное значение — кредит (например, комиссия при большой компенсации СПП).
Деньги — только Decimal; в БД NUMERIC(20,6).
"""
from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal

NORMALIZER_VERSION = 1

# status записи
OK = "ok"                    # классифицирована, проверки сошлись
REVIEW = "review"            # суммы сохранены, но смысл/знак не подтверждён политикой или данными
INCONSISTENT = "inconsistent"  # не хватает полей или не сошлась арифметика
UNCLASSIFIED = "unclassified"  # тип операции неизвестен — сумм (entries) нет

# nature: как P&L вправе использовать line_type
REVENUE, EXPENSE, INFO, PENDING = "revenue", "expense", "info", "pending"

LINE_TYPES: dict[str, str] = {
    # продажи
    "sale_revenue": REVENUE,          # retailPriceWithDisc
    "commission_gross": EXPENSE,      # vw + vwNds + ppvzReward + компенсация СПП = retailPrice × commissionPercent
    "acquiring": EXPENSE,             # acquiringFee
    "sale_buyer_amount": INFO,        # retailAmount (цена покупателя после СПП)
    "spp_compensation": INFO,         # retailPrice − retailAmount (компенсация WB, уже учтена в commission_gross)
    "commission_vat": INFO,           # vwNds (часть комиссии)
    "for_pay": INFO,                  # forPay — для сверки с выплатами, не выручка и не прибыль
    # расходы маркетплейса
    "logistics_to_customer_sale": EXPENSE,
    "logistics_to_customer_cancel": EXPENSE,
    "logistics_from_customer_cancel": EXPENSE,
    "logistics_other": EXPENSE,
    "storage": EXPENSE,
    "acceptance": EXPENSE,
    "advertising": EXPENSE,           # удержание «WB Продвижение»
    "deduction_other": EXPENSE,
    # требуют решения политики / подтверждения знака
    "rebill_logistics_cost": PENDING,
    "rebill_commission_credit": PENDING,
    "penalty": PENDING,
    "additional_payment": PENDING,
}
# неописанные денежные поля сохраняются как "unmapped:<поле>" с nature=PENDING


def nature_of(line_type: str) -> str:
    return LINE_TYPES.get(line_type, PENDING)


@dataclass
class Entry:
    line_type: str
    amount: Decimal


@dataclass
class NormalizedRecord:
    category: str
    status: str
    issues: list[str] = field(default_factory=list)
    entries: list[Entry] = field(default_factory=list)
    entry_date: date | None = None
    currency: str | None = None
    nm_id: int | None = None
    vendor_code: str | None = None
    sku: str | None = None
    product_name: str | None = None
    brand: str | None = None
    quantity: int | None = None
    source_operation: str | None = None
    doc_type: str | None = None
    bonus_type: str | None = None
    source_report_id: str | None = None
    srid: str | None = None
    order_id: int | None = None
