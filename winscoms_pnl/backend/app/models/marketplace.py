import uuid
from datetime import date, datetime

from sqlalchemy import (
    BigInteger, CheckConstraint, Date, DateTime, ForeignKey, Identity, Index, Integer, LargeBinary,
    String, Text, UniqueConstraint, func, text,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.db.base import Base


class SellerAccount(Base):
    """Аккаунт продавца на маркетплейсе. Токен хранится только зашифрованным."""

    __tablename__ = "seller_accounts"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    organization_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    marketplace: Mapped[str] = mapped_column(String(32))
    name: Mapped[str] = mapped_column(String(200))
    encrypted_token: Mapped[bytes | None] = mapped_column(LargeBinary)
    token_hint: Mapped[str | None] = mapped_column(String(8))           # последние 4 символа
    status: Mapped[str] = mapped_column(String(20), server_default="active")  # active|auth_error|disconnected
    last_validated_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    last_sync_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    next_request_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))  # не раньше — лимит API
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    __table_args__ = (CheckConstraint("status in ('active','auth_error','disconnected')", name="status_valid"),)


class SyncJob(Base):
    __tablename__ = "sync_jobs"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, server_default=text("gen_random_uuid()"))
    organization_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"), index=True)
    seller_account_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("seller_accounts.id", ondelete="CASCADE"), index=True)
    kind: Mapped[str] = mapped_column(String(16))                       # initial|daily|manual
    period_from: Mapped[date] = mapped_column(Date)                     # даты по Москве (UTC+3)
    period_to: Mapped[date] = mapped_column(Date)
    status: Mapped[str] = mapped_column(String(16), server_default="queued")
    cursor_rrd_id: Mapped[int] = mapped_column(BigInteger, server_default="0")   # чекпоинт пагинации
    pages_fetched: Mapped[int] = mapped_column(Integer, server_default="0")
    records_fetched: Mapped[int] = mapped_column(Integer, server_default="0")
    records_saved: Mapped[int] = mapped_column(Integer, server_default="0")
    attempts: Mapped[int] = mapped_column(Integer, server_default="0")          # подряд неудачных
    error_code: Mapped[str | None] = mapped_column(String(40))
    error_message: Mapped[str | None] = mapped_column(Text)
    scheduled_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    heartbeat_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    __table_args__ = (
        CheckConstraint("status in ('queued','running','succeeded','failed','partial','cancelled')", name="status_valid"),
        # один активный job на аккаунт: параллельные загрузки одного токена исключены
        Index("uq_sync_jobs_one_active_per_account", "seller_account_id", unique=True,
              postgresql_where=text("status in ('queued','running')")),
    )


class RawRecord(Base):
    """Исходная строка ответа маркетплейса без потерь (JSONB). Дедупликация по (аккаунт, endpoint, source_id)."""

    __tablename__ = "raw_records"

    id: Mapped[int] = mapped_column(BigInteger, Identity(), primary_key=True)
    organization_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("organizations.id", ondelete="CASCADE"))
    seller_account_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("seller_accounts.id", ondelete="CASCADE"))
    source_endpoint: Mapped[str] = mapped_column(String(100))
    source_id: Mapped[int] = mapped_column(BigInteger)                  # для WB — rrdId
    sync_job_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("sync_jobs.id", ondelete="SET NULL"))
    payload: Mapped[dict] = mapped_column(JSONB)
    fetched_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    __table_args__ = (
        UniqueConstraint("seller_account_id", "source_endpoint", "source_id", name="uq_raw_records_source"),
        Index("ix_raw_records_org_account", "organization_id", "seller_account_id"),
    )
