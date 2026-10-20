#!/usr/bin/env bash
# Безопасный деплой: сначала сборка (старая версия продолжает работать), потом замена,
# проверка готовности и автоматический откат на предыдущий образ при неудаче.
# Не трогает .env и том с базой данных.
set -euo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$APP_DIR"
[ -f .env ] || { echo "ERROR: $APP_DIR/.env не найден (создайте из .env.example)"; exit 2; }

exec 9>/tmp/winscoms_pnl_deploy.lock
flock -n 9 || { echo "Деплой уже выполняется"; exit 3; }

PROXY_PORT="$(grep -E '^PROXY_PORT=' .env | head -1 | cut -d= -f2 | cut -d' ' -f1)"
PROXY_PORT="${PROXY_PORT:-8091}"
log() { echo "[$(date '+%F %T')] $*"; }
IMAGES=(winscoms_pnl-backend winscoms_pnl-frontend)

wait_ready() {
  for _ in $(seq 1 40); do
    if curl -fsS "http://127.0.0.1:${PROXY_PORT}/api/v1/health/ready" >/dev/null 2>&1; then return 0; fi
    sleep 3
  done
  return 1
}

log "Сохраняю текущие образы как :previous"
for img in "${IMAGES[@]}"; do
  docker image inspect "$img:latest" >/dev/null 2>&1 && docker tag "$img:latest" "$img:previous" || true
done

log "Сборка (работающая версия не останавливается)"
docker compose build            # при ошибке сборки скрипт прерывается, старая версия продолжает работать

if compgen -G "backend/migrations/versions/*.py" >/dev/null; then
  grep -q '^APP_DB_PASSWORD=.\{16,\}' .env || { echo "ERROR: в .env нет APP_DB_PASSWORD. Выполните: bash deploy/scripts/init-env.sh"; exit 2; }
  log "Бэкап БД перед миграцией"
  docker compose up -d db
  mkdir -p "$HOME/backups"
  BK="$HOME/backups/pre-migration_$(date +%F_%H%M%S).sql.gz"
  docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip > "$BK" \
    || { echo "ERROR: не удалось сделать бэкап, миграция отменена"; rm -f "$BK"; exit 2; }
  log "Бэкап: $BK. Миграции БД"
  docker compose run --rm backend alembic upgrade head
fi

log "Запуск новой версии"
docker compose up -d --remove-orphans
# прокси перезапускается всегда: он подхватывает новый nginx.conf и новые адреса пересозданных контейнеров
docker compose restart proxy >/dev/null

if wait_ready; then
  log "OK: приложение готово"
  docker image prune -f >/dev/null 2>&1 || true
  exit 0
fi

log "ОШИБКА: приложение не стало готовым. Откат на :previous"
echo "--- ответ через прокси:"; curl -sS -m 5 -i "http://127.0.0.1:${PROXY_PORT}/api/v1/health/ready" 2>&1 | head -15 || true
echo "--- логи proxy:"; docker compose logs --tail=15 proxy || true
echo "--- логи backend:"; docker compose logs --tail=40 backend || true
for img in "${IMAGES[@]}"; do
  docker image inspect "$img:previous" >/dev/null 2>&1 && docker tag "$img:previous" "$img:latest" || true
done
docker compose up -d --no-build --remove-orphans
docker compose restart proxy >/dev/null
wait_ready && log "Откат выполнен, работает предыдущая версия" || log "Откат не помог — нужно вмешательство"
exit 1
