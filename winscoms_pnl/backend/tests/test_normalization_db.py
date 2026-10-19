import json
import uuid
from datetime import date
from decimal import Decimal as D
from pathlib import Path

import pytest
from sqlalchemy import func, select, text

from app.core.crypto import encrypt
from app.db.session import set_rls_context
from app.financial import model as fin_model
from app.jobs.sync_runner import process_next
from app.models import FinancialEntry, FinancialTransaction, Organization, SellerAccount, SyncJob
from app.services import normalization
from tests.conftest import needs_db
from tests.test_sync_db import STEP, T0, FakeClient, run_all

pytestmark = needs_db
ROWS = json.loads((Path(__file__).parent / "fixtures" / "wb_real_sample.json").read_text(encoding="utf-8"))


class WbFake(FakeClient):
    source_endpoint = "wb:sales-reports/detailed"


@pytest.fixture
async def acct(maker):
    async with maker() as db:
        await set_rls_context(db, platform_admin=True)
        await db.execute(text("UPDATE sync_jobs SET status='cancelled' WHERE status IN ('queued','running')"))
        org = Organization(name=f"n-{uuid.uuid4().hex[:6]}")
        db.add(org)
        await db.flush()
        a = SellerAccount(organization_id=org.id, marketplace="wildberries", name="t", encrypted_token=encrypt("tok"), token_hint="tok")
        db.add(a)
        await db.flush()
        j = SyncJob(organization_id=org.id, seller_account_id=a.id, kind="initial", period_from=date(2026, 7, 1), period_to=date(2026, 7, 11))
        db.add(j)
        await db.commit()
        return org.id, a.id, j.id


async def totals(maker, org, acc):
    async with maker() as db:
        await set_rls_context(db, org_id=org)
        rows = (await db.execute(
            select(FinancialEntry.line_type, func.sum(FinancialEntry.amount), func.count())
            .where(FinancialEntry.seller_account_id == acc).group_by(FinancialEntry.line_type))).all()
        n_tx = (await db.execute(select(func.count()).select_from(FinancialTransaction).where(FinancialTransaction.seller_account_id == acc))).scalar_one()
        return {r[0]: (r[1], r[2]) for r in rows}, n_tx


async def test_sync_normalizes_pages_and_totals_match(maker, acct):
    org, acc, job = acct
    await run_all(maker, WbFake([ROWS[:15], ROWS[15:], []]))
    t, n_tx = await totals(maker, org, acc)
    assert n_tx == len(ROWS)
    sales = [r for r in ROWS if r["sellerOperName"] == "Продажа"]
    assert t["sale_revenue"] == (sum(D(str(r["retailPriceWithDisc"])) for r in sales), len(sales))
    assert t["acquiring"][0] == sum(D(str(r["acquiringFee"])) for r in sales)
    assert t["for_pay"][0] == sum(D(str(r["forPay"])) for r in sales)
    # forPay = выручка − комиссия − эквайринг на уровне итогов (допуск на округление retailAmount)
    assert abs(t["for_pay"][0] - (t["sale_revenue"][0] - t["commission_gross"][0] - t["acquiring"][0])) <= D("0.02") * len(sales)
    async with maker() as db:
        await set_rls_context(db, org_id=org)
        s = await normalization.summary(db, org_id=org, account_id=acc)
    assert s["raw_records"] == s["normalized"] == len(ROWS)
    assert s["by_status"]["ok"] > 0 and s["by_status"]["review"] == 2 and s["needs_attention"] == 2
    assert s["by_category"]["sale"] == len(sales)


async def test_normalization_is_idempotent_and_versioned(maker, acct, monkeypatch):
    org, acc, job = acct
    await run_all(maker, WbFake([ROWS, []]))
    before = await totals(maker, org, acc)
    async with maker() as db:
        await set_rls_context(db, org_id=org)
        assert await normalization.normalize_pending(db, org_id=org, account_id=acc) == 0   # нечего делать
        await db.commit()
    assert await totals(maker, org, acc) == before

    monkeypatch.setattr(normalization, "NORMALIZER_VERSION", fin_model.NORMALIZER_VERSION + 1)
    async with maker() as db:
        await set_rls_context(db, org_id=org)
        assert await normalization.normalize_pending(db, org_id=org, account_id=acc) == len(ROWS)   # пересчёт новой версией
        assert await normalization.normalize_pending(db, org_id=org, account_id=acc) == 0
        await db.commit()
    assert await totals(maker, org, acc) == before                                           # строки пересозданы без дублей


async def test_overlapping_pages_do_not_duplicate_financial_rows(maker, acct):
    org, acc, job = acct
    await run_all(maker, WbFake([ROWS[:10], ROWS[5:20], ROWS[20:], []]))   # страницы перекрываются (повтор после сбоя)
    t, n_tx = await totals(maker, org, acc)
    assert n_tx == len(ROWS)


async def test_rls_on_financial_tables(maker, acct):
    org, acc, job = acct
    await run_all(maker, WbFake([ROWS, []]))
    async with maker() as db:
        for t in ("financial_transactions", "financial_entries"):
            assert (await db.execute(text(f"SELECT count(*) FROM {t}"))).scalar_one() == 0
        await set_rls_context(db, org_id=uuid.uuid4())
        for t in ("financial_transactions", "financial_entries"):
            assert (await db.execute(text(f"SELECT count(*) FROM {t}"))).scalar_one() == 0
        await set_rls_context(db, org_id=org)
        assert (await db.execute(text("SELECT count(*) FROM financial_transactions"))).scalar_one() == len(ROWS)


async def test_amounts_keep_six_decimals_without_float_artifacts(maker, acct):
    org, acc, job = acct
    await run_all(maker, WbFake([ROWS, []]))
    async with maker() as db:
        await set_rls_context(db, org_id=org)
        vals = (await db.execute(text("SELECT amount::text FROM financial_entries WHERE line_type='commission_gross'"))).scalars().all()
    assert vals and all(len(v.split(".")[1]) == 6 for v in vals)
