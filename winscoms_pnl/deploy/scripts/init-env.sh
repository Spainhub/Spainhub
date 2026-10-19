#!/usr/bin/env bash
# Создаёт .env из .env.example с новыми секретами. Секреты на экран НЕ выводятся.
# Если .env уже есть — ничего не меняет.
# REUSE_DB=1 — взять POSTGRES_USER/PASSWORD/DB из уже запущенного контейнера БД
#              (нужно, когда том winscoms_pnl_pgdata уже инициализирован старым паролем).
set -euo pipefail
APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$APP_DIR"
[ -f .env ] && { echo ".env уже существует — не трогаю"; exit 0; }
[ -f .env.example ] || { echo "Нет .env.example"; exit 1; }

DB_CONTAINER="${DB_CONTAINER:-winscoms_pnl-db-1}"
export REUSE_DB="${REUSE_DB:-0}" DB_CONTAINER
if [ "$REUSE_DB" = "1" ]; then
  export PG_USER="$(docker exec "$DB_CONTAINER" printenv POSTGRES_USER)"
  export PG_PASS="$(docker exec "$DB_CONTAINER" printenv POSTGRES_PASSWORD)"
  export PG_DB="$(docker exec "$DB_CONTAINER" printenv POSTGRES_DB)"
fi

umask 077
python3 - <<'PY'
import base64, os, re, secrets
from urllib.parse import quote

src = open(".env.example", encoding="utf-8").read()
user = os.environ.get("PG_USER") or "winscoms"
pw = os.environ.get("PG_PASS") or secrets.token_urlsafe(24)
db = os.environ.get("PG_DB") or "winscoms"
values = {
    "APP_ENV": "production",
    "POSTGRES_USER": user,
    "POSTGRES_PASSWORD": pw,
    "POSTGRES_DB": db,
    "DATABASE_URL": f"postgresql+asyncpg://{quote(user, safe='')}:{quote(pw, safe='')}@db:5432/{db}",
    "SECRET_KEY": secrets.token_urlsafe(48),
    "ENCRYPTION_KEYS": base64.urlsafe_b64encode(os.urandom(32)).decode(),
}
out = []
for line in src.splitlines():
    m = re.match(r"^([A-Z_]+)=", line)
    if m and m.group(1) in values:
        line = f"{m.group(1)}={values.pop(m.group(1))}"
    out.append(line)
open(".env", "w", encoding="utf-8").write("\n".join(out) + "\n")
PY
chmod 600 .env
echo ".env создан ($APP_DIR/.env). Ключ ENCRYPTION_KEYS сохраните отдельно (например, в менеджере паролей)."
