# Ручной перенос WINSCOMS на VPS → https://winscoms.com/pnl/

Принцип: **ничего существующего не трогаем**. Новый проект живёт в своей папке и своём Docker Compose-проекте (`winscoms_pnl`), слушает только `127.0.0.1:<порт>`, а существующий nginx на VPS добавляет один `location /pnl/`. Порты 80 и 443 наш Compose не занимает.

Команды ниже, где написано «ТОЛЬКО ЧТЕНИЕ», ничего не меняют.

## Шаг 0. Подключение и разведка (ТОЛЬКО ЧТЕНИЕ)

Подключитесь по SSH (Terminal в PyCharm: **Tools → Start SSH Session…**, либо терминал ОС):
```bash
ssh ВАШ_ПОЛЬЗОВАТЕЛЬ@IP_СЕРВЕРА
```
Выполните и **пришлите мне вывод** (токены/пароли в нём вырежьте):
```bash
cat /etc/os-release | head -3
docker --version; docker compose version
docker ps -a --format 'table {{.Names}}\t{{.Image}}\t{{.Ports}}\t{{.Status}}'
docker compose ls
sudo ss -tlnp
df -h /; free -m
sudo nginx -T 2>/dev/null | grep -n -E "server_name|listen|location|root|proxy_pass" | head -60
ls /etc/nginx/sites-enabled /etc/nginx/conf.d 2>/dev/null
```
Что ищем: какой веб-сервер держит 80/443 (nginx на хосте или в контейнере), как устроен `winscoms.com`, какие порты заняты (чтобы выбрать свободный вместо 8081), есть ли Docker и место.

> Если Docker не установлен — остановитесь и напишите мне, установим отдельно.
> Если nginx работает **в контейнере** (а не на хосте), конфиг `location /pnl/` добавляется туда — пришлите вывод, подскажу точно.

## Шаг 1. Папка проекта
```bash
mkdir -p ~/apps/winscoms_pnl
```
(Существующий проект не затрагивается; `~/apps/` — просто удобное место. Если у вас другая схема, используйте её.)

## Шаг 2. Доставить код на сервер — выберите один способ

### Способ A. Через git (проще всего обновлять)
Репозиторий приватный, на сервере нужен доступ только на чтение:
1. На сервере: `ssh-keygen -t ed25519 -f ~/.ssh/winscoms_deploy -N ""` и `cat ~/.ssh/winscoms_deploy.pub`
2. GitHub → репозиторий → **Settings → Deploy keys → Add deploy key**: вставьте публичный ключ, галочку Write **не** ставьте.
3. На сервере:
   ```bash
   cd ~/apps
   GIT_SSH_COMMAND="ssh -i ~/.ssh/winscoms_deploy" git clone --branch winscoms/main --single-branch git@github.com:Spainhub/Spainhub.git winscoms_src
   ln -sfn ~/apps/winscoms_src/winscoms_pnl ~/apps/winscoms_pnl_app
   ```
   Код: `~/apps/winscoms_src/winscoms_pnl`.

### Способ B. Через PyCharm (SFTP, без git на сервере)
1. Откройте проект `winscoms_pnl` (см. `TRANSFER.md`).
2. **Settings → Build, Execution, Deployment → Deployment → + → SFTP**. Host/Port/User — как для SSH; аутентификация — ключ или пароль. Нажмите **Test Connection**.
3. Вкладка **Mappings**: Local path = папка `winscoms_pnl`, Deployment path = `/home/ВАШ_ПОЛЬЗОВАТЕЛЬ/apps/winscoms_pnl`.
4. Вкладка **Excluded Paths**: добавьте `.git`, `frontend/node_modules`, `.venv`, `.env`.
5. Правый клик на папке `winscoms_pnl` → **Deployment → Upload to…** (позже можно включить **Automatic Upload**).

### Способ C. ZIP + scp
```bash
# на своём компьютере, из папки с распакованным ZIP:
scp -r winscoms_pnl ВАШ_ПОЛЬЗОВАТЕЛЬ@IP_СЕРВЕРА:~/apps/
```

## Шаг 3. Создать `.env` на сервере
```bash
cd ~/apps/winscoms_pnl        # (для способа A: cd ~/apps/winscoms_src/winscoms_pnl)
cp .env.example .env
python3 -c "import secrets; print('SECRET_KEY=' + secrets.token_urlsafe(48))"
python3 -c "import secrets; print('POSTGRES_PASSWORD=' + secrets.token_urlsafe(24))"
```
Если на сервере нет `cryptography`, ключ Fernet сгенерируйте так (даёт 44 символа base64):
```bash
python3 -c "import base64,os; print('ENCRYPTION_KEYS=' + base64.urlsafe_b64encode(os.urandom(32)).decode())"
```
Откройте `.env` (`nano .env`) и задайте:
- `APP_ENV=production`
- `POSTGRES_PASSWORD`, `SECRET_KEY`, `ENCRYPTION_KEYS` — значения выше;
- `DATABASE_URL=postgresql+asyncpg://winscoms:ТОТ_ЖЕ_ПАРОЛЬ@db:5432/winscoms` (пароль без спецсимволов `@ : / #`; `token_urlsafe` их не создаёт);
- `PROXY_PORT` — свободный порт (проверьте `ss -tlnp`; по умолчанию 8081).

**Сохраните ключ `ENCRYPTION_KEYS` и пароли отдельно (менеджер паролей)**: потеряете ключ — сохранённые токены WB не расшифровать. `chmod 600 .env`.

## Шаг 4. Запуск
```bash
docker compose build
docker compose up -d
docker compose ps
curl -s http://127.0.0.1:8081/pnl/api/v1/health/ready     # ожидаем {"status":"ok","database":"up"}
```
Логи: `docker compose logs -f backend`. Если `ready` отдаёт `down` — смотрите `docker compose logs db backend`.

## Шаг 5. Подключить к https://winscoms.com/pnl/ (существующий nginx на хосте)

1. Найдите файл, где объявлен `server_name winscoms.com` с `listen 443` (из вывода шага 0).
2. **Сделайте копию**: `sudo cp /etc/nginx/sites-enabled/ФАЙЛ /etc/nginx/sites-enabled/ФАЙЛ.bak-$(date +%F)` — резервную копию лучше положить вне `sites-enabled` (например, `~/nginx-backup/`), чтобы nginx не читал её как конфиг.
3. Внутрь блока `server { … listen 443 … }` **до** общего `location /` добавьте:
   ```nginx
   location /pnl/ {
       proxy_pass http://127.0.0.1:8081;     # порт = PROXY_PORT; БЕЗ слэша в конце и без пути
       proxy_set_header Host $host;
       proxy_set_header X-Real-IP $remote_addr;
       proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
       proxy_set_header X-Forwarded-Proto $scheme;
   }
   location = /pnl { return 301 /pnl/; }
   ```
4. Проверьте и применяйте только если проверка прошла:
   ```bash
   sudo nginx -t && sudo systemctl reload nginx
   ```
   `reload` не обрывает текущие соединения. При ошибке `nginx -t` ничего не перезагружайте — верните копию.
5. Откройте `https://winscoms.com/pnl/` — должна быть страница WINSCOMS и «Сервер работает».

Откат: удалите добавленные блоки (или верните копию), `sudo nginx -t && sudo systemctl reload nginx`; `docker compose down` остановит проект (данные БД в томе `winscoms_pnl_pgdata` сохраняются; **не используйте `down -v`** — это удалит базу).

## Шаг 6. Обновление
- Способ A: `cd ~/apps/winscoms_src && GIT_SSH_COMMAND="ssh -i ~/.ssh/winscoms_deploy" git pull && cd winscoms_pnl && docker compose up -d --build`
- Способ B: загрузить изменённые файлы из PyCharm, затем `docker compose up -d --build`.
- Миграции БД (когда появятся, с Stage 4): `docker compose run --rm backend alembic upgrade head`.

## Бэкап БД (минимум, до настройки автоматики)
```bash
mkdir -p ~/backups && docker compose exec -T db sh -c 'pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB"' | gzip > ~/backups/winscoms_$(date +%F_%H%M).sql.gz
```
Бэкап считается рабочим только после проверки восстановления в тестовой БД (опишем на Stage 10).

## Что дальше проверять
Текущая версия — каркас: страница и health-check. Авторизации и данных пока нет, поэтому до Stage 4 не публикуйте адрес широко (можно ограничить доступ по IP или `auth_basic` в nginx).
