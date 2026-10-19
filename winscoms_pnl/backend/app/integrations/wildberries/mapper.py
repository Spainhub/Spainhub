"""Wildberries → общая финансовая модель. Правила подтверждены на реальной выгрузке 01–11.07.2026
(см. docs/wb-real-data-findings.md и tests/test_wb_real_data.py).

Принципы: отсутствующее поле — это «нет данных», а не ноль; неизвестная операция не теряется, а получает
статус unclassified; ненулевое денежное поле, не описанное правилами, сохраняется как unmapped:<поле>.
"""
from datetime import date, datetime
from decimal import ROUND_HALF_EVEN, Decimal, InvalidOperation

from app.financial.model import (
    INCONSISTENT, OK, REVIEW, UNCLASSIFIED, Entry, NormalizedRecord,
)

Q = Decimal("0.000001")
TOL_FORPAY = Decimal("0.02")      # retailAmount округлён до рубля → допуск на сверку
TOL_COMMISSION = Decimal("0.05")

OP_SALE = "Продажа"
OP_LOGISTICS = "Логистика"
OP_STORAGE = "Хранение"
OP_ACCEPTANCE = "Обработка товара"
OP_DEDUCTION = "Удержание"
OP_REBILL = "Возмещение издержек по перевозке/по складским операциям с товаром"
ADVERTISING_PREFIX = "Оказание услуг «WB Продвижение»"

LOGISTICS_BY_BONUS = {
    "К клиенту при продаже": "logistics_to_customer_sale",
    "К клиенту при отмене": "logistics_to_customer_cancel",
    "От клиента при отмене": "logistics_from_customer_cancel",
}

# денежные поля, которые могут встретиться в любой строке (для страховки от потерянных сумм)
MONEY_FIELDS = (
    "deliveryService", "paidStorage", "paidAcceptance", "deduction", "penalty", "additionalPayment",
    "rebillLogisticCost", "installmentCofinancingAmount", "cashbackAmount", "cashbackDiscount",
    "cashbackCommissionChange", "ppvzReward", "acquiringFee", "vw", "vwNds", "forPay", "retailPrice",
    "retailAmount", "retailPriceWithDisc",
)
# какие из них нормально присутствуют в строке каждого типа
EXPECTED = {
    OP_SALE: {"retailPrice", "retailAmount", "retailPriceWithDisc", "vw", "vwNds", "ppvzReward", "acquiringFee", "forPay"},
    OP_LOGISTICS: {"deliveryService"},
    OP_STORAGE: {"paidStorage"},
    OP_ACCEPTANCE: {"paidAcceptance"},
    OP_DEDUCTION: {"deduction"},
    OP_REBILL: {"rebillLogisticCost", "vw", "vwNds"},
}


class _Reader:
    def __init__(self, payload: dict, issues: list[str]) -> None:
        self.p, self.issues = payload, issues

    def num(self, key: str) -> Decimal | None:
        v = self.p.get(key)
        if v is None or v == "":
            return None
        if isinstance(v, bool):
            self.issues.append(f"bad_number:{key}")
            return None
        try:
            return Decimal(str(v).strip())          # str(float) даёт исходную десятичную запись
        except InvalidOperation:
            self.issues.append(f"bad_number:{key}")
            return None

    def text(self, key: str) -> str | None:
        v = self.p.get(key)
        return None if v is None or v == "" else str(v)

    def integer(self, key: str) -> int | None:
        v = self.p.get(key)
        return v if isinstance(v, int) and not isinstance(v, bool) else None

    def day(self, key: str) -> date | None:
        v = self.p.get(key)
        if not v:
            return None
        try:
            return datetime.fromisoformat(str(v).replace("Z", "+00:00")).date()
        except ValueError:
            self.issues.append(f"bad_date:{key}")
            return None


def _q(x: Decimal) -> Decimal:
    return x.quantize(Q, rounding=ROUND_HALF_EVEN)


def normalize(payload: dict) -> NormalizedRecord:
    """Никогда не бросает исключений: ошибки превращаются в issues и статус записи."""
    issues: list[str] = []
    try:
        r = _Reader(payload, issues)
        op = r.text("sellerOperName")
        rec = NormalizedRecord(
            category="unclassified", status=UNCLASSIFIED, issues=issues,
            entry_date=r.day("rrDate"), currency=r.text("currency"), nm_id=r.integer("nmId") or None,
            vendor_code=r.text("vendorCode"), sku=r.text("sku"), product_name=r.text("title"), brand=r.text("brandName"),
            quantity=r.integer("quantity"), source_operation=op, doc_type=r.text("docTypeName"),
            bonus_type=r.text("bonusTypeName"),
            source_report_id=None if payload.get("reportId") is None else str(payload.get("reportId")),
            srid=r.text("srid"), order_id=r.integer("orderId"),
        )
        if rec.entry_date is None:
            issues.append("missing_date:rrDate")
        if rec.currency is None:
            issues.append("missing_field:currency")

        handler = {
            OP_SALE: _sale, OP_LOGISTICS: _logistics, OP_STORAGE: _simple("storage", "paidStorage"),
            OP_ACCEPTANCE: _simple("acceptance", "paidAcceptance"), OP_DEDUCTION: _deduction, OP_REBILL: _rebill,
        }.get(op or "")
        if handler is None:
            issues.append(f"unknown_operation:{op}")
            if rec.entry_date is not None and rec.currency is not None:
                _capture_unmapped(r, rec, set())     # суммы неизвестной операции не теряем, но статус остаётся unclassified
            return rec
        handler(r, rec)

        _capture_unmapped(r, rec, EXPECTED[op])
        if rec.entry_date is None or rec.currency is None:
            rec.status, rec.entries = INCONSISTENT, []        # без даты/валюты суммы нельзя отнести к периоду
        elif any(i.startswith(("missing_field", "bad_number", "bad_date", "for_pay_mismatch", "commission_mismatch")) for i in issues):
            rec.status = INCONSISTENT
        elif any(i.startswith(("pending_policy", "unmapped", "unknown_bonus", "sale_quantity", "sale_doc_type")) for i in issues):
            rec.status = REVIEW
        else:
            rec.status = OK
        return rec
    except Exception as e:                                      # страховка: нормализатор не должен ронять синхронизацию
        return NormalizedRecord(category="unclassified", status=UNCLASSIFIED, issues=[f"normalizer_error:{type(e).__name__}"])


def _add(rec: NormalizedRecord, line_type: str, amount: Decimal | None) -> None:
    if amount is not None:
        rec.entries.append(Entry(line_type, _q(amount)))


def _sale(r: _Reader, rec: NormalizedRecord) -> None:
    rec.category = "sale"
    need = ("retailPrice", "retailPriceWithDisc", "retailAmount", "commissionPercent", "vw", "vwNds", "ppvzReward", "acquiringFee", "forPay")
    v = {k: r.num(k) for k in need}
    for k, val in v.items():
        if val is None:
            rec.issues.append(f"missing_field:{k}")
    if rec.doc_type != "Продажа":
        rec.issues.append(f"sale_doc_type:{rec.doc_type}")
    if rec.quantity != 1:
        rec.issues.append(f"sale_quantity:{rec.quantity}")   # количество ≠ 1 не встречалось — формулу не проверяли

    _add(rec, "sale_revenue", v["retailPriceWithDisc"])
    _add(rec, "sale_buyer_amount", v["retailAmount"])
    _add(rec, "acquiring", v["acquiringFee"])
    _add(rec, "for_pay", v["forPay"])
    _add(rec, "commission_vat", v["vwNds"])
    if v["retailPrice"] is not None and v["retailAmount"] is not None:
        _add(rec, "spp_compensation", v["retailPrice"] - v["retailAmount"])
    if all(v[k] is not None for k in ("retailPrice", "retailAmount", "vw", "vwNds", "ppvzReward")):
        spp = v["retailPrice"] - v["retailAmount"]
        gross = v["vw"] + v["vwNds"] + v["ppvzReward"] + spp
        _add(rec, "commission_gross", gross)
        if v["commissionPercent"] is not None:
            nominal = v["retailPrice"] * v["commissionPercent"] / 100
            if abs(gross - nominal) > TOL_COMMISSION:
                rec.issues.append("commission_mismatch")
    if all(v[k] is not None for k in ("retailAmount", "acquiringFee", "vw", "vwNds", "ppvzReward", "forPay")):
        expected = v["retailAmount"] - v["acquiringFee"] - v["vw"] - v["vwNds"] - v["ppvzReward"]
        if abs(v["forPay"] - expected) > TOL_FORPAY:
            rec.issues.append("for_pay_mismatch")


def _logistics(r: _Reader, rec: NormalizedRecord) -> None:
    rec.category = "logistics"
    line = LOGISTICS_BY_BONUS.get(rec.bonus_type or "")
    if line is None:
        line = "logistics_other"
        rec.issues.append(f"unknown_bonus_type:{rec.bonus_type}")
    amount = r.num("deliveryService")
    if amount is None:
        rec.issues.append("missing_field:deliveryService")
    _add(rec, line, amount)


def _simple(line_type: str, field_name: str):
    def handler(r: _Reader, rec: NormalizedRecord) -> None:
        rec.category = line_type
        amount = r.num(field_name)
        if amount is None:
            rec.issues.append(f"missing_field:{field_name}")
        _add(rec, line_type, amount)
    return handler


def _deduction(r: _Reader, rec: NormalizedRecord) -> None:
    advertising = (rec.bonus_type or "").startswith(ADVERTISING_PREFIX)
    rec.category = "advertising" if advertising else "deduction_other"
    amount = r.num("deduction")
    if amount is None:
        rec.issues.append("missing_field:deduction")
    _add(rec, rec.category, amount)


def _rebill(r: _Reader, rec: NormalizedRecord) -> None:
    """Направление (доход/расход) по данным не определяется: vw+vwNds+rebillLogisticCost = 0 в каждой строке.
    Суммы сохраняются, запись помечается review до решения по политике (см. findings §3)."""
    rec.category = "rebill"
    cost, vw, nds = r.num("rebillLogisticCost"), r.num("vw"), r.num("vwNds")
    if cost is None:
        rec.issues.append("missing_field:rebillLogisticCost")
    _add(rec, "rebill_logistics_cost", cost)
    if vw is not None and nds is not None:
        _add(rec, "rebill_commission_credit", vw + nds)
    rec.issues.append("pending_policy:rebill")


def _capture_unmapped(r: _Reader, rec: NormalizedRecord, expected: set[str]) -> None:
    """Ненулевое денежное поле вне правил не теряется: сохраняется как unmapped:<поле>."""
    for key in MONEY_FIELDS:
        if key in expected:
            continue
        val = r.num(key)
        if val is not None and val != 0:
            _add(rec, f"unmapped:{key}", val)
            rec.issues.append(f"unmapped:{key}")
