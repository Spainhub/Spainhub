# WINSCOMS

SaaS для управленческого P&L по маркетплейсам (первый — Wildberries). Модульный монолит: FastAPI + PostgreSQL + React.

Статус: **Stage 7** — авторизация и организации ([docs/auth.md](docs/auth.md)), подключение Wildberries и синхронизация ([docs/wb-integration.md](docs/wb-integration.md)), нормализация данных ([docs/financial-model.md](docs/financial-model.md)), движок P&L ([docs/pnl-engine.md](docs/pnl-engine.md)). Разбор реальных данных WB: [docs/wb-real-data-findings.md](docs/wb-real-data-findings.md). Интерфейса пока нет (API готов).

## Быстрый старт
```bash
cp .env.example .env        # заполните CHANGE_ME
docker compose up -d --build
curl http://127.0.0.1:8091/api/v1/health/ready   # в браузере: http://127.0.0.1:8091/
```

## Тесты бэкенда
```bash
cd backend && python -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
TEST_DATABASE_URL='postgresql+asyncpg://postgres@localhost:5432/postgres' pytest   # без переменной DB-тесты пропускаются
```

## Фронтенд
```bash
cd frontend && npm install && npm run build
```

## Миграции
```bash
docker compose run --rm backend alembic upgrade head
```

Перенос и деплой: [скачать проект](docs/TRANSFER.md) · [развернуть на VPS: finans.winscoms.com, автозапуск и автодеплой](docs/DEPLOY_VPS.md).

Решения и допущения: [docs/decisions.md](docs/decisions.md).
