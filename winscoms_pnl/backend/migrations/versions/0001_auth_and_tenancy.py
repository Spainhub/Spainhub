"""Пользователи, организации, членство, сессии, аудит; RLS на memberships; роль приложения.

Revision ID: 0001
Revises:
"""
import os
import re

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0001"
down_revision = None
branch_labels = None
depends_on = None

_NAME_RE = re.compile(r"^[a-z_][a-z0-9_]{0,62}$")


def _app_role() -> tuple[str, str]:
    name = os.environ.get("APP_DB_USER", "winscoms_app")
    password = os.environ.get("APP_DB_PASSWORD", "")
    if not _NAME_RE.match(name):
        raise RuntimeError("APP_DB_USER: допустимы только строчные латинские буквы, цифры и _")
    if len(password) < 16:
        raise RuntimeError("Задайте APP_DB_PASSWORD (не короче 16 символов) — пароль роли приложения в БД")
    return name, password


def upgrade() -> None:
    uuid_pk = dict(server_default=sa.text("gen_random_uuid()"))
    now = dict(server_default=sa.func.now())

    op.create_table(
        "users",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, **uuid_pk),
        sa.Column("email", sa.String(320), nullable=False),
        sa.Column("password_hash", sa.String(255), nullable=False),
        sa.Column("full_name", sa.String(200)),
        sa.Column("is_active", sa.Boolean, nullable=False, server_default=sa.text("true")),
        sa.Column("is_platform_admin", sa.Boolean, nullable=False, server_default=sa.text("false")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, **now),
        sa.UniqueConstraint("email", name="uq_users_email"),
        sa.CheckConstraint("email = lower(email)", name="ck_users_email_lowercase"),
    )
    op.create_table(
        "organizations",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, **uuid_pk),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("is_active", sa.Boolean, nullable=False, server_default=sa.text("true")),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, **now),
    )
    op.create_table(
        "memberships",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, **uuid_pk),
        sa.Column("organization_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("organizations.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("role", sa.String(20), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, **now),
        sa.UniqueConstraint("organization_id", "user_id", name="uq_memberships_organization_id"),
        sa.CheckConstraint("role in ('admin','member','viewer')", name="ck_memberships_role_valid"),
    )
    op.create_index("ix_memberships_organization_id", "memberships", ["organization_id"])
    op.create_index("ix_memberships_user_id", "memberships", ["user_id"])
    op.create_table(
        "auth_sessions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, **uuid_pk),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("token_hash", sa.String(64), nullable=False),
        sa.Column("csrf_token", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, **now),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False, **now),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
        sa.UniqueConstraint("token_hash", name="uq_auth_sessions_token_hash"),
    )
    op.create_index("ix_auth_sessions_user_id", "auth_sessions", ["user_id"])
    op.create_table(
        "audit_events",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True, **uuid_pk),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, **now),
        sa.Column("actor_user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL")),
        sa.Column("organization_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("organizations.id", ondelete="SET NULL")),
        sa.Column("action", sa.String(80), nullable=False),
        sa.Column("ip", sa.String(64)),
        sa.Column("details", postgresql.JSONB, nullable=False, server_default=sa.text("'{}'::jsonb")),
    )
    op.create_index("ix_audit_events_created_at", "audit_events", ["created_at"])
    op.create_index("ix_audit_events_action", "audit_events", ["action"])

    # --- Row-Level Security: второй рубеж изоляции поверх проверок в приложении ---
    # Строка видна, если: это организация текущего запроса, ИЛИ это членство самого пользователя,
    # ИЛИ запрос выполняет администратор платформы. Переменные задаёт приложение в начале запроса.
    op.execute("ALTER TABLE memberships ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE memberships FORCE ROW LEVEL SECURITY")
    op.execute(
        """
        CREATE POLICY memberships_isolation ON memberships
        USING (
            organization_id = nullif(current_setting('app.current_org', true), '')::uuid
            OR user_id = nullif(current_setting('app.current_user', true), '')::uuid
            OR current_setting('app.is_platform_admin', true) = 'on'
        )
        WITH CHECK (
            organization_id = nullif(current_setting('app.current_org', true), '')::uuid
            OR current_setting('app.is_platform_admin', true) = 'on'
        )
        """
    )

    # --- Роль приложения: без прав суперпользователя, не владелец таблиц → RLS действует ---
    name, password = _app_role()
    pw = password.replace("'", "''")
    op.execute(
        f"""
        DO $$ BEGIN
            IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '{name}') THEN
                CREATE ROLE {name} LOGIN PASSWORD '{pw}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
            ELSE
                ALTER ROLE {name} LOGIN PASSWORD '{pw}' NOSUPERUSER NOBYPASSRLS;
            END IF;
        END $$;
        """
    )
    op.execute(f"DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), '{name}'); END $$")
    op.execute(f"GRANT USAGE ON SCHEMA public TO {name}")
    op.execute(f"GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO {name}")
    op.execute(f"REVOKE ALL ON TABLE alembic_version FROM {name}")
    op.execute(f"ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO {name}")


def downgrade() -> None:
    for t in ("audit_events", "auth_sessions", "memberships", "organizations", "users"):
        op.drop_table(t)
