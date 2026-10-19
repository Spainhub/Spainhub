import uuid
from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints

Currency = Annotated[str, StringConstraints(pattern=r"^[A-Z]{3}$")]


class SettingsIn(BaseModel):
    tax_regime: Literal["usn_income", "osno"]
    usn_rate: Decimal = Field(default=Decimal("6"), ge=0, le=100, max_digits=6, decimal_places=3)
    profit_tax_rate: Decimal = Field(default=Decimal("20"), ge=0, le=100, max_digits=6, decimal_places=3)
    vat_sales_rate: Decimal = Field(default=Decimal("22"), ge=0, le=100, max_digits=6, decimal_places=3)
    vat_services_rate: Decimal = Field(default=Decimal("22"), ge=0, le=100, max_digits=6, decimal_places=3)


class SettingsOut(SettingsIn):
    model_config = ConfigDict(from_attributes=True)
    updated_at: datetime | None = None


class ManualEntryIn(BaseModel):
    entry_date: date
    category: str
    amount: Decimal = Field(ge=0, max_digits=20, decimal_places=6)
    currency: Currency = "RUB"
    description: str | None = Field(default=None, max_length=1000)
    seller_account_id: uuid.UUID | None = None


class ManualEntryOut(ManualEntryIn):
    model_config = ConfigDict(from_attributes=True)
    id: int
    marketplace: str | None
    created_by: uuid.UUID | None
    created_at: datetime
    updated_at: datetime


class CostOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: int
    nm_id: int
    vendor_code: str | None
    cost_per_unit: Decimal
    currency: str
    valid_from: date
