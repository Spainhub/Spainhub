#!/usr/bin/env bash
# Создаёт или дополняет .env. Секреты на экран НЕ выводятся.
#  - .env нет      → создаётся из .env.example с новыми секретами.
#  - .env уже есть → добавляются недостающие ключи (роль приложения БД: APP_DB_USER/PASSWORD,
#                    MIGRATION_DATABASE_URL); существующие значения не меняются.
# REUSE_DB=1 — при создании взять POSTGRES_* из запущенного контейнера БД (том уже инициализирован).
set -euo pipefail
APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$APP_DIR"
[ -f .env.example ] || { echo "Нет .env.example"; exit 1; }

DB_CONTAINER="${DB_CONTAINER:-winscoms_pnl-db-1}"
export REUSE_DB="${REUSE_DB:-0}" DB_CONTAINER
if [ ! -f .env ] && [ "$REUSE_DB" = "1" ]; then
  export PG_USER="$(docker exec "$DB_CONTAINER" printenv POSTGRES_USER)"
  export PG_PASS="$(docker exec "$DB_CONTAINER" printenv POSTGRES_PASSWORD)"
  export PG_DB="$(docker exec "$DB_CONTAINER" printenv POSTGRES_DB)"
fi

umask 077
python3 - <<'PY'
import base64, os, re, secrets
from urllib.parse import quote, urlsplit, urlunsplit

def parse(text):
    d = {}
    for line in text.splitlines():
        m = re.match(r"^([A-Z_]+)=([^#\n]*)", line)
        if m:
            d[m.group(1)] = m.group(2).strip()
    return d

def set_line(lines, key, value):
    for i, l in enumerate(lines):
        if l.startswith(key + "="):
            lines[i] = f"{key}={value}"
            return
    lines.append(f"{key}={value}")

exists = os.path.exists(".env")
if not exists:
    src = open(".env.example", encoding="utf-8").read()
    user = os.environ.get("PG_USER") or "winscoms"
    pw = os.environ.get("PG_PASS") or secrets.token_urlsafe(24)
    db = os.environ.get("PG_DB") or "winscoms"
    lines = src.splitlines()
    app_user, app_pw = "winscoms_app", secrets.token_urlsafe(24)
    owner_url = f"postgresql+asyncpg://{quote(user, safe='')}:{quote(pw, safe='')}@db:5432/{db}"
    for k, v in {
        "APP_ENV": "production", "POSTGRES_USER": user, "POSTGRES_PASSWORD": pw, "POSTGRES_DB": db,
        "MIGRATION_DATABASE_URL": owner_url,
        "DATABASE_URL": f"postgresql+asyncpg://{app_user}:{quote(app_pw, safe='')}@db:5432/{db}",
        "APP_DB_USER": app_user, "APP_DB_PASSWORD": app_pw,
        "SECRET_KEY": secrets.token_urlsafe(48),
        "ENCRYPTION_KEYS": base64.urlsafe_b64encode(os.urandom(32)).decode(),
    }.items():
        set_line(lines, k, v)
    msg = ".env создан"
else:
    lines = open(".env", encoding="utf-8").read().splitlines()
    cur = parse("\n".join(lines))
    changed = []
    if "MIGRATION_DATABASE_URL" not in cur:
        # прежний DATABASE_URL (владелец схемы) становится URL для миграций
        set_line(lines, "MIGRATION_DATABASE_URL", cur["DATABASE_URL"])
        changed.append("MIGRATION_DATABASE_URL")
        app_user = cur.get("APP_DB_USER") or "winscoms_app"
        app_pw = cur.get("APP_DB_PASSWORD") or secrets.token_urlsafe(24)
        parts = urlsplit(cur["DATABASE_URL"])
        netloc = f"{app_user}:{quote(app_pw, safe='')}@{parts.hostname}" + (f":{parts.port}" if parts.port else "")
        set_line(lines, "DATABASE_URL", urlunsplit(parts._replace(netloc=netloc)))
        set_line(lines, "APP_DB_USER", app_user)
        set_line(lines, "APP_DB_PASSWORD", app_pw)
        changed += ["DATABASE_URL (роль приложения)", "APP_DB_USER", "APP_DB_PASSWORD"]
    msg = ".env дополнен: " + (", ".join(changed) if changed else "изменений не требуется")
open(".env", "w", encoding="utf-8").write("\n".join(lines) + "\n")
print(msg)
PY
chmod 600 .env
echo "Готово ($APP_DIR/.env). Ключ ENCRYPTION_KEYS храните отдельно (менеджер паролей)."
