"""Административные команды.  Пример (внутри контейнера):
    docker compose exec backend python -m app.cli create-admin --email you@example.com
Пароль запрашивается интерактивно (или берётся из WINSCOMS_ADMIN_PASSWORD) и не печатается."""
import argparse
import asyncio
import getpass
import os
import sys

from sqlalchemy.ext.asyncio import async_sessionmaker

from app.core.security import MIN_PASSWORD_LENGTH
from app.db.session import dispose_engine, get_engine, set_rls_context
from app.services.auth import create_user, get_user_by_email


async def _create_admin(email: str, password: str) -> int:
    maker = async_sessionmaker(get_engine(), expire_on_commit=False)
    async with maker() as db:
        await set_rls_context(db, platform_admin=True)
        if await get_user_by_email(db, email):
            print("Пользователь уже существует", file=sys.stderr)
            return 1
        await create_user(db, email=email, password=password, is_platform_admin=True)
        await db.commit()
    await dispose_engine()
    print(f"Администратор {email} создан")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(prog="app.cli")
    sub = parser.add_subparsers(dest="cmd", required=True)
    ca = sub.add_parser("create-admin", help="создать администратора платформы")
    ca.add_argument("--email", required=True)
    args = parser.parse_args()

    password = os.environ.get("WINSCOMS_ADMIN_PASSWORD") or getpass.getpass("Пароль: ")
    if len(password) < MIN_PASSWORD_LENGTH:
        print(f"Пароль короче {MIN_PASSWORD_LENGTH} символов", file=sys.stderr)
        return 2
    return asyncio.run(_create_admin(args.email.lower(), password))


if __name__ == "__main__":
    raise SystemExit(main())
