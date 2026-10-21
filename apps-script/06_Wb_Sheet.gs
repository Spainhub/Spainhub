/**********************************************************************
 * 06_Wb_Sheet.gs — ЛИСТ DATA_WB: запись данных, нормализация, очистка
 *
 * Дедупликация по rrdId, окно хранения — с 1-го числа месяца 3 месяца назад.
 * Даты — нативный Date UTC-полдень, числа — number (см. 01_Utils.gs).
 **********************************************************************/

/* ===================== ЧИСЛОВЫЕ И ДАТОВЫЕ ПОЛЯ API ===================== */

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

/* ===================== ЗАПИСЬ В DATA_WB ===================== */

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

/** Последняя дата rrDate в DATA_WB (Date UTC-полдень) или null. */
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

/**********************************************************************
 * МИГРАЦИЯ СТАРЫХ ДАННЫХ (в меню НЕ выводится)
 * Вызывается вручную из редактора Apps Script.
 **********************************************************************/

function recalcNumbersInDataSheet() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_DATA);
  if (!sh) {
    SpreadsheetApp.getActive().toast('Лист DATA_WB не найден.', 'WB', 6);
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
 * «90 дней»: иначе самый старый месяц в отчётах получался бы неполным.
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
 * ЧТЕНИЕ DATA_WB ДЛЯ ОТЧЁТОВ
 **********************************************************************/

/**
 * Читает из DATA_WB только нужные колонки (быстрее, чем весь лист).
 * Возвращает null, если данных нет. dayKey(i) — "yyyy-MM-dd" строки i
 * в часовом поясе таблицы (как их видит SUMIFS).
 * Используется также в Charts.gs.
 */
function Wb_readColumns_() {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(SHEET_DATA);
  if (!sh || sh.getLastRow() < 2) return null;

  const n = sh.getLastRow() - 1;
  const maxCol = sh.getLastColumn();
  const headers = sh.getRange(1, 1, 1, maxCol).getValues()[0];

  const readCol = colNum => {
    if (!colNum || colNum > maxCol) return new Array(n).fill('');
    return sh.getRange(2, colNum, n, 1).getValues().map(r => r[0]);
  };
  const byLetter = letter => readCol(Util_colIndex_(letter));
  const byName = names => {
    for (const name of names) {
      const i = headers.indexOf(name);
      if (i >= 0) return readCol(i + 1);
    }
    return null;
  };

  const out = { n: n };
  Object.keys(DATA_COLS).forEach(k => { out[k] = byLetter(DATA_COLS[k]); });
  Object.keys(DATA_NAME_FIELDS).forEach(k => { out[k] = byName(DATA_NAME_FIELDS[k]); });

  const tz = ss.getSpreadsheetTimeZone();
  const cache = {};
  out.dayKey = i => {
    const v = out.date[i];
    if (!(v instanceof Date)) return '';
    const t = v.getTime();
    let k = cache[t];
    if (k === undefined) k = cache[t] = Utilities.formatDate(v, tz, 'yyyy-MM-dd');
    return k;
  };
  return out;
}
