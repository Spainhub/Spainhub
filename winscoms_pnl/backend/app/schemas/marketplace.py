import uuid
from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, SecretStr, field_validator


class SellerAccountCreate(BaseModel):
    marketplace: Literal["wildberries"] = "wildberries"
    name: str = Field(min_length=1, max_length=200)
    token: SecretStr = Field(min_length=10, max_length=4096)

    @field_validator("token")
    @classmethod
    def _strip(cls, v: SecretStr) -> SecretStr:
        s = v.get_secret_value().strip()
        if len(s) < 10 or any(ch.isspace() for ch in s):
            raise ValueError("Некорректный токен")
        return SecretStr(s)


class SellerAccountOut(BaseModel):
    """Токен в ответах API не возвращается никогда — только последние 4 символа."""
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    marketplace: str
    name: str
    token_hint: str | None
    status: str
    last_validated_at: datetime | None
    last_sync_at: datetime | None
    created_at: datetime


class ValidateOut(BaseModel):
    valid: bool
    message: str


class SyncStart(BaseModel):
    months: int | None = Field(default=None, ge=1, le=36)   # по умолчанию settings.history_months


class SyncJobOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    seller_account_id: uuid.UUID
    kind: str
    period_from: date
    period_to: date
    status: str
    pages_fetched: int
    records_fetched: int
    records_saved: int
    attempts: int
    error_code: str | None
    error_message: str | None
    scheduled_at: datetime
    started_at: datetime | None
    finished_at: datetime | None
    created_at: datetime
