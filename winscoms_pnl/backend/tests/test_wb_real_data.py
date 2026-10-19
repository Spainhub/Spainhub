"""Закономерности реального отчёта WB (01–11.07.2026, 592 строки, обезличенная выборка в fixtures).

Это исполняемая документация: движок P&L (Stage 7) опирается на эти соотношения. Их проверка на ПОЛНОМ
файле дала расхождения не более 0.01 ₽ (округление retailAmount до рубля). Деньги — только Decimal.
"""
import json
from decimal import Decimal as D
from pathlib import Path

import pytest

ROWS = json.loads((Path(__file__).parent / "fixtures" / "wb_real_sample.json").read_text(encoding="utf-8"))
TOL = D("0.02")


def d(row, key):
    return D(str(row.get(key, 0) or 0))          # str(float) возвращает исходную десятичную запись


def by_oper(name):
    return [r for r in ROWS if r["sellerOperName"] == name]


SALES = by_oper("Продажа")


def test_fixture_covers_every_operation_type():
    assert {r["sellerOperName"] for r in ROWS} == {
        "Продажа", "Логистика", "Хранение", "Обработка товара",
        "Возмещение издержек по перевозке/по складским операциям с товаром", "Удержание",
    }
    assert len(SALES) >= 10


@pytest.mark.parametrize("row", SALES, ids=lambda r: str(r["rrdId"]))
def test_for_pay_identity(row):
    """forPay = retailAmount − acquiringFee − (vw + vwNds) − ppvzReward."""
    expected = d(row, "retailAmount") - d(row, "acquiringFee") - d(row, "vw") - d(row, "vwNds") - d(row, "ppvzReward")
    assert abs(d(row, "forPay") - expected) <= TOL


@pytest.mark.parametrize("row", SALES, ids=lambda r: str(r["rrdId"]))
def test_gross_commission_and_spp_decomposition(row):
    """Номинальная комиссия = retailPrice × commissionPercent. Её чистая часть (vw+vwNds+ppvzReward)
    уменьшена на компенсацию СПП от WB (retailPrice − retailAmount); поэтому vw бывает отрицательным."""
    nominal = d(row, "retailPrice") * d(row, "commissionPercent") / 100
    spp_comp = d(row, "retailPrice") - d(row, "retailAmount")
    net = d(row, "vw") + d(row, "vwNds") + d(row, "ppvzReward")
    assert abs(nominal - spp_comp - net) <= TOL


@pytest.mark.parametrize("row", SALES, ids=lambda r: str(r["rrdId"]))
def test_for_pay_from_price_commission_and_acquiring(row):
    """С точки зрения продавца: forPay = retailPrice − номинальная комиссия − эквайринг."""
    expected = d(row, "retailPrice") * (1 - d(row, "commissionPercent") / 100) - d(row, "acquiringFee")
    assert abs(d(row, "forPay") - expected) <= TOL


@pytest.mark.parametrize("row", SALES, ids=lambda r: str(r["rrdId"]))
def test_acquiring_is_percent_of_retail_price_and_price_equals_price_with_disc(row):
    # acquiringPercent округлён до сотых процента → допуск 0.2 ₽ на цене до 3000 ₽
    assert abs(d(row, "acquiringFee") - d(row, "retailPrice") * d(row, "acquiringPercent") / 100) <= D("0.2")
    assert d(row, "retailPrice") == d(row, "retailPriceWithDisc")      # скидок продавца в отчёте нет
    assert row["docTypeName"] == "Продажа" and row["quantity"] == 1


def test_vat_on_commission_is_22_percent():
    for r in SALES:
        if d(r, "vw") != 0:
            assert abs(d(r, "vwNds") / d(r, "vw") - D("0.22")) < D("0.01")


def test_negative_commission_is_possible():
    """Когда СПП-компенсация больше номинальной комиссии, vw < 0 — это кредит продавцу, не ошибка данных."""
    assert any(d(r, "vw") < 0 for r in SALES) and any(d(r, "vw") > 0 for r in SALES)


def test_rebill_rows_net_commission_equals_minus_rebill_cost():
    rows = by_oper("Возмещение издержек по перевозке/по складским операциям с товаром")
    assert rows
    for r in rows:
        assert abs(d(r, "vw") + d(r, "vwNds") + d(r, "rebillLogisticCost")) <= TOL
        assert d(r, "forPay") == 0 and r["quantity"] == 2 and "docTypeName" not in r


def test_expense_rows_carry_amount_in_exactly_one_field():
    expected = {"Логистика": "deliveryService", "Хранение": "paidStorage", "Обработка товара": "paidAcceptance", "Удержание": "deduction"}
    money = ["retailPrice", "retailAmount", "deliveryService", "forPay", "ppvzReward", "acquiringFee", "vw", "vwNds",
             "rebillLogisticCost", "paidStorage", "deduction", "paidAcceptance", "penalty", "additionalPayment"]
    for oper, field in expected.items():
        for r in by_oper(oper):
            nonzero = {k for k in money if d(r, k) != 0}
            assert nonzero == {field}, (oper, nonzero)
            assert d(r, field) > 0                                   # расход приходит положительным числом
            assert r["quantity"] == 0 and "docTypeName" not in r


def test_logistics_direction_is_in_bonus_type_name():
    kinds = {r["bonusTypeName"] for r in by_oper("Логистика")}
    assert kinds <= {"К клиенту при продаже", "К клиенту при отмене", "От клиента при отмене"}


def test_advertising_is_a_deduction_identified_by_bonus_type_name():
    for r in by_oper("Удержание"):
        assert r["bonusTypeName"].startswith("Оказание услуг «WB Продвижение»")


def test_large_ids_survive_json_roundtrip_exactly():
    """reportId (~2.5e16) выше 2^53: через float/JS-Number он портится — храним как int/строку."""
    raw = '{"reportId": 25001000000000001}'
    assert json.loads(raw)["reportId"] == 25001000000000001
    assert float(25001000000000001) != 25001000000000001
