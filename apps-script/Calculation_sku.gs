/**********************************************************************
 * Calculation_sku.gs
 * Лист "Calculation_sku" → вкладка «P&L по SKU» в Web App.
 *
 * РАСЧЁТЫ НА ЛИСТЕ ВЫ ДЕЛАЕТЕ САМИ (свои формулы). Скрипт:
 *  - один раз создаёт лист и шапку (строки 1–6) — меню «Отчёты МП» →
 *    «Wildberries — P&L» → «Создать лист Calculation_sku (шапка)»;
 *  - НИЧЕГО не пишет в таблицу с A7 и не ссылается на лист Calculation;
 *  - читает лист «как есть» (значения ваших формул) и отдаёт в Web App.
 *
 * Шапка — та же, что у Calculation, но это значения и формулы ЭТОГО
 * листа (без ссылок на Calculation):
 *   E2 / G2 — фильтр «Дата от / Дата до» (Web App пишет сюда тоже),
 *   E4 = ЕСЛИ(E2="";СЕГОДНЯ();E2), G4 = ЕСЛИ(G2="";ДАТАМЕС(E4;-3);G2), C4 = E4.
 * В своих формулах берите период с этого листа: $G$4 … $E$4.
 *
 * Таблица начинается с A6:
 *   № | Артикул WB | Артикул | Категория товара | Выручка | Логистика |
 *   Логистика % | Расходы | Себестоимость | ВП | Маржа, % | Доля, % | XYZ | ABC
 *
 * Web App читает лист ПО ЗАГОЛОВКАМ строки 6 — порядок и количество колонок
 * можно менять (добавили колонку — она появится во вкладке сама). Формат
 * колонки определяется по названию: «…%» — проценты (число 0,125 → 12,5%),
 * XYZ/ABC — цветные метки, «Артикул WB» — числовой код WB (nmId), «Артикул» и
 * «Категория» — текст, остальное — деньги.
 * Строки с числом в колонке «№» — товары; строки без номера, но с текстом
 * (например, «Итого») — выводятся итоговыми внизу.
 *
 * Для графика при наведении на строку SKU скрипт дополнительно берёт
 * продажи SKU по неделям из Data_wb (Продажа − Возвраты) за период
 * $G$4…$E$4 этого листа. В таблицу это не пишется.
 *
 * ВАЖНО: все имена в этом файле имеют префикс SKUCALC_ / SkuCalc_.
 **********************************************************************/

const SKUCALC_SHEET = 'Calculation_sku';
const SKUCALC_HEADER_ROW = 6;
const SKUCALC_FIRST_ROW = 7;
const SKUCALC_CACHE_PREFIX = 'SKUCALC_W2_';

const SKUCALC_HEADERS = [
  '№', 'Артикул WB', 'Артикул', 'Категория товара', 'Выручка', 'Логистика',
  'Логистика %', 'Расходы', 'Себестоимость', 'ВП', 'Маржа, %', 'Доля, %', 'XYZ', 'ABC'
];

// Колонки Data_wb — ровно те же буквы, что в calcFormula() (Code.gs).
// Если поменяете буквы там — поменяйте и здесь.
const SKUCALC_COLS = {
  amount: 'V',     // сумма продажи/возврата
  oper: 'Z',       // тип операции ("Продажа", "Возвраты", "Логистика" …)
  date: 'AB',      // rrDate — дата строки отчёта
  logistics: 'AH', // логистика
  forPay: 'AR',    // к перечислению
  penalty: 'BI',   // штрафы
  storage: 'BL',   // хранение
  deduction: 'BM'  // прочие удержания
};

// Значения колонки Z — те же строки, что в формулах Calculation.
const SKUCALC_OPER_SALE = 'Продажа';
const SKUCALC_OPER_RETURN = 'Возвраты';
const SKUCALC_OPER_LOGISTICS = 'Логистика';

// Колонки Data_wb, которые ищем по имени заголовка (первое найденное).
const SKUCALC_NAME_FIELDS = {
  sku: ['nmId', 'nm_id'],
  category: ['subjectName', 'subject_name', 'subject'],
  article: ['saName', 'sa_name', 'supplierArticle', 'vendorCode'],
  qty: ['quantity']
};


/* =================== ЛИСТ =================== */

/** Пункт меню: создать лист (или пересоздать шапку — строки 1–6). */
function SkuCalc_setupSheet() {
  const ss = SpreadsheetApp.getActive();
  const ui = SpreadsheetApp.getUi();
  let sh = ss.getSheetByName(SKUCALC_SHEET);
  if (sh) {
    const res = ui.alert('Calculation_sku',
      'Лист уже есть. Пересоздать шапку (строки 1–6)?\nВаши формулы с 7-й строки не изменятся.',
      ui.ButtonSet.YES_NO);
    if (res !== ui.Button.YES) return;
  } else {
    const calc = ss.getSheetByName(SHEET_CALC);
    sh = ss.insertSheet(SKUCALC_SHEET, calc ? calc.getIndex() : ss.getNumSheets());
  }
  SkuCalc_initHeader_(sh);
  ss.setActiveSheet(sh);
  ui.alert('Calculation_sku', 'Шапка готова. Заполняйте таблицу своими формулами с A7.', ui.ButtonSet.OK);
}

/**
 * Шапка: тексты как у Calculation (значениями), фильтр E2/G2 и свои
 * формулы периода. Строки 7+ не трогаются.
 */
function SkuCalc_initHeader_(sh) {
  const ss = SpreadsheetApp.getActive();
  const calc = ss.getSheetByName(SHEET_CALC);
  const val = (a1, def) => {
    const v = calc ? calc.getRange(a1).getValue() : '';
    return v === '' || v === null ? def : v;
  };

  sh.getRange(1, 1, SKUCALC_HEADER_ROW - 1, SKUCALC_HEADERS.length).clearContent();
  sh.getRange('A1').setValue(val('A1', 'P&L REPORT Wildberries'));
  sh.getRange('A2').setValue(val('A2', 'Отчёт о прибылях и убытках'));
  sh.getRange('C2').setValue('Установка даты:');
  sh.getRange('D2').setValue('Дата от (фильтр):');
  sh.getRange('F2').setValue('Дата до (фильтр):');
  sh.getRange('E2').setValue(val('E2', ''));
  sh.getRange('G2').setValue(val('G2', ''));
  sh.getRange('A3').setValue(val('A3', `Продавец — ${SELLER_NAME}`));
  sh.getRange('A4').setValue('Период отчёта (в рублях) Сформирован:');
  sh.getRange('D4').setValue('Дата от:');
  sh.getRange('F4').setValue('Дата до:');
  setFormulaRu_(sh.getRange('C4'), '=E4');
  setFormulaRu_(sh.getRange('E4'), '=ЕСЛИ(E2="";СЕГОДНЯ();E2)');
  setFormulaRu_(sh.getRange('G4'), '=ЕСЛИ(G2="";ДАТАМЕС(E4;-3);G2)');
  sh.getRange('E5').setValue('Сегодня');

  if (calc) calc.getRange('A1:M5').copyFormatToRange(sh, 1, 13, 1, 5);
  sh.getRangeList(['E2', 'G2', 'C4', 'E4', 'G4']).setNumberFormat('dd.MM.yyyy');

  sh.getRange(SKUCALC_HEADER_ROW, 1, 1, SKUCALC_HEADERS.length).setValues([SKUCALC_HEADERS])
    .setFontWeight('bold').setBackground('#efefef').setHorizontalAlignment('center');
  sh.setFrozenRows(SKUCALC_HEADER_ROW);
  sh.setFrozenColumns(3);
  sh.setColumnWidth(1, 45);
  sh.setColumnWidth(2, 110);
  sh.setColumnWidth(3, 170);
  sh.setColumnWidth(4, 190);
  for (let c = 5; c <= 12; c++) sh.setColumnWidth(c, 110);
  sh.setColumnWidth(13, 55);
  sh.setColumnWidth(14, 55);

  Formulas_fixRejected_(sh);
}

/* =================== ДАННЫЕ ДЛЯ WEB APP =================== */

/**
 * Тип колонки по её заголовку (строка 6 листа) — от него зависит формат
 * в Web App. Названия можно менять: распознаются по ключевым словам.
 */
function SkuCalc_colType_(title) {
  const t = String(title).toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
  if (t === '№' || t === 'no' || t === 'n' || t === '#') return 'num';
  if (t.indexOf('%') >= 0) return 'pct';
  if (t === 'xyz') return 'xyz';
  if (t === 'abc') return 'abc';
  if (t === 'артикул wb' || t === 'артикул вб' || t === 'nmid' || t === 'nm id' || t === 'sku') return 'id';
  if (t === 'артикул' || t === 'артикул продавца') return 'art';
  if (/категор|наимен|назван|бренд|предмет/.test(t)) return 'text';
  return 'money';
}

/**
 * Серверный вызов для Web App (вкладка «P&L по SKU»). Каждый вызов читает
 * лист заново — изменили ячейку/формулу в Calculation_sku, и при
 * следующем обновлении вкладки (автоматически раз в ~40 с, кнопка
 * «Обновить») значение изменится и в приложении.
 * Колонки берутся из заголовков строки 6, значения — как в листе.
 */
function SkuCalc_getReportData() {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(SKUCALC_SHEET);
  if (!sh) {
    throw new Error('Лист Calculation_sku не найден. Меню «Отчёты МП» → «Wildberries — P&L» → «Создать лист Calculation_sku (шапка)».');
  }

  const lastCol = Math.max(sh.getLastColumn(), 1);
  const headerVals = sh.getRange(SKUCALC_HEADER_ROW, 1, 1, lastCol).getValues()[0];
  let n = lastCol;
  while (n > 0 && String(headerVals[n - 1]).trim() === '') n--;

  const columns = [];
  for (let i = 0; i < n; i++) {
    const title = String(headerVals[i]).trim();
    if (isDashHeader_(title)) continue; // пусто или «-» — колонку не показываем
    columns.push({ i: i, title: title, type: SkuCalc_colType_(title) });
  }
  const colOf = type => columns.find(c => c.type === type);
  const numCol = colOf('num'), idCol = colOf('id'), artCol = colOf('art');

  const cellOut = (v, type) => {
    if (v instanceof Date) return fmtCell(v);
    if (typeof v === 'string') v = v.trim();
    if (type === 'xyz' || type === 'abc') return String(v).toUpperCase();
    if (type === 'id' && typeof v === 'number') return String(v);
    return v;
  };

  const rows = [];
  const service = [];
  const last = sh.getLastRow();
  if (last >= SKUCALC_FIRST_ROW && columns.length) {
    const cnt = last - SKUCALC_FIRST_ROW + 1;
    const values = sh.getRange(SKUCALC_FIRST_ROW, 1, cnt, n).getValues();
    values.forEach(v => {
      const cells = columns.map(c => cellOut(v[c.i], c.type));
      if (cells.every(x => x === '' || x === null)) return;
      const numVal = numCol ? v[numCol.i] : '';
      const idVal = idCol ? String(v[idCol.i] === null ? '' : v[idCol.i]).trim() : '';
      const isItem = numCol
        ? (typeof numVal === 'number' || /^\d+$/.test(String(numVal).trim()))
        : idVal !== '';
      const r = {
        cells: cells,
        id: isItem ? idVal : '',
        article: artCol && isItem ? String(v[artCol.i] === null ? '' : v[artCol.i]).trim() : ''
      };
      (isItem ? rows : service).push(r);
    });
  }

  const period = SkuCalc_sheetPeriod_(sh);
  const weekly = SkuCalc_weekly_(period);
  rows.forEach(r => {
    const w = weekly.bySku[r.id];
    r.weekRev = w ? w.rev : null;
    if (!r.article && w) r.article = w.article;
  });
  service.forEach(r => {
    const label = r.cells.map(x => String(x)).join(' ');
    r.weekRev = /итог/i.test(label) ? weekly.total : null;
  });

  return {
    header: SkuCalc_header_(),
    columns: columns.map(c => ({ title: c.title, type: c.type })),
    period: {
      from: SkuCalc_keyToRu_(period.fromKey),
      to: SkuCalc_keyToRu_(period.toKey),
      days: weekly.days,
      fullWeeks: Math.floor(weekly.days / 7)
    },
    weeks: weekly.weeks,
    rows: rows,
    service: service
  };
}

/** Период листа Calculation_sku: [min(E4,G4); max(E4,G4)], иначе — как у Calculation. */
function SkuCalc_sheetPeriod_(sh) {
  const tz = SpreadsheetApp.getActive().getSpreadsheetTimeZone();
  const toKey = v => (v instanceof Date) ? Utilities.formatDate(v, tz, 'yyyy-MM-dd') : '';
  const a = toKey(sh.getRange('E4').getValue());
  const b = toKey(sh.getRange('G4').getValue());
  if (!a || !b) return SkuCalc_period_();
  return a <= b ? { fromKey: a, toKey: b } : { fromKey: b, toKey: a };
}

/**
 * Продажи по неделям из Data_wb (Продажа − Возвраты, колонка V) — только
 * для графика при наведении. Кэш — до изменения данных или периода.
 */
function SkuCalc_weekly_(period) {
  const days = SkuCalc_daysBetween_(period.fromKey, period.toKey) + 1;
  const weeksCount = Math.max(1, Math.ceil(days / 7));
  const data = SpreadsheetApp.getActive().getSheetByName(SHEET_DATA);
  const ver = PropertiesService.getScriptProperties().getProperty('WB_DATA_VERSION') || '0';
  const sig = [period.fromKey, period.toKey, data ? data.getLastRow() : 0, ver].join('#');

  const cached = SkuCalc_cacheGetJson_(SKUCALC_CACHE_PREFIX, sig);
  if (cached) return cached;

  const weeks = [];
  for (let w = 0; w < weeksCount; w++) {
    weeks.push(SkuCalc_keyToRu_(SkuCalc_addDaysKey_(period.fromKey, w * 7)));
  }
  const res = { days: days, weeks: weeks, bySku: {}, total: new Array(weeksCount).fill(0) };

  const d = SkuCalc_readData_();
  if (d) {
    const dayIdx = {};
    for (let i = 0; i < d.n; i++) {
      const k = d.dayKey(i);
      if (!k || k < period.fromKey || k > period.toKey) continue;
      const op = String(d.oper[i] || '').trim();
      const sign = op === SKUCALC_OPER_SALE ? 1 : (op === SKUCALC_OPER_RETURN ? -1 : 0);
      if (!sign) continue;
      let di = dayIdx[k];
      if (di === undefined) di = dayIdx[k] = SkuCalc_daysBetween_(period.fromKey, k);
      const w = Math.floor(di / 7);
      const amt = sign * SkuCalc_num_(d.amount[i]);
      res.total[w] += amt;

      let sku = d.sku ? String(d.sku[i] === null ? '' : d.sku[i]).trim() : '';
      if (!sku || sku === '0') continue;
      const rec = res.bySku[sku] || (res.bySku[sku] = { rev: new Array(weeksCount).fill(0), article: '' });
      rec.rev[w] += amt;
      if (!rec.article && d.article && d.article[i]) rec.article = String(d.article[i]);
    }
  }
  res.total = res.total.map(SkuCalc_r2_);
  Object.keys(res.bySku).forEach(s => { res.bySku[s].rev = res.bySku[s].rev.map(SkuCalc_r2_); });

  SkuCalc_cachePutJson_(SKUCALC_CACHE_PREFIX, sig, res);
  return res;
}

/* =================== ЧТЕНИЕ ДАННЫХ =================== */

/**
 * Читает из Data_wb только нужные колонки (быстрее, чем весь лист).
 * Возвращает null, если данных нет. dayKey(i) — "yyyy-MM-dd" строки i
 * в часовом поясе таблицы (как их видит SUMIFS).
 * Используется также в Charts.gs.
 */
function SkuCalc_readData_() {
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
  const byLetter = letter => readCol(SkuCalc_colIndex_(letter));
  const byName = names => {
    for (const name of names) {
      const i = headers.indexOf(name);
      if (i >= 0) return readCol(i + 1);
    }
    return null;
  };

  const out = { n: n };
  Object.keys(SKUCALC_COLS).forEach(k => { out[k] = byLetter(SKUCALC_COLS[k]); });
  Object.keys(SKUCALC_NAME_FIELDS).forEach(k => { out[k] = byName(SKUCALC_NAME_FIELDS[k]); });

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

/** Период отчёта из шапки Calculation: [min(E4,G4); max(E4,G4)]. */
function SkuCalc_period_() {
  const ss = SpreadsheetApp.getActive();
  const calc = ss.getSheetByName(SHEET_CALC);
  if (!calc) throw new Error('Лист Calculation не найден.');
  const tz = ss.getSpreadsheetTimeZone();
  const toKey = v => (v instanceof Date) ? Utilities.formatDate(v, tz, 'yyyy-MM-dd') : '';
  let a = toKey(calc.getRange('E4').getValue());
  let b = toKey(calc.getRange('G4').getValue());
  const today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  if (!a) a = today;
  if (!b) b = a;
  return a <= b ? { fromKey: a, toKey: b } : { fromKey: b, toKey: a };
}

function SkuCalc_header_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_CALC);
  const userFrom = sh.getRange('E2').getValue();
  const userTo = sh.getRange('G2').getValue();
  const defFrom = sh.getRange('E4').getValue();
  const defTo = sh.getRange('G4').getValue();
  return {
    title: String(sh.getRange('A1').getValue()),
    subtitle: String(sh.getRange('A2').getValue()),
    seller: String(sh.getRange('A3').getValue()),
    periodFrom: fmtCell(userFrom) || fmtCell(defFrom),
    periodTo: fmtCell(userTo) || fmtCell(defTo),
    defaultFrom: fmtCell(defFrom),
    defaultTo: fmtCell(defTo)
  };
}

// CacheService хранит до 100 КБ на ключ — режем JSON на куски.
function SkuCalc_cachePutJson_(prefix, sig, obj) {
  try {
    const cache = CacheService.getScriptCache();
    const json = JSON.stringify(obj);
    const size = 90000;
    const parts = {};
    let count = 0;
    for (let i = 0; i < json.length; i += size) parts[prefix + 'p' + (count++)] = json.slice(i, i + size);
    if (count > 50) return; // слишком большой объём — не кэшируем
    parts[prefix + 'meta'] = JSON.stringify({ sig: sig, count: count });
    cache.putAll(parts, 6 * 60 * 60);
  } catch (e) {
    Logger.log('Кэш не сохранён: ' + e.message);
  }
}

function SkuCalc_cacheGetJson_(prefix, sig) {
  try {
    const cache = CacheService.getScriptCache();
    const meta = cache.get(prefix + 'meta');
    if (!meta) return null;
    const m = JSON.parse(meta);
    if (m.sig !== sig) return null;
    const keys = [];
    for (let i = 0; i < m.count; i++) keys.push(prefix + 'p' + i);
    const got = cache.getAll(keys);
    let json = '';
    for (const k of keys) {
      if (got[k] === undefined) return null;
      json += got[k];
    }
    return JSON.parse(json);
  } catch (e) {
    return null;
  }
}

/* =================== УТИЛИТЫ =================== */

// Как SUMIFS: суммируются только настоящие числа, текст игнорируется.
function SkuCalc_num_(v) {
  return (typeof v === 'number' && isFinite(v)) ? v : 0;
}

function SkuCalc_r2_(v) {
  return Math.round(v * 100) / 100;
}

function SkuCalc_colIndex_(letter) {
  let n = 0;
  for (const ch of String(letter).toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function SkuCalc_keyToUtc_(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  return Date.UTC(+m[1], +m[2] - 1, +m[3]);
}

function SkuCalc_daysBetween_(fromKey, toKey) {
  return Math.round((SkuCalc_keyToUtc_(toKey) - SkuCalc_keyToUtc_(fromKey)) / 86400000);
}

function SkuCalc_addDaysKey_(key, n) {
  return Utilities.formatDate(new Date(SkuCalc_keyToUtc_(key) + n * 86400000 + 12 * 3600000), 'UTC', 'yyyy-MM-dd');
}

function SkuCalc_keyToRu_(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : key;
}

