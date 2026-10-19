"""Тесты движка P&L на известных числах. Для каждой формулы указано ожидаемое значение и почему оно верно."""
import json
from decimal import Decimal as D
from pathlib import Path

import pytest

from app.financial.engine import (
    BLOCKED, INCOMPLETE, MISSING, OK, CogsInput, PeriodInputs, Settings, build_report, compute_period, r2,
)
from app.financial.pl_template import TEMPLATE, validate_template
from app.integrations.wildberries.mapper import normalize

USN = Settings(regime="usn_income")
OSNO = Settings(regime="osno")


def base_inputs(**over) -> PeriodInputs:
    """Один период: выручка 1000, комиссия 300, эквайринг 30, логистика 100, хранение 10, приёмка 5, реклама WB 20."""
    inp = PeriodInputs(
        key="2026-07", has_import_data=True,
        imports={"sale_revenue": D("1000"), "commission_gross": D("300"), "acquiring": D("30"),
                 "logistics_to_customer_sale": D("100"), "storage": D("10"), "acceptance": D("5"),
                 "advertising": D("20"), "for_pay": D("670")},
        manual={"opex_salaries": (D("50"), 1), "advertising_external": (D("0"), 1)},
        cogs=CogsInput(amount=D("200"), units_total=2, units_costed=2),
    )
    for k, v in over.items():
        setattr(inp, k, v)
    return inp


def val(res, line):
    return res[line].value


def test_template_is_valid():
    validate_template()


def test_usn_full_chain_known_numbers():
    r = compute_period(base_inputs(), USN)
    assert val(r, "net_revenue") == D("1000.00")                       # на УСН НДС не выделяем
    assert val(r, "marketplace_costs") == D("445.00")                  # 300+30+100+10+5
    assert val(r, "gross_profit") == D("355.00")                       # 1000−445−200
    assert val(r, "marketing") == D("20.00")                           # реклама WB 20 + внешняя 0 (подтверждена нулём)
    assert val(r, "opex") == D("50.00")
    assert val(r, "operating_profit") == D("285.00")                   # 355−20−50
    assert val(r, "pbt") == D("285.00")                                # прочих доходов/расходов нет (опциональные)
    assert val(r, "tax_usn") == D("60.00")                             # 6% от ПРОДАЖ (1000), не от прибыли
    assert val(r, "net_profit") == D("225.00")                         # 285−60
    assert val(r, "gross_margin") == D("35.50") and val(r, "net_margin") == D("22.50")
    assert r["net_profit"].status == OK


def test_osno_separates_vat_and_taxes_profit():
    r = compute_period(base_inputs(), OSNO)                            # НДС 22% в цене и в услугах
    assert val(r, "vat_output") == D("180.33")                         # 1000×22/122
    assert val(r, "net_revenue") == D("819.67")                        # 1000−180.33
    assert val(r, "commission") == D("245.90") and val(r, "acquiring") == D("24.59")   # 300/1.22, 30/1.22
    # услуги с НДС 465 = 300+30+100+10+5+20; без НДС по строкам 245.90+24.59+81.97+8.20+4.10+16.39 = 381.15 → НДС 83.85
    assert val(r, "vat_input_services") == D("83.85")
    assert val(r, "tax_profit") == r2(max(val(r, "pbt"), D(0)) * D("0.20"))
    assert val(r, "net_profit") == val(r, "pbt") - val(r, "tax_profit")
    assert "tax_usn" not in r                                           # строка другого режима неактивна


def test_osno_vat_payable_needs_purchase_vat_input():
    r = compute_period(base_inputs(), OSNO)
    assert r["vat_payable"].status == BLOCKED and r["vat_payable"].value is None   # нет НДС по закупкам
    inp = base_inputs()
    inp.manual["vat_input_purchases"] = (D("40"), 1)
    r = compute_period(inp, OSNO)
    assert val(r, "vat_payable") == val(r, "vat_output") - val(r, "vat_input_services") - D("40")


def test_osno_tax_is_zero_on_loss_without_carryforward():
    inp = base_inputs(cogs=CogsInput(amount=D("900"), units_total=1, units_costed=1))
    r = compute_period(inp, OSNO)
    assert val(r, "pbt") < 0 and val(r, "tax_profit") == D("0.00")
    assert val(r, "net_profit") == val(r, "pbt")


def test_missing_cost_blocks_profit_but_shows_preliminary():
    inp = base_inputs(cogs=CogsInput(amount=D("100"), units_total=2, units_costed=1, missing_nm_ids=[777]))
    r = compute_period(inp, USN)
    assert r["cogs_goods"].status == BLOCKED and r["cogs_goods"].value is None
    for line in ("cogs", "gross_profit", "operating_profit", "net_profit", "gross_margin"):
        assert r[line].value is None and r[line].status == BLOCKED, line
    assert "777" in r["cogs_goods"].notes[0]
    assert "Себестоимость" in r["gross_profit"].notes[0]                  # причина названа человеческим языком, не id
    assert r["gross_profit"].preliminary is not None                    # справочная оценка есть, но помечена
    assert val(r, "net_revenue") == D("1000.00")                        # выручка от COGS не зависит


def test_group_preliminary_includes_blocked_children_and_flows_to_profit():
    inp = base_inputs(cogs=CogsInput(amount=D("100"), units_total=2, units_costed=1, missing_nm_ids=[777]))
    r = compute_period(inp, USN)
    assert r["cogs"].value is None and r["cogs"].preliminary == D("100.00")           # не 0: известная часть себестоимости учтена
    assert r["gross_profit"].preliminary == D("455.00")                                # 1000 − 445 − 100


def test_unconfirmed_opex_and_marketing_block_operating_profit():
    inp = base_inputs()
    inp.manual = {}                                                     # ни одной ручной записи
    r = compute_period(inp, USN)
    assert r["opex"].status == MISSING and r["opex"].value is None
    assert r["marketing"].status == MISSING                             # реклама WB не подтверждает внешнюю/прочую
    assert r["operating_profit"].status == BLOCKED and r["net_profit"].status == BLOCKED
    assert val(r, "gross_profit") == D("355.00")                        # валовая прибыль от этого не зависит
    inp.manual = {"opex_other": (D("0"), 1), "marketing_other": (D("0"), 1)}   # явный ноль = подтверждение
    assert compute_period(inp, USN)["net_profit"].value is not None


def test_optional_manual_lines_missing_are_visible_not_blocking():
    r = compute_period(base_inputs(), USN)
    assert r["other_income"].status == MISSING
    assert any("Прочие доходы" in n for n in r["pbt"].notes)             # допущение «нет» показано явно
    assert r["cogs"].status == OK and any("Доп. затраты на товар" in n for n in r["cogs"].notes)


def test_manual_extras_flow_into_lines():
    inp = base_inputs()
    inp.manual.update({"logistics_extra": (D("7.5"), 2), "cogs_extra": (D("13"), 1), "other_income": (D("5"), 1),
                       "other_expense": (D("2"), 1), "taxes_other": (D("1"), 1)})
    r = compute_period(inp, USN)
    assert val(r, "marketplace_costs") == D("452.50") and val(r, "cogs") == D("213.00")
    assert val(r, "pbt") == val(r, "operating_profit") + D("5") - D("2")
    assert val(r, "taxes") == D("61.00") and r["logistics_extra"].contributions[0]["entries"] == 2


def test_no_import_data_is_missing_not_zero():
    inp = base_inputs(has_import_data=False, imports={})
    r = compute_period(inp, USN)
    assert r["sales_gross"].status == MISSING and r["sales_gross"].value is None
    assert r["net_revenue"].status == BLOCKED and r["net_profit"].value is None


def test_import_without_operations_is_honest_zero():
    r = compute_period(base_inputs(imports={"sale_revenue": D("1000")}), USN)
    assert val(r, "storage") == D("0.00") and r["storage"].status == OK


def test_import_issues_make_lines_incomplete_and_returns_penalties_flagged():
    r = compute_period(base_inputs(import_issues=3), USN)
    assert r["commission"].status == INCOMPLETE and r["net_profit"].status == INCOMPLETE
    assert r["returns"].status == INCOMPLETE and r["penalties"].status == INCOMPLETE
    clean = compute_period(base_inputs(), USN)
    assert clean["returns"].status == OK and clean["returns"].value == D("0.00")


def test_rounding_leaves_half_up_and_report_foots():
    inp = PeriodInputs(key="x", has_import_data=True,
                       imports={"sale_revenue": D("100.005"), "commission_gross": D("33.335"), "acquiring": D("0.005")},
                       manual={"opex_other": (D("0.005"), 1), "marketing_other": (D("0"), 1)},
                       cogs=CogsInput(amount=D("10.005"), units_total=1, units_costed=1))
    r = compute_period(inp, USN)
    assert val(r, "sales_gross") == D("100.01") and val(r, "commission") == D("33.34") and val(r, "acquiring") == D("0.01")
    # подтоги считаются из округлённых листьев → сходятся копейка в копейку
    assert val(r, "marketplace_costs") == val(r, "commission") + val(r, "acquiring") + val(r, "logistics") + val(r, "storage") + val(r, "acceptance") + val(r, "deductions_other") + val(r, "penalties")
    assert val(r, "gross_profit") == val(r, "net_revenue") - val(r, "marketplace_costs") - val(r, "cogs")


def test_no_double_counting_between_commission_and_info_lines():
    inp = base_inputs()
    inp.imports.update({"spp_compensation": D("500"), "sale_buyer_amount": D("500"), "commission_vat": D("66")})
    r = compute_period(inp, USN)
    assert val(r, "marketplace_costs") == D("445.00")                   # info-типы не попадают в P&L


def test_for_pay_is_reconciliation_only():
    r = compute_period(base_inputs(), USN)
    assert val(r, "wb_for_pay") == D("670.00")
    assert val(r, "wb_payout_estimate") == D("535.00")                  # 670 − (100+10+5+20)
    assert val(r, "net_profit") != val(r, "wb_for_pay")                 # forPay ≠ прибыль


def test_report_total_is_computed_from_total_inputs_not_sum_of_months():
    profit = base_inputs()
    loss = base_inputs(cogs=CogsInput(amount=D("5000"), units_total=1, units_costed=1))
    loss.key = "2026-08"
    total = PeriodInputs(key="total", has_import_data=True,
                         imports={k: profit.imports[k] + loss.imports[k] for k in profit.imports},
                         manual={"opex_salaries": (D("100"), 2), "advertising_external": (D("0"), 2)},
                         cogs=CogsInput(amount=D("5200"), units_total=3, units_costed=3))
    rep = build_report([profit, loss], total, OSNO)
    tax = next(l for l in rep["lines"] if l["id"] == "tax_profit")["values"]
    assert D(tax["2026-08"]["value"]) == D("0")                         # убыточный месяц — налога нет
    assert rep["periods"] == ["2026-07", "2026-08", "total"]


# ---------- сквозной расчёт на реальной обезличенной выборке WB ----------
FIX = json.loads((Path(__file__).parent / "fixtures" / "wb_real_sample.json").read_text(encoding="utf-8"))


def inputs_from_fixture() -> PeriodInputs:
    sums: dict[str, D] = {}
    for row in FIX:
        for e in normalize(row).entries:
            sums[e.line_type] = sums.get(e.line_type, D(0)) + e.amount
    return PeriodInputs(key="2026-07", has_import_data=True, imports=sums,
                        manual={"opex_other": (D(0), 1), "marketing_other": (D(0), 1)},
                        cogs=CogsInput(amount=D(0), units_total=0, units_costed=0))


def test_real_sample_reconciles_forpay_with_pnl_lines():
    r = compute_period(inputs_from_fixture(), USN)
    # на уровне WB: forPay = продажи − комиссия − эквайринг (с допуском округления retailAmount на каждую строку)
    n_sales = sum(1 for x in FIX if x["sellerOperName"] == "Продажа")
    lhs = val(r, "wb_for_pay")
    rhs = val(r, "sales_gross") - val(r, "commission") - val(r, "acquiring")
    assert abs(lhs - rhs) <= D("0.02") * n_sales
    assert val(r, "commission") > 0                                     # валовая комиссия положительна, хотя Σ(vw+vwNds) < 0 бывает
