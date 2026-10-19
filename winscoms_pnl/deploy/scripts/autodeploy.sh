#!/usr/bin/env bash
# Следит за файлами проекта и сам запускает deploy.sh после изменений.
# Ждёт, пока загрузка файлов закончится (QUIET_SECONDS без изменений), чтобы не собирать
# наполовину загруженный проект. Упавший деплой не повторяется, пока файлы снова не изменятся.
set -uo pipefail

APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
STATE_DIR="${STATE_DIR:-/var/lib/winscoms_pnl}"
INTERVAL="${INTERVAL:-10}"
QUIET_SECONDS="${QUIET_SECONDS:-20}"
mkdir -p "$STATE_DIR"
cd "$APP_DIR"

signature() {
  find backend frontend deploy docker-compose.yml \
    \( -name node_modules -o -name __pycache__ -o -name dist -o -name .pytest_cache -o -name .venv \) -prune -o \
    -type f -printf '%p %s %T@\n' 2>/dev/null | LC_ALL=C sort | sha256sum | cut -d' ' -f1
}

deployed="$(cat "$STATE_DIR/deployed.sig" 2>/dev/null || true)"
failed="$(cat "$STATE_DIR/failed.sig" 2>/dev/null || true)"
echo "[autodeploy] слежение за $APP_DIR"

while true; do
  sleep "$INTERVAL"
  sig="$(signature)"
  [ "$sig" = "$deployed" ] && continue
  [ "$sig" = "$failed" ] && continue

  echo "[autodeploy] обнаружены изменения, жду завершения загрузки (${QUIET_SECONDS}с тишины)"
  last="$sig"; stable_since=$SECONDS
  while [ $((SECONDS - stable_since)) -lt "$QUIET_SECONDS" ]; do
    sleep 3
    cur="$(signature)"
    [ "$cur" != "$last" ] && { last="$cur"; stable_since=$SECONDS; }
  done

  if APP_DIR="$APP_DIR" "$APP_DIR/deploy/scripts/deploy.sh"; then
    deployed="$last"; echo "$deployed" > "$STATE_DIR/deployed.sig"; : > "$STATE_DIR/failed.sig"; failed=""
  else
    failed="$last"; echo "$failed" > "$STATE_DIR/failed.sig"
    echo "[autodeploy] деплой не удался; повтор после следующего изменения файлов"
  fi
done
