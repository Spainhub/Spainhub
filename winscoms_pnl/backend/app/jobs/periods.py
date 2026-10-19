from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

MSK = ZoneInfo("Europe/Moscow")   # даты отчётов WB — по Москве (UTC+3); в БД моменты времени — UTC


def today_msk(now: datetime | None = None) -> date:
    return (now or datetime.now(MSK)).astimezone(MSK).date()


def initial_period(months: int, today: date | None = None) -> tuple[date, date]:
    """С 1-го числа месяца `months` месяцев назад по сегодня (МСК): последние N календарных месяцев."""
    today = today or today_msk()
    y, m = today.year, today.month - months
    while m <= 0:
        m += 12
        y -= 1
    return date(y, m, 1), today


def daily_period(today: date | None = None, overlap_days: int = 7) -> tuple[date, date]:
    """Ежедневная загрузка с перекрытием: WB может публиковать данные с задержкой."""
    today = today or today_msk()
    return today - timedelta(days=overlap_days), today
