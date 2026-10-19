class MarketplaceError(Exception):
    """Базовая ошибка интеграции. message — безопасный текст для пользователя (без токенов)."""

    code = "marketplace_error"
    retryable = False

    def __init__(self, message: str, *, retry_after: float | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.retry_after = retry_after


class AuthError(MarketplaceError):
    code = "auth_error"      # 401/403: токен недействителен или нет прав на категорию API


class PaymentRequired(MarketplaceError):
    code = "payment_required"  # 402: смысл уточнить по документации WB


class BadRequest(MarketplaceError):
    code = "bad_request"     # 400: неверные параметры запроса


class RateLimited(MarketplaceError):
    code = "rate_limited"    # 429
    retryable = True


class TemporaryError(MarketplaceError):
    code = "temporary_error"  # 5xx, сеть, таймаут
    retryable = True


class ParseError(MarketplaceError):
    code = "parse_error"     # ответ не соответствует ожидаемой структуре
