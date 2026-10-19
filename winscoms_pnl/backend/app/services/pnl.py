"""Сбор агрегатов из БД для движка P&L. Агрегаты считает PostgreSQL (отчёт не загружает транзакции в память)."""
import uuid
from calendar import monthrange
from dataclasses import dataclass
from datetime import date, timedelta
from decimal import Decimal

from fastapi import HTTPException, status
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.financial import engine
from app.financial.engine import CogsInput, PeriodInputs, Settings
from app.financial.model import PENDING, nature_of
from app.financial.pl_template import TEMPLATE
from app.models import FinancialEntry, FinancialTransaction, ManualEntry, OrgSettings

MAX_DAYS_DAILY = 62
MAX_MONTHS = 36


async def load_settings(db: AsyncSession, org_id: uuid.UUID) -> Settings:
    row = await db.get(OrgSettings, org_id)
    if row is None:
        raise HTTPException(status.HTTP_409_CONFLICT, "Не задана учётная политика организации (налоговый режим). Откройте «Настройки».")
    return Settings(regime=row.tax_regime, usn_rate=row.usn_rate, profit_tax_rate=row.profit_tax_rate,
                    vat_sales_rate=row.vat_sales_rate, vat_services_rate=row.vat_services_rate)


def bucket_keys(d1: date, d2: date, granularity: str) -> list[str]:
    if granularity == "total":
        return []
    keys, cur = [], d1
    if granularity == "day":
        if (d2 - d1).days + 1 > MAX_DAYS_DAILY:
            raise HTTPException(422, f"Для помесячной детализации по дням максимум {MAX_DAYS_DAILY} дней")
        while cur <= d2:
            keys.append(cur.isoformat()); cur += timedelta(days=1)
    else:
        y, m = d1.year, d1.month
        while (y, m) <= (d2.year, d2.month):
            keys.append(f"{y:04d}-{m:02d}")
            y, m = (y + 1, 1) if m == 12 else (y, m + 1)
        if len(keys) > MAX_MONTHS:
            raise HTTPException(422, f"Максимум {MAX_MONTHS} месяцев")
    return keys


def _bucket_sql(col: str, granularity: str) -> str:
    if granularity == "day":
        return f"to_char({col}, 'YYYY-MM-DD')"
    if granularity == "month":
        return f"to_char({col}, 'YYYY-MM')"
    return "'total'"


@dataclass
class ReportData:
    periods: list[PeriodInputs]
    total: PeriodInputs
    currency: str
    quality: dict
    coverage: dict


async def resolve_currency(db: AsyncSession, org_id, account_id, d1: date, d2: date, requested: str | None) -> str:
    q = select(FinancialEntry.currency).where(
        FinancialEntry.organization_id == org_id, FinancialEntry.entry_date.between(d1, d2)).distinct()
    if account_id:
        q = q.where(FinancialEntry.seller_account_id == account_id)
    found = sorted((await db.execute(q)).scalars())
    if requested:
        return requested
    if len(found) > 1:
        raise HTTPException(409, f"В периоде несколько валют ({', '.join(found)}): укажите currency — суммы в разных валютах не складываются")
    return found[0] if found else "RUB"


async def load_report_data(db: AsyncSession, *, org_id, account_id, d1: date, d2: date, granularity: str, currency: str) -> ReportData:
    keys = bucket_keys(d1, d2, granularity)
    params = {"org": org_id, "acc": account_id, "d1": d1, "d2": d2, "cur": currency}
    acc_ft = "AND ft.seller_account_id = :acc" if account_id else ""
    acc_fe = "AND fe.seller_account_id = :acc" if account_id else ""
    # org-уровневые (без аккаунта) ручные записи видны только в отчёте по всей организации
    acc_me = "AND me.seller_account_id = :acc" if account_id else ""
    b_fe, b_ft, b_me = (_bucket_sql(c, granularity) for c in ("fe.entry_date", "ft.entry_date", "me.entry_date"))

    periods = {k: PeriodInputs(key=k) for k in keys}
    total = PeriodInputs(key="total")

    def get(k: str) -> PeriodInputs:
        return periods.setdefault(k, PeriodInputs(key=k)) if granularity != "total" else total

    def targets(b: str) -> list[PeriodInputs]:
        return [total] if granularity == "total" else [get(b), total]

    # 1. импортированные суммы
    rows = (await db.execute(text(f"""
        SELECT {b_fe} AS b, fe.line_type, sum(fe.amount) AS amt
        FROM financial_entries fe
        WHERE fe.organization_id = :org AND fe.entry_date BETWEEN :d1 AND :d2 AND fe.currency = :cur {acc_fe}
        GROUP BY 1, 2"""), params)).all()
    for b, lt, amt in rows:
        for tgt in targets(b):
            tgt.imports[lt] = tgt.imports.get(lt, Decimal(0)) + amt

    # 2. наличие данных и качество
    rows = (await db.execute(text(f"""
        SELECT {b_ft} AS b, ft.status, count(*)
        FROM financial_transactions ft
        WHERE ft.organization_id = :org AND ft.entry_date BETWEEN :d1 AND :d2 AND ft.currency = :cur {acc_ft}
        GROUP BY 1, 2"""), params)).all()
    by_status: dict[str, int] = {}
    for b, st, n in rows:
        by_status[st] = by_status.get(st, 0) + n
        for tgt in targets(b):
            tgt.has_import_data = True
            if st in ("inconsistent", "unclassified"):
                tgt.import_issues += n
    for p in [*periods.values(), total]:
        p.unclassified_money = any(k.startswith("unmapped:") for k in p.imports)

    # 3. ручные записи
    rows = (await db.execute(text(f"""
        SELECT {b_me} AS b, me.category, sum(me.amount), count(*)
        FROM manual_entries me
        WHERE me.organization_id = :org AND me.entry_date BETWEEN :d1 AND :d2 AND me.currency = :cur {acc_me}
        GROUP BY 1, 2"""), params)).all()
    for b, cat, amt, n in rows:
        for tgt in targets(b):
            a, c = tgt.manual.get(cat, (Decimal(0), 0))
            tgt.manual[cat] = (a + amt, c + n)

    # 4. себестоимость: штуки проданного × себестоимость единицы на дату продажи
    rows = (await db.execute(text(f"""
        SELECT {b_ft} AS b,
               coalesce(sum(ft.quantity), 0) AS units,
               coalesce(sum(CASE WHEN c.cost IS NOT NULL THEN ft.quantity END), 0) AS costed,
               coalesce(sum(ft.quantity * c.cost), 0) AS cogs,
               array_agg(DISTINCT ft.nm_id) FILTER (WHERE c.cost IS NULL) AS missing
        FROM financial_transactions ft
        LEFT JOIN LATERAL (
            SELECT pc.cost_per_unit AS cost FROM product_costs pc
            WHERE pc.organization_id = ft.organization_id AND pc.nm_id = ft.nm_id
              AND pc.currency = ft.currency AND pc.valid_from <= ft.entry_date
            ORDER BY pc.valid_from DESC LIMIT 1) c ON true
        WHERE ft.organization_id = :org AND ft.category = 'sale' AND ft.status IN ('ok','review')
          AND ft.entry_date BETWEEN :d1 AND :d2 AND ft.currency = :cur {acc_ft}
        GROUP BY 1"""), params)).all()
    for b, units, costed, cogs, missing in rows:
        for tgt in targets(b):
            c = tgt.cogs
            c.units_total += int(units); c.units_costed += int(costed); c.amount += cogs
            c.missing_nm_ids = sorted(set(c.missing_nm_ids) | set(missing or []))

    # 5. качество и покрытие
    pending = {k: str(v) for k, v in total.imports.items() if nature_of(k) == PENDING}
    days_with = set((await db.execute(select(FinancialTransaction.entry_date).where(
        FinancialTransaction.organization_id == org_id, FinancialTransaction.entry_date.between(d1, d2),
        FinancialTransaction.currency == currency,
        *([FinancialTransaction.seller_account_id == account_id] if account_id else []),
    ).distinct())).scalars())
    all_days = [d1 + timedelta(days=i) for i in range((d2 - d1).days + 1)]
    missing_days = [d.isoformat() for d in all_days if d not in days_with]
    ordered = [periods[k] for k in keys] if granularity != "total" else []
    if granularity != "total":
        ordered += [p for k, p in sorted(periods.items()) if k not in keys]
    return ReportData(
        periods=ordered, total=total, currency=currency,
        quality={"transactions_by_status": by_status, "excluded_pending_amounts": pending,
                 "import_issues": total.import_issues},
        coverage={"days_in_range": len(all_days), "days_with_data": len(days_with),
                  "missing_days": missing_days[:62], "missing_days_count": len(missing_days)},
    )


async def build_pnl(db: AsyncSession, *, org_id, account_id, d1: date, d2: date, granularity: str, currency: str | None) -> dict:
    cfg = await load_settings(db, org_id)
    cur = await resolve_currency(db, org_id, account_id, d1, d2, currency)
    data = await load_report_data(db, org_id=org_id, account_id=account_id, d1=d1, d2=d2, granularity=granularity, currency=cur)
    report = engine.build_report(data.periods, data.total, cfg)
    return {
        "date_from": d1.isoformat(), "date_to": d2.isoformat(), "granularity": granularity, "currency": cur,
        "account_id": str(account_id) if account_id else None,
        "settings": {"tax_regime": cfg.regime, "usn_rate": str(cfg.usn_rate), "profit_tax_rate": str(cfg.profit_tax_rate),
                     "vat_sales_rate": str(cfg.vat_sales_rate), "vat_services_rate": str(cfg.vat_services_rate)},
        "quality": data.quality, "coverage": data.coverage, **report,
    }
