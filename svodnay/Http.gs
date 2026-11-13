/**
 * Http.gs — обращения к Ozon Seller API.
 */
const OZON_API_BASE = 'https://api-seller.ozon.ru';

/**
 * POST-запрос к Ozon API, возвращает разобранный JSON.
 * 429 и 5xx и сетевые сбои -> OzonRetryLaterError (запуск продолжится позже),
 * остальные не-2xx -> обычная ошибка (запуск помечается FAILED).
 * UrlFetchApp с muteHttpExceptions, чтобы самим читать тело ответа с описанием ошибки.
 */
function ozonRequestJson_(path, payload, context) {
  const label = context || path;
  let response;
  try {
    response = UrlFetchApp.fetch(OZON_API_BASE + path, {
      method: 'post',
      muteHttpExceptions: true,
      contentType: 'application/json',
      headers: {
        'Client-Id': ozonGetClientId_(),
        'Api-Key': ozonGetApiKey_()
      },
      payload: JSON.stringify(payload || {})
    });
  } catch (e) {
    // Сетевые сбои UrlFetchApp (таймаут, DNS, превышен лимит) — пробуем позже
    throw new OzonRetryLaterError(60, label + ' | сетевая ошибка: ' + e.message);
  }

  const status = response.getResponseCode();
  const text = response.getContentText() || '';

  if (status === 429) {
    throw new OzonRetryLaterError(61, label + ' | лимит запросов Ozon (429)');
  }
  if (status >= 500) {
    throw new OzonRetryLaterError(60, label + ' | ошибка сервера Ozon HTTP ' + status);
  }
  if (status === 401 || status === 403) {
    throw new Error(label + ' | HTTP ' + status + ': неверный Seller ID / API-ключ или у ключа нет прав на метод. ' + text.slice(0, 300));
  }
  if (status < 200 || status >= 300) {
    throw new Error(label + ' | HTTP ' + status + ': ' + text.slice(0, 500));
  }
  return text ? JSON.parse(text) : {};
}

/**
 * Быстрая проверка пары Seller ID + API-ключ лёгким запросом (1 товар).
 * Возвращает {ok: boolean, message: string}.
 */
function ozonCheckConnection_() {
  try {
    ozonRequestJson_('/v3/product/list', { filter: { visibility: 'ALL' }, last_id: '', limit: 1 }, 'проверка доступа');
    return { ok: true, message: 'Подключение к Ozon работает.' };
  } catch (e) {
    return { ok: false, message: e.message };
  }
}
