import pytest
from pydantic import ValidationError

from app.core.config import Settings

_GOOD = dict(
    app_env="production",
    secret_key="s" * 48,
    encryption_keys="k" * 44,
    database_url="postgresql+asyncpg://u:strongpw@db:5432/x",
)


def test_production_rejects_placeholders():
    with pytest.raises(ValidationError):
        Settings(_env_file=None, app_env="production")


def test_production_rejects_default_db_password():
    bad = {**_GOOD, "database_url": "postgresql+asyncpg://winscoms:winscoms@db:5432/x"}
    with pytest.raises(ValidationError):
        Settings(_env_file=None, **bad)


def test_production_accepts_real_values():
    assert Settings(_env_file=None, **_GOOD).app_env == "production"


def test_development_allows_defaults():
    assert Settings(_env_file=None).app_env == "development"
