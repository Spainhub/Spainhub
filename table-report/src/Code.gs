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
 *   WB&OZ         — две таблицы: шапка 1-й в строке 6, шапка 2-й в строке 11
 *   строка 7/8+   — данные
 *   OZPL1/OZPL2   — шапка в строке 5, «Итого» в строке 6, данные с 7
 *   LINK          — текст и ссылки A1:J30 с исходным форматированием
 */

const HEADER_ROWS = 5;   // строки 1–5: информационный блок
const TABLE_HEAD_ROW = 6; // строка шапки таблицы

/**
 * Порядок ключей = порядок вкладок.
 *   infoRows  — сколько верхних строк выводится блоком «как в таблице» (по умолчанию 5)
 *   headRow   — строка шапки таблицы (по умолчанию 6)
 *   stickyTotal — следующая за шапкой строка — фиксированный «Итого»
 *   view      — лист показывается «как есть» (текст, ссылки, форматирование) в диапазоне range
 */
const SHEETS_CONFIG = {
  // Две таблицы одна под другой. headRow — строка шапки; данные идут до шапки следующей таблицы.
  'WB&OZ': {
    title: 'WB & OZ Total',
    tables: [
      { key: 'WB', title: 'Wildberries', headRow: 6,  units: ['WB Kvantum', 'WB Azimut'] },
      { key: 'OZ', title: 'Ozon',        headRow: 11, units: ['Ozon Kvantum', 'Ozon Azimut'] }
    ],
    // Диаграммы: столбцы — выручка по магазинам, линия с градиентом — маржинальная прибыль
    charts: [
      { title: 'Wildberries — Revenue and Marginal profit by store', store: 'B7:B8',   revenue: 'C7:C8',   profit: 'O7:O8' },
      { title: 'Ozon — Revenue and Marginal profit by store',        store: 'B12:B13', revenue: 'C12:C13', profit: 'L12:L13' }
    ]
  },
  'OZ_UNIT1': { title: 'OZ Unit 1', stickyTotal: true, marketplace: true },
  'OZ_UNIT2': { title: 'OZ Unit 2',  stickyTotal: true, marketplace: true },
  'WB_UNIT1': { title: 'WB Unit 1', stickyTotal: true, dateColumns: true, marketplace: true },
  'WB_UNIT2': { title: 'WB Unit 2',  stickyTotal: true, dateColumns: true, marketplace: true },
  'OZPL1':    { title: 'OZ Stock 1', infoRows: 4, headRow: 5, stickyTotal: true },
  'OZPL2':    { title: 'OZ Stock 2',  infoRows: 4, headRow: 5, stickyTotal: true },
  'LINK':     { title: 'LINK', view: true, range: 'A1:J30' }
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

/** Столбцы с дробными значениями (месяцы, недели, продажи в день): знаки после запятой не отбрасываются. */
const FRACTION_LABEL_RE = /month|week|daily|per day|мес|недел|в день|оборач/i;

// ───────────────────────── Веб-приложение ─────────────────────────

function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('REPORT · P&L 4 version 1.0')
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
    .map(name => ({
      name,
      title: SHEETS_CONFIG[name].title,
      marketplace: !!SHEETS_CONFIG[name].marketplace,
      view: !!SHEETS_CONFIG[name].view
    }));
}

// ───────────────────────── Вспомогательное ─────────────────────────

/** Один вызов при старте: список листов + данные первой вкладки (быстрее, чем два вызова подряд). */
function getBootstrap() {
  const sheets = getSheetsList();
  return { sheets, first: sheets.length ? getSheetData(sheets[0].name) : null };
}

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
  if (FRACTION_LABEL_RE.test(String(colLabel || ''))) {
    return { v: value, f: Math.min(formatDecimals(f), 9) || (Number.isInteger(value) ? 0 : 1) };
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
  if (cfg.view) return { name: sheetName, view: buildSheetView(ss, sheet, cfg) };

  const head = cfg.headRow || TABLE_HEAD_ROW;
  const infoRows = cfg.infoRows || HEADER_ROWS;
  const headRows = cfg.tables ? cfg.tables.map(t => t.headRow) : [head];
  const maxHead = Math.max.apply(null, headRows);
  const lastRow = Math.max(sheet.getLastRow(), maxHead);
  const lastCol = Math.max(sheet.getLastColumn(), 1);

  const range = sheet.getRange(1, 1, lastRow, lastCol);
  const raw = range.getValues();
  const fmts = range.getNumberFormats();
  const labels = (raw[head - 1] || []).map(v => String(serializeValue(v, tz)));

  // Реальная ширина: последний непустой столбец среди строк 1–6
  let width = 0;
  for (let r = 0; r < maxHead; r++) {
    for (let c = lastCol - 1; c >= width; c--) {
      if (!isBlank(raw[r][c])) { width = c + 1; break; }
    }
  }
  width = Math.max(width, 1);

  const info = buildInfoBlock(sheet, raw, fmts, tz, width, infoRows);
  const base = { name: sheetName, info, sortable: cfg.sortable !== false };

  if (cfg.charts) base.charts = buildCharts(sheet, cfg);
  if (cfg.tables) return Object.assign(base, buildStackedTables(cfg, raw, fmts, tz, width));
  return Object.assign(base, buildUnitTable(cfg, raw, fmts, tz, labels, width, head));
}

/** Строки 1–5 «как в Google Sheets»: значения, форматы и объединённые ячейки. */
function buildInfoBlock(sheet, raw, fmts, tz, width, infoRows) {
  const rows = [], f = [];
  for (let r = 0; r < infoRows; r++) {
    const rv = [], rf = [];
    for (let c = 0; c < width; c++) {
      const cl = classifyCell(serializeValue(raw[r][c], tz), fmts[r][c], '', '', false);
      // в информационном блоке проценты только по формату ячейки
      rv.push(cl.v); rf.push(cl.f);
    }
    rows.push(rv); f.push(rf);
  }
  const merges = [];
  sheet.getRange(1, 1, infoRows, width).getMergedRanges().forEach(m => {
    merges.push({
      r: m.getRow() - 1, c: m.getColumn() - 1,
      rs: m.getNumRows(), cs: m.getNumColumns()
    });
  });
  return { width, rows, fmts: f, merges };
}

function buildUnitTable(cfg, raw, fmts, tz, labels, width, head) {
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
      if (isDateHeader(raw[head - 1][col.idx])) {
        dateSeries.push({ idx: col.idx, label: col.label });
        idCols[col.idx] = false;
      }
    });
  }

  const colIdx = columns.map(c => c.idx);
  const abcIdx = columns.findIndex(c => /^abc$/i.test(c.label.trim()));

  const firstDataRow = head + (cfg.stickyTotal ? 1 : 0); // индекс (0-based): строка после шапки / после «Итого»
  let totalRow = null;
  if (cfg.stickyTotal && raw.length > head) {
    const t = buildMatrix(raw, fmts, tz, labels, -1, idCols, head, head + 1, colIdx);
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

/** Несколько таблиц на одном листе, расположенных друг под другом. */
function buildStackedTables(cfg, raw, fmts, tz, width) {
  const heads = cfg.tables.map(t => t.headRow - 1); // 0-based индексы строк шапок

  const tables = cfg.tables.map((t, n) => {
    const h = t.headRow - 1;
    const end = n + 1 < heads.length ? heads[n + 1] : raw.length;
    const labels = (raw[h] || []).map(v => String(serializeValue(v, tz)));

    const columns = [];
    for (let c = 0; c < width; c++) {
      if (!isBlank(labels[c])) columns.push({ idx: c, label: String(labels[c]) });
    }
    const idCols = {};
    columns.forEach(col => { if (ID_HEADER_RE.test(col.label.trim())) idCols[col.idx] = true; });
    const colIdx = columns.map(c => c.idx);
    const abcIdx = columns.findIndex(c => /^abc$/i.test(c.label.trim()));

    const m = buildMatrix(raw, fmts, tz, labels, -1, idCols, h + 1, end, colIdx);
    const rows = [], rowFmts = [];
    m.v.forEach((vals, i) => {
      if (rowHasData(vals)) { rows.push(vals); rowFmts.push(m.f[i]); }
    });
    return { key: t.key, title: t.title, units: t.units || [], abcIdx, columns, rows, fmts: rowFmts, totalRow: null };
  });

  return { meta: { twoTables: true }, tables };
}

/** Данные диаграмм берутся напрямую из указанных диапазонов (например B7:B8, C7:C8, O7:O8). */
function buildCharts(sheet, cfg) {
  const flat = arr => [].concat.apply([], arr);
  const num = v => {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    const n = parseFloat(String(v).replace(/\s/g, '').replace(',', '.'));
    return isFinite(n) ? n : null;
  };
  return cfg.charts.map(ch => ({
    title: ch.title,
    labels: flat(sheet.getRange(ch.store).getDisplayValues()).map(String),
    revenue: flat(sheet.getRange(ch.revenue).getValues()).map(num),
    profit: flat(sheet.getRange(ch.profit).getValues()).map(num)
  }));
}

// ───────────────────────── Лист «как есть» (LINK) ─────────────────────────

/** Ссылки допускаются только безопасных схем; внутренние (#gid=…) превращаем в полный адрес таблицы. */
function safeUrl(url, ss) {
  if (!url) return '';
  url = String(url);
  if (url.charAt(0) === '#') return ss.getUrl() + url;
  return /^(https?:\/\/|mailto:|tel:)/i.test(url) ? url : '';
}

function buildSheetView(ss, sheet, cfg) {
  const rng = sheet.getRange(cfg.range);
  const R = rng.getNumRows(), C = rng.getNumColumns(), r0 = rng.getRow(), c0 = rng.getColumn();
  const rich = rng.getRichTextValues(), disp = rng.getDisplayValues(), formulas = rng.getFormulas();
  const bg = rng.getBackgrounds(), fc = rng.getFontColors(), fs = rng.getFontSizes();
  const fw = rng.getFontWeights(), fst = rng.getFontStyles(), fl = rng.getFontLines();
  const ha = rng.getHorizontalAlignments(), va = rng.getVerticalAlignments(), ws = rng.getWrapStrategies();

  const cells = [];
  for (let r = 0; r < R; r++) {
    const row = [];
    for (let c = 0; c < C; c++) {
      const cell = {};
      const text = disp[r][c];
      const rv = rich[r][c];
      let runs = null;

      if (rv && rv.getText() !== '') {
        const list = rv.getRuns();
        const hasStyleOrLink = list.some(run => run.getLinkUrl() || list.length > 1);
        if (hasStyleOrLink) {
          runs = list.map(run => {
            const st = run.getTextStyle();
            const o = { t: run.getText() };
            const url = safeUrl(run.getLinkUrl(), ss);
            if (url) o.url = url;
            if (st.isBold()) o.b = 1;
            if (st.isItalic()) o.i = 1;
            if (st.isUnderline() && !url) o.u = 1;
            const col = st.getForegroundColor();
            if (col && !url) o.fg = col;
            return o;
          });
        }
      }
      const m = String(formulas[r][c] || '').match(/^=HYPERLINK\(\s*"([^"]+)"/i);
      if (m && safeUrl(m[1], ss)) runs = [{ t: text, url: safeUrl(m[1], ss) }];

      if (runs) cell.runs = runs; else if (text !== '') cell.t = text;
      if (bg[r][c] && bg[r][c].toLowerCase() !== '#ffffff') cell.bg = bg[r][c];
      if (fc[r][c] && fc[r][c].toLowerCase() !== '#000000') cell.fg = fc[r][c];
      if (fs[r][c] && fs[r][c] !== 10) cell.fs = fs[r][c];
      if (fw[r][c] === 'bold') cell.b = 1;
      if (fst[r][c] === 'italic') cell.i = 1;
      if (fl[r][c] === 'underline') cell.u = 1;
      if (fl[r][c] === 'line-through') cell.s = 1;
      if (ha[r][c] && ha[r][c] !== 'general-left' && ha[r][c] !== 'general') cell.ha = ha[r][c];
      if (va[r][c] && va[r][c] !== 'bottom') cell.va = va[r][c];
      if (String(ws[r][c]) === 'WRAP') cell.w = 1;
      row.push(cell);
    }
    cells.push(row);
  }

  const merges = [];
  rng.getMergedRanges().forEach(mr => {
    merges.push({ r: mr.getRow() - r0, c: mr.getColumn() - c0, rs: mr.getNumRows(), cs: mr.getNumColumns() });
  });

  const colWidths = [], rowHeights = [];
  for (let c = 0; c < C; c++) colWidths.push(sheet.isColumnHiddenByUser(c0 + c) ? 0 : sheet.getColumnWidth(c0 + c));
  for (let r = 0; r < R; r++) rowHeights.push(sheet.isRowHiddenByUser(r0 + r) ? 0 : sheet.getRowHeight(r0 + r));

  return { rows: R, cols: C, cells, merges, colWidths, rowHeights };
}

function testConnection() {
  const ss = getSpreadsheet();
  return { success: true, spreadsheet: ss.getName(), sheets: getSheetsList(), timestamp: new Date().toISOString() };
}
