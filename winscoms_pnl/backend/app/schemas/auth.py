import uuid
from typing import Annotated

from pydantic import BaseModel, ConfigDict, EmailStr, Field, StringConstraints

from app.core.security import MIN_PASSWORD_LENGTH

Password = Annotated[str, StringConstraints(min_length=MIN_PASSWORD_LENGTH, max_length=200)]
RoleName = Annotated[str, StringConstraints(pattern="^(admin|member|viewer)$")]


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=200)


class MembershipOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    organization_id: uuid.UUID
    role: str


class UserOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    email: str
    full_name: str | None
    is_active: bool
    is_platform_admin: bool


class MeOut(BaseModel):
    user: UserOut
    memberships: list[MembershipOut]
    csrf_token: str


class OrganizationCreate(BaseModel):
    name: str = Field(min_length=1, max_length=200)


class OrganizationOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    name: str
    is_active: bool


class UserCreate(BaseModel):
    email: EmailStr
    password: Password
    full_name: str | None = Field(default=None, max_length=200)
    organization_id: uuid.UUID | None = None
    role: RoleName = "member"


class UserUpdate(BaseModel):
    is_active: bool | None = None
    password: Password | None = None


class MemberAdd(BaseModel):
    user_id: uuid.UUID
    role: RoleName


class MemberOut(BaseModel):
    user_id: uuid.UUID
    email: str
    full_name: str | None
    role: str
