import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Membership, Organization, User


async def list_for_user(db: AsyncSession, user_id: uuid.UUID) -> list[dict]:
    rows = await db.execute(
        select(Membership.organization_id, Organization.name, Membership.role)
        .join(Organization, Organization.id == Membership.organization_id)
        .where(Membership.user_id == user_id, Organization.is_active.is_(True))
        .order_by(Organization.name)
    )
    return [{"organization_id": o, "organization_name": n, "role": r} for o, n, r in rows.all()]


async def list_members(db: AsyncSession, org_id: uuid.UUID) -> list[tuple[Membership, User]]:
    """Участники организации. org_id обязателен: запросов без организации в репозитории нет."""
    rows = await db.execute(
        select(Membership, User)
        .join(User, User.id == Membership.user_id)
        .where(Membership.organization_id == org_id)
        .order_by(User.email)
    )
    return [(m, u) for m, u in rows.all()]
