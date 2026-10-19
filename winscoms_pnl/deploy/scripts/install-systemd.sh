#!/usr/bin/env bash
# Устанавливает два systemd-сервиса (автозапуск при загрузке сервера и автодеплой).
# Запуск от root:  APP_DIR=/root/projects/winscoms_pnl bash deploy/scripts/install-systemd.sh
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Нужен root (sudo)"; exit 1; }
APP_DIR="${APP_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
[ -f "$APP_DIR/docker-compose.yml" ] || { echo "В $APP_DIR нет docker-compose.yml"; exit 1; }
[ -f "$APP_DIR/.env" ] || { echo "Сначала создайте $APP_DIR/.env"; exit 1; }
chmod +x "$APP_DIR"/deploy/scripts/*.sh
for u in winscoms-pnl winscoms-autodeploy; do
  sed "s#@APP_DIR@#$APP_DIR#g" "$APP_DIR/deploy/systemd/$u.service" > "/etc/systemd/system/$u.service"
done
systemctl daemon-reload
systemctl enable docker
systemctl enable winscoms-pnl.service
systemctl enable --now winscoms-autodeploy.service
echo "Готово. Статус: systemctl status winscoms-autodeploy ; логи: journalctl -u winscoms-autodeploy -f"
