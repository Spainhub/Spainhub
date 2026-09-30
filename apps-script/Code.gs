/**********************************************************************
 * Code.gs
 * Wildberries → Google Sheets + Web App "PnL Report Wildberries"
 *
 * Шаг 1: загрузка данных в "Data_wb"
 * Шаг 2: P&L считается АВТОМАТИЧЕСКИ в "Calculation" по формулам
 * (СУММЕСЛИМН к Data_wb). Формулы пишутся на русском (СУММЕСЛИМН,
 * ЕСЛИ, ЕСЛИОШИБКА…, разделитель «;»), см. раздел «ФОРМУЛЫ НА РУССКОМ». Вручную заполняются только 5 строк:
 * COGS (020), Реклама (040), Налог (045), Зарплата (050),
 * Прочие OPEX (055) — эти данные WB API не отдаёт.
 * Шаг 3: Web App (doGet + Index.html)
 *
 * ЕДИНОЕ МЕНЮ ПРОЕКТА: пункт "Отчёты МП" в этом файле объединяет все
 * методы проекта (WB P&L, доп. отчёты WB и Ozon). Ключи API вводятся
 * в ОДНОМ месте — подменю "Ключи API" (см. Auth.gs). Сами загрузчики
 * данных других методов лежат каждый в своём файле:
 *   Report_finans_oz_1.gs — Ozon, финансовый отчёт (Cash Flow)
 *   Report_finans_wb_2.gs — WB, эквайринг (детализация)
 *   Get_sku_wb.gs         — WB, список товаров
 *   Get_sku_oz.gs         — Ozon, список товаров
 *
 * РЕШЕНИЕ ПО ДАТАМ:
 * Даты сохраняем как нативный Date БЕЗ времени (UTC-полдень).
 * UTC-полдень = «иммунитет» к сдвигу на ±1 день в любом часовом поясе:
 * ячейка не «уезжает» ни в скрипте, ни в таблице.
 * Формат ячеек — "dd.MM.yyyy" → отображается только дата, без времени.
 * Формулы SUMIFS/DATE корректно работают с такими датами.
 *
 * "2026-03-16" → Date (16.03.2026, 12:00 UTC)
 * "2026-08-10T20:10:21Z" → Date (10.08.2026, 12:00 UTC) — время
 * отбрасываем, MSK (+3ч) применяем только для определения дня.
 *
 * РЕШЕНИЕ ПО ЧИСЛАМ:
 * API WB отдаёт числа строками с точкой ("25.44"). В RU-локали это ТЕКСТ.
 * Конвертируем в number (NUMERIC_FIELDS + parseNumber).
 *
 * СТРУКТУРА ЛИСТА Calculation:
 * 9 колонок-периодов (E:M) = 6 последних дней + 3 предыдущих месяца.
 * Дневное окно (E:J) считается от "Дата от" (E4/E2), а не жёстко от
 * TODAY() — поэтому фильтр периода в Web App двигает и дни, и месяцы.
 * ensureCalculationSheetExists создаёт лист (со всеми формулами) один
 * раз при первом запуске. applyPeriod / resetPeriod меняют только
 * E2:G2 (что пересчитывает формулы). forceRebuildCalculationSheet
 * (вызывается вручную из редактора) пересоздаёт лист с чистыми
 * формулами — ручные значения OPEX при этом теряются, поэтому
 * используйте её только в аварийном случае.
 *
 * НАДЁЖНАЯ АВТОЗАГРУЗКА (защита от пропусков):
 * - Первый запуск грузит окно целиком: с 1-го числа месяца 3 месяца
 *   назад (столько нужно колонкам K:M) по сегодня.
 * - dailyUpdate (ежедневный триггер) перезапрашивает последние
 *   DAILY_OVERLAP_DAYS дней (WB дописывает строки задним числом),
 *   догоняет, если триггер несколько дней не работал, и дозагружает
 *   пропуски, найденные проверкой (Data_check.gs). Дубликаты
 *   отсекаются по rrdId.
 * - Загрузка идёт через очередь (ScriptProperties): при нехватке
 *   времени (лимит 6 мин) прогресс сохраняется и скрипт сам
 *   продолжает через минуту. Данные пишутся после каждой страницы.
 * - 429/5xx/сетевые ошибки повторяются; каждый запуск пишется в лист
 *   Load_log. После загрузки: очистка окна и проверка пропусков
 *   (письмо при проблемах).
 *
 * ЛИСТ Calculation_sku заполняется ВРУЧНУЮ (свои формулы). Скрипт только
 * создаёт шапку и читает лист для вкладки «P&L по SKU» в Web App.
 **********************************************************************/

/**********************************************************************
 * КОНСТАНТЫ
 **********************************************************************/
const API_URL = 'https://finance-api.wildberries.ru/api/finance/v1/sales-reports/detailed';
const SHEET_DATA = 'Data_wb';
const SHEET_CALC = 'Calculation';
const SHEET_INFO = 'Info';
const MAX_MONTHS_BACK = 3;        // окно хранения: с 1-го числа месяца N месяцев назад
const PAGE_LIMIT = 100000;
const REQUEST_PAUSE_MS = 62000;   // лимит WB: 1 запрос в минуту
const MAX_RUNTIME_MS = 5.5 * 60 * 1000;
const REQUEST_BUDGET_MS = 90 * 1000; // запас времени на один запрос + запись
const SELLER_NAME = 'ООО "Users"';

// Автозагрузка
const TZ_MSK = 'Europe/Moscow';
const CHUNK_DAYS = 30;            // период одного запроса к API
const DAILY_OVERLAP_DAYS = 7;     // сколько последних дней перезапрашивать каждый день
const DAILY_TRIGGER_HOUR = 6;     // час запуска dailyUpdate (МСК)
const LOAD_MAX_JOB_ERRORS = 3;    // после N ошибок подряд задание снимается
const LOAD_RETRY_DELAY_MS = 15 * 60 * 1000; // повтор после ошибки через 15 мин
const LOAD_LOG_SHEET = 'Load_log';
const LOAD_LOG_MAX_ROWS = 1000;
const PROP_LOAD_QUEUE = 'WB_LOAD_QUEUE';
const PROP_LAST_REQUEST = 'WB_LAST_REQUEST_AT';
const PROP_AFTERLOAD = 'WB_AFTERLOAD_PENDING';
const PROP_DATA_VERSION = 'WB_DATA_VERSION';

// Строки служебной "шапки" листа Calculation
const CALC_ROW_TITLE = 1;
const CALC_ROW_SUBTITLE = 2;
const CALC_ROW_SELLER = 3;
const CALC_ROW_CONTROLS = 4; // "Сформирован / Дата от / Дата до"
const CALC_ROW_TODAY_TAG = 5; // подпись "Сегодня" над колонкой E
const CALC_HEADER_ROW = 6; // №, Наименование, Сумма, Доля,% + даты периодов
const CALC_ROW_PARAMS = 7; // "Параметры": дни недели / конец месяца
const CALC_DATA_START_ROW = 8; // первая строка P&L-показателей
const CALC_DATA_END_ROW = 30; // "Чистая прибыль (Net Profit)"

// 9 колонок-периодов: 6 дней (E:J) + 3 месяца (K:M)
const CALC_PERIOD_COLS = ['E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M'];
const CALC_MONTH_COLS = ['K', 'L', 'M'];

// Сдвиг UTC → MSK (часы) — только для определения дня в дата-времени
const MSK_OFFSET_HOURS = 3;

/**********************************************************************
 * ЧИСЛОВЫЕ И ДАТОВЫЕ ПОЛЯ API
 **********************************************************************/
const NUMERIC_FIELDS = new Set([
  'reportId', 'reportType', 'rrdId', 'giId', 'dlvPrc',
  'nmId', 'quantity',
  'retailPrice', 'retailAmount', 'salePercent', 'commissionPercent',
  'retailPriceWithDisc', 'deliveryAmount', 'returnAmount',
  'deliveryService', // ← добавлено
  'productDiscountForReport', 'sellerPromo', 'spp',
  'kvwBase', 'kvw', 'supRatingUp', 'isKgvpV2',
  'ppvzSalesCommission', 'forPay', 'ppvzReward',
  'acquiringFee', 'acquiringPercent',
  'vw', 'vwNds',
  'ppvzOfficeId',
  'penalty', 'additionalPayment', 'rebillLogisticCost',
  'paidStorage', 'deduction', 'paidAcceptance',
  'orderId', 'shkId',
  'installmentCofinancingAmount',
  'wibesDiscountPercent', 'cashbackAmount', 'cashbackDiscount', 'cashbackCommissionChange',
  'paymentSchedule',
  'sellerPromoId', 'sellerPromoDiscount', 'loyaltyId', 'loyaltyDiscount',
  'salePricePromocodeDiscountPrc', 'salePriceAffiliatedDiscountPrc',
  'agencyVat', 'salePriceWholesaleDiscountPrc',
  'warehouseLogisticsCoeff'
]);

const DATE_FIELDS = new Set([
  'dateFrom', 'dateTo', 'createDate',
  'fixTariffDateFrom', 'fixTariffDateTo',
  'rrDate'
]);

const DATETIME_FIELDS = new Set([
  'orderDt', 'saleDt'
]);

/**********************************************************************
 * МЕНЮ (единое для всего проекта)
 **********************************************************************/
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('Отчёты МП')
    .addSubMenu(
      ui.createMenu('Ключи API')
        .addItem('Wildberries: ввести токен', 'Auth_setWbToken')
        .addItem('Ozon: ввести Client-Id и Api-Key', 'Auth_setOzonCredentials')
    )
    .addSeparator()
    .addSubMenu(
      ui.createMenu('Wildberries — P&L')
        .addItem('Первый запуск (3 месяца)', 'firstRun')
        .addItem('Ежедневное обновление (сейчас)', 'dailyUpdate')
        .addItem('Загрузить за период...', 'loadCustomPeriod')
        .addItem('Очистить старше 3 месяцев', 'cleanupOldRows')
        .addSeparator()
        .addItem('Создать лист Calculation_sku (шапка)', 'SkuCalc_setupSheet')
        .addItem('Формулы активного листа → на русском', 'Formulas_activeSheetToRussian')
    )
    .addSubMenu(
      ui.createMenu('Контроль данных')
        .addItem('Проверить пропуски', 'Gap_checkMenu')
        .addItem('Дозагрузить пропуски', 'Gap_healMenu')
        .addSeparator()
        .addItem('Установить ежедневный триггер', 'installDailyTrigger')
    )
    .addSubMenu(
      ui.createMenu('Wildberries — доп. отчёты')
        .addItem('Финансовый отчёт (эквайринг)', 'WbAcq2_loadReport')
        .addItem('Список товаров (SKU)', 'WbSku_loadGoods')
    )
    .addSubMenu(
      ui.createMenu('Ozon — отчёты')
        .addItem('Финансовый отчёт (Cash Flow)', 'OzFin1_loadReport')
        .addItem('Список товаров (SKU)', 'OzSku_loadProducts')
    )
    .addSeparator()
    .addItem('Открыть отчёт', 'openWebApp')
    .addSeparator()
    .addItem('Обновить Info', 'buildInfoSheet')
    .addToUi();
}

function openWebApp() {
  const url = ScriptApp.getService().getUrl();
  if (!url) {
    SpreadsheetApp.getUi().alert(
      'Web App ещё не развёрнут.\n\n' +
      'Развернуть → Новое развёртывание → Веб-приложение.'
    );
    return;
  }
  const html = HtmlService.createHtmlOutput(
    `<script>window.open('${url}', '_blank');google.script.host.close();</script>`
  ).setWidth(100).setHeight(50);
  SpreadsheetApp.getUi().showModalDialog(html, 'Открываю отчёт...');
}

/**********************************************************************
 * ТОЧКИ ВХОДА (WB P&L)
 * Токен WB берётся из единого хранилища — см. Auth.gs → Auth_getWbToken().
 * Все даты загрузчика — «день» в МСК, хранится как Date UTC-полдень
 * (как и в Data_wb): не зависит от часового пояса проекта.
 **********************************************************************/
function firstRun() {
  const from = retentionStart_();
  const to = mskToday_();
  ensureCalculationSheetExists();
  buildInfoSheet();
  enqueueLoad_(from, to, `первый запуск (${MAX_MONTHS_BACK} мес.)`);
  processLoadQueue_();
}

/**
 * ЕЖЕДНЕВНОЕ ОБНОВЛЕНИЕ — на него ставится триггер (installDailyTrigger).
 * 1) перезапрашивает последние DAILY_OVERLAP_DAYS дней;
 * 2) если последние данные старше — догоняет с даты последних данных;
 * 3) дозагружает пропуски раньше этого окна (Data_check.gs);
 * 4) после загрузки: очистка, проверка + письмо.
 */
function dailyUpdate() {
  const today = mskToday_();
  const start = retentionStart_();
  let from = dayAdd_(today, -DAILY_OVERLAP_DAYS);

  const last = dataWbLastDate_();
  if (!last) from = start;                               // данных нет — всё окно
  else if (last < from) from = dayAdd_(last, -1);        // триггер «пропускал» дни
  if (from < start) from = start;

  enqueueLoad_(from, today, 'ежедневное обновление');

  if (typeof Gap_findHealRanges_ === 'function') {
    try {
      Gap_findHealRanges_(dayKey_(from), true)
        .forEach(r => enqueueLoad_(r.from, r.to, 'дозагрузка пропусков'));
    } catch (e) {
      logLoad_('проверка пропусков', '', '', 0, 'ОШИБКА', e.message);
    }
  }
  processLoadQueue_();
}

/** Совместимость: старый пункт меню / старый триггер. */
function loadYesterday() {
  dailyUpdate();
}

function loadCustomPeriod() {
  const ui = SpreadsheetApp.getUi();
  const r1 = ui.prompt('Дата начала (ГГГГ-ММ-ДД):', ui.ButtonSet.OK_CANCEL);
  if (r1.getSelectedButton() !== ui.Button.OK) return;
  const r2 = ui.prompt('Дата окончания (ГГГГ-ММ-ДД):', ui.ButtonSet.OK_CANCEL);
  if (r2.getSelectedButton() !== ui.Button.OK) return;

  const from = parseDate(r1.getResponseText().trim());
  const to = parseDate(r2.getResponseText().trim());
  if (!from || !to) { ui.alert('Неверный формат даты'); return; }
  if (from > to) { ui.alert('Дата начала больше даты окончания'); return; }

  const cutoff = retentionStart_();
  const realFrom = from < cutoff ? cutoff : from;
  if (realFrom > to) {
    ui.alert(`Период вне допустимого окна (${MAX_MONTHS_BACK} месяца, с ${formatRu(cutoff)}).`);
    return;
  }
  enqueueLoad_(realFrom, to, 'ручной период');
  processLoadQueue_();
}

/** Ставит ежедневный триггер dailyUpdate (старые триггеры загрузки удаляет). */
function installDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (['dailyUpdate', 'loadYesterday', 'cleanupOldRows', 'runReport'].includes(t.getHandlerFunction())) {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('dailyUpdate')
    .timeBased()
    .everyDays(1)
    .atHour(DAILY_TRIGGER_HOUR)
    .inTimezone(TZ_MSK)
    .create();
  const msg = `Триггер установлен: dailyUpdate ежедневно в ~${DAILY_TRIGGER_HOUR}:00 МСК ` +
    '(от имени текущего пользователя — используется ЕГО токен WB).';
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { Logger.log(msg); }
}

/**********************************************************************
 * ОЧЕРЕДЬ ЗАГРУЗКИ
 * Задание: { from, to, label, cur, rrdId, rows, errors, updatedAt }
 * (даты — "yyyy-MM-dd"). cur/rrdId — курсор: откуда продолжать после
 * таймаута. Очередь хранится в ScriptProperties и переживает перезапуски.
 **********************************************************************/
function enqueueLoad_(from, to, label) {
  const f = dayKey_(from);
  const t = dayKey_(to);
  withQueue_(q => {
    // Уже есть задание, покрывающее этот период — не дублируем
    if (q.some(j => j.from <= f && j.to >= t && j.cur <= f)) return q;
    q.push({
      id: Date.now() + '_' + Math.floor(Math.random() * 1e6),
      from: f, to: t, label: label, cur: f, rrdId: 0, rows: 0, errors: 0, updatedAt: Date.now()
    });
    return q;
  });
}

function getLoadQueue_() {
  const raw = PropertiesService.getScriptProperties().getProperty(PROP_LOAD_QUEUE);
  return raw ? JSON.parse(raw) : [];
}

/**
 * Изменение очереди под короткой блокировкой документа. Обработчик
 * держит ScriptLock всё время загрузки, поэтому для очереди нужна
 * отдельная блокировка — иначе задание, добавленное во время загрузки
 * (например, ручной «Загрузить за период»), затёрлось бы.
 */
function withQueue_(fn) {
  const lock = LockService.getDocumentLock();
  lock.waitLock(20000);
  try {
    const q = fn(getLoadQueue_());
    const props = PropertiesService.getScriptProperties();
    if (q.length) props.setProperty(PROP_LOAD_QUEUE, JSON.stringify(q));
    else props.deleteProperty(PROP_LOAD_QUEUE);
  } finally {
    lock.releaseLock();
  }
}

function updateJob_(job) {
  withQueue_(q => q.map(j => (j.id === job.id ? job : j)));
}

function removeJob_(job) {
  withQueue_(q => q.filter(j => j.id !== job.id));
}

/** Точка входа одноразового триггера-продолжения. */
function continueLoadQueue() {
  processLoadQueue_();
}

function processLoadQueue_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    notify_('Загрузка уже выполняется — задание поставлено в очередь.');
    return;
  }
  const startTime = Date.now();
  const props = PropertiesService.getScriptProperties();
  try {
    deleteContinuationTriggers_();
    let token = null;

    while (true) {
      const job = getLoadQueue_()[0];
      if (!job) break;
      let state;
      try {
        token = token || Auth_getWbToken();
        state = runJob_(token, job, startTime, () => updateJob_(job));
      } catch (e) {
        job.errors = (job.errors || 0) + 1;
        job.updatedAt = Date.now();
        const fatal = /^(401|402|403)|не задан/.test(e.message);
        if (fatal || job.errors >= LOAD_MAX_JOB_ERRORS) {
          logLoad_(job.label, job.from, job.to, job.rows, 'ПРОПУЩЕНО',
            `${e.message} (попыток: ${job.errors}). Пропуск будет найден проверкой.`);
          removeJob_(job);
          props.setProperty(PROP_AFTERLOAD, '1');
          continue;
        }
        updateJob_(job);
        logLoad_(job.label, job.from, job.to, job.rows, 'ОШИБКА',
          `${e.message}. Повтор через ${LOAD_RETRY_DELAY_MS / 60000} мин (попытка ${job.errors}).`);
        scheduleContinuation_(LOAD_RETRY_DELAY_MS);
        return;
      }

      if (state === 'timeout') {
        updateJob_(job);
        logLoad_(job.label, job.from, job.to, job.rows, 'ПРОДОЛЖЕНИЕ',
          `Лимит времени: продолжу с ${job.cur} через 1 мин.`);
        scheduleContinuation_(60 * 1000);
        notify_(`Загружено ${job.rows} строк, продолжение через минуту (автоматически).`);
        return;
      }

      logLoad_(job.label, job.from, job.to, job.rows, 'OK', '');
      removeJob_(job);
      props.setProperty(PROP_AFTERLOAD, '1');
    }

    // Очередь пуста — пост-обработка (если осталось время, иначе в продолжении)
    if (props.getProperty(PROP_AFTERLOAD)) {
      if (Date.now() - startTime > MAX_RUNTIME_MS - 2 * 60 * 1000) {
        scheduleContinuation_(60 * 1000);
        return;
      }
      props.deleteProperty(PROP_AFTERLOAD);
      afterLoad_();
    }
  } finally {
    lock.releaseLock();
  }
}

/**
 * Выполняет одно задание. Пишет данные после КАЖДОЙ страницы и сохраняет
 * курсор — при таймауте/ошибке уже загруженное не теряется.
 * Возвращает 'done' | 'timeout'.
 */
function runJob_(token, job, startTime, persist) {
  const to = isoDateToDate(job.to);
  let cur = isoDateToDate(job.cur);

  while (cur <= to) {
    let end = dayAdd_(cur, CHUNK_DAYS - 1);
    if (end > to) end = to;

    while (true) {
      if (!hasTimeForRequest_(startTime)) return 'timeout';
      const page = fetchPage_(token, cur, end, job.rrdId);
      if (!page.length) break;

      appendToDataSheet(page);
      job.rows += page.length;
      job.rrdId = page[page.length - 1].rrdId;
      job.updatedAt = Date.now();
      persist();
      if (page.length < PAGE_LIMIT) break;
    }

    cur = dayAdd_(end, 1);
    job.cur = dayKey_(cur);
    job.rrdId = 0;
    job.errors = 0;
    job.updatedAt = Date.now();
    persist();
  }
  return 'done';
}

/** Хватит ли времени на паузу лимита + ещё один запрос с записью. */
function hasTimeForRequest_(startTime) {
  const wait = rateLimitWaitMs_();
  return Date.now() - startTime + wait + REQUEST_BUDGET_MS < MAX_RUNTIME_MS;
}

function rateLimitWaitMs_() {
  const last = +(PropertiesService.getScriptProperties().getProperty(PROP_LAST_REQUEST) || 0);
  return Math.max(0, last + REQUEST_PAUSE_MS - Date.now());
}

function scheduleContinuation_(ms) {
  deleteContinuationTriggers_();
  ScriptApp.newTrigger('continueLoadQueue').timeBased().after(ms).create();
}

function deleteContinuationTriggers_() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'continueLoadQueue') ScriptApp.deleteTrigger(t);
  });
}

/** После загрузки: очистка окна, P&L по SKU, контроль пропусков. */
function afterLoad_() {
  const steps = [
    ['очистка', () => cleanupOldRows_(false)],
    ['контроль данных', () => { if (typeof Gap_runCheck === 'function') Gap_runCheck({ notify: true }); }]
  ];
  steps.forEach(([name, fn]) => {
    try { fn(); } catch (e) { logLoad_(name, '', '', 0, 'ОШИБКА', e.message); }
  });
}

/**********************************************************************
 * ЖУРНАЛ ЗАГРУЗОК (лист Load_log)
 **********************************************************************/
function logLoad_(label, from, to, rows, status, message) {
  try {
    const ss = SpreadsheetApp.getActive();
    let sh = ss.getSheetByName(LOAD_LOG_SHEET);
    if (!sh) {
      sh = ss.insertSheet(LOAD_LOG_SHEET);
      sh.getRange(1, 1, 1, 7).setValues([['Время', 'Операция', 'Период с', 'Период по', 'Строк', 'Статус', 'Сообщение']])
        .setFontWeight('bold').setBackground('#efefef');
      sh.setFrozenRows(1);
      sh.setColumnWidth(1, 140);
      sh.setColumnWidth(2, 190);
      sh.setColumnWidth(7, 520);
      sh.getRange('A:A').setNumberFormat('dd.MM.yyyy HH:mm');
    }
    sh.appendRow([new Date(), label, from, to, rows, status, message || '']);
    const color = { OK: '#e6f4ea', 'ПРОДОЛЖЕНИЕ': '#eef3fb', 'ОШИБКА': '#fde8e1', 'ПРОПУЩЕНО': '#fde8e1' }[status];
    if (color) sh.getRange(sh.getLastRow(), 6).setBackground(color);
    if (sh.getLastRow() > LOAD_LOG_MAX_ROWS + 1) {
      sh.deleteRows(2, sh.getLastRow() - LOAD_LOG_MAX_ROWS - 1);
    }
  } catch (e) {
    Logger.log('Load_log: ' + e.message);
  }
  Logger.log(`[${status}] ${label} ${from}–${to}: ${rows} строк. ${message || ''}`);
}

/** Toast работает только при ручном запуске; в триггере — просто лог. */
function notify_(msg) {
  Logger.log(msg);
  try { SpreadsheetApp.getActive().toast(msg, 'WB', 8); } catch (e) { /* триггер */ }
}

/**********************************************************************
 * API
 **********************************************************************/
/** Одна страница отчёта (с учётом лимита 1 запрос/мин). */
function fetchPage_(token, dateFrom, dateTo, rrdId) {
  const payload = {
    dateFrom: dayKey_(dateFrom),
    dateTo: dayKey_(dateTo),
    limit: PAGE_LIMIT,
    rrdId: rrdId || 0,
    period: 'daily'
  };
  const resp = fetchWithRetry(token, payload);
  const code = resp.getResponseCode();
  if (code === 204) return [];
  if (code !== 200) {
    throw new Error(`WB API ${code}: ${resp.getContentText().slice(0, 300)}`);
  }
  const data = JSON.parse(resp.getContentText());
  return Array.isArray(data) ? data : [];
}

/**
 * Запрос с повторами: 429 (ждём X-Ratelimit-Retry или паузу), 5xx и
 * сетевые исключения (до 5 попыток). 401/402/403 — сразу ошибка.
 */
function fetchWithRetry(token, payload) {
  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: token },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  const props = PropertiesService.getScriptProperties();
  let lastErr = '';

  for (let attempt = 1; attempt <= 5; attempt++) {
    const wait = rateLimitWaitMs_();
    if (wait > 0) Utilities.sleep(wait);
    props.setProperty(PROP_LAST_REQUEST, String(Date.now()));

    let resp;
    try {
      resp = UrlFetchApp.fetch(API_URL, options);
    } catch (e) {
      lastErr = 'сеть: ' + e.message;
      continue; // следующая попытка — после паузы лимита
    }
    const code = resp.getResponseCode();

    if (code === 429) {
      const h = resp.getHeaders() || {};
      const retry = +(h['X-Ratelimit-Retry'] || h['x-ratelimit-retry'] || 0);
      if (retry > 0) Utilities.sleep(Math.min(retry, 120) * 1000);
      lastErr = '429: превышен лимит запросов';
      continue;
    }
    if (code >= 500) {
      lastErr = `${code}: ошибка сервера WB`;
      continue;
    }
    if (code === 401) throw new Error('401: неверный или просроченный токен');
    if (code === 403) throw new Error('403: у токена нет категории «Финансы»');
    if (code === 402) throw new Error('402: недостаточно средств на балансе');
    return resp;
  }
  throw new Error(`Попытки исчерпаны (${lastErr})`);
}

/**********************************************************************
 * ЗАПИСЬ В Data_wb
 **********************************************************************/
function appendToDataSheet(rows) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(SHEET_DATA);
  if (!sh) sh = ss.insertSheet(SHEET_DATA);

  const keySet = new Set();
  rows.forEach(r => Object.keys(r).forEach(k => keySet.add(k)));
  const incomingHeaders = Array.from(keySet);

  const lastCol = sh.getLastColumn();
  let existingHeaders = lastCol > 0
    ? sh.getRange(1, 1, 1, lastCol).getValues()[0].filter(h => h !== '')
    : [];

  const merged = mergeHeaders(existingHeaders, incomingHeaders);
  const headersChanged =
    merged.length !== existingHeaders.length ||
    merged.some((h, i) => h !== existingHeaders[i]);

  if (headersChanged) {
    if (sh.getLastRow() > 1) {
      migrateSheet(sh, existingHeaders, merged);
    } else {
      // Раньше при листе «только заголовок» новые поля не дописывались
      // в шапку, и данные сдвигались относительно заголовков.
      sh.getRange(1, 1, 1, merged.length).setValues([merged]);
    }
  }

  const rrdIdx = merged.indexOf('rrdId');
  let existingRrd = new Set();
  if (rrdIdx >= 0 && sh.getLastRow() > 1) {
    const colVals = sh.getRange(2, rrdIdx + 1, sh.getLastRow() - 1, 1).getValues();
    existingRrd = new Set(colVals.flat().map(String));
  }

  const fresh = rrdIdx >= 0
    ? rows.filter(r => !existingRrd.has(String(r.rrdId)))
    : rows;

  if (!fresh.length) {
    notify_('Новых строк нет (все rrdId уже есть).');
    return;
  }

  const matrix = fresh.map(r => merged.map(h => normalize(r[h], h)));
  const startRow = sh.getLastRow() + 1;
  sh.getRange(startRow, 1, matrix.length, merged.length).setValues(matrix);

  styleHeader(sh, merged.length);
  applyDateFormatToDateColumns(sh);
  bumpDataVersion_();
}

/** Версия данных — по ней графики понимают, что кэш устарел. */
function bumpDataVersion_() {
  const props = PropertiesService.getScriptProperties();
  props.setProperty(PROP_DATA_VERSION, String(+(props.getProperty(PROP_DATA_VERSION) || 0) + 1));
}

/** Последняя дата rrDate в Data_wb (Date UTC-полдень) или null. */
function dataWbLastDate_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_DATA);
  if (!sh || sh.getLastRow() < 2) return null;
  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const idx = headers.indexOf('rrDate');
  if (idx < 0) return null;
  let max = null;
  sh.getRange(2, idx + 1, sh.getLastRow() - 1, 1).getValues().forEach(r => {
    const v = r[0];
    if (v instanceof Date && (!max || v > max)) max = v;
  });
  return max ? isoDateToDate(dayKey_(max)) : null;
}

function migrateSheet(sh, oldHeaders, newHeaders) {
  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();

  if (lastRow < 2) {
    sh.clear();
    sh.getRange(1, 1, 1, newHeaders.length).setValues([newHeaders]);
    applyDateFormatToDateColumns(sh);
    return;
  }

  const data = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();
  const oldIdx = {};
  oldHeaders.forEach((h, i) => { oldIdx[h] = i; });

  const newData = data.map(row => newHeaders.map(h => {
    const i = oldIdx[h];
    if (i === undefined) return '';
    const v = row[i];

    // Старое значение типа Date → Date без времени (UTC-полдень)
    if (v instanceof Date && (DATE_FIELDS.has(h) || DATETIME_FIELDS.has(h))) {
      const y = v.getUTCFullYear();
      const m = v.getUTCMonth();
      const d = v.getUTCDate();
      return new Date(Date.UTC(y, m, d, 12, 0, 0, 0));
    }
    // Строка → Date
    if (typeof v === 'string' && v.trim() !== '') {
      if (DATE_FIELDS.has(h)) {
        const d = isoDateToDate(v.trim());
        return d || v;
      }
      if (DATETIME_FIELDS.has(h)) {
        const d = isoDateTimeToDate(v.trim());
        return d || v;
      }
    }
    return v;
  }));

  sh.clear();
  sh.getRange(1, 1, 1, newHeaders.length).setValues([newHeaders]);
  if (newData.length) {
    sh.getRange(2, 1, newData.length, newHeaders.length).setValues(newData);
  }
  applyDateFormatToDateColumns(sh);
}

function mergeHeaders(a, b) {
  const out = a.slice();
  b.forEach(h => { if (!out.includes(h)) out.push(h); });
  return out;
}

function styleHeader(sh, cols) {
  const rng = sh.getRange(1, 1, 1, cols);
  rng.setFontWeight('bold').setBackground('#efefef');
  sh.setFrozenRows(1);
}

/**
 * Проставляет датовым колонкам формат "dd.MM.yyyy".
 * Значения — нативный Date (UTC-полдень), поэтому формулы SUMIFS
 * работают, а на экране видна только дата, без времени.
 */
function applyDateFormatToDateColumns(sh) {
  const lastCol = sh.getLastColumn();
  if (lastCol < 1) return;
  const maxRows = sh.getMaxRows();
  if (maxRows < 2) return;

  const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  headers.forEach((h, i) => {
    if (DATE_FIELDS.has(h) || DATETIME_FIELDS.has(h)) {
      sh.getRange(2, i + 1, maxRows - 1, 1).setNumberFormat('dd.MM.yyyy');
    }
  });
}

/**********************************************************************
 * НОРМАЛИЗАЦИЯ ЗНАЧЕНИЙ
 **********************************************************************/
function normalize(v, key) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') {
    return isFinite(v) ? v : '';
  }
  if (typeof v === 'string') {
    const s = v.trim();
    if (s === '') return '';
    if (NUMERIC_FIELDS.has(key)) {
      return parseNumber(s);
    }
    if (DATE_FIELDS.has(key)) {
      return isoDateToDate(s); // Date (UTC-полдень), без времени
    }
    if (DATETIME_FIELDS.has(key)) {
      return isoDateTimeToDate(s); // Date (UTC-полдень), без времени, день в MSK
    }
    return v;
  }
  if (typeof v === 'object') {
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  }
  return v;
}

function parseNumber(s) {
  if (s === '' || s === null || s === undefined) return '';
  const cleaned = String(s)
    .replace(/\s/g, '')
    .replace(',', '.');
  const n = Number(cleaned);
  return isNaN(n) ? '' : n;
}

/**
 * "2026-03-16" → Date(16.03.2026 12:00 UTC).
 * UTC-полдень = защита от сдвига на ±1 день в любом часовом поясе.
 */
function isoDateToDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s).trim());
  if (!m) return '';
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12, 0, 0, 0));
}

/**
 * "2026-08-10T20:10:21Z" → Date(10.08.2026 12:00 UTC).
 * Время отбрасываем. День определяем в MSK: UTC+3.
 */
function isoDateTimeToDate(s) {
  const str = String(s).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/.exec(str);
  if (!m) return '';

  let year = +m[1];
  let month = +m[2];
  let day = +m[3];
  let hh = +m[4];
  let mi = +m[5];

  // Часовой сдвиг исходной записи
  let offsetMin = 0;
  const tz = m[8];
  if (tz && tz !== 'Z') {
    const tm = /^([+-])(\d{2}):?(\d{2})$/.exec(tz);
    if (tm) {
      const sign = tm[1] === '-' ? -1 : 1;
      offsetMin = sign * (+tm[2] * 60 + +tm[3]);
    }
  }

  // UTC → MSK (+3ч), учитываем переход через полночь
  let totalMin = hh * 60 + mi - offsetMin + MSK_OFFSET_HOURS * 60;
  let dayShift = Math.floor(totalMin / 1440);
  totalMin = ((totalMin % 1440) + 1440) % 1440;

  if (dayShift !== 0) {
    const d = new Date(Date.UTC(year, month - 1, day));
    d.setUTCDate(d.getUTCDate() + dayShift);
    year = d.getUTCFullYear();
    month = d.getUTCMonth() + 1;
    day = d.getUTCDate();
  }
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
}

/**********************************************************************
 * МИГРАЦИЯ СТАРЫХ ДАННЫХ (в меню НЕ выводится)
 * Вызывается вручную из редактора Apps Script.
 **********************************************************************/
function recalcNumbersInDataSheet() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_DATA);
  if (!sh) {
    SpreadsheetApp.getActive().toast('Лист Data_wb не найден.', 'WB', 6);
    return;
  }
  const lastRow = sh.getLastRow();
  const lastCol = sh.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return;

  const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  const numericIdx = [];
  const dateIdx = [];
  const dtIdx = [];
  headers.forEach((h, i) => {
    if (NUMERIC_FIELDS.has(h)) numericIdx.push(i);
    else if (DATE_FIELDS.has(h)) dateIdx.push(i);
    else if (DATETIME_FIELDS.has(h)) dtIdx.push(i);
  });

  const range = sh.getRange(2, 1, lastRow - 1, lastCol);
  const values = range.getValues();
  let convertedNum = 0;
  let convertedDate = 0;

  for (let r = 0; r < values.length; r++) {
    // Числа
    for (const c of numericIdx) {
      const v = values[r][c];
      if (typeof v === 'number') continue;
      if (v === '' || v === null) continue;
      const n = parseNumber(String(v));
      if (n !== '') { values[r][c] = n; convertedNum++; }
      else values[r][c] = '';
    }
    // Даты (без времени)
    for (const c of dateIdx) {
      const v = values[r][c];
      if (v === '' || v === null) continue;
      if (v instanceof Date) {
        const y = v.getUTCFullYear(), m = v.getUTCMonth(), d = v.getUTCDate();
        values[r][c] = new Date(Date.UTC(y, m, d, 12, 0, 0, 0));
        convertedDate++;
        continue;
      }
      const s = String(v).trim();
      let d1 = isoDateToDate(s);
      if (!d1) {
        const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(s);
        if (m) {
          d1 = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], 12, 0, 0, 0));
        }
      }
      if (d1) { values[r][c] = d1; convertedDate++; }
    }
    // Дата-время → только дата (в MSK)
    for (const c of dtIdx) {
      const v = values[r][c];
      if (v === '' || v === null) continue;
      if (v instanceof Date) {
        const y = v.getUTCFullYear(), m = v.getUTCMonth(), d = v.getUTCDate();
        values[r][c] = new Date(Date.UTC(y, m, d, 12, 0, 0, 0));
        convertedDate++;
        continue;
      }
      const s = String(v).trim();
      let d1 = isoDateTimeToDate(s);
      if (!d1) {
        const m = /^(\d{2})\.(\d{2})\.(\d{4})(?:\s+\d{2}:\d{2})?$/.exec(s);
        if (m) {
          d1 = new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], 12, 0, 0, 0));
        }
      }
      if (d1) { values[r][c] = d1; convertedDate++; }
    }
  }

  range.setValues(values);
  applyDateFormatToDateColumns(sh);
  SpreadsheetApp.getActive().toast(
    `Пересчитано: чисел ${convertedNum}, дат ${convertedDate}`,
    'WB', 8
  );
}

/**********************************************************************
 * ОЧИСТКА СТАРШЕ 3 МЕСЯЦЕВ
 * Граница = 1-е число месяца MAX_MONTHS_BACK месяцев назад (МСК), а не
 * «90 дней»: иначе самый старый месяц в колонке M листа Calculation
 * получался неполным (при 90 днях к концу месяца он пустел почти целиком).
 * Строки удаляются блоками (deleteRows), а не по одной — быстрее в сотни
 * раз и не упирается в лимит 6 минут.
 **********************************************************************/
function cleanupOldRows() {
  cleanupOldRows_(true);
}

function cleanupOldRows_(interactive) {
  const say = msg => { if (interactive) notify_(msg); else Logger.log(msg); };
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_DATA);
  if (!sh) return 0;
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return 0;

  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const dateIdx = headers.indexOf('rrDate');
  if (dateIdx < 0) {
    say('Не найден столбец rrDate.');
    return 0;
  }

  const cutoffKey = dayKey_(retentionStart_());

  const values = sh.getRange(2, dateIdx + 1, lastRow - 1, 1).getValues();
  const drop = [];
  values.forEach((row, i) => {
    const v = row[0];
    if (v === '' || v === null) return;
    let key = '';
    if (v instanceof Date) {
      key = dayKey_(v);
    } else {
      const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(v).trim());
      if (m) key = `${m[3]}-${m[2]}-${m[1]}`;
    }
    if (key && key < cutoffKey) drop.push(i + 2);
  });

  // Склеиваем подряд идущие строки в блоки и удаляем снизу вверх
  const blocks = [];
  drop.forEach(r => {
    const last = blocks[blocks.length - 1];
    if (last && last.start + last.count === r) last.count++;
    else blocks.push({ start: r, count: 1 });
  });
  blocks.reverse().forEach(b => sh.deleteRows(b.start, b.count));

  if (drop.length) {
    bumpDataVersion_();
    logLoad_('очистка', '', dayKey_(retentionStart_()), drop.length, 'ИНФО', 'удалено строк старше окна');
  }
  say(`Удалено строк: ${drop.length}`);
  return drop.length;
}

/**********************************************************************
 * ЛИСТ Calculation — создаётся один раз, дальше живёт на формулах.
 **********************************************************************/
function ensureCalculationSheetExists() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(SHEET_CALC);
  if (sh) return sh;
  sh = ss.insertSheet(SHEET_CALC);
  initCalculationSheet(sh);
  return sh;
}

// Описание всех строк P&L.
// type управляет и формулой, и оформлением:
// section --- заголовок раздела (сумма дочерних строк)
// money --- обычная денежная строка (авто-формула из Data_wb)
// sub --- денежная под-строка "в т.ч." (авто-формула)
// sub_pct --- процентная под-строка "в т.ч. ..., %"
// pct --- итоговая процентная строка (рентабельность)
// manual --- заполняется пользователем вручную (WB API не отдаёт)
// total --- итоговая строка (Чистая прибыль)
const CALC_ROWS = [
  { row: 8, code: '', name: 'Доходы', type: 'section' },
  { row: 9, code: '010', name: 'Чистая выручка (Net Sales), с НДС', type: 'money' },
  { row: 10, code: '015', name: 'Возвраты (Refunds), с НДС', type: 'money' },
  { row: 11, code: '008', name: 'К перечислению (forPay), с НДС', type: 'money' },
  { row: 12, code: '', name: 'Внереализационный доход, с НДС (СПП)', type: 'money' },
  { row: 13, code: '', name: 'Прямые расходы (COGS & WB Fees)', type: 'section' },
  { row: 14, code: '020', name: 'Себестоимость (COGS), без НДС', type: 'manual' },
  { row: 15, code: '025', name: 'Итого расходы маркетплейса, с НДС', type: 'money' },
  { row: 16, code: '', name: 'в т.ч. комиссия WB, нетто', type: 'sub' },
  { row: 17, code: '', name: 'в т.ч. комиссия WB, %', type: 'sub_pct' },
  { row: 18, code: '', name: 'в т.ч. логистика, нетто', type: 'sub' },
  { row: 19, code: '', name: 'в т.ч. логистика, %', type: 'sub_pct' },
  { row: 20, code: '', name: 'в т.ч. хранение', type: 'sub' },
  { row: 21, code: '', name: 'в т.ч. штрафы и прочие удержания', type: 'sub' },
  { row: 22, code: '', name: 'Валовая прибыль (Gross Margin)', type: 'section' },
  { row: 23, code: '030', name: 'Валовая прибыль (GM), управленческая', type: 'money' },
  { row: 24, code: '035', name: 'Рентабельность по GM, %', type: 'pct' },
  { row: 25, code: '', name: 'Операционные расходы (OPEX)', type: 'section' },
  { row: 26, code: '040', name: 'Реклама', type: 'manual' },
  { row: 27, code: '045', name: 'Налог', type: 'manual' },
  { row: 28, code: '050', name: 'Зарплата / фриланс', type: 'manual' },
  { row: 29, code: '055', name: 'Прочие OPEX', type: 'manual' },
  { row: 30, code: '060', name: 'Чистая прибыль (Net Profit)', type: 'total' }
];

function initCalculationSheet(sh) {
  // --- Заголовок и панель управления периодом ---
  sh.getRange(CALC_ROW_TITLE, 1).setValue('P&L REPORT Wildberries');
  sh.getRange(CALC_ROW_SUBTITLE, 1).setValue('Отчёт о прибылях и убытках');
  sh.getRange(CALC_ROW_SUBTITLE, 3).setValue('Установка даты:');
  sh.getRange(CALC_ROW_SELLER, 1).setValue(`Продавец — ${SELLER_NAME}`);
  sh.getRange(CALC_ROW_CONTROLS, 1).setValue('Период отчёта (в рублях) Сформирован:');
  setFormulaRu_(sh.getRange(CALC_ROW_CONTROLS, 3), '=E4');
  sh.getRange(CALC_ROW_CONTROLS, 4).setValue('Дата от:');
  setFormulaRu_(sh.getRange(CALC_ROW_CONTROLS, 5), '=ЕСЛИ(E2="";СЕГОДНЯ();E2)');
  sh.getRange(CALC_ROW_CONTROLS, 6).setValue('Дата до:');
  setFormulaRu_(sh.getRange(CALC_ROW_CONTROLS, 7), '=ЕСЛИ(G2="";ДАТАМЕС(E4;-3);G2)');
  sh.getRange('D2').setValue('Дата от (фильтр):');
  sh.getRange('F2').setValue('Дата до (фильтр):');
  sh.getRange('E2').setValue('');
  sh.getRange('G2').setValue('');
  sh.getRange(CALC_ROW_TODAY_TAG, 5).setValue('Сегодня');

  sh.getRange('A1').setFontSize(14).setFontWeight('bold');
  sh.getRange('A2:A3').setFontWeight('bold');
  sh.getRange('C2,D2,F2,D4,F4').setFontWeight('bold').setFontColor('#737272');
  sh.getRange('E2,G2').setBackground('#fff5f1');
  sh.getRange('C4,E4,G4').setFontColor('#737272');

  // --- Заголовок таблицы (строка 6) и строка "Параметры" (7) ---
  const header = ['№', 'Наименование показателя', 'Сумма', 'Доля, %'];
  sh.getRange(CALC_HEADER_ROW, 1, 1, header.length).setValues([header])
    .setFontWeight('bold').setBackground('#efefef');
  sh.getRange(CALC_ROW_PARAMS, 2).setValue('Параметры');
  sh.setFrozenRows(CALC_HEADER_ROW);
  sh.setFrozenColumns(2);

  CALC_PERIOD_COLS.forEach((col, i) => {
    const isMonth = CALC_MONTH_COLS.includes(col);
    if (!isMonth) {
      // Дни: E --- якорь от "Дата от" (E4), дальше на 1 день назад.
      // Якорь на E4 (а не TODAY()) --- чтобы фильтр периода в Web App
      // двигал не только месяцы, но и дневное окно.
      const formula = (col === 'E') ? '=$E$4' : `=${prevCol(col)}${CALC_HEADER_ROW}-1`;
      setFormulaRu_(sh.getRange(`${col}${CALC_HEADER_ROW}`), formula);
      setFormulaRu_(sh.getRange(`${col}${CALC_ROW_PARAMS}`), `=ТЕКСТ(${col}${CALC_HEADER_ROW};"dddd")`);
      sh.getRange(`${col}${CALC_ROW_PARAMS}`).setNumberFormat('@');
    } else {
      const back = i - 5; // K = 1 месяц назад, L = 2, M = 3
      setFormulaRu_(sh.getRange(`${col}${CALC_HEADER_ROW}`), `=ДАТА(ГОД($E$4);МЕСЯЦ($E$4)-${back};1)`);
      setFormulaRu_(sh.getRange(`${col}${CALC_ROW_PARAMS}`), `=КОНМЕСЯЦА($E$4;-${back})`);
      sh.getRange(`${col}${CALC_ROW_PARAMS}`).setNumberFormat('dd.MM.yyyy');
    }
    sh.getRange(`${col}${CALC_HEADER_ROW}`).setNumberFormat('dd.MM.yyyy');
  });

  // --- Строки-показатели: подписи + формулы по каждому периоду ---
  CALC_ROWS.forEach(def => {
    sh.getRange(def.row, 1).setValue(def.code);
    sh.getRange(def.row, 2).setValue(def.name);

    CALC_PERIOD_COLS.forEach(col => {
      const f = calcFormula(def.row, col);
      if (f) setFormulaRu_(sh.getRange(`${col}${def.row}`), f);
    });

    const cd = calcSumShareFormula(def);
    if (cd.sum) setFormulaRu_(sh.getRange(`C${def.row}`), cd.sum);
    if (cd.share) setFormulaRu_(sh.getRange(`D${def.row}`), cd.share);

    styleCalcRow(sh, def);
  });

  sh.autoResizeColumns(1, 2);
  sh.setColumnWidth(3, 120);
  sh.setColumnWidth(4, 90);
  for (let c = 5; c <= 13; c++) sh.setColumnWidth(c, 110);

  // Если таблица не приняла русские названия функций — переписываем
  // такие ячейки английским эквивалентом (формулы продолжат считать).
  Formulas_fixRejected_(sh);
}

function prevCol(col) {
  return String.fromCharCode(col.charCodeAt(0) - 1);
}

// Формула конкретной строки P&L для конкретной колонки-периода.
// Нижняя граница --- дата в CALC_HEADER_ROW; верхняя --- для дней это
// "+1 день" (полуоткрытый интервал), для месяцев --- EOMONTH+1 (чтобы
// последний день месяца попадал в выборку).
function calcFormula(row, col) {
  const isMonth = CALC_MONTH_COLS.includes(col);
  const lower = `${col}${CALC_HEADER_ROW}`;
  const upper = isMonth ? `(${col}${CALC_ROW_PARAMS}+1)` : `(${col}${CALC_HEADER_ROW}+1)`;

  const sumifs = (colLetter, extra) =>
    `СУММЕСЛИМН(Data_wb!$${colLetter}:$${colLetter};${extra ? extra + ';' : ''}` +
    `Data_wb!$AB:$AB;">="&${lower};Data_wb!$AB:$AB;"<"&${upper})`;

  switch (row) {
    case 8: return `=${col}9+${col}12`;
    case 9: return `=${sumifs('V', 'Data_wb!$Z:$Z;"Продажа"')}-${col}10`;
    case 10: return `=${sumifs('V', 'Data_wb!$Z:$Z;"Возвраты"')}`;
    case 11: return `=${sumifs('AR', 'Data_wb!$Z:$Z;"Продажа"')}`;
    case 12: return `=ЕСЛИ((${col}11-${col}9)<0;0;${col}11-${col}9)`;
    case 13: return `=${col}14+${col}15`;
    case 14: return null; // COGS --- вручную
    case 15: return `=${col}21+${col}20+${col}18+${col}16`;
    case 16: return `=${col}9-${col}11`;
    case 17: return `=ЕСЛИОШИБКА(${col}16/${col}9;0)`;
    case 18: return `=${sumifs('AH', 'Data_wb!$Z:$Z;"Логистика"')}`;
    case 19: return `=ЕСЛИОШИБКА(${col}18/${col}9;0)`;
    case 20: return `=${sumifs('BL')}`;
    case 21: return `=${sumifs('BI')}+${sumifs('BM')}`;
    case 22: return `=${col}23`;
    case 23: return `=${col}8-${col}13`;
    case 24: return `=ЕСЛИОШИБКА(${col}23/${col}8;0)`;
    case 25: return `=СУММ(${col}26:${col}29)`;
    case 26: case 27: case 28: case 29: return null; // OPEX --- вручную
    case 30: return `=${col}23-${col}25`;
    default: return null;
  }
}

// Формулы для колонок "Сумма" (C) и "Доля, %" (D).
function calcSumShareFormula(def) {
  const r = def.row;
  if (def.type === 'sub_pct' || def.type === 'pct') {
    // Проценты пересчитываем из уже просуммированных базовых строк,
    // а не усредняем по периодам --- точнее для месяцев разной длины.
    const map = { 17: 'C16/C9', 19: 'C18/C9', 24: 'C23/C8' };
    return { sum: `=ЕСЛИОШИБКА(${map[r]};0)`, share: null };
  }
  return { sum: `=СУММ(E${r}:M${r})`, share: `=ЕСЛИОШИБКА(C${r}/$C$9;0)` };
}

function styleCalcRow(sh, def) {
  const rng = sh.getRange(def.row, 1, 1, 13); // A..M
  if (def.type === 'section') {
    rng.setFontWeight('bold').setBackground('#f3f3f3');
  } else if (def.type === 'sub' || def.type === 'sub_pct') {
    rng.setFontStyle('italic');
  } else if (def.type === 'total') {
    rng.setFontWeight('bold').setBackground('#fff8f5');
  } else if (def.type === 'manual') {
    sh.getRange(def.row, 5, 1, 9).setBackground('#fff5f1'); // E:M --- ручной ввод
  }

  if (def.type === 'pct' || def.type === 'sub_pct') {
    sh.getRange(def.row, 3, 1, 11).setNumberFormat('0.0%'); // C..M
  } else {
    sh.getRange(def.row, 3, 1, 1).setNumberFormat('#,##0.00'); // C
    sh.getRange(def.row, 5, 1, 9).setNumberFormat('#,##0.00'); // E..M
    sh.getRange(def.row, 4, 1, 1).setNumberFormat('0.0%'); // D --- доля всегда %
  }
}

/**********************************************************************
 * ЗАЩИТА ЛИСТА Calculation (в меню НЕ выводится)
 * Формулы защищены. Открыты для правки только:
 * - E2:G2 (фильтр периода),
 * - строки ручного ввода (COGS, Реклама, Налог, Зарплата, Прочие OPEX).
 **********************************************************************/
function protectCalculationSheet() {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(SHEET_CALC);
  if (!sh) {
    SpreadsheetApp.getActive().toast('Лист Calculation не найден.', 'WB', 6);
    return;
  }
  sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).forEach(p => p.remove());

  const me = Session.getEffectiveUser();
  const protection = sh.protect()
    .setDescription('Calculation --- формулы считаются автоматически')
    .setWarningOnly(true);
  protection.addEditor(me);

  const manualRows = CALC_ROWS.filter(d => d.type === 'manual').map(d => d.row);
  const unprotected = [sh.getRange('E2:G2')].concat(
    manualRows.map(r => sh.getRange(r, 5, 1, 9))
  );
  protection.setUnprotectedRanges(unprotected);

  SpreadsheetApp.getActive().toast('Лист Calculation защищён (с предупреждением).', 'WB', 8);
}

/**********************************************************************
 * АВАРИЙНОЕ ПЕРЕСОЗДАНИЕ Calculation (в меню НЕ выводится)
 * Пересоздаёт лист с чистыми формулами. Ручные значения (COGS,
 * реклама, налог, зарплата, прочее) при этом теряются.
 **********************************************************************/
function forceRebuildCalculationSheet() {
  const ui = SpreadsheetApp.getUi();
  const res = ui.alert(
    'Внимание',
    'Лист Calculation будет полностью пересоздан. Ручные значения (COGS, реклама, налог, зарплата, прочее) будут удалены. Продолжить?',
    ui.ButtonSet.YES_NO
  );
  if (res !== ui.Button.YES) return;

  const ss = SpreadsheetApp.getActive();
  const old = ss.getSheetByName(SHEET_CALC);
  if (old) ss.deleteSheet(old);
  const sh = ss.insertSheet(SHEET_CALC);
  initCalculationSheet(sh);
  ui.alert('Лист Calculation пересоздан.');
}

function doGet(e) {
  const tmpl = HtmlService.createTemplateFromFile('Index');
  return tmpl.evaluate()
    .setTitle('PnL Report Wildberries')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**********************************************************************
 * СЕРВЕРНЫЕ ВЫЗОВЫ ДЛЯ WEB APP
 **********************************************************************/
function getReportData() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_CALC);
  if (!sh) throw new Error('Лист Calculation не найден.');

  const title = sh.getRange('A1').getValue();
  const subtitle = sh.getRange('A2').getValue();
  const seller = sh.getRange('A3').getValue();
  const userFrom = sh.getRange('E2').getValue();
  const userTo = sh.getRange('G2').getValue();
  const defFrom = sh.getRange('E4').getValue();
  const defTo = sh.getRange('G4').getValue();
  const periodFrom = fmtCell(userFrom) || fmtCell(defFrom);
  const periodTo = fmtCell(userTo) || fmtCell(defTo);

  const headerRow = CALC_HEADER_ROW;
  const lastCol = sh.getLastColumn();
  const lastRow = sh.getLastRow();
  const headers = sh.getRange(headerRow, 1, 1, lastCol).getValues()[0];
  const periodLabels = headers.slice(4).filter(h => h !== '').map(fmtCell);

  const values = sh.getRange(headerRow + 1, 1, lastRow - headerRow, lastCol).getValues();
  const rows = values
    .filter(r => r[1] !== '')
    .map(r => {
      const name = String(r[1] || '');
      const code = String(r[0] || '');
      return {
        num: code,
        name: name,
        sum: r[2],
        share: r[3],
        isPercent: /%/.test(name), // проценты форматируем иначе
        isManual: ['020', '040', '045', '050', '055'].includes(code), // ручной ввод
        values: r.slice(4, 4 + periodLabels.length).map(fmtCell)
      };
    });

  return {
    header: {
      title: String(title),
      subtitle: String(subtitle),
      seller: String(seller),
      periodFrom,
      periodTo,
      defaultFrom: fmtCell(defFrom),
      defaultTo: fmtCell(defTo)
    },
    periods: periodLabels,
    rows
  };
}

// Date → "dd.MM.yyyy" строкой (для показа в Web App); число/строку не трогает.
function fmtCell(v) {
  if (v === '' || v === null || v === undefined) return '';
  if (v instanceof Date) return formatRu(v);
  return v; // числа остаются числами --- фронтенд сам их форматирует
}

function applyPeriod(from, to) {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_CALC);
  if (!sh) throw new Error('Лист Calculation не найден.');
  sh.getRange('E2').setValue(from || '');
  sh.getRange('G2').setValue(to || '');
  setSkuPeriod_(from || '', to || '');
  SpreadsheetApp.flush();
  return getReportData();
}

function resetPeriod() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_CALC);
  if (!sh) throw new Error('Лист Calculation не найден.');
  sh.getRange('E2').setValue('');
  sh.getRange('G2').setValue('');
  setSkuPeriod_('', '');
  SpreadsheetApp.flush();
  return getReportData();
}

/**
 * Фильтр периода Web App пишется и в Calculation_sku!E2:G2 — чтобы ваши
 * формулы на этом листе могли брать период со своего листа ($E$4/$G$4),
 * без ссылок на Calculation.
 */
function setSkuPeriod_(from, to) {
  const sku = SpreadsheetApp.getActive().getSheetByName(typeof SKUCALC_SHEET === 'string' ? SKUCALC_SHEET : 'Calculation_sku');
  if (!sku) return;
  sku.getRange('E2').setValue(from);
  sku.getRange('G2').setValue(to);
}

function getMeta() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_CALC);
  if (!sh) throw new Error('Лист Calculation не найден.');
  return {
    seller: String(sh.getRange('A3').getValue()),
    defaultFrom: String(sh.getRange('E4').getValue()),
    defaultTo: String(sh.getRange('G4').getValue())
  };
}

/**********************************************************************
 * ЛИСТ Info
 **********************************************************************/
function buildInfoSheet() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(SHEET_INFO);
  if (!sh) sh = ss.insertSheet(SHEET_INFO, 0);
  sh.clear();

  const now = new Date();
  const rows = [
    ['WB / Ozon API → Google Sheets --- Шпаргалка разработчика', ''],
    ['', ''],
    ['ОБЩЕЕ', ''],
    ['Назначение', 'Загрузка данных Wildberries и Ozon в Google Sheets и расчёт P&L по WB.'],
    ['Поток данных (P&L)', 'WB API → очередь загрузки (processLoadQueue_) → Data_wb → Calculation / Calculation_sku → Web App.'],
    ['', ''],
    ['ЕДИНОЕ МЕНЮ И КЛЮЧИ API', ''],
    ['Меню проекта', '«Отчёты МП» --- объединяет все методы (WB P&L, доп. отчёты WB, отчёты Ozon).'],
    ['Ключи API', 'Вводятся ОДИН РАЗ в подменю «Ключи API»: токен WB, Client-Id/Api-Key Ozon.'],
    ['Хранение ключей', 'Auth.gs, PropertiesService.getUserProperties() --- не в коде, привязаны к пользователю.'],
    ['', ''],
    ['ЛИСТЫ (загрузка данных)', ''],
    ['Data_wb', 'Сырые данные WB API (реализация). Дедуп по rrdId, окно — с 1-го числа месяца 3 месяца назад.'],
    ['Calculation', 'P&L WB: строки --- статьи, колонки --- периоды (6 дней + 3 месяца). Формулы СУММЕСЛИМН к Data_wb (на русском).'],
    ['Calculation_sku', 'P&L в разрезе SKU. Формулы с A7 пишутся вручную; скрипт создаёт только шапку и читает лист во вкладку «P&L по SKU» Web App.'],
    ['Data_check', 'Контроль полноты данных: пропущенные/неполные дни, структура колонок, типы операций (Data_check.gs).'],
    ['Load_log', 'Журнал загрузок: время, период, строк, статус, ошибка.'],
    ['Report_finans_wb_2', 'WB: детализация по эквайрингу (Report_finans_wb_2.gs → WbAcq2_loadReport).'],
    ['Report_sku_wb', 'WB: список товаров с ценами (Get_sku_wb.gs → WbSku_loadGoods).'],
    ['Report_finans_oz_1', 'Ozon: финансовый отчёт Cash Flow (Report_finans_oz_1.gs → OzFin1_loadReport).'],
    ['Report_sku_oz', 'Ozon: список товаров (Get_sku_oz.gs → OzSku_loadProducts).'],
    ['Info', 'Эта шпаргалка. Генерируется функцией buildInfoSheet().'],
    ['', ''],
    ['РЕШЕНИЕ ПО ДАТАМ (ВАЖНО, для WB P&L)', ''],
    ['Тип', 'Нативный Date БЕЗ времени (UTC-полдень: 12:00 UTC).'],
    ['Зачем UTC-полдень', 'Защита от сдвига на ±1 день в любом часовом поясе.'],
    ['Формат ячеек', '"dd.MM.yyyy" → видна только дата, без времени.'],
    ['ISO-дата', '"2026-03-16" → Date(16.03.2026).'],
    ['ISO-датавремя', '"2026-08-10T20:10:21Z" → Date(10.08.2026). Время отброшено, день в MSK.'],
    ['Формулы', 'СУММЕСЛИМН/ДАТА работают --- это настоящие даты, а не текст.'],
    ['Язык формул', 'Скрипт пишет формулы на русском. Если в ячейках видны английские названия: Файл → Настройки → снять «Всегда использовать английские названия функций». Меню: «Формулы активного листа → на русском».'],
    ['', ''],
    ['АВТОЗАГРУЗКА', ''],
    ['Триггер', 'dailyUpdate раз в день (меню «Контроль данных» → «Установить ежедневный триггер»). Ставить от имени пользователя, чей токен WB сохранён.'],
    ['Перекрытие', `Каждый день перезапрашиваются последние ${DAILY_OVERLAP_DAYS} дней; дубликаты отсекаются по rrdId.`],
    ['Таймаут', 'Прогресс хранится в очереди (ScriptProperties), продолжение — автоматически через 1 мин.'],
    ['Пропуски', 'После загрузки — проверка (лист Data_check), письмо при проблемах, авто-дозагрузка пропусков (до 3 попыток на день).'],
    ['', ''],
    ['ПРАВИЛА ПО CALCULATION', ''],
    ['Создание', 'Создаётся автоматически один раз --- при firstRun, если листа ещё нет.'],
    ['Изменения', 'Ни одна команда меню не трогает формулы (кроме перевода на русский). Вручную заполняются только 5 строк: COGS (020), Реклама (040), Налог (045), Зарплата (050), Прочие OPEX (055).'],
    ['Исключение 1', 'applyPeriod / resetPeriod --- при нажатии «Применить» / «Сбросить» в Web App.'],
    ['Исключение 2', 'forceRebuildCalculationSheet --- аварийная, вызывается вручную из редактора.'],
    ['Защита', 'protectCalculationSheet --- вручную из редактора (в меню не выведена).'],
    ['', ''],
    ['ТОКЕН / КЛЮЧИ', ''],
    ['WB', 'Меню «Отчёты МП» → «Ключи API» → «Wildberries: ввести токен». Категория «Финансы» --- иначе 403 у WB P&L.'],
    ['Ozon', 'Меню «Отчёты МП» → «Ключи API» → «Ozon: ввести Client-Id и Api-Key».'],
    ['', ''],
    ['КАК РАСШИРЯТЬ', ''],
    ['Новый метод API', 'Отдельный .gs файл (1 метод = 1 скрипт), уникальный префикс имён, ключи --- через Auth.gs, пункт меню --- в onOpen() этого файла.'],
    ['Периоды P&L', 'CALC_PERIOD_COLS / CALC_MONTH_COLS в calcFormula() --- если нужно другое окно, чем 6 дней + 3 месяца.'],
    ['Окно хранения', 'MAX_MONTHS_BACK (месяцев, от 1-го числа).'],
    ['UI', 'Правки в Index.html.'],
    ['Часовой пояс', 'MSK_OFFSET_HOURS (сейчас 3).'],
    ['', ''],
    ['Последнее обновление', formatRu(now) + ' ' + formatTime(now)]
  ];

  sh.getRange(1, 1, rows.length, 2).setValues(rows);
  sh.getRange('A1').setFontSize(14).setFontWeight('bold');
  rows.forEach((r, i) => {
    const row = i + 1;
    if (r[0] && !r[1] && row > 1) {
      sh.getRange(row, 1, 1, 2).setFontWeight('bold').setBackground('#f3f3f3');
    }
  });
  sh.setColumnWidth(1, 220);
  sh.setColumnWidth(2, 620);
  sh.getRange('B:B').setWrap(true);
  sh.setFrozenRows(1);
}

/**********************************************************************
 * ПОСТРОЕНИЕ ПЕРИОДОВ ДЛЯ КОЛОНОК P&L
 **********************************************************************/
function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatRu(d) {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${d.getFullYear()}`;
}

function formatTime(d) {
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mi}`;
}

// "2026-03-16" → Date(16.03.2026 12:00 UTC) — тот же формат «дня», что в Data_wb.
function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12, 0, 0, 0));
}

/**********************************************************************
 * «ДНИ» ЗАГРУЗЧИКА: Date UTC-полдень, календарь — МСК.
 * Не зависят от часового пояса проекта (у нового проекта он может быть
 * не Москва — тогда «сегодня» и «вчера» сдвигались бы на день).
 **********************************************************************/
function mskToday_() {
  return isoDateToDate(Utilities.formatDate(new Date(), TZ_MSK, 'yyyy-MM-dd'));
}

function dayAdd_(d, n) {
  return new Date(d.getTime() + n * 86400000);
}

function dayKey_(d) {
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
}

/** 1-е число месяца MAX_MONTHS_BACK месяцев назад (начало окна хранения). */
function retentionStart_() {
  const t = mskToday_();
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - MAX_MONTHS_BACK, 1, 12, 0, 0, 0));
}

function splitByDays(from, to, chunkDays) {
  const chunks = [];
  let cur = new Date(from);
  while (cur <= to) {
    let end = addDays(cur, chunkDays - 1);
    if (end > to) end = to;
    chunks.push({ from: new Date(cur), to: end });
    cur = addDays(end, 1);
  }
  return chunks;
}

/**********************************************************************
 * ФОРМУЛЫ НА РУССКОМ
 * Скрипт пишет формулы с русскими названиями функций и «;» между
 * аргументами (как их набирают в таблице с русской локалью).
 *
 * Как Google Таблицы показывают формулы, зависит от настройки таблицы:
 *   Файл → Настройки → Язык: Россия, флажок «Всегда использовать
 *   английские названия функций» — СНЯТЬ.
 * Если таблица не приняла русскую формулу (ячейка показывает #ИМЯ? /
 * #NAME? / #ОШИБКА!), Formulas_fixRejected_ перепишет её английским
 * эквивалентом — расчёт не сломается.
 **********************************************************************/
const FORMULA_RU = {
  SUMIFS: 'СУММЕСЛИМН', SUMIF: 'СУММЕСЛИ', SUM: 'СУММ', SUMPRODUCT: 'СУММПРОИЗВ',
  COUNTIFS: 'СЧЁТЕСЛИМН', COUNTIF: 'СЧЁТЕСЛИ', COUNT: 'СЧЁТ', COUNTA: 'СЧЁТЗ',
  AVERAGEIFS: 'СРЗНАЧЕСЛИМН', AVERAGEIF: 'СРЗНАЧЕСЛИ', AVERAGE: 'СРЗНАЧ',
  MAX: 'МАКС', MIN: 'МИН', ROUND: 'ОКРУГЛ', ABS: 'ABS',
  IFERROR: 'ЕСЛИОШИБКА', IFNA: 'ЕСНД', IF: 'ЕСЛИ', AND: 'И', OR: 'ИЛИ', NOT: 'НЕ',
  ISBLANK: 'ЕПУСТО', ISNUMBER: 'ЕЧИСЛО', ISERROR: 'ЕОШИБКА',
  DATE: 'ДАТА', YEAR: 'ГОД', MONTH: 'МЕСЯЦ', DAY: 'ДЕНЬ', WEEKDAY: 'ДЕНЬНЕД',
  EOMONTH: 'КОНМЕСЯЦА', EDATE: 'ДАТАМЕС', TODAY: 'СЕГОДНЯ', NOW: 'ТДАТА', TEXT: 'ТЕКСТ',
  VLOOKUP: 'ВПР', HLOOKUP: 'ГПР', INDEX: 'ИНДЕКС', MATCH: 'ПОИСКПОЗ'
};
const FORMULA_EN = Object.keys(FORMULA_RU).reduce((o, k) => { o[FORMULA_RU[k]] = k; return o; }, {});
const FORMULA_CONST_RU = { TRUE: 'ИСТИНА', FALSE: 'ЛОЖЬ' };
const FORMULA_CONST_EN = { 'ИСТИНА': 'TRUE', 'ЛОЖЬ': 'FALSE' };
const FORMULA_ERR = /^#(NAME\?|ИМЯ\?|ERROR!|ОШИБКА!)/;

/** Пишет формулу (на русском); при исключении — английский вариант. */
function setFormulaRu_(range, formula) {
  try {
    range.setFormula(formula);
  } catch (e) {
    range.setFormula(Formulas_convert_(formula, false));
  }
}

/**
 * Перевод формулы: toRu = true — EN → RU (функции, «,» → «;», 1.5 → 1,5),
 * toRu = false — обратно. Строки в кавычках и имена листов не трогаются.
 */
function Formulas_convert_(f, toRu) {
  const dict = toRu ? FORMULA_RU : FORMULA_EN;
  const consts = toRu ? FORMULA_CONST_RU : FORMULA_CONST_EN;
  const isDigit = c => c >= '0' && c <= '9';
  let out = '';
  let i = 0;
  while (i < f.length) {
    const ch = f[i];
    if (ch === '"' || ch === "'") {           // "текст" или 'Имя листа'
      let j = i + 1;
      while (j < f.length) {
        if (f[j] === ch) { if (f[j + 1] === ch) { j += 2; continue; } break; }
        j++;
      }
      out += f.slice(i, j + 1);
      i = j + 1;
      continue;
    }
    if (/[A-Za-zА-Яа-яЁё_]/.test(ch)) {       // имя функции / ссылка
      let j = i;
      while (j < f.length && /[A-Za-zА-Яа-яЁё0-9_.]/.test(f[j])) j++;
      const word = f.slice(i, j);
      const k = word.toUpperCase();
      const tr = dict[k];
      if (f[j] === '(' && tr) out += tr;
      else if (f[j] !== '(' && f[j] !== '!' && consts[k]) out += consts[k]; // ИСТИНА / ЛОЖЬ
      else out += word;
      i = j;
      continue;
    }
    if (toRu && ch === ',') { out += ';'; i++; continue; }
    if (toRu && ch === '.' && isDigit(f[i - 1] || '') && isDigit(f[i + 1] || '')) { out += ','; i++; continue; }
    if (!toRu && ch === ';') { out += ','; i++; continue; }
    if (!toRu && ch === ',' && isDigit(f[i - 1] || '') && isDigit(f[i + 1] || '')) { out += '.'; i++; continue; }
    out += ch;
    i++;
  }
  return out;
}

/** Ячейки с русской формулой, которую таблица не приняла, → английский вариант. */
function Formulas_fixRejected_(sh) {
  SpreadsheetApp.flush();
  const rng = sh.getDataRange();
  const formulas = rng.getFormulas();
  const disp = rng.getDisplayValues();
  let fixed = 0;
  formulas.forEach((row, r) => row.forEach((f, c) => {
    if (!f || !FORMULA_ERR.test(disp[r][c])) return;
    const en = Formulas_convert_(f, false);
    if (en !== f) { rng.getCell(r + 1, c + 1).setFormula(en); fixed++; }
  }));
  if (fixed) Logger.log(`Лист ${sh.getName()}: русские формулы не приняты в ${fixed} ячейках — записаны на английском.`);
  return fixed;
}

/**
 * Пункт меню: перевести все формулы АКТИВНОГО листа на русский (ваши
 * формулы тоже). Значения и ручные ячейки не трогаются. Ячейка, которая
 * после перевода стала ошибкой, возвращается к исходной формуле.
 */
function Formulas_activeSheetToRussian() {
  const ui = SpreadsheetApp.getUi();
  const sh = SpreadsheetApp.getActiveSheet();
  const ok = ui.alert('Формулы на русском',
    `Перевести формулы листа «${sh.getName()}» на русские названия функций?`, ui.ButtonSet.YES_NO);
  if (ok !== ui.Button.YES) return;

  const rng = sh.getDataRange();
  const before = rng.getFormulas();
  const errBefore = rng.getDisplayValues().map(r => r.map(v => FORMULA_ERR.test(v)));
  let changed = 0;
  before.forEach((row, r) => row.forEach((f, c) => {
    if (!f) return;
    const ru = Formulas_convert_(f, true);
    if (ru === f) return;
    try { rng.getCell(r + 1, c + 1).setFormula(ru); changed++; } catch (e) { /* оставляем как было */ }
  }));

  SpreadsheetApp.flush();
  const after = rng.getDisplayValues();
  let reverted = 0;
  before.forEach((row, r) => row.forEach((f, c) => {
    if (f && !errBefore[r][c] && FORMULA_ERR.test(after[r][c])) {
      rng.getCell(r + 1, c + 1).setFormula(f);
      reverted++;
    }
  }));

  ui.alert('Формулы на русском',
    `Переведено формул: ${changed - reverted}.` +
    (reverted ? `\nНе приняты таблицей и оставлены как были: ${reverted}.` : '') +
    '\n\nЕсли в ячейках всё ещё английские названия: Файл → Настройки → ' +
    'снимите флажок «Всегда использовать английские названия функций» (язык — Россия).',
    ui.ButtonSet.OK);
}
