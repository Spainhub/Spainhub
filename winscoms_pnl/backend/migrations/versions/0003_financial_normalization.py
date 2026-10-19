"""Нормализованные транзакции и их денежные строки (RLS по организации).

Revision ID: 0003
Revises: 0002
"""
import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0003"
down_revision = "0002"
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
    org = lambda: sa.Column("organization_id", uuid_t, sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False)
    acc = lambda: sa.Column("seller_account_id", uuid_t, sa.ForeignKey("seller_accounts.id", ondelete="CASCADE"), nullable=False)

    op.create_table(
        "financial_transactions",
        sa.Column("id", sa.BigInteger, sa.Identity(), primary_key=True),
        org(), acc(),
        sa.Column("raw_record_id", sa.BigInteger, sa.ForeignKey("raw_records.id", ondelete="CASCADE"), nullable=False),
        sa.Column("marketplace", sa.String(32), nullable=False),
        sa.Column("source_id", sa.BigInteger, nullable=False),
        sa.Column("entry_date", sa.Date),
        sa.Column("currency", sa.String(8)),
        sa.Column("nm_id", sa.BigInteger),
        sa.Column("vendor_code", sa.Text), sa.Column("sku", sa.Text), sa.Column("product_name", sa.Text), sa.Column("brand", sa.Text),
        sa.Column("quantity", sa.Integer),
        sa.Column("source_operation", sa.Text), sa.Column("doc_type", sa.Text), sa.Column("bonus_type", sa.Text),
        sa.Column("source_report_id", sa.String(40)),
        sa.Column("srid", sa.Text),
        sa.Column("order_id", sa.BigInteger),
        sa.Column("category", sa.String(40), nullable=False),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("issues", postgresql.JSONB, nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("normalizer_version", sa.Integer, nullable=False),
        sa.Column("normalized_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("raw_record_id", name="uq_financial_transactions_raw_record_id"),
        sa.CheckConstraint("status in ('ok','review','inconsistent','unclassified')", name="ck_financial_transactions_status_valid"),
    )
    op.create_index("ix_fin_tx_org_account_date", "financial_transactions", ["organization_id", "seller_account_id", "entry_date"])
    op.create_index("ix_fin_tx_org_status", "financial_transactions", ["organization_id", "status"])

    op.create_table(
        "financial_entries",
        sa.Column("id", sa.BigInteger, sa.Identity(), primary_key=True),
        org(), acc(),
        sa.Column("transaction_id", sa.BigInteger, sa.ForeignKey("financial_transactions.id", ondelete="CASCADE"), nullable=False),
        sa.Column("entry_date", sa.Date, nullable=False),
        sa.Column("currency", sa.String(8), nullable=False),
        sa.Column("nm_id", sa.BigInteger),
        sa.Column("line_type", sa.String(60), nullable=False),
        sa.Column("amount", sa.Numeric(20, 6), nullable=False),
    )
    op.create_index("ix_financial_entries_transaction_id", "financial_entries", ["transaction_id"])
    op.create_index("ix_fin_entries_report", "financial_entries", ["organization_id", "seller_account_id", "entry_date", "line_type"])

    for t in ("financial_transactions", "financial_entries"):
        op.execute(f"ALTER TABLE {t} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {t} FORCE ROW LEVEL SECURITY")
        op.execute(_POLICY.format(t=t))


def downgrade() -> None:
    op.drop_table("financial_entries")
    op.drop_table("financial_transactions")
