#!/usr/bin/env bash
# Закрывает finans.winscoms.com паролем (nginx auth_basic) + ограничение частоты запросов.
# Правит ТОЛЬКО /etc/nginx/conf.d/finans.winscoms.com.conf (с резервной копией), перед reload делает nginx -t
# и при ошибке возвращает прежний файл. Запуск от root:
#   sudo bash deploy/scripts/enable-basic-auth.sh            # спросит логин/пароль (ввод скрыт)
#   sudo AUTH_USER=winscoms AUTH_PASSWORD='...' bash ...      # без вопросов
# Отключение: sudo bash deploy/scripts/enable-basic-auth.sh --disable
set -euo pipefail
[ "$(id -u)" -eq 0 ] || { echo "Нужен root (sudo)"; exit 1; }

CONF="${NGINX_CONF:-/etc/nginx/conf.d/finans.winscoms.com.conf}"
SNIPPET="${NGINX_SNIPPET:-/etc/nginx/snippets/finans-basic-auth.conf}"
LIMIT_CONF="${NGINX_LIMIT_CONF:-/etc/nginx/conf.d/finans-limit.conf}"
HTPASSWD="${NGINX_HTPASSWD:-/etc/nginx/.htpasswd-finans}"
MARK="include $SNIPPET;"
NGINX_TEST="${NGINX_TEST:-nginx -t}"
NGINX_RELOAD="${NGINX_RELOAD:-systemctl reload nginx}"

[ -f "$CONF" ] || { echo "Нет $CONF — сначала настройте домен"; exit 1; }
BK="${CONF}.bak-$(date +%F_%H%M%S)"
mkdir -p "$HOME/nginx-backup"

apply() {
  if ! $NGINX_TEST >/dev/null 2>&1; then
    echo "nginx -t не прошёл — возвращаю прежний конфиг"; cp "$BK" "$CONF"; exit 1
  fi
  $NGINX_RELOAD
}

if [ "${1:-}" = "--disable" ]; then
  cp "$CONF" "$BK"; cp "$BK" "$HOME/nginx-backup/"
  sed -i "\#$MARK#d" "$CONF"
  apply; echo "Пароль на сайте отключён"; exit 0
fi

AUTH_USER="${AUTH_USER:-}"
if [ -z "$AUTH_USER" ]; then read -rp "Логин [winscoms]: " AUTH_USER; AUTH_USER="${AUTH_USER:-winscoms}"; fi
if [ -z "${AUTH_PASSWORD:-}" ]; then read -rsp "Пароль: " AUTH_PASSWORD; echo; fi
[[ "$AUTH_USER" =~ ^[A-Za-z0-9_.-]+$ ]] || { echo "Логин: только латиница, цифры, _ . -"; exit 1; }
[ "${#AUTH_PASSWORD}" -ge 8 ] || echo "ВНИМАНИЕ: пароль короче 8 символов подбирается за минуты. Лучше длиннее."

mkdir -p "$(dirname "$SNIPPET")"
printf '%s:%s\n' "$AUTH_USER" "$(printf '%s' "$AUTH_PASSWORD" | openssl passwd -apr1 -stdin)" > "$HTPASSWD"
chmod 640 "$HTPASSWD"; chgrp www-data "$HTPASSWD" 2>/dev/null || true

cat > "$SNIPPET" <<SNIP
auth_basic "WINSCOMS";
auth_basic_user_file $HTPASSWD;
limit_req zone=finans_auth burst=20 nodelay;
SNIP
cat > "$LIMIT_CONF" <<'LIM'
limit_req_zone $binary_remote_addr zone=finans_auth:1m rate=5r/s;
LIM

cp "$CONF" "$BK"; cp "$BK" "$HOME/nginx-backup/"
if ! grep -qF "$MARK" "$CONF"; then
  # include добавляется в каждый server { } этого файла (и 80, и 443) сразу после server_name
  sed -i "/^[[:space:]]*server_name finans\.winscoms\.com;/a\\    $MARK" "$CONF"
fi
grep -qF "$MARK" "$CONF" || { echo "Не нашёл server_name в $CONF"; cp "$BK" "$CONF"; exit 1; }
apply
echo "Готово: сайт закрыт паролем (логин: $AUTH_USER). Копия конфига: $BK"
