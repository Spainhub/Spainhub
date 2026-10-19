"""Аккаунты продавцов, задания синхронизации, сырые записи (все под RLS по организации).

Revision ID: 0002
Revises: 0001
"""
import os
import re

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0002"
down_revision = "0001"
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
    pk = dict(server_default=sa.text("gen_random_uuid()"))
    now = dict(server_default=sa.func.now())
    uuid_t = postgresql.UUID(as_uuid=True)
    ts = sa.DateTime(timezone=True)

    op.create_table(
        "seller_accounts",
        sa.Column("id", uuid_t, primary_key=True, **pk),
        sa.Column("organization_id", uuid_t, sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("marketplace", sa.String(32), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("encrypted_token", sa.LargeBinary),
        sa.Column("token_hint", sa.String(8)),
        sa.Column("status", sa.String(20), nullable=False, server_default="active"),
        sa.Column("last_validated_at", ts),
        sa.Column("last_sync_at", ts),
        sa.Column("next_request_at", ts),
        sa.Column("created_by", uuid_t, sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("created_at", ts, nullable=False, **now),
        sa.CheckConstraint("status in ('active','auth_error','disconnected')", name="ck_seller_accounts_status_valid"),
    )
    op.create_index("ix_seller_accounts_organization_id", "seller_accounts", ["organization_id"])

    op.create_table(
        "sync_jobs",
        sa.Column("id", uuid_t, primary_key=True, **pk),
        sa.Column("organization_id", uuid_t, sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("seller_account_id", uuid_t, sa.ForeignKey("seller_accounts.id", ondelete="CASCADE"), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("period_from", sa.Date, nullable=False),
        sa.Column("period_to", sa.Date, nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="queued"),
        sa.Column("cursor_rrd_id", sa.BigInteger, nullable=False, server_default="0"),
        sa.Column("pages_fetched", sa.Integer, nullable=False, server_default="0"),
        sa.Column("records_fetched", sa.Integer, nullable=False, server_default="0"),
        sa.Column("records_saved", sa.Integer, nullable=False, server_default="0"),
        sa.Column("attempts", sa.Integer, nullable=False, server_default="0"),
        sa.Column("error_code", sa.String(40)),
        sa.Column("error_message", sa.Text),
        sa.Column("scheduled_at", ts, nullable=False, **now),
        sa.Column("heartbeat_at", ts),
        sa.Column("started_at", ts),
        sa.Column("finished_at", ts),
        sa.Column("created_by", uuid_t, sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("created_at", ts, nullable=False, **now),
        sa.CheckConstraint("status in ('queued','running','succeeded','failed','partial','cancelled')", name="ck_sync_jobs_status_valid"),
    )
    op.create_index("ix_sync_jobs_organization_id", "sync_jobs", ["organization_id"])
    op.create_index("ix_sync_jobs_seller_account_id", "sync_jobs", ["seller_account_id"])
    op.create_index(
        "uq_sync_jobs_one_active_per_account", "sync_jobs", ["seller_account_id"], unique=True,
        postgresql_where=sa.text("status in ('queued','running')"),
    )

    op.create_table(
        "raw_records",
        sa.Column("id", sa.BigInteger, sa.Identity(), primary_key=True),
        sa.Column("organization_id", uuid_t, sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("seller_account_id", uuid_t, sa.ForeignKey("seller_accounts.id", ondelete="CASCADE"), nullable=False),
        sa.Column("source_endpoint", sa.String(100), nullable=False),
        sa.Column("source_id", sa.BigInteger, nullable=False),
        sa.Column("sync_job_id", uuid_t, sa.ForeignKey("sync_jobs.id", ondelete="SET NULL")),
        sa.Column("payload", postgresql.JSONB, nullable=False),
        sa.Column("fetched_at", ts, nullable=False, **now),
        sa.UniqueConstraint("seller_account_id", "source_endpoint", "source_id", name="uq_raw_records_source"),
    )
    op.create_index("ix_raw_records_org_account", "raw_records", ["organization_id", "seller_account_id"])

    for t in ("seller_accounts", "sync_jobs", "raw_records"):
        op.execute(f"ALTER TABLE {t} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {t} FORCE ROW LEVEL SECURITY")
        op.execute(_POLICY.format(t=t))

    # последовательность identity у raw_records нужна роли приложения; для будущих — по умолчанию
    role = os.environ.get("APP_DB_USER", "winscoms_app")
    if not re.match(r"^[a-z_][a-z0-9_]{0,62}$", role):
        raise RuntimeError("APP_DB_USER: допустимы только строчные латинские буквы, цифры и _")
    op.execute(f"GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO {role}")
    op.execute(f"ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO {role}")


def downgrade() -> None:
    for t in ("raw_records", "sync_jobs", "seller_accounts"):
        op.drop_table(t)
