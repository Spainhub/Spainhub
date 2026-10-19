import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.models import AuditEvent


def record(
    db: AsyncSession,
    action: str,
    *,
    actor: uuid.UUID | None = None,
    org: uuid.UUID | None = None,
    ip: str | None = None,
    **details: object,
) -> None:
    """Добавляет событие аудита в текущую транзакцию. Секреты в details передавать нельзя."""
    db.add(AuditEvent(action=action, actor_user_id=actor, organization_id=org, ip=ip, details=details))
