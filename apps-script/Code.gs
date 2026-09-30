/**********************************************************************
 * Code.gs
 * Wildberries → Google Sheets + Web App "PnL Report Wildberries"
 *
 * Шаг 1: загрузка данных в "Data_wb"
 * Шаг 2: P&L считается АВТОМАТИЧЕСКИ в "Calculation" по формулам
 * (SUMIFS к Data_wb). Вручную заполняются только 5 строк:
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
 **********************************************************************/

/**********************************************************************
 * КОНСТАНТЫ
 **********************************************************************/
const API_URL = 'https://finance-api.wildberries.ru/api/finance/v1/sales-reports/detailed';
const SHEET_DATA = 'Data_wb';
const SHEET_CALC = 'Calculation';
const SHEET_INFO = 'Info';
const FIRST_RUN_DAYS = 30;
const RETENTION_DAYS = 90;
const MAX_MONTHS_BACK = 3;
const PAGE_LIMIT = 100000;
const REQUEST_PAUSE_MS = 62000;
const MAX_RUNTIME_MS = 5.5 * 60 * 1000;
const SELLER_NAME = 'ООО "Users"';

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
        .addItem('Первый запуск (1 месяц)', 'firstRun')
        .addItem('Загрузить вчера', 'loadYesterday')
        .addItem('Загрузить за период...', 'loadCustomPeriod')
        .addItem('Очистить старше 3 месяцев', 'cleanupOldRows')
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
 **********************************************************************/
function firstRun() {
  const today = new Date();
  const from = addDays(today, -FIRST_RUN_DAYS);
  runReport(from, today, 'первый запуск (30 дней)');
  ensureCalculationSheetExists();
  buildInfoSheet();
}

function loadYesterday() {
  const today = new Date();
  const from = addDays(today, -2);
  runReport(from, today, 'ежедневное обновление');
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

  const cutoff = addDays(new Date(), -MAX_MONTHS_BACK * 30);
  const realFrom = from < cutoff ? cutoff : from;
  if (realFrom > to) {
    ui.alert('Период вне допустимого окна (3 месяца).');
    return;
  }
  runReport(realFrom, to, 'ручной период');
}

/**********************************************************************
 * ОСНОВНОЙ ЗАПУСК
 **********************************************************************/
function runReport(dateFrom, dateTo, label) {
  const token = Auth_getWbToken();
  const startTime = Date.now();
  const chunks = splitByDays(dateFrom, dateTo, 30);
  let total = 0;

  for (const chunk of chunks) {
    if (Date.now() - startTime > MAX_RUNTIME_MS) {
      SpreadsheetApp.getActive().toast(
        'Остановлено по таймауту. Запустите ещё раз — данные допишутся.',
        'WB', 10
      );
      break;
    }
    const rows = fetchAllPages(token, chunk.from, chunk.to);
    if (rows.length) {
      appendToDataSheet(rows);
      total += rows.length;
    }
  }
  SpreadsheetApp.getActive().toast(`Загружено строк: ${total} (${label})`, 'WB', 10);
}

/**********************************************************************
 * API
 **********************************************************************/
function fetchAllPages(token, dateFrom, dateTo) {
  const all = [];
  let rrdId = 0;
  let first = true;

  while (true) {
    if (!first) Utilities.sleep(REQUEST_PAUSE_MS);
    first = false;

    const payload = {
      dateFrom: formatDate(dateFrom),
      dateTo: formatDate(dateTo),
      limit: PAGE_LIMIT,
      rrdId: rrdId,
      period: 'daily'
    };

    const resp = fetchWithRetry(token, payload);
    const code = resp.getResponseCode();
    if (code === 204) break;
    if (code !== 200) {
      throw new Error(`WB API ${code}: ${resp.getContentText()}`);
    }
    const data = JSON.parse(resp.getContentText());
    if (!Array.isArray(data) || data.length === 0) break;

    all.push(...data);
    rrdId = data[data.length - 1].rrdId;
    if (data.length < PAGE_LIMIT) break;
  }
  return all;
}

function fetchWithRetry(token, payload, attempt = 1) {
  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: token },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  const resp = UrlFetchApp.fetch(API_URL, options);
  const code = resp.getResponseCode();

  if (code === 429) {
    if (attempt > 5) throw new Error('429: превышен лимит, попытки исчерпаны');
    Utilities.sleep(REQUEST_PAUSE_MS);
    return fetchWithRetry(token, payload, attempt + 1);
  }
  if (code === 401) throw new Error('401: неверный или просроченный токен');
  if (code === 403) throw new Error('403: у токена нет категории «Финансы»');
  if (code === 402) throw new Error('402: недостаточно средств на балансе');
  return resp;
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

  if (headersChanged && sh.getLastRow() > 1) {
    migrateSheet(sh, existingHeaders, merged);
  } else if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, merged.length).setValues([merged]);
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
    SpreadsheetApp.getActive().toast('Новых строк нет (все rrdId уже есть).', 'WB', 6);
    return;
  }

  const matrix = fresh.map(r => merged.map(h => normalize(r[h], h)));
  const startRow = sh.getLastRow() + 1;
  sh.getRange(startRow, 1, matrix.length, merged.length).setValues(matrix);

  styleHeader(sh, merged.length);
  applyDateFormatToDateColumns(sh);
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
 **********************************************************************/
function cleanupOldRows() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_DATA);
  if (!sh) return;
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return;

  const headers = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
  const dateIdx = headers.indexOf('rrDate');
  if (dateIdx < 0) {
    SpreadsheetApp.getActive().toast('Не найден столбец rrDate.', 'WB', 6);
    return;
  }

  const cutoff = addDays(new Date(), -RETENTION_DAYS);
  const cutoffKey = cutoff.getFullYear() * 10000 + (cutoff.getMonth() + 1) * 100 + cutoff.getDate();

  const values = sh.getRange(2, dateIdx + 1, lastRow - 1, 1).getValues();
  const drop = [];
  values.forEach((row, i) => {
    const v = row[0];
    if (v === '' || v === null) return;
    let key = 0;
    if (v instanceof Date) {
      key = v.getUTCFullYear() * 10000 + (v.getUTCMonth() + 1) * 100 + v.getUTCDate();
    } else {
      const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(v).trim());
      if (m) key = +m[3] * 10000 + +m[2] * 100 + +m[1];
    }
    if (key && key < cutoffKey) drop.push(i + 2);
  });

  drop.sort((a, b) => b - a).forEach(r => sh.deleteRow(r));
  SpreadsheetApp.getActive().toast(`Удалено строк: ${drop.length}`, 'WB', 6);
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
  sh.getRange(CALC_ROW_CONTROLS, 3).setFormula('=E4');
  sh.getRange(CALC_ROW_CONTROLS, 4).setValue('Дата от:');
  sh.getRange(CALC_ROW_CONTROLS, 5).setFormula('=IF(E2="",TODAY(),E2)');
  sh.getRange(CALC_ROW_CONTROLS, 6).setValue('Дата до:');
  sh.getRange(CALC_ROW_CONTROLS, 7).setFormula('=IF(G2="",EDATE(E4,-3),G2)');
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
      sh.getRange(`${col}${CALC_HEADER_ROW}`).setFormula(formula);
      sh.getRange(`${col}${CALC_ROW_PARAMS}`).setFormula(`=TEXT(${col}${CALC_HEADER_ROW}, "dddd")`);
      sh.getRange(`${col}${CALC_ROW_PARAMS}`).setNumberFormat('@');
    } else {
      const back = i - 5; // K = 1 месяц назад, L = 2, M = 3
      sh.getRange(`${col}${CALC_HEADER_ROW}`).setFormula(`=DATE(YEAR($E$4),MONTH($E$4)-${back},1)`);
      sh.getRange(`${col}${CALC_ROW_PARAMS}`).setFormula(`=EOMONTH($E$4,-${back})`);
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
      if (f) sh.getRange(`${col}${def.row}`).setFormula(f);
    });

    const cd = calcSumShareFormula(def);
    if (cd.sum) sh.getRange(`C${def.row}`).setFormula(cd.sum);
    if (cd.share) sh.getRange(`D${def.row}`).setFormula(cd.share);

    styleCalcRow(sh, def);
  });

  sh.autoResizeColumns(1, 2);
  sh.setColumnWidth(3, 120);
  sh.setColumnWidth(4, 90);
  for (let c = 5; c <= 13; c++) sh.setColumnWidth(c, 110);
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
    `SUMIFS(Data_wb!$${colLetter}:$${colLetter},${extra ? extra + ',' : ''}` +
    `Data_wb!$AB:$AB,">="&${lower},Data_wb!$AB:$AB,"<"&${upper})`;

  switch (row) {
    case 8: return `=${col}9+${col}12`;
    case 9: return `=${sumifs('V', 'Data_wb!$Z:$Z,"Продажа"')}-${col}10`;
    case 10: return `=${sumifs('V', 'Data_wb!$Z:$Z,"Возвраты"')}`;
    case 11: return `=${sumifs('AR', 'Data_wb!$Z:$Z,"Продажа"')}`;
    case 12: return `=IF((${col}11-${col}9)<0,0,${col}11-${col}9)`;
    case 13: return `=${col}14+${col}15`;
    case 14: return null; // COGS --- вручную
    case 15: return `=${col}21+${col}20+${col}18+${col}16`;
    case 16: return `=${col}9-${col}11`;
    case 17: return `=IFERROR(${col}16/${col}9,0)`;
    case 18: return `=${sumifs('AH', 'Data_wb!$Z:$Z,"Логистика"')}`;
    case 19: return `=IFERROR(${col}18/${col}9,0)`;
    case 20: return `=${sumifs('BL')}`;
    case 21: return `=${sumifs('BI')}+${sumifs('BM')}`;
    case 22: return `=${col}23`;
    case 23: return `=${col}8-${col}13`;
    case 24: return `=IFERROR(${col}23/${col}8,0)`;
    case 25: return `=SUM(${col}26:${col}29)`;
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
    return { sum: `=IFERROR(${map[r]},0)`, share: null };
  }
  return { sum: `=SUM(E${r}:M${r})`, share: `=IFERROR(C${r}/$C$9,0)` };
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
  SpreadsheetApp.flush();
  return getReportData();
}

function resetPeriod() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_CALC);
  if (!sh) throw new Error('Лист Calculation не найден.');
  sh.getRange('E2').setValue('');
  sh.getRange('G2').setValue('');
  SpreadsheetApp.flush();
  return getReportData();
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
    ['Поток данных (P&L)', 'WB API → fetchAllPages → Data_wb → Calculation (P&L) → Web App.'],
    ['', ''],
    ['ЕДИНОЕ МЕНЮ И КЛЮЧИ API', ''],
    ['Меню проекта', '«Отчёты МП» --- объединяет все методы (WB P&L, доп. отчёты WB, отчёты Ozon).'],
    ['Ключи API', 'Вводятся ОДИН РАЗ в подменю «Ключи API»: токен WB, Client-Id/Api-Key Ozon.'],
    ['Хранение ключей', 'Auth.gs, PropertiesService.getUserProperties() --- не в коде, привязаны к пользователю.'],
    ['', ''],
    ['ЛИСТЫ (загрузка данных)', ''],
    ['Data_wb', 'Сырые данные WB API (реализация). Дедуп по rrdId, окно 90 дней.'],
    ['Calculation', 'P&L WB: строки --- статьи, колонки --- периоды (6 дней + 3 месяца). Формулы SUMIFS к Data_wb.'],
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
    ['Формулы', 'SUMIFS/DATE работают --- это настоящие даты, а не текст.'],
    ['', ''],
    ['ПРАВИЛА ПО CALCULATION', ''],
    ['Создание', 'Создаётся автоматически один раз --- при firstRun, если листа ещё нет.'],
    ['Изменения', 'Ни одна команда меню не трогает формулы. Вручную заполняются только 5 строк: COGS (020), Реклама (040), Налог (045), Зарплата (050), Прочие OPEX (055).'],
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
    ['Окно хранения', 'RETENTION_DAYS.'],
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

function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return new Date(+m[1], +m[2] - 1, +m[3]);
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
