"""Учётная политика, себестоимость, ручные записи (RLS по организации).

Revision ID: 0004
Revises: 0003
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0004"
down_revision = "0003"
branch_labels = None
depends_on = None

_POLICY = """
CREATE POLICY {t}_isolation ON {t}
USING (organization_id = nullif(current_setting('app.current_org', true), '')::uuid
       OR current_setting('app.is_platform_admin', true) = 'on')
WITH CHECK (organization_id = nullif(current_setting('app.current_org', true), '')::uuid
       OR current_setting('app.is_platform_admin', true) = 'on')
"""


def upgrade() -> None:
    uuid_t = postgresql.UUID(as_uuid=True)
    ts = sa.DateTime(timezone=True)
    org = lambda **kw: sa.Column("organization_id", uuid_t, sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False, **kw)
    user = lambda n: sa.Column(n, uuid_t, sa.ForeignKey("users.id", ondelete="SET NULL"))

    op.create_table(
        "org_settings",
        sa.Column("organization_id", uuid_t, sa.ForeignKey("organizations.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("tax_regime", sa.String(16), nullable=False),
        sa.Column("usn_rate", sa.Numeric(6, 3), nullable=False, server_default="6"),
        sa.Column("profit_tax_rate", sa.Numeric(6, 3), nullable=False, server_default="20"),
        sa.Column("vat_sales_rate", sa.Numeric(6, 3), nullable=False, server_default="22"),
        sa.Column("vat_services_rate", sa.Numeric(6, 3), nullable=False, server_default="22"),
        user("updated_by"),
        sa.Column("updated_at", ts, nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("tax_regime in ('usn_income','osno')", name="ck_org_settings_regime_valid"),
    )
    op.create_table(
        "product_costs",
        sa.Column("id", sa.BigInteger, sa.Identity(), primary_key=True),
        org(),
        sa.Column("nm_id", sa.BigInteger, nullable=False),
        sa.Column("vendor_code", sa.Text),
        sa.Column("cost_per_unit", sa.Numeric(20, 6), nullable=False),
        sa.Column("currency", sa.String(8), nullable=False, server_default="RUB"),
        sa.Column("valid_from", sa.Date, nullable=False),
        user("created_by"),
        sa.Column("created_at", ts, nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("cost_per_unit >= 0", name="ck_product_costs_cost_nonnegative"),
    )
    op.create_index("uq_product_costs_nm_from", "product_costs", ["organization_id", "nm_id", "currency", "valid_from"], unique=True)
    op.create_table(
        "manual_entries",
        sa.Column("id", sa.BigInteger, sa.Identity(), primary_key=True),
        org(),
        sa.Column("entry_date", sa.Date, nullable=False),
        sa.Column("category", sa.String(40), nullable=False),
        sa.Column("amount", sa.Numeric(20, 6), nullable=False),
        sa.Column("currency", sa.String(8), nullable=False, server_default="RUB"),
        sa.Column("description", sa.Text),
        sa.Column("marketplace", sa.String(32)),
        sa.Column("seller_account_id", uuid_t, sa.ForeignKey("seller_accounts.id", ondelete="SET NULL")),
        user("created_by"),
        sa.Column("created_at", ts, nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", ts, nullable=False, server_default=sa.func.now()),
        sa.CheckConstraint("amount >= 0", name="ck_manual_entries_amount_nonnegative"),
    )
    op.create_index("ix_manual_entries_organization_id", "manual_entries", ["organization_id"])
    op.create_index("ix_manual_entries_org_date_cat", "manual_entries", ["organization_id", "entry_date", "category"])
    for t in ("org_settings", "product_costs", "manual_entries"):
        op.execute(f"ALTER TABLE {t} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {t} FORCE ROW LEVEL SECURITY")
        op.execute(_POLICY.format(t=t))


def downgrade() -> None:
    for t in ("manual_entries", "product_costs", "org_settings"):
        op.drop_table(t)
