from fastapi import APIRouter, Depends, Response, status
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession

from app.db.session import get_session

router = APIRouter(tags=["health"])


@router.get("/health")
async def liveness() -> dict[str, str]:
    """Процесс жив. Зависимости не проверяются."""
    return {"status": "ok"}


@router.get("/health/ready")
async def readiness(
    response: Response, session: AsyncSession = Depends(get_session)
) -> dict[str, str]:
    """Готовность: доступна ли база данных."""
    try:
        await session.execute(text("SELECT 1"))
    except Exception:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return {"status": "unavailable", "database": "down"}
    return {"status": "ok", "database": "up"}
