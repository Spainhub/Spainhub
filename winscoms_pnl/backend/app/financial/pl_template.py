"""Структура управленческого P&L как ДАННЫЕ. Движок (engine.py) не знает конкретных строк:
добавить или переставить строку = изменить этот список, не трогая формулы движка.

Поля LineSpec:
  id, name, parent        — стабильный идентификатор, название, родитель (None = верхний уровень)
  kind                    — header | group | imported | manual | cogs | formula | ratio | tax
  line_types              — для imported: какие line_type из financial_entries суммировать
  vat                     — для imported при ОСНО: 'sales' | 'services' — как выделять НДС из суммы
  category                — для manual: категория ручных записей
  terms                   — для formula: ((+1|-1, line_id), …); для ratio: (числитель, знаменатель)
  regimes                 — при каких налоговых режимах строка активна (None = при всех)
  in_totals               — входит ли в сумму родительской группы
  confirm                 — для group: требует подтверждения (хотя бы одна ручная запись, в т.ч. 0)
  memo                    — справочная строка вне итогов
  active                  — строку можно отключить, не удаляя
  optional                — ручная строка: отсутствие записей не блокирует расчёт (принимается как «нет», явно помечается)
Расходы показываются положительными числами; знак применяют formula-строки.
"""
from dataclasses import dataclass, replace


@dataclass(frozen=True)
class LineSpec:
    id: str
    name: str
    parent: str | None
    kind: str
    line_types: tuple[str, ...] = ()
    vat: str | None = None
    category: str | None = None
    terms: tuple = ()
    regimes: tuple[str, ...] | None = None
    in_totals: bool = True
    confirm: bool = False
    memo: bool = False
    active: bool = True
    optional: bool = False
    note: str | None = None


OSNO = ("osno",)
USN = ("usn_income",)


def L(*a, **k) -> LineSpec:
    return LineSpec(*a, **k)


TEMPLATE: tuple[LineSpec, ...] = (
    L("revenue", "Выручка", None, "header"),
    L("sales_gross", "Продажи (по цене продажи)", "revenue", "imported", line_types=("sale_revenue",), in_totals=False),
    L("returns", "Возвраты", "revenue", "imported", line_types=(), in_totals=False,
      note="Возвраты в подтверждённых данных не встречались; при появлении операций строка помечается неполной"),
    L("vat_output", "НДС с продаж", "revenue", "imported", line_types=("sale_revenue",), vat="sales", regimes=OSNO, in_totals=False),
    L("net_revenue", "Чистая выручка", None, "formula", terms=((1, "sales_gross"), (-1, "returns"), (-1, "vat_output"))),

    L("marketplace_costs", "Затраты маркетплейса", None, "group"),
    L("commission", "Комиссия маркетплейса", "marketplace_costs", "imported", line_types=("commission_gross",), vat="services",
      note="Номинальная комиссия: с учётом компенсации СПП (retailPrice × commissionPercent)"),
    L("acquiring", "Эквайринг", "marketplace_costs", "imported", line_types=("acquiring",), vat="services"),
    L("logistics", "Логистика", "marketplace_costs", "group"),
    L("logistics_to_customer_sale", "К клиенту при продаже", "logistics", "imported", line_types=("logistics_to_customer_sale",), vat="services"),
    L("logistics_to_customer_cancel", "К клиенту при отмене", "logistics", "imported", line_types=("logistics_to_customer_cancel",), vat="services"),
    L("logistics_from_customer_cancel", "От клиента при отмене", "logistics", "imported", line_types=("logistics_from_customer_cancel",), vat="services"),
    L("logistics_other", "Прочая логистика", "logistics", "imported", line_types=("logistics_other",), vat="services"),
    L("logistics_extra", "Дополнительная логистика (вручную)", "logistics", "manual", category="logistics_extra"),
    L("storage", "Хранение", "marketplace_costs", "imported", line_types=("storage",), vat="services"),
    L("acceptance", "Приёмка", "marketplace_costs", "imported", line_types=("acceptance",), vat="services"),
    L("deductions_other", "Прочие удержания", "marketplace_costs", "imported", line_types=("deduction_other",), vat="services"),
    L("penalties", "Штрафы", "marketplace_costs", "imported", line_types=(),
      note="Знак штрафов не подтверждён данными; при появлении штрафов строка помечается неполной"),

    L("cogs", "Себестоимость (COGS)", None, "group"),
    L("cogs_goods", "Себестоимость проданных товаров", "cogs", "cogs",
      note="Штуки проданных товаров × себестоимость единицы на дату продажи"),
    L("cogs_extra", "Доп. затраты на товар (вручную)", "cogs", "manual", category="cogs_extra"),
    L("gross_profit", "Валовая прибыль", None, "formula", terms=((1, "net_revenue"), (-1, "marketplace_costs"), (-1, "cogs"))),

    L("marketing", "Реклама и маркетинг", None, "group", confirm=True),
    L("advertising_wb", "Реклама WB (удержания «WB Продвижение»)", "marketing", "imported", line_types=("advertising",), vat="services"),
    L("advertising_external", "Внешняя реклама", "marketing", "manual", category="advertising_external"),
    L("marketing_other", "Прочие маркетинговые расходы", "marketing", "manual", category="marketing_other"),

    L("opex", "Операционные расходы", None, "group", confirm=True),
    L("opex_salaries", "Зарплаты и подрядчики", "opex", "manual", category="opex_salaries"),
    L("opex_software", "ПО и подписки", "opex", "manual", category="opex_software"),
    L("opex_admin", "Бухгалтерия и администрирование", "opex", "manual", category="opex_admin"),
    L("opex_other", "Прочие операционные расходы", "opex", "manual", category="opex_other"),
    L("operating_profit", "Операционная прибыль", None, "formula", terms=((1, "gross_profit"), (-1, "marketing"), (-1, "opex"))),

    L("other_income", "Прочие доходы", None, "manual", category="other_income"),
    L("other_expense", "Прочие расходы", None, "manual", category="other_expense"),
    L("pbt", "Прибыль до налогов", None, "formula", terms=((1, "operating_profit"), (1, "other_income"), (-1, "other_expense"))),

    L("taxes", "Налоги", None, "group"),
    L("tax_usn", "УСН «доходы»", "taxes", "tax", regimes=USN, note="Ставка × продажи (по цене продажи); приближение к кассовой базе УСН"),
    L("tax_profit", "Налог на прибыль", "taxes", "tax", regimes=OSNO, note="Ставка × прибыль до налогов (убыток → 0, без переноса)"),
    L("taxes_other", "Прочие налоги и корректировки (вручную)", "taxes", "manual", category="taxes_other"),
    L("net_profit", "Чистая прибыль", None, "formula", terms=((1, "pbt"), (-1, "taxes"))),

    L("memo", "Справочно", None, "header"),
    L("gross_margin", "Валовая маржа, %", "memo", "ratio", terms=("gross_profit", "net_revenue"), memo=True, in_totals=False),
    L("operating_margin", "Операционная маржа, %", "memo", "ratio", terms=("operating_profit", "net_revenue"), memo=True, in_totals=False),
    L("net_margin", "Чистая маржа, %", "memo", "ratio", terms=("net_profit", "net_revenue"), memo=True, in_totals=False),
    L("vat_input_services", "НДС по услугам WB к вычету", "memo", "imported", line_types=(), regimes=OSNO, memo=True, in_totals=False,
      note="Расчёт: сумма услуг WB с НДС минус сумма без НДС (ставка услуг из настроек)"),
    L("vat_input_purchases", "НДС по закупкам к вычету (вручную)", "memo", "manual", category="vat_input_purchases", regimes=OSNO, memo=True, in_totals=False),
    L("vat_payable", "НДС к уплате (расчётно)", "memo", "formula",
      terms=((1, "vat_output"), (-1, "vat_input_services"), (-1, "vat_input_purchases")), regimes=OSNO, memo=True, in_totals=False),
    L("wb_for_pay", "WB: начислено к выплате по продажам (forPay)", "memo", "imported", line_types=("for_pay",), memo=True, in_totals=False,
      note="Справка для сверки. Это не выручка и не прибыль"),
    L("wb_payout_estimate", "Расчётная выплата WB (без возмещений издержек)", "memo", "imported", line_types=(), memo=True, in_totals=False,
      note="forPay − логистика − хранение − приёмка − реклама − прочие удержания; сверять с кабинетом WB"),
)

# Ручные строки, отсутствие записей по которым не блокирует расчёт (помечается явно). Группы marketing и opex
# требуют подтверждения хотя бы одной записью (confirm=True).
_OPTIONAL = {"logistics_extra", "cogs_extra", "advertising_external", "marketing_other", "opex_salaries", "opex_software",
             "opex_admin", "opex_other", "other_income", "other_expense", "taxes_other"}
TEMPLATE = tuple(replace(s, optional=True) if s.id in _OPTIONAL else s for s in TEMPLATE)

MANUAL_CATEGORIES: dict[str, str] = {s.category: s.name for s in TEMPLATE if s.kind == "manual"}


def validate_template(template: tuple[LineSpec, ...] = TEMPLATE) -> None:
    seen: set[str] = set()
    for s in template:
        assert s.id not in seen, f"дубликат id {s.id}"
        assert s.parent is None or s.parent in seen, f"родитель {s.parent} не определён раньше {s.id}"
        if s.kind in ("formula", "ratio"):
            refs = [t[1] for t in s.terms] if s.kind == "formula" else list(s.terms)
            for r in refs:
                assert r in seen, f"{s.id}: ссылка на неопределённую (или более позднюю) строку {r}"
        if s.kind == "manual":
            assert s.category
        seen.add(s.id)
