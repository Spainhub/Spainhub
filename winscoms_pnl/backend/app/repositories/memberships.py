import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import Membership, User


async def list_for_user(db: AsyncSession, user_id: uuid.UUID) -> list[Membership]:
    return list((await db.execute(select(Membership).where(Membership.user_id == user_id))).scalars())


async def list_members(db: AsyncSession, org_id: uuid.UUID) -> list[tuple[Membership, User]]:
    """Участники организации. org_id обязателен: запросов без организации в репозитории нет."""
    rows = await db.execute(
        select(Membership, User)
        .join(User, User.id == Membership.user_id)
        .where(Membership.organization_id == org_id)
        .order_by(User.email)
    )
    return [(m, u) for m, u in rows.all()]
