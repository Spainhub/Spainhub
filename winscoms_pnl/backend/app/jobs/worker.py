"""Процесс-воркер:  python -m app.jobs.worker   (отдельный сервис в docker-compose)."""
import asyncio
import logging
import signal

from sqlalchemy.ext.asyncio import async_sessionmaker

from app.core.config import get_settings
from app.core.logging import setup_logging
from app.db.session import dispose_engine, get_engine
from app.integrations.wildberries.client import WildberriesClient
from app.jobs.sync_runner import process_next

log = logging.getLogger("winscoms.worker")
POLL_SECONDS = 10


async def main() -> None:
    cfg = get_settings()
    setup_logging(cfg.log_level)
    maker = async_sessionmaker(get_engine(), expire_on_commit=False)
    client = WildberriesClient()
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        loop.add_signal_handler(sig, stop.set)
    log.info("worker started")
    while not stop.is_set():
        try:
            worked = await process_next(maker, client)
        except Exception:
            log.exception("worker iteration failed")
            worked = False
        if not worked:
            try:
                await asyncio.wait_for(stop.wait(), timeout=POLL_SECONDS)
            except asyncio.TimeoutError:
                pass
    await client.aclose()
    await dispose_engine()
    log.info("worker stopped")


if __name__ == "__main__":
    asyncio.run(main())
