import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import BigInteger, Date, DateTime, ForeignKey, Identity, Index, Integer, Numeric, String, Text, func, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class FinancialTransaction(Base):
    """Нормализованная строка отчёта маркетплейса (1:1 с raw_records)."""

    __tablename__ = "financial_transactions"

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    organization_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"))
    seller_account_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("seller_accounts.id", ondelete="CASCADE"))
    raw_record_id: Mapped[int] = mapped_column(ForeignKey("raw_records.id", ondelete="CASCADE"), unique=True)
    marketplace: Mapped[str] = mapped_column(String(32))
    source_id: Mapped[int] = mapped_column(BigInteger)                        # rrdId
    entry_date: Mapped[date | None] = mapped_column(Date)                     # дата строки отчёта (rrDate, МСК)
    currency: Mapped[str | None] = mapped_column(String(8))
    nm_id: Mapped[int | None] = mapped_column(BigInteger)
    vendor_code: Mapped[str | None] = mapped_column(Text)
    sku: Mapped[str | None] = mapped_column(Text)
    product_name: Mapped[str | None] = mapped_column(Text)
    brand: Mapped[str | None] = mapped_column(Text)
    quantity: Mapped[int | None] = mapped_column(Integer)
    source_operation: Mapped[str | None] = mapped_column(Text)               # sellerOperName
    doc_type: Mapped[str | None] = mapped_column(Text)                        # docTypeName
    bonus_type: Mapped[str | None] = mapped_column(Text)                      # bonusTypeName
    source_report_id: Mapped[str | None] = mapped_column(String(40))          # reportId текстом (≥2^53)
    srid: Mapped[str | None] = mapped_column(Text)
    order_id: Mapped[int | None] = mapped_column(BigInteger)
    category: Mapped[str] = mapped_column(String(40))
    status: Mapped[str] = mapped_column(String(16))                           # ok|review|inconsistent|unclassified
    issues: Mapped[list] = mapped_column(JSONB, server_default=text("'[]'::jsonb"))
    normalizer_version: Mapped[int] = mapped_column(Integer)
    normalized_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    __table_args__ = (
        Index("ix_fin_tx_org_account_date", "organization_id", "seller_account_id", "entry_date"),
        Index("ix_fin_tx_org_status", "organization_id", "status"),
    )


class FinancialEntry(Base):
    """Одна денежная величина строки: (line_type, amount). Движок P&L агрегирует только эту таблицу."""

    __tablename__ = "financial_entries"

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    organization_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"))
    seller_account_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("seller_accounts.id", ondelete="CASCADE"))
    transaction_id: Mapped[int] = mapped_column(ForeignKey("financial_transactions.id", ondelete="CASCADE"), index=True)
    entry_date: Mapped[date] = mapped_column(Date)
    currency: Mapped[str] = mapped_column(String(8))
    nm_id: Mapped[int | None] = mapped_column(BigInteger)
    line_type: Mapped[str] = mapped_column(String(60))
    amount: Mapped[Decimal] = mapped_column(Numeric(20, 6))
    __table_args__ = (
        Index("ix_fin_entries_report", "organization_id", "seller_account_id", "entry_date", "line_type"),
    )
