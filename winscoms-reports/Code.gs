/**
 * WINSCOMS — Interactive Reports (P&L for 4 marketplaces)
 * Серверная часть Google Apps Script.
 *
 * Структура КАЖДОГО листа:
 *   строка 1      — заголовок
 *   строка 2      — подзаголовок
 *   строки 3–5    — дополнительная информация (выводится «как в таблице»)
 *   строка 6      — шапка таблицы
 *   строка 7      — (OZ_UNIT*, WB_UNIT*) фиксированная итоговая строка
 *   строка 7/8+   — данные
 */

const HEADER_ROWS = 5;   // строки 1–5: информационный блок
const TABLE_HEAD_ROW = 6; // строка шапки таблицы

const SHEETS_CONFIG = {
  'WB&OZ': {
    title: 'WB & OZ Svod',
    twoTables: true,        // слева Wildberries, справа Ozon
    sortable: false         // P&L читается в заданном порядке строк
  },
  'OZ_UNIT1': { title: 'Ozon Kvantum', stickyTotal: true },
  'OZ_UNIT2': { title: 'Ozon Azimut',  stickyTotal: true },
  'WB_UNIT1': { title: 'WB Kvantum',   stickyTotal: true, dateColumns: true },
  'WB_UNIT2': { title: 'WB Azimut',    stickyTotal: true, dateColumns: true }
};

/** Если проект НЕ привязан к Google-таблице, укажите её ID. */
const SPREADSHEET_ID = '';

/**
 * 'integer' — суммы всегда целые (1 207 845);
 * 'sheet'   — брать количество знаков из формата ячейки в Google Sheets.
 * Проценты всегда берут знаки из формата ячейки (0.92%, 16%).
 */
const NUMBER_DECIMALS = 'integer';

/** Столбцы-идентификаторы: НИКОГДА не форматируются как числа (без пробелов-разделителей). */
const ID_HEADER_RE = /^(№|no\.?|id)$|sku|артикул|баркод|barcode|nm\s?id/i;

/** Столбцы/строки, значения которых — проценты, даже если формат ячейки «Общий». */
const PERCENT_LABEL_RE = /%|процент|выкуп|доля|share|rate/i;

// ───────────────────────── Веб-приложение ─────────────────────────

function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('WINSCOMS — Отчёты')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function getSpreadsheet() {
  const ss = SPREADSHEET_ID
    ? SpreadsheetApp.openById(SPREADSHEET_ID)
    : SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    throw new Error('Не удалось определить Google-таблицу. Привяжите Apps Script к таблице или укажите SPREADSHEET_ID.');
  }
  return ss;
}

function getSheetsList() {
  const ss = getSpreadsheet();
  return Object.keys(SHEETS_CONFIG)
    .filter(name => ss.getSheetByName(name))
    .map(name => ({ name, title: SHEETS_CONFIG[name].title }));
}

// ───────────────────────── Вспомогательное ─────────────────────────

function isBlank(v) { return v === '' || v === null || v === undefined; }

function isDateHeader(value) {
  if (value instanceof Date) return true;
  return /^\d{1,2}\.\d{1,2}\.\d{4}$/.test(String(value || '').trim());
}

function serializeValue(value, tz) {
  if (value instanceof Date) {
    return isNaN(value.getTime()) ? '' : Utilities.formatDate(value, tz, 'dd.MM.yyyy');
  }
  if (isBlank(value)) return '';
  if (typeof value === 'number' && !isFinite(value)) return '';
  return value;
}

/** Количество знаков после запятой в числовом формате Google Sheets. */
function formatDecimals(fmt) {
  const m = String(fmt || '').match(/\.([0#]+)/);
  return m ? m[1].length : 0;
}

/**
 * Код формата ячейки для клиента:
 *   -1       — показывать как есть (текст, идентификаторы, даты)
 *   0..9     — число с N знаками
 *   100..109 — процент с (код-100) знаками (значение приходит ДОЛЕЙ: 0.5 → 50%)
 * Возвращает {v, f} — нормализованное значение и код.
 */
function classifyCell(value, fmt, colLabel, rowLabel, isIdCol) {
  if (isIdCol || typeof value !== 'number') {
    // «0.92%» строкой → превращаем в долю
    if (!isIdCol && typeof value === 'string' && /^-?\d+([.,]\d+)?\s*%$/.test(value.trim())) {
      return { v: parseFloat(value.replace(',', '.')) / 100, f: 100 + 2 };
    }
    return { v: value, f: -1 };
  }
  const f = String(fmt || '');
  if (f.indexOf('%') !== -1) {
    return { v: value, f: 100 + formatDecimals(f) };
  }
  const byLabel = PERCENT_LABEL_RE.test(String(colLabel || '')) || PERCENT_LABEL_RE.test(String(rowLabel || ''));
  if (byLabel && Math.abs(value) <= 100) {
    const frac = Math.abs(value) <= 1 ? value : value / 100;
    const pct = frac * 100;
    return { v: frac, f: 100 + (Math.abs(pct - Math.round(pct)) < 0.005 ? 0 : 2) };
  }
  return { v: value, f: NUMBER_DECIMALS === 'sheet' ? Math.min(formatDecimals(f), 9) : 0 };
}

function buildMatrix(values, formats, tz, colLabels, rowLabelCol, idCols, firstRow, lastRow, colIdxList) {
  const v = [], f = [];
  for (let r = firstRow; r < lastRow; r++) {
    const rowLabel = rowLabelCol >= 0 ? values[r][rowLabelCol] : '';
    const rv = [], rf = [];
    colIdxList.forEach(c => {
      const raw = values[r][c];
      const ser = serializeValue(raw, tz);
      const cl = classifyCell(ser, formats[r][c], colLabels[c], rowLabel, !!idCols[c]);
      rv.push(cl.v); rf.push(cl.f);
    });
    v.push(rv); f.push(rf);
  }
  return { v, f };
}

function rowHasData(vals) { return vals.some(x => !isBlank(x)); }

// ───────────────────────── Данные листа ─────────────────────────

function getSheetData(sheetName) {
  const cfg = SHEETS_CONFIG[sheetName];
  if (!cfg) throw new Error('Неизвестный лист: ' + sheetName);

  const ss = getSpreadsheet();
  const sheet = ss.getSheetByName(sheetName);
  if (!sheet) throw new Error('Лист не найден: ' + sheetName);

  const tz = ss.getSpreadsheetTimeZone();
  const lastRow = Math.max(sheet.getLastRow(), TABLE_HEAD_ROW);
  const lastCol = Math.max(sheet.getLastColumn(), 1);

  const range = sheet.getRange(1, 1, lastRow, lastCol);
  const raw = range.getValues();
  const fmts = range.getNumberFormats();
  const labels = (raw[TABLE_HEAD_ROW - 1] || []).map(v => String(serializeValue(v, tz)));

  // Реальная ширина: последний непустой столбец среди строк 1–6
  let width = 0;
  for (let r = 0; r < TABLE_HEAD_ROW; r++) {
    for (let c = lastCol - 1; c >= width; c--) {
      if (!isBlank(raw[r][c])) { width = c + 1; break; }
    }
  }
  width = Math.max(width, 1);

  const info = buildInfoBlock(sheet, raw, fmts, tz, width);
  const base = { name: sheetName, info, sortable: cfg.sortable !== false };

  if (lastRow < TABLE_HEAD_ROW) {
    return Object.assign(base, { meta: {}, columns: [], rows: [], fmts: [], totalRow: null });
  }
  if (cfg.twoTables) return Object.assign(base, buildTwoTables(raw, fmts, tz, labels, width));
  return Object.assign(base, buildUnitTable(cfg, raw, fmts, tz, labels, width));
}

/** Строки 1–5 «как в Google Sheets»: значения, форматы и объединённые ячейки. */
function buildInfoBlock(sheet, raw, fmts, tz, width) {
  const rows = [], f = [];
  for (let r = 0; r < HEADER_ROWS; r++) {
    const rv = [], rf = [];
    for (let c = 0; c < width; c++) {
      const cl = classifyCell(serializeValue(raw[r][c], tz), fmts[r][c], '', '', false);
      // в информационном блоке проценты только по формату ячейки
      rv.push(cl.v); rf.push(cl.f);
    }
    rows.push(rv); f.push(rf);
  }
  const merges = [];
  sheet.getRange(1, 1, HEADER_ROWS, width).getMergedRanges().forEach(m => {
    merges.push({
      r: m.getRow() - 1, c: m.getColumn() - 1,
      rs: m.getNumRows(), cs: m.getNumColumns()
    });
  });
  return { width, rows, fmts: f, merges };
}

function buildUnitTable(cfg, raw, fmts, tz, labels, width) {
  // Столбцы: до последнего непустого заголовка в строке 6
  let colCount = 0;
  for (let c = 0; c < width; c++) if (!isBlank(labels[c])) colCount = c + 1;

  const columns = [];
  const idCols = {};
  for (let c = 0; c < colCount; c++) {
    const label = isBlank(labels[c]) ? '' : labels[c];
    columns.push({ idx: c, label });
    if (ID_HEADER_RE.test(label.trim())) idCols[c] = true;
  }

  // Столбцы-даты (графики) — только для WB
  const dateSeries = [];
  if (cfg.dateColumns) {
    columns.forEach(col => {
      if (isDateHeader(raw[TABLE_HEAD_ROW - 1][col.idx])) {
        dateSeries.push({ idx: col.idx, label: col.label });
        idCols[col.idx] = false;
      }
    });
  }

  const colIdx = columns.map(c => c.idx);
  const abcIdx = columns.findIndex(c => /^abc$/i.test(c.label.trim()));

  const firstDataRow = TABLE_HEAD_ROW + (cfg.stickyTotal ? 1 : 0); // индекс (0-based) = строка 7 / 8
  let totalRow = null;
  if (cfg.stickyTotal && raw.length > TABLE_HEAD_ROW) {
    const t = buildMatrix(raw, fmts, tz, labels, -1, idCols, TABLE_HEAD_ROW, TABLE_HEAD_ROW + 1, colIdx);
    totalRow = { v: t.v[0], f: t.f[0] };
  }

  // Подписи строк для эвристики процентов не нужны: берём заголовок столбца.
  const data = buildMatrix(raw, fmts, tz, labels, -1, idCols, firstDataRow, raw.length, colIdx);
  const rows = [], rowFmts = [];
  data.v.forEach((vals, i) => {
    if (rowHasData(vals)) { rows.push(vals); rowFmts.push(data.f[i]); }
  });

  return {
    meta: { dateColumns: !!cfg.dateColumns, stickyTotal: !!cfg.stickyTotal, abcIdx },
    columns, rows, fmts: rowFmts, totalRow, dateSeries
  };
}

function buildTwoTables(raw, fmts, tz, labels, width) {
  // Блок WB — до первой пустой ячейки шапки; блок OZ — после неё.
  let splitCol = -1, seen = false;
  for (let c = 0; c < width; c++) {
    if (!isBlank(labels[c])) seen = true;
    else if (seen) { splitCol = c; break; }
  }
  if (splitCol < 0) splitCol = Math.floor(width / 2);

  let ozStart = splitCol;
  while (ozStart < width && isBlank(labels[ozStart])) ozStart++;

  function cols(from, to) {
    const out = [];
    for (let c = from; c < to; c++) if (!isBlank(labels[c])) out.push({ idx: c, label: String(labels[c]) });
    return out;
  }

  function makeTable(key, title, columns) {
    const idCols = {};
    columns.forEach(col => { if (ID_HEADER_RE.test(col.label.trim())) idCols[col.idx] = true; });
    // Подпись строки — столбец «Parameters» (второй столбец блока)
    const labelCol = columns.length > 1 ? columns[1].idx : -1;
    const colIdx = columns.map(c => c.idx);
    const m = buildMatrix(raw, fmts, tz, labels, labelCol, idCols, TABLE_HEAD_ROW, raw.length, colIdx);
    const rows = [], rowFmts = [];
    m.v.forEach((vals, i) => {
      if (rowHasData(vals)) { rows.push(vals); rowFmts.push(m.f[i]); }
    });
    return { key, title, columns, rows, fmts: rowFmts, totalRow: null };
  }

  return {
    meta: { twoTables: true },
    tables: [
      makeTable('WB', 'Wildberries', cols(0, splitCol)),
      makeTable('OZ', 'Ozon', cols(ozStart, width))
    ]
  };
}

function testConnection() {
  const ss = getSpreadsheet();
  return { success: true, spreadsheet: ss.getName(), sheets: getSheetsList(), timestamp: new Date().toISOString() };
}
