/**
 * Config.gs — все настройки проекта в одном месте.
 */
const OZON_CONFIG = {
  // Часовой пояс для расчёта периодов и отметки «Последнее обновление»
  timezone: 'Asia/Yekaterinburg',

  // Лимиты времени одного запуска (у Apps Script жёсткий лимит ~6 минут = 360 000 мс)
  maxRunMillis: 240000,          // после этого запуск ставится на паузу и продолжается триггером
  requestSafetyMillis: 90000,    // новый шаг не стартует, если до maxRunMillis осталось меньше этого запаса
  continuationDelayMillis: 60000,// минимальная пауза перед продолжением (триггер Apps Script — не раньше 1 минуты)
  maxConsecutiveRetries: 12,     // сколько раз подряд можно получить 429/5xx/сетевую ошибку, прежде чем остановиться

  // Ключи в Script Properties
  clientIdProperty: 'OZON_CLIENT_ID',
  apiKeyProperty: 'OZON_API_KEY',
  sheetNameProperty: 'OZON_SHEET_NAME',
  stateProperty: 'OZON_RUN_STATE',
  autoModeProperty: 'OZON_AUTO_MODE',
  dailyTriggerHour: 3,           // час суток (в часовом поясе проекта) для ежедневного автообновления
  defaultSheetName: 'Ozon',

  // Имена функций, на которые вешаются триггеры
  scheduledHandler: 'ozonScheduledRun',
  continuationHandler: 'continueOzonRun',

  // Фазы загрузки. Каждая фаза состоит из одного или нескольких коротких шагов (один HTTP-запрос = один шаг).
  phases: [
    'FETCH_PRODUCTS',
    'FETCH_PRODUCT_INFO',
    'FETCH_ATTRIBUTES',
    'FETCH_CATEGORY_TREE',
    'FETCH_PRICES',
    'FETCH_FBS_STOCKS',
    'FETCH_FBO_STOCKS',
    'FETCH_FINANCE',
    'FETCH_FBO_POSTINGS_180',
    'FETCH_FBS_POSTINGS_180',
    'BUILD_ROWS',
    'WRITE_SHEET'
  ],

  // Скрытые служебные листы-кэши (после успешного прогона удаляются)
  cacheSheets: {
    products: '_ozon_cache_products',
    info: '_ozon_cache_info',
    attributes: '_ozon_cache_attributes',
    categories: '_ozon_cache_categories',
    prices: '_ozon_cache_prices',
    fbsStocks: '_ozon_cache_fbs_stocks',
    fboStocks: '_ozon_cache_fbo_stocks',
    finance: '_ozon_cache_finance',
    fboPostings180: '_ozon_cache_fbo_postings_180',
    fbsPostings180: '_ozon_cache_fbs_postings_180',
    finalRows: '_ozon_cache_final_rows',
    runs: '_ozon_runs'
  },

  // Заголовки итоговой таблицы (порядок = порядок колонок)
  headers: [
    'Статус товара',
    'Артикул продавца',
    'sku',
    'Остатки FBS',
    'Остатки FBO',
    'Цена с учетом акции или стратегии, руб',
    'Комиссия за продажу FBO',
    'Комиссия за продажу FBS',
    '% выкупа',
    'Эквайринг %',
    'Сумма заказов',
    'Маркетинг',
    'Длина, мм',
    'Ширина, мм',
    'Высота, мм',
    'Вес, г',
    'Соинвест от Ozon %',
    'Категория',
    'Комиссия за продажу rFBS',
    'Продажи за месяц'
  ]
};

/** Следующая фаза по списку; после последней возвращает 'DONE'. */
function ozonNextPhase_(phase) {
  const index = OZON_CONFIG.phases.indexOf(phase);
  if (index < 0) return OZON_CONFIG.phases[0];
  return OZON_CONFIG.phases[index + 1] || 'DONE';
}
