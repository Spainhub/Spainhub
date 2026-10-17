# Как скачать проект из GitHub (ZIP или PyCharm)

Репозиторий: `https://github.com/Spainhub/Spainhub` (приватный). Проект WINSCOMS — в ветке **`winscoms/main`**, в папке **`winscoms_pnl/`**.

## Вариант 1. ZIP
1. Откройте `https://github.com/Spainhub/Spainhub/tree/winscoms/main` (войдите в GitHub).
2. Зелёная кнопка **Code → Download ZIP** (скачается именно ветка `winscoms/main`).
3. Распакуйте. Рабочая папка проекта — `winscoms_pnl` внутри архива.

## Вариант 2. PyCharm (рекомендуется, сразу с Git)
1. PyCharm → **File → New → Project from Version Control** (на стартовом экране: **Get from VCS**).
2. URL: `https://github.com/Spainhub/Spainhub.git`. Для приватного репо PyCharm предложит войти через GitHub (**Log in via GitHub**) или вставить токен (Personal Access Token с правом `repo`).
3. Directory: например `C:\Projects\Spainhub`. Нажмите **Clone**.
4. Переключите ветку: внизу справа (имя ветки) → **Remote Branches → origin/winscoms/main → Checkout**.
5. Откройте папку `winscoms_pnl` как проект: **File → Open → …\Spainhub\winscoms_pnl**.
6. Python-окружение для тестов: **Settings → Project → Python Interpreter → Add → Virtualenv** (Python 3.13), затем в терминале PyCharm:
   ```
   cd backend
   pip install -r requirements-dev.txt
   pytest
   ```

## Вариант 3. Командная строка
```bash
git clone --branch winscoms/main --single-branch https://github.com/Spainhub/Spainhub.git
cd Spainhub/winscoms_pnl
```

> Файл `.env` с паролями в Git не попадает и создаётся вручную (из `.env.example`).
