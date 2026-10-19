import uuid
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import BigInteger, CheckConstraint, Date, DateTime, ForeignKey, Index, Numeric, String, Text, func, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class OrgSettings(Base):
    """Учётная политика организации (одна строка на организацию)."""

    __tablename__ = "org_settings"

    organization_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), primary_key=True)
    tax_regime: Mapped[str] = mapped_column(String(16))                               # usn_income | osno
    usn_rate: Mapped[Decimal] = mapped_column(Numeric(6, 3), server_default="6")       # % от выручки
    profit_tax_rate: Mapped[Decimal] = mapped_column(Numeric(6, 3), server_default="20")
    vat_sales_rate: Mapped[Decimal] = mapped_column(Numeric(6, 3), server_default="22")     # НДС в цене продажи (ОСНО)
    vat_services_rate: Mapped[Decimal] = mapped_column(Numeric(6, 3), server_default="22")  # НДС в услугах WB (ОСНО)
    updated_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    __table_args__ = (CheckConstraint("tax_regime in ('usn_income','osno')", name="regime_valid"),)


class ProductCost(Base):
    """Себестоимость единицы товара; действует с valid_from до следующей записи по тому же nm_id."""

    __tablename__ = "product_costs"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    organization_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"))
    nm_id: Mapped[int] = mapped_column(BigInteger)
    vendor_code: Mapped[str | None] = mapped_column(Text)
    cost_per_unit: Mapped[Decimal] = mapped_column(Numeric(20, 6))
    currency: Mapped[str] = mapped_column(String(8), server_default="RUB")
    valid_from: Mapped[date] = mapped_column(Date)
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    __table_args__ = (
        CheckConstraint("cost_per_unit >= 0", name="cost_nonnegative"),
        Index("uq_product_costs_nm_from", "organization_id", "nm_id", "currency", "valid_from", unique=True),
    )


class ManualEntry(Base):
    """Ручной расход/доход (OPEX, внешняя реклама, налоги, корректировки…). Сумма положительная; смысл задаёт category."""

    __tablename__ = "manual_entries"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    organization_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    entry_date: Mapped[date] = mapped_column(Date)
    category: Mapped[str] = mapped_column(String(40))
    amount: Mapped[Decimal] = mapped_column(Numeric(20, 6))
    currency: Mapped[str] = mapped_column(String(8), server_default="RUB")
    description: Mapped[str | None] = mapped_column(Text)
    marketplace: Mapped[str | None] = mapped_column(String(32))
    seller_account_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("seller_accounts.id", ondelete="SET NULL"))
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    __table_args__ = (
        CheckConstraint("amount >= 0", name="amount_nonnegative"),
        Index("ix_manual_entries_org_date_cat", "organization_id", "entry_date", "category"),
    )
