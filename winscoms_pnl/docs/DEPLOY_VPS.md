# Деплой WINSCOMS на VPS → https://finans.winscoms.com

Принцип: **существующие проекты и nginx не ломаем**. Приложение живёт в Docker Compose-проекте `winscoms_pnl`, слушает только `127.0.0.1:8081`, а хостовый nginx проксирует на него домен `finans.winscoms.com`.

## Как работает «не падать и перезапускаться само»
| Что | Чем обеспечено |
|---|---|
| Контейнеры поднимаются после перезагрузки сервера | `restart: unless-stopped` + `systemctl enable docker` + сервис `winscoms-pnl` |
| Падение процесса | Docker перезапускает контейнер; healthcheck у backend и db |
| Обновление файлов не роняет работающее приложение | Приложение запущено **из собранных образов**, а не из папки с исходниками: пока вы загружаете файлы, старая версия продолжает работать |
| Автоматический деплой после загрузки файлов | Сервис `winscoms-autodeploy` замечает изменения, ждёт 20 с окончания загрузки, собирает образ, заменяет контейнеры |
| Битая версия | Если сборка не удалась — старая версия остаётся; если новая не прошла `/health/ready` — автоматический откат на предыдущий образ |
| Секреты и данные | `.env` и том БД скрипты не трогают |

> Раньше приложение «падало» при изменении файлов, скорее всего потому, что работало прямо из папки проекта (dev-режим с авто-перезагрузкой или процесс без supervisor). Точную причину сказать не могу: я не видел старый запуск на сервере. Здесь исходники в работающий процесс не подмонтированы.

## Шаг 0. Разведка (ТОЛЬКО ЧТЕНИЕ) — пришлите вывод, вырезав секреты
```bash
cat /etc/os-release | head -3
docker --version; docker compose version
docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}'
sudo ss -tlnp
df -h /; free -m
sudo nginx -T 2>/dev/null | grep -n -E "server_name|listen|include" | head -40
dig +short finans.winscoms.com
```
`dig` должен вернуть IP вашего сервера. Если порт 8081 занят — выберите другой и используйте его везде (в `.env` как `PROXY_PORT` и в nginx).

## Шаг 1. Код на сервере
Текущий workflow (`.github/workflows/deploy.yml`) делает на сервере `git reset --hard origin/winscoms/main` в `/root/projects/winscoms_pnl`. Поэтому корень git-репозитория на сервере — `/root/projects/winscoms_pnl`, а **`APP_DIR` (папка с `docker-compose.yml`) = `/root/projects/winscoms_pnl/winscoms_pnl`**. Во всех командах ниже используйте этот путь. `.env` лежит в `APP_DIR`, он в `.gitignore`, и `git reset --hard` его не удаляет (удаляются только отслеживаемые файлы). Не запускайте `git clean -fdx` в этой папке.

## Шаг 2. Файл `.env` (один раз, вручную на сервере)
```bash
cd /root/projects/winscoms_pnl/winscoms_pnl
cp .env.example .env && chmod 600 .env
python3 -c "import secrets; print('SECRET_KEY=' + secrets.token_urlsafe(48))"
python3 -c "import secrets; print('POSTGRES_PASSWORD=' + secrets.token_urlsafe(24))"
python3 -c "import base64,os; print('ENCRYPTION_KEYS=' + base64.urlsafe_b64encode(os.urandom(32)).decode())"
nano .env
```
Задайте: `APP_ENV=production`, три значения выше, `DATABASE_URL=postgresql+asyncpg://winscoms:ПАРОЛЬ@db:5432/winscoms` (тот же пароль), `PROXY_PORT`. Сохраните `ENCRYPTION_KEYS` отдельно: без ключа сохранённые токены WB не расшифровать.

## Шаг 3. Первый запуск вручную (проверка)
```bash
cd /root/projects/winscoms_pnl/winscoms_pnl
bash deploy/scripts/deploy.sh
curl -s http://127.0.0.1:8081/api/v1/health/ready      # {"status":"ok","database":"up"}
```

## Шаг 4. Автозапуск и автодеплой (один раз)
```bash
cd /root/projects/winscoms_pnl/winscoms_pnl
sudo APP_DIR=/root/projects/winscoms_pnl/winscoms_pnl bash deploy/scripts/install-systemd.sh
systemctl status winscoms-autodeploy
journalctl -u winscoms-autodeploy -f          # лог автодеплоя
```
С этого момента: загрузили файлы → через ~30–60 с (пауза на окончание загрузки + сборка) новая версия сама заменила старую. Тест перезагрузки: `sudo reboot`, затем снова `curl` на health.

## Шаг 5. Домен finans.winscoms.com и HTTPS
1. Убедитесь, что `dig +short finans.winscoms.com` возвращает IP сервера.
2. Конфиг хостового nginx — файл `deploy/nginx/host-finans.winscoms.com.conf` (порт = `PROXY_PORT`):
   ```bash
   sudo cp deploy/nginx/host-finans.winscoms.com.conf /etc/nginx/conf.d/finans.winscoms.com.conf
   sudo nginx -t && sudo systemctl reload nginx
   ```
   (Если ваш nginx использует `sites-available/sites-enabled`, положите файл туда и сделайте симлинк. Существующие конфиги не редактируются — добавляется только новый файл. `reload` не обрывает соединения; при ошибке `nginx -t` ничего не перезагружайте.)
3. HTTPS (Let's Encrypt):
   ```bash
   sudo certbot --nginx -d finans.winscoms.com
   ```
   Certbot допишет TLS-блок и редирект и сам продлевает сертификат. Если certbot не установлен: `sudo apt install certbot python3-certbot-nginx`. Если nginx у вас в контейнере — напишите, дам другой вариант.
4. Откройте `https://finans.winscoms.com` — «Сервер работает».

Откат домена: удалить `/etc/nginx/conf.d/finans.winscoms.com.conf`, `nginx -t && reload`.

## Загрузка файлов (на выбор)
- **PyCharm SFTP:** Deployment → Mappings: Local = папка `winscoms_pnl`, Remote = `/root/projects/winscoms_pnl/winscoms_pnl`; Excluded: `.git`, `node_modules`, `.venv`, `.env`. Включите *Automatic Upload*. Дальше всё делает автодеплой. (Не смешивайте с git-способом: выберите один.)
- **GitHub Actions** (`.github/workflows/deploy.yml`, ветка `winscoms/main`): по пушу заходит на сервер по SSH и обновляет код через git. Секреты `VPS_HOST`, `VPS_USER`, `VPS_SSH_KEY` (environment `production`). Дальше автодеплой на сервере сам пересобирает и перезапускает приложение. Для первого клонирования репозитория на сервере нужен deploy-ключ (read-only).

## Эксплуатация
```bash
docker compose ps                         # состояние
docker compose logs -f backend            # логи приложения
sudo systemctl restart winscoms-autodeploy
bash deploy/scripts/deploy.sh             # деплой вручную
```
Принудительный откат: `docker tag winscoms_pnl-backend:previous winscoms_pnl-backend:latest` (то же для frontend) и `docker compose up -d --no-build`.
**Не используйте `docker compose down -v`** — удалит базу.

## Бэкап БД (минимум)
```bash
mkdir -p ~/backups && docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip > ~/backups/winscoms_$(date +%F_%H%M).sql.gz
```
Рабочим бэкап считается после проверки восстановления в тестовую БД.

## Ограничения
Скрипты проверены локально только синтаксически и на заглушке (логика автодеплоя), а не на вашем сервере; сборка Docker-образов в этой среде не запускалась. Первый запуск делайте вручную (шаг 3) и смотрите вывод.
Пока в приложении нет авторизации (Stage 4): не публикуйте домен широко — можно временно закрыть `auth_basic` в nginx.
