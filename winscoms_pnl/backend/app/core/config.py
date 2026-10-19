from functools import lru_cache
from typing import Literal

from pydantic import model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_PLACEHOLDER = "CHANGE_ME"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_env: Literal["development", "production", "test"] = "development"
    log_level: str = "INFO"
    database_url: str = "postgresql+asyncpg://winscoms:winscoms@localhost:5432/winscoms"
    # URL владельца схемы для Alembic; если не задан — используется database_url.
    migration_database_url: str | None = None
    secret_key: str = _PLACEHOLDER
    # Ключи Fernet через запятую; первый шифрует, остальные только расшифровывают (ротация).
    encryption_keys: str = _PLACEHOLDER
    session_ttl_hours: int = 168        # абсолютный срок жизни сессии
    session_idle_hours: int = 12        # сессия без активности дольше этого срока недействительна
    wb_finance_api_url: str = "https://finance-api.wildberries.ru"
    wb_min_interval_seconds: int = 65     # лимит токена: 1 запрос/мин + запас
    wb_page_limit: int = 20000            # записей на страницу (API допускает до 100000)
    wb_request_timeout_seconds: int = 120
    wb_report_period: str = "daily"       # параметр period; ТРЕБУЕТ ПОДТВЕРЖДЕНИЯ по документации
    history_months: int = 3               # глубина первичной загрузки

    @model_validator(mode="after")
    def _forbid_unsafe_production(self) -> "Settings":
        if self.app_env != "production":
            return self
        missing = [
            name
            for name in ("secret_key", "encryption_keys")
            if not getattr(self, name) or _PLACEHOLDER in getattr(self, name)
        ]
        if "winscoms:winscoms@" in self.database_url or _PLACEHOLDER in self.database_url:
            missing.append("database_url")
        if missing:
            raise ValueError(
                "Небезопасная конфигурация production, задайте через окружение: "
                + ", ".join(missing)
            )
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
