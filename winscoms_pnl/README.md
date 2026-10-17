# WINSCOMS

SaaS для управленческого P&L по маркетплейсам (первый — Wildberries). Модульный монолит: FastAPI + PostgreSQL + React.

Статус: **Stage 3 — каркас** (health-check, конфигурация, Docker, пустая фронтенд-страница). Таблиц и авторизации пока нет.

## Быстрый старт
```bash
cp .env.example .env        # заполните CHANGE_ME
docker compose up -d --build
curl http://127.0.0.1:8081/pnl/api/v1/health/ready   # в браузере: http://127.0.0.1:8081/pnl/
```

## Тесты бэкенда
```bash
cd backend && python -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt && pytest
```

## Фронтенд
```bash
cd frontend && npm install && npm run build
```

## Миграции
```bash
docker compose run --rm backend alembic upgrade head
```

Перенос и деплой: [скачать проект](docs/TRANSFER.md) · [развернуть на VPS под /pnl](docs/DEPLOY_VPS.md).

Решения и допущения: [docs/decisions.md](docs/decisions.md).
