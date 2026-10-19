"""Движок управленческого P&L: чистые функции над агрегатами, без БД и без знания о маркетплейсах.

Правила (подробно в docs/pnl-engine.md):
  * Деньги — Decimal. Листья округляются до копеек (ROUND_HALF_UP), подтоги считаются из округлённых листьев,
    поэтому отчёт «сходится» сам с собой.
  * Нет данных ≠ 0. Ручная строка без записей — статус 'missing'. Импортируемая строка без данных за период — 'missing',
    а при наличии данных и отсутствии операций — честный 0.
  * Если обязательный вход отсутствует, строка получает value=None, status='blocked' и показывает preliminary
    (расчёт при допущении 0 для недостающего) только как справку.
"""
from dataclasses import dataclass, field
from decimal import ROUND_HALF_UP, Decimal

from app.financial.pl_template import TEMPLATE, LineSpec, validate_template

ZERO = Decimal("0")
CENT = Decimal("0.01")
OK, INCOMPLETE, MISSING, BLOCKED, HEADER, NA = "ok", "incomplete", "missing", "blocked", "header", "not_applicable"
_BAD = (MISSING, BLOCKED)
_RANK = {OK: 0, HEADER: 0, NA: 0, INCOMPLETE: 1, MISSING: 2, BLOCKED: 3}


def r2(x: Decimal) -> Decimal:
    return x.quantize(CENT, rounding=ROUND_HALF_UP)


@dataclass
class Settings:
    regime: str                      # usn_income | osno
    usn_rate: Decimal = Decimal("6")
    profit_tax_rate: Decimal = Decimal("20")
    vat_sales_rate: Decimal = Decimal("22")
    vat_services_rate: Decimal = Decimal("22")


@dataclass
class CogsInput:
    amount: Decimal = ZERO
    units_total: int = 0
    units_costed: int = 0
    missing_nm_ids: list[int] = field(default_factory=list)


@dataclass
class PeriodInputs:
    key: str
    has_import_data: bool = False                                 # были ли импортированные строки в периоде
    imports: dict[str, Decimal] = field(default_factory=dict)     # line_type → сумма
    manual: dict[str, tuple[Decimal, int]] = field(default_factory=dict)   # category → (сумма, число записей)
    cogs: CogsInput = field(default_factory=CogsInput)
    import_issues: int = 0                                        # строк inconsistent + unclassified (не unmapped/review)
    unclassified_money: bool = False                              # есть суммы вне правил (unmapped:*) или неподтверждённые типы


@dataclass
class LineResult:
    id: str
    value: Decimal | None
    status: str
    preliminary: Decimal | None = None
    notes: list[str] = field(default_factory=list)
    contributions: list[dict] = field(default_factory=list)


def _worst(statuses) -> str:
    return max(statuses, key=lambda s: _RANK[s], default=OK)


def compute_period(inp: PeriodInputs, cfg: Settings, template: tuple[LineSpec, ...] = TEMPLATE) -> dict[str, LineResult]:
    res: dict[str, LineResult] = {}
    gross: dict[str, Decimal] = {}          # сумма услуги с НДС до выделения (для справки по НДС)
    children: dict[str, list[LineSpec]] = {}
    optional = {s.id for s in template if s.optional}
    active = [s for s in template if s.active and (s.regimes is None or cfg.regime in s.regimes)]
    for s in active:
        children.setdefault(s.parent or "", []).append(s)

    def vat_net(amount: Decimal, rate: Decimal) -> Decimal:
        return r2(amount / (1 + rate / 100))

    by_id = {s.id: s for s in active}

    def deps(s: LineSpec) -> list[str]:
        if s.kind == "group":
            return [k.id for k in children.get(s.id, []) if k.in_totals]
        if s.kind == "formula":
            return [i for _, i in s.terms if i in by_id]
        if s.kind == "ratio":
            return list(s.terms)
        if s.id == "tax_usn":
            return ["sales_gross"]
        if s.id == "tax_profit":
            return ["pbt"]
        if s.id == "vat_input_services":
            return [x.id for x in active if x.vat == "services"]
        return []

    def evaluate(s: LineSpec) -> None:
        if s.id in res:
            return
        for d in deps(s):
            evaluate(by_id[d])
        r = LineResult(s.id, None, OK)
        if s.kind == "header":
            r.status = HEADER

        elif s.kind == "imported":
            if not inp.has_import_data:
                r.status, r.notes = MISSING, ["Нет импортированных данных за период"]
            else:
                if s.id == "wb_payout_estimate":
                    parts = {k: inp.imports.get(k, ZERO) for k in inp.imports}
                    spend = sum((parts.get(k, ZERO) for k in (
                        "logistics_to_customer_sale", "logistics_to_customer_cancel", "logistics_from_customer_cancel",
                        "logistics_other", "storage", "acceptance", "advertising", "deduction_other")), ZERO)
                    amount = parts.get("for_pay", ZERO) - spend
                    r.contributions = [{"source": "import", "line_type": "for_pay", "amount": str(parts.get("for_pay", ZERO))}]
                elif s.id == "vat_input_services":
                    amount = ZERO
                else:
                    amount = sum((inp.imports.get(t, ZERO) for t in s.line_types), ZERO)
                    r.contributions = [{"source": "import", "line_type": t, "amount": str(inp.imports[t])}
                                       for t in s.line_types if t in inp.imports]
                if s.vat == "sales" and cfg.regime == "osno":
                    r.value = r2(amount * cfg.vat_sales_rate / (100 + cfg.vat_sales_rate))
                elif s.vat == "services" and cfg.regime == "osno":
                    gross[s.id] = r2(amount)
                    r.value = vat_net(amount, cfg.vat_services_rate)
                    r.notes.append(f"без НДС {cfg.vat_services_rate}%")
                else:
                    r.value = r2(amount)
                if inp.import_issues and s.id not in ("returns", "penalties") and s.line_types:
                    r.status = INCOMPLETE
                    r.notes.append(f"В импорте {inp.import_issues} строк с ошибками/неизвестным типом")
                if s.id in ("returns", "penalties"):
                    r.value = ZERO
                    if inp.import_issues or inp.unclassified_money:
                        r.status = INCOMPLETE
                        r.notes.append("Есть неклассифицированные операции — возможны возвраты/штрафы")
                    else:
                        r.notes.append("Операций этого типа в импортированных данных нет")

        elif s.kind == "manual":
            amount, count = inp.manual.get(s.category, (ZERO, 0))
            if count == 0:
                r.status = MISSING
                r.notes = ["Нет записей — принято как «отсутствует» (введите 0, чтобы подтвердить явно)"] if s.optional \
                    else ["Нет записей: введите сумму (в т.ч. 0)"]
            else:
                r.value = r2(amount)
                r.contributions = [{"source": "manual", "category": s.category, "amount": str(amount), "entries": count}]

        elif s.kind == "cogs":
            c = inp.cogs
            if c.units_total == 0:
                r.value = ZERO
                r.notes.append("Продаж с учётом товара в периоде нет")
            elif c.units_costed == c.units_total:
                r.value = r2(c.amount)
            else:
                r.status, r.preliminary = BLOCKED, r2(c.amount)
                r.notes.append(f"Нет себестоимости для {c.units_total - c.units_costed} из {c.units_total} шт. "
                               f"(nmId: {', '.join(map(str, c.missing_nm_ids[:20]))}{'…' if len(c.missing_nm_ids) > 20 else ''})")
            r.contributions = [{"source": "costs", "units": c.units_total, "units_without_cost": c.units_total - c.units_costed}]

        elif s.kind == "tax":
            if s.id == "tax_usn":
                base = res["sales_gross"]
                if base.status in _BAD:
                    r.status = BLOCKED
                else:
                    r.value = r2(base.value * cfg.usn_rate / 100)
                    r.status = base.status
                    r.notes.append(f"{cfg.usn_rate}% от продаж")
            else:  # tax_profit
                base = res["pbt"]
                if base.value is None:
                    r.status, r.preliminary = BLOCKED, (r2(max(base.preliminary, ZERO) * cfg.profit_tax_rate / 100) if base.preliminary is not None else None)
                else:
                    r.value = r2(max(base.value, ZERO) * cfg.profit_tax_rate / 100)
                    r.status = base.status
                    r.notes.append(f"{cfg.profit_tax_rate}% от прибыли до налогов" + ("; убыток → налог 0" if base.value < 0 else ""))

        elif s.kind == "group":
            kids = [k for k in children.get(s.id, []) if k.in_totals]
            kr = [res[k.id] for k in kids]
            if s.confirm:
                manual_ids = [k.id for k in kids if k.kind == "manual"]
                if manual_ids and all(res[i].status == MISSING for i in manual_ids):
                    r.status = MISSING
                    r.notes.append("Группа не подтверждена: введите хотя бы одну запись (можно 0)")
            # недостающая ручная строка внутри подтверждённой группы или групп без confirm — не считается нулём молча
            known = [x for x in kr if x.value is not None]
            r.preliminary = r2(sum((x.value if x.value is not None else (x.preliminary or ZERO) for x in kr), ZERO))
            if r.status != MISSING:
                bad = [x for x in kr if x.status in _BAD]
                inc = [x for x in kr if x.status == INCOMPLETE]
                if any(x.status == BLOCKED for x in bad):
                    r.status = BLOCKED
                else:
                    r.value = r2(sum((x.value for x in known), ZERO))
                    miss = [x.id for x in kr if x.status == MISSING and x.id not in optional]
                    if miss and not s.confirm:
                        r.status = INCOMPLETE
                        r.notes.append("Нет данных по строкам: " + ", ".join(by_id[i].name for i in miss))
                    elif inc or (miss and s.confirm):
                        r.status = INCOMPLETE
                    opt_missing = [x.id for x in kr if x.status == MISSING and x.id in optional]
                    if opt_missing and r.status == OK:
                        r.notes.append("Нет записей (принято как «отсутствует»): " + ", ".join(by_id[i].name for i in opt_missing))
            if r.status in (MISSING, BLOCKED):
                r.value = None
            r.contributions = [{"source": "child", "line": x.id, "amount": None if x.value is None else str(x.value)} for x in kr]

        elif s.kind == "formula":
            terms = [(sg, res[i]) for sg, i in s.terms if i in res]
            skipped = [x.id for _, x in terms if x.status == MISSING and x.id in optional]
            terms = [(sg, x) for sg, x in terms if x.id not in skipped]
            bad = [x.id for _, x in terms if x.status in _BAD]
            r.preliminary = sum((sg * (x.value if x.value is not None else (x.preliminary or ZERO)) for sg, x in terms), ZERO)
            r.preliminary = r2(r.preliminary)
            if bad:
                r.status = BLOCKED
                r.notes.append("Нет данных для расчёта: " + ", ".join(by_id[i].name for i in bad))
            else:
                r.value = r2(sum((sg * x.value for sg, x in terms), ZERO))
                r.status = _worst([x.status for _, x in terms])
            if skipped:
                r.notes.append("Не заданы (принято как «отсутствует»): " + ", ".join(by_id[i].name for i in skipped))
            if s.id == "vat_payable" and r.value is not None:
                r.notes.append("Оценка: ставка НДС в услугах WB принята одинаковой; часть услуг может быть без НДС")
            r.contributions = [{"source": "formula", "sign": sg, "line": x.id} for sg, x in terms]

        elif s.kind == "ratio":
            num, den = res[s.terms[0]], res[s.terms[1]]
            if num.value is None or den.value is None:
                r.status = BLOCKED
            elif den.value == 0:
                r.status, r.notes = NA, ["Деление на 0: нет выручки"]
            else:
                r.value = (num.value / den.value * 100).quantize(CENT, rounding=ROUND_HALF_UP)
                r.status = _worst([num.status, den.status])

        if s.id == "vat_input_services" and cfg.regime == "osno":
            deltas = [gross[k] - res[k].value for k in gross if k in res and res[k].value is not None]
            r.value = r2(sum(deltas, ZERO)) if inp.has_import_data else None
            r.status = OK if inp.has_import_data else MISSING
            if inp.has_import_data and inp.import_issues:
                r.status = INCOMPLETE
        res[s.id] = r

    for s in active:
        evaluate(s)
    return res


def build_report(periods: list[PeriodInputs], total: PeriodInputs, cfg: Settings,
                 template: tuple[LineSpec, ...] = TEMPLATE) -> dict:
    """Колонки по периодам + итоговая колонка, рассчитанная по суммарным входам (а не суммой колонок:
    налог на прибыль с убытком в одном месяце не равен сумме месячных налогов)."""
    validate_template(template)
    cols = {p.key: compute_period(p, cfg, template) for p in periods}
    cols["total"] = compute_period(total, cfg, template)
    lines = []
    active = [s for s in template if s.active and (s.regimes is None or cfg.regime in s.regimes)]
    depth = {}
    for s in active:
        depth[s.id] = 0 if s.parent is None else depth.get(s.parent, 0) + 1
        lines.append({
            "id": s.id, "name": s.name, "parent": s.parent, "level": depth[s.id], "kind": s.kind,
            "memo": s.memo, "note": s.note,
            "values": {k: _dump(c[s.id]) for k, c in cols.items() if s.id in c},
        })
    return {"periods": [p.key for p in periods] + ["total"], "lines": lines}


def _dump(r: LineResult) -> dict:
    return {
        "value": None if r.value is None else str(r.value),
        "preliminary": None if r.preliminary is None else str(r.preliminary),
        "status": r.status, "notes": r.notes, "contributions": r.contributions,
    }
