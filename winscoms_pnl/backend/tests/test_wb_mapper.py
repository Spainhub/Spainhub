import copy
import json
from decimal import Decimal as D
from pathlib import Path

import pytest

from app.financial.model import INCONSISTENT, OK, REVIEW, UNCLASSIFIED, nature_of
from app.integrations.wildberries.mapper import normalize

ROWS = json.loads((Path(__file__).parent / "fixtures" / "wb_real_sample.json").read_text(encoding="utf-8"))
SALES = [r for r in ROWS if r["sellerOperName"] == "Продажа"]
TOL = D("0.02")


def amounts(n):
    return {e.line_type: e.amount for e in n.entries}


def test_every_real_row_is_classified_and_amounts_are_decimal():
    for row in ROWS:
        n = normalize(row)
        assert n.status != UNCLASSIFIED, (row["sellerOperName"], n.issues)
        assert n.entry_date and n.currency == "RUB" and n.source_report_id == "25001000000000000"
        assert all(isinstance(e.amount, D) for e in n.entries)


def test_statuses_by_operation():
    for row in ROWS:
        n, op = normalize(row), row["sellerOperName"]
        if op.startswith("Возмещение"):
            assert n.status == REVIEW and "pending_policy:rebill" in n.issues
        else:
            assert n.status == OK and n.issues == [], (op, n.issues)


@pytest.mark.parametrize("row", SALES, ids=lambda r: str(r["rrdId"]))
def test_sale_entries_are_consistent(row):
    a = amounts(normalize(row))
    assert a["sale_revenue"] == D(str(row["retailPriceWithDisc"]))
    assert abs(a["for_pay"] - (a["sale_revenue"] - a["commission_gross"] - a["acquiring"])) <= TOL
    assert abs(a["commission_gross"] - D(str(row["retailPrice"])) * D(str(row["commissionPercent"])) / 100) <= D("0.05")
    assert a["spp_compensation"] == D(str(row["retailPrice"])) - D(str(row["retailAmount"]))


def test_known_sale_row_values():
    row = next(r for r in SALES if r["retailPrice"] == 2697)
    a = amounts(normalize(row))
    assert a["sale_revenue"] == D("2697") and a["acquiring"] == D("75.8") and a["for_pay"] == D("1785.13")
    assert a["spp_compensation"] == D("802") and abs(a["commission_gross"] - D("836.07")) <= D("0.02")


def test_negative_net_commission_does_not_make_gross_commission_negative():
    neg = next(r for r in SALES if r["vw"] < 0)
    a = amounts(normalize(neg))
    assert D(str(neg["vw"])) + D(str(neg["vwNds"])) < 0 and a["commission_gross"] > 0


def test_expense_rows_map_to_single_line():
    expected = {"Хранение": "storage", "Обработка товара": "acceptance"}
    for row in ROWS:
        op = row["sellerOperName"]
        if op in expected:
            n = normalize(row)
            assert [e.line_type for e in n.entries] == [expected[op]] and n.entries[0].amount > 0
    logi = {normalize(r).entries[0].line_type for r in ROWS if r["sellerOperName"] == "Логистика"}
    assert logi <= {"logistics_to_customer_sale", "logistics_to_customer_cancel", "logistics_from_customer_cancel"}


def test_advertising_vs_other_deduction():
    row = next(r for r in ROWS if r["sellerOperName"] == "Удержание")
    assert normalize(row).category == "advertising"
    other = {**row, "bonusTypeName": "Иное удержание"}
    n = normalize(other)
    assert n.category == "deduction_other" and n.entries[0].line_type == "deduction_other" and n.status == OK


def test_rebill_amounts_kept_but_not_pnl_eligible():
    row = next(r for r in ROWS if r["sellerOperName"].startswith("Возмещение"))
    n = normalize(row)
    a = amounts(n)
    assert a["rebill_logistics_cost"] > 0 and abs(a["rebill_logistics_cost"] + a["rebill_commission_credit"]) <= TOL
    assert all(nature_of(e.line_type) == "pending" for e in n.entries)


def test_unknown_operation_is_unclassified_but_amounts_are_not_lost():
    n = normalize({**SALES[0], "sellerOperName": "Возврат", "docTypeName": "Возврат"})
    assert n.status == UNCLASSIFIED and "unknown_operation:Возврат" in n.issues
    assert amounts(n)["unmapped:retailPrice"] == D(str(SALES[0]["retailPrice"]))      # знак возврата не подтверждён → в P&L не попадёт
    assert not any(nature_of(e.line_type) in ("revenue", "expense") for e in n.entries)


def test_missing_required_field_is_inconsistent_not_zero():
    row = {k: v for k, v in SALES[0].items() if k != "retailAmount"}
    n = normalize(row)
    assert n.status == INCONSISTENT and "missing_field:retailAmount" in n.issues
    a = amounts(n)
    assert "commission_gross" not in a and "spp_compensation" not in a and "sale_buyer_amount" not in a   # не подменяем нулём
    assert "sale_revenue" in a


def test_arithmetic_mismatch_is_flagged():
    row = {**SALES[0], "forPay": SALES[0]["forPay"] + 5}
    n = normalize(row)
    assert n.status == INCONSISTENT and "for_pay_mismatch" in n.issues


def test_unmapped_money_field_is_preserved_and_flagged():
    logistics = next(r for r in ROWS if r["sellerOperName"] == "Логистика")
    n = normalize({**logistics, "penalty": 100})
    assert n.status == REVIEW and amounts(n)["unmapped:penalty"] == D("100")


def test_unknown_logistics_bonus_type_needs_review():
    logistics = next(r for r in ROWS if r["sellerOperName"] == "Логистика")
    n = normalize({**logistics, "bonusTypeName": "Новый вид"})
    assert n.status == REVIEW and n.entries[0].line_type == "logistics_other"


def test_bad_values_and_garbage_never_raise():
    assert normalize({**SALES[0], "vw": "abc"}).status == INCONSISTENT
    assert normalize({**SALES[0], "retailPrice": True}).status == INCONSISTENT
    for garbage in ({}, {"sellerOperName": 5}, {"sellerOperName": "Продажа", "rrDate": "not-a-date", "currency": "RUB"}, {"rrDate": [1]}):
        n = normalize(garbage)
        assert n.status in (UNCLASSIFIED, INCONSISTENT)


def test_missing_date_or_currency_drops_entries():
    n = normalize({k: v for k, v in SALES[0].items() if k != "rrDate"})
    assert n.status == INCONSISTENT and n.entries == []


def test_string_money_from_api_works_like_numbers():
    as_str = {k: (str(v) if k in {"retailPrice", "retailAmount", "retailPriceWithDisc", "vw", "vwNds", "ppvzReward", "acquiringFee", "forPay", "commissionPercent"} else v)
              for k, v in SALES[0].items()}
    assert amounts(normalize(as_str)) == amounts(normalize(SALES[0]))


def test_normalization_is_deterministic_and_does_not_mutate_input():
    row = copy.deepcopy(SALES[0])
    assert normalize(row).entries == normalize(row).entries and row == SALES[0]
