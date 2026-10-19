import logging
from collections import Counter

from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
import uuid

from app.financial.model import NORMALIZER_VERSION
from app.integrations.registry import NORMALIZERS
from app.models import FinancialEntry, FinancialTransaction, RawRecord

log = logging.getLogger("winscoms.normalize")
MARKETPLACE_BY_PREFIX = {"wb:": "wildberries"}
BATCH = 2000


def _marketplace(source_endpoint: str) -> str:
    return next((m for p, m in MARKETPLACE_BY_PREFIX.items() if source_endpoint.startswith(p)), "unknown")


async def normalize_pending(db: AsyncSession, *, org_id: uuid.UUID, account_id: uuid.UUID) -> int:
    """Нормализует сырые записи аккаунта, у которых нет транзакции или версия нормализатора устарела.

    Идемпотентно: транзакция уникальна по raw_record_id, её строки пересоздаются целиком.
    Выполняется в текущей транзакции вызывающего кода."""
    total = 0
    while True:
        rows = (
            await db.execute(
                select(RawRecord.id, RawRecord.source_endpoint, RawRecord.source_id, RawRecord.payload)
                .outerjoin(FinancialTransaction, FinancialTransaction.raw_record_id == RawRecord.id)
                .where(
                    RawRecord.organization_id == org_id,
                    RawRecord.seller_account_id == account_id,
                    (FinancialTransaction.id.is_(None)) | (FinancialTransaction.normalizer_version < NORMALIZER_VERSION),
                )
                .order_by(RawRecord.id)
                .limit(BATCH)
            )
        ).all()
        if not rows:
            return total

        tx_rows, results = [], {}
        for raw_id, endpoint, source_id, payload in rows:
            normalize = NORMALIZERS.get(endpoint)
            if normalize is None:
                log.error("no normalizer", extra={"ctx": {"endpoint": endpoint}})
                continue
            n = normalize(payload)
            results[raw_id] = n
            tx_rows.append({
                "organization_id": org_id, "seller_account_id": account_id, "raw_record_id": raw_id,
                "marketplace": _marketplace(endpoint), "source_id": source_id, "entry_date": n.entry_date,
                "currency": n.currency, "nm_id": n.nm_id, "vendor_code": n.vendor_code, "sku": n.sku,
                "product_name": n.product_name, "brand": n.brand, "quantity": n.quantity,
                "source_operation": n.source_operation, "doc_type": n.doc_type, "bonus_type": n.bonus_type,
                "source_report_id": n.source_report_id, "srid": n.srid, "order_id": n.order_id,
                "category": n.category, "status": n.status, "issues": n.issues,
                "normalizer_version": NORMALIZER_VERSION,
            })
        if not tx_rows:
            return total

        stmt = pg_insert(FinancialTransaction).values(tx_rows)
        update_cols = {c: stmt.excluded[c] for c in tx_rows[0] if c not in ("organization_id", "seller_account_id", "raw_record_id")}
        update_cols["normalized_at"] = func.now()
        stmt = stmt.on_conflict_do_update(constraint="uq_financial_transactions_raw_record_id", set_=update_cols)
        ids = {raw: tx for tx, raw in (await db.execute(stmt.returning(FinancialTransaction.id, FinancialTransaction.raw_record_id))).all()}

        await db.execute(delete(FinancialEntry).where(FinancialEntry.transaction_id.in_(ids.values())))
        entry_rows = [
            {
                "organization_id": org_id, "seller_account_id": account_id, "transaction_id": ids[raw],
                "entry_date": n.entry_date, "currency": n.currency, "nm_id": n.nm_id,
                "line_type": e.line_type, "amount": e.amount,
            }
            for raw, n in results.items() for e in n.entries
        ]
        for i in range(0, len(entry_rows), 4000):
            await db.execute(pg_insert(FinancialEntry).values(entry_rows[i : i + 4000]))
        total += len(tx_rows)
        await db.flush()


async def summary(db: AsyncSession, *, org_id: uuid.UUID, account_id: uuid.UUID) -> dict:
    """Полнота нормализации: сколько строк в каждом статусе/категории и какие замечания встречаются."""
    q = (
        select(FinancialTransaction.status, FinancialTransaction.category, func.count())
        .where(FinancialTransaction.organization_id == org_id, FinancialTransaction.seller_account_id == account_id)
        .group_by(FinancialTransaction.status, FinancialTransaction.category)
    )
    by_status: Counter = Counter()
    by_category: Counter = Counter()
    for status, category, n in (await db.execute(q)).all():
        by_status[status] += n
        by_category[category] += n
    raw_total = (await db.execute(select(func.count()).select_from(RawRecord).where(
        RawRecord.organization_id == org_id, RawRecord.seller_account_id == account_id))).scalar_one()
    return {
        "raw_records": raw_total, "normalized": sum(by_status.values()),
        "by_status": dict(by_status), "by_category": dict(by_category),
        "needs_attention": by_status["review"] + by_status["inconsistent"] + by_status["unclassified"],
    }
