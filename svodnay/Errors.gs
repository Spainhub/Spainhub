/**
 * Errors.gs — служебные типы ошибок для управления потоком выполнения.
 */

/** Временная ошибка (лимит 429, 5xx, сеть): запуск нужно продолжить позже. */
class OzonRetryLaterError extends Error {
  constructor(retryAfterSeconds, message) {
    super(message);
    this.name = 'OzonRetryLaterError';
    this.retryAfterSeconds = retryAfterSeconds || 60;
  }
}

/** Достигнут внутренний лимит времени — запуск ставится на паузу, это не сбой. */
class OzonDeadlineError extends Error {
  constructor() {
    super('Достигнут лимит времени выполнения, запуск будет продолжен триггером.');
    this.name = 'OzonDeadlineError';
  }
}
