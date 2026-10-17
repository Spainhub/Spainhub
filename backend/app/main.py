import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.api.v1.router import api_router
from app.core.config import get_settings
from app.core.logging import setup_logging
from app.db.session import dispose_engine

log = logging.getLogger("winscoms")


@asynccontextmanager
async def lifespan(_: FastAPI) -> AsyncIterator[None]:
    settings = get_settings()  # падает на старте при небезопасной конфигурации production
    setup_logging(settings.log_level)
    log.info("startup", extra={"ctx": {"env": settings.app_env}})
    yield
    await dispose_engine()
    log.info("shutdown")


def create_app() -> FastAPI:
    settings = get_settings()
    docs = None if settings.app_env == "production" else "/api/docs"
    app = FastAPI(title="WINSCOMS", version="0.1.0", lifespan=lifespan, docs_url=docs, redoc_url=None)
    app.include_router(api_router)
    return app


app = create_app()
