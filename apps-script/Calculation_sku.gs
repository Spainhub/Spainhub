/**********************************************************************
 * Calculation_sku.gs
 * P&L в разрезе SKU → лист "Calculation_sku" + вкладка «P&L по SKU»
 * в Web App.
 *
 * ЛОГИКА ПОЛЕЙ — та же, что в листе Calculation (см. calcFormula() в
 * Code.gs). Используются ТЕ ЖЕ колонки Data_wb и ТЕ ЖЕ условия SUMIFS:
 *   Выручка        = Σ V ("Продажа") − Σ V ("Возвраты")        (строка 9)
 *   К перечислению = Σ AR ("Продажа")                          (строка 11)
 *   Доход СПП      = MAX(0; К перечислению − Выручка)           (строка 12)
 *   Комиссия WB    = Выручка − К перечислению                   (строка 16)
 *   Логистика      = Σ AH ("Логистика")                         (строка 18)
 *   Логистика, %   = Логистика / Выручка                        (строка 19)
 *   Хранение       = Σ BL                                       (строка 20)
 *   Штрафы/удерж.  = Σ BI + Σ BM                                (строка 21)
 *   Расходы        = Комиссия + Логистика + Хранение + Штрафы   (строка 15)
 *   Себестоимость  = себестоимость ед. (лист Cost_sku) × кол-во (строка 14)
 *   ВП (MG)        = (Выручка + Доход СПП) − (Себест. + Расходы) (строка 23)
 *   Маржа, %       = ВП / (Выручка + Доход СПП)                  (строка 24)
 *   Доля, %        = Выручка SKU / Выручка итого        (колонка D Calculation)
 *   ABC            — по выручке: A ≤ 80%, B ≤ 95%, C — остальное
 *   XYZ            — по коэффициенту вариации недельных продаж (шт.)
 *
 * Период = период из шапки отчёта (Calculation!E4 … Calculation!G4),
 * т.е. фильтр «Дата от / Дата до» Web App действует и на эту вкладку.
 *
 * Шапка листа (строки 1–5) — ссылки на шапку Calculation, т.е. та же.
 * Таблица начинается с A6:
 *   № | SKU | Категория товара | Выручка | Логистика | % | Расходы |
 *   Себестоимость | ВП (MG) | Маржа, % | Доля, % | XYZ | ABC
 *
 * Себестоимость WB API не отдаёт. Её вводят ОДИН раз на единицу товара
 * в листе "Cost_sku" (создаётся автоматически, новые SKU дописываются
 * сами, введённые значения не затираются).
 *
 * ВАЖНО: все имена в этом файле имеют префикс SKUCALC_ / SkuCalc_.
 **********************************************************************/

const SKUCALC_SHEET = 'Calculation_sku';
const SKUCALC_COST_SHEET = 'Cost_sku';
const SKUCALC_HEADER_ROW = 6;

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

// ABC: границы накопленной доли выручки
const SKUCALC_ABC_A = 0.80;
const SKUCALC_ABC_B = 0.95;
// XYZ: границы коэффициента вариации недельных продаж (шт.)
const SKUCALC_XYZ_X = 0.10;
const SKUCALC_XYZ_Y = 0.25;
const SKUCALC_XYZ_MIN_WEEKS = 4; // меньше полных недель — XYZ не считаем

const SKUCALC_NO_SKU_LABEL = 'Без SKU (общие начисления)';
const SKUCALC_CACHE_PREFIX = 'SKUCALC_V1_';

const SKUCALC_HEADERS = [
  '№', 'SKU', 'Категория товара', 'Выручка', 'Логистика', '%', 'Расходы',
  'Себестоимость', 'ВП (MG)', 'Маржа, %', 'Доля, %', 'XYZ', 'ABC'
];

/* =================== ТОЧКИ ВХОДА =================== */

/** Пункт меню: пересчитать лист Calculation_sku. */
function SkuCalc_rebuildMenu() {
  const res = SkuCalc_rebuild();
  SpreadsheetApp.getActive().toast(
    `Calculation_sku: SKU ${res.rows.length}` +
    (res.missingCost ? `, без себестоимости: ${res.missingCost} (лист ${SKUCALC_COST_SHEET})` : ''),
    'P&L по SKU', 8
  );
}

/** Пункт меню: открыть лист себестоимости (создаёт при отсутствии). */
function SkuCalc_openCostSheet() {
  const sh = SkuCalc_ensureCostSheet_();
  SpreadsheetApp.getActive().setActiveSheet(sh);
}

/**
 * Пересчитывает Calculation_sku (вызывается после ежедневной загрузки
 * и из меню). Возвращает результат расчёта.
 */
function SkuCalc_rebuild() {
  const result = SkuCalc_compute_();
  SkuCalc_writeSheet_(result);
  SkuCalc_cachePut_(result.sig, result);
  return result;
}

/**
 * Серверный вызов для Web App (вкладка «P&L по SKU»).
 * Если данные/период/себестоимость не менялись — отдаёт из кэша.
 */
function SkuCalc_getReportData() {
  const sig = SkuCalc_signature_();
  let result = SkuCalc_cacheGet_(sig);
  if (!result) {
    result = SkuCalc_compute_(sig);
    SkuCalc_writeSheet_(result);
    SkuCalc_cachePut_(sig, result);
  }
  return result;
}

/* =================== РАСЧЁТ =================== */

function SkuCalc_compute_(sig) {
  const ss = SpreadsheetApp.getActive();
  const period = SkuCalc_period_();
  const data = SkuCalc_readData_();
  const costs = SkuCalc_readCosts_();

  const days = SkuCalc_daysBetween_(period.fromKey, period.toKey) + 1;
  const weeksCount = Math.max(1, Math.ceil(days / 7));
  const fullWeeks = Math.floor(days / 7);

  const bySku = {};
  const total = SkuCalc_emptyAgg_(weeksCount);
  const dayIdx = {};

  if (data) {
    for (let i = 0; i < data.n; i++) {
      const k = data.dayKey(i);
      if (!k || k < period.fromKey || k > period.toKey) continue;
      let di = dayIdx[k];
      if (di === undefined) di = dayIdx[k] = SkuCalc_daysBetween_(period.fromKey, k);
      const w = Math.floor(di / 7);

      let sku = data.sku ? String(data.sku[i] === null ? '' : data.sku[i]).trim() : '';
      if (sku === '0') sku = '';
      let rec = bySku[sku];
      if (!rec) {
        rec = bySku[sku] = SkuCalc_emptyAgg_(weeksCount);
        rec.sku = sku;
      }
      if (!rec.article && data.article && data.article[i]) rec.article = String(data.article[i]);
      if (!rec.category && data.category && data.category[i]) rec.category = String(data.category[i]);

      const op = String(data.oper[i] || '').trim();
      const amt = SkuCalc_num_(data.amount[i]);
      const q = data.qty ? SkuCalc_num_(data.qty[i]) : 0;

      [rec, total].forEach(a => {
        if (op === SKUCALC_OPER_SALE) {
          a.sales += amt;
          a.forPay += SkuCalc_num_(data.forPay[i]);
          a.qty += q;
          a.weekRev[w] += amt;
          a.weekQty[w] += q;
        } else if (op === SKUCALC_OPER_RETURN) {
          a.returns += amt;
          a.qty -= q;
          a.weekRev[w] -= amt;
          a.weekQty[w] -= q;
        } else if (op === SKUCALC_OPER_LOGISTICS) {
          a.logistics += SkuCalc_num_(data.logistics[i]);
        }
        // Хранение и штрафы — без фильтра по типу операции (как в Calculation)
        a.storage += SkuCalc_num_(data.storage[i]);
        a.penalties += SkuCalc_num_(data.penalty[i]) + SkuCalc_num_(data.deduction[i]);
      });
    }
  }

  // Новые SKU → в лист себестоимости (пустое значение для ввода)
  SkuCalc_appendNewSkusToCost_(bySku, costs);

  const recs = Object.keys(bySku).filter(s => s !== '').map(s => bySku[s]);
  let missingCost = 0;
  recs.forEach(r => {
    const unit = costs[r.sku];
    r.hasCost = typeof unit === 'number';
    r.cogs = r.hasCost ? unit * r.qty : 0;
    if (!r.hasCost && (r.sales || r.returns)) missingCost++;
  });

  const totalCogs = recs.reduce((s, r) => s + r.cogs, 0);
  const totalRow = SkuCalc_finish_(total, totalCogs);
  const netTotal = totalRow.revenue;

  const rows = recs.map(r => SkuCalc_finish_(r, r.cogs))
    .sort((a, b) => b.revenue - a.revenue);

  // ABC по выручке
  const positive = rows.filter(r => r.revenue > 0).reduce((s, r) => s + r.revenue, 0);
  let cum = 0;
  rows.forEach((r, i) => {
    r.num = i + 1;
    r.share = netTotal ? r.revenue / netTotal : 0;
    if (r.revenue > 0 && positive > 0) {
      const before = cum / positive;
      cum += r.revenue;
      // Класс определяется по накопленной доле ДО товара: первый товар,
      // пересекающий границу 80%, ещё попадает в A.
      r.abc = before < SKUCALC_ABC_A ? 'A' : (before < SKUCALC_ABC_B ? 'B' : 'C');
    } else {
      r.abc = 'C';
    }
    // XYZ по недельным продажам в штуках (только полные недели)
    const series = r.weekQty.slice(0, fullWeeks);
    if (series.length >= SKUCALC_XYZ_MIN_WEEKS) {
      const mean = series.reduce((s, v) => s + v, 0) / series.length;
      if (mean > 0) {
        const variance = series.reduce((s, v) => s + (v - mean) * (v - mean), 0) / series.length;
        r.cv = Math.sqrt(variance) / mean;
        r.xyz = r.cv <= SKUCALC_XYZ_X ? 'X' : (r.cv <= SKUCALC_XYZ_Y ? 'Y' : 'Z');
      } else {
        r.cv = null;
        r.xyz = 'Z';
      }
    } else {
      r.cv = null;
      r.xyz = '—';
    }
  });

  const noSkuRec = bySku[''];
  const noSku = noSkuRec ? SkuCalc_finish_(noSkuRec, 0) : null;
  if (noSku) noSku.share = netTotal ? noSku.revenue / netTotal : 0;
  totalRow.share = netTotal ? 1 : 0;

  // Подписи недель (дата начала недели)
  const weekLabels = [];
  for (let w = 0; w < weeksCount; w++) {
    weekLabels.push(SkuCalc_keyToRu_(SkuCalc_addDaysKey_(period.fromKey, w * 7)));
  }

  return {
    sig: sig || SkuCalc_signature_(),
    header: SkuCalc_header_(),
    period: { from: SkuCalc_keyToRu_(period.fromKey), to: SkuCalc_keyToRu_(period.toKey), days: days, fullWeeks: fullWeeks },
    weeks: weekLabels,
    rows: rows,
    noSku: noSku,
    total: totalRow,
    missingCost: missingCost,
    builtAt: formatRu(new Date()) + ' ' + formatTime(new Date()),
    hasData: !!data
  };
}

function SkuCalc_emptyAgg_(weeks) {
  return {
    sku: '', article: '', category: '',
    sales: 0, returns: 0, forPay: 0, logistics: 0, storage: 0, penalties: 0, qty: 0,
    weekRev: new Array(weeks).fill(0),
    weekQty: new Array(weeks).fill(0)
  };
}

/** Итоговые показатели по агрегату — формулы строк Calculation. */
function SkuCalc_finish_(a, cogs) {
  const revenue = a.sales - a.returns;                  // строка 9
  const extra = Math.max(0, a.forPay - revenue);         // строка 12
  const income = revenue + extra;                        // строка 8
  const commission = revenue - a.forPay;                 // строка 16
  const expenses = commission + a.logistics + a.storage + a.penalties; // строка 15
  const mg = income - (cogs + expenses);                 // строка 23
  return {
    sku: a.sku, article: a.article, category: a.category,
    revenue: SkuCalc_r2_(revenue),
    logistics: SkuCalc_r2_(a.logistics),
    logisticsPct: revenue ? a.logistics / revenue : 0,   // строка 19
    expenses: SkuCalc_r2_(expenses),
    cogs: SkuCalc_r2_(cogs),
    mg: SkuCalc_r2_(mg),
    margin: income ? mg / income : 0,                    // строка 24
    qty: a.qty,
    hasCost: a.hasCost !== false,
    weekRev: a.weekRev.map(SkuCalc_r2_),
    weekQty: a.weekQty
  };
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

/* =================== СЕБЕСТОИМОСТЬ (Cost_sku) =================== */

function SkuCalc_ensureCostSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(SKUCALC_COST_SHEET);
  if (sh) return sh;
  sh = ss.insertSheet(SKUCALC_COST_SHEET);
  sh.getRange(1, 1, 1, 4).setValues([[
    'SKU (nmId)', 'Артикул', 'Категория товара', 'Себестоимость за ед., ₽ (без НДС)'
  ]]).setFontWeight('bold').setBackground('#efefef');
  sh.setFrozenRows(1);
  sh.setColumnWidth(1, 120);
  sh.setColumnWidth(2, 180);
  sh.setColumnWidth(3, 200);
  sh.setColumnWidth(4, 220);
  sh.getRange('D:D').setNumberFormat('#,##0.00');
  sh.getRange('A:A').setNumberFormat('@');
  return sh;
}

/** { "12345678": 350.5, ... } — только ячейки с числом. */
function SkuCalc_readCosts_() {
  const sh = SkuCalc_ensureCostSheet_();
  const out = {};
  if (sh.getLastRow() < 2) return out;
  sh.getRange(2, 1, sh.getLastRow() - 1, 4).getValues().forEach(r => {
    const sku = String(r[0]).trim();
    if (sku && typeof r[3] === 'number') out[sku] = r[3];
  });
  return out;
}

function SkuCalc_appendNewSkusToCost_(bySku, costs) {
  const sh = SkuCalc_ensureCostSheet_();
  const existing = new Set();
  if (sh.getLastRow() >= 2) {
    sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues()
      .forEach(r => existing.add(String(r[0]).trim()));
  }
  const add = Object.keys(bySku)
    .filter(s => s !== '' && !existing.has(s))
    .map(s => [s, bySku[s].article || '', bySku[s].category || '', '']);
  if (add.length) {
    sh.getRange(sh.getLastRow() + 1, 1, add.length, 4).setValues(add);
  }
}

/* =================== ЗАПИСЬ ЛИСТА =================== */

function SkuCalc_ensureSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(SKUCALC_SHEET);
  if (sh) return sh;
  const calc = ss.getSheetByName(SHEET_CALC);
  sh = ss.insertSheet(SKUCALC_SHEET, calc ? calc.getIndex() : ss.getNumSheets());
  SkuCalc_initHeader_(sh);
  return sh;
}

/**
 * Шапка (строки 1–5) = ссылки на Calculation. Период задаётся там же
 * (Calculation!E2:G2 или фильтр Web App), здесь только отображается.
 */
function SkuCalc_initHeader_(sh) {
  const calc = SpreadsheetApp.getActive().getSheetByName(SHEET_CALC);
  const cells = ['A1', 'A2', 'C2', 'D2', 'E2', 'F2', 'G2', 'A3',
    'A4', 'C4', 'D4', 'E4', 'F4', 'G4', 'E5'];
  cells.forEach(a1 => {
    sh.getRange(a1).setFormula(`=IF(ISBLANK(${SHEET_CALC}!${a1}),"",${SHEET_CALC}!${a1})`);
  });
  if (calc) {
    calc.getRange('A1:M5').copyFormatToRange(sh, 1, 13, 1, 5);
  }
  sh.getRangeList(['E2', 'G2', 'E4', 'G4', 'C4']).setNumberFormat('dd.MM.yyyy');
}

function SkuCalc_writeSheet_(res) {
  const sh = SkuCalc_ensureSheet_();
  if (sh.getRange('A1').getFormula() === '') SkuCalc_initHeader_(sh);

  // Чистим всё ниже шапки
  const maxRows = sh.getMaxRows();
  if (maxRows >= SKUCALC_HEADER_ROW) {
    sh.getRange(SKUCALC_HEADER_ROW, 1, maxRows - SKUCALC_HEADER_ROW + 1, Math.max(13, sh.getMaxColumns()))
      .clear();
  }

  const W = SKUCALC_HEADERS.length;
  sh.getRange(SKUCALC_HEADER_ROW, 1, 1, W).setValues([SKUCALC_HEADERS])
    .setFontWeight('bold').setBackground('#efefef').setHorizontalAlignment('center');

  const line = (num, r, xyz, abc) => [
    num, r.sku, r.category, r.revenue, r.logistics, r.logisticsPct, r.expenses,
    r.cogs, r.mg, r.margin, r.share, xyz, abc
  ];
  const matrix = res.rows.map(r => line(r.num, r, r.xyz, r.abc));
  const extraRows = [];
  if (res.noSku) extraRows.push(line('', Object.assign({}, res.noSku, { sku: SKUCALC_NO_SKU_LABEL, category: '' }), '', ''));
  extraRows.push(line('', Object.assign({}, res.total, { sku: 'Итого', category: '' }), '', ''));
  const all = matrix.concat(extraRows);

  const start = SKUCALC_HEADER_ROW + 1;
  if (sh.getMaxRows() < start + all.length) {
    sh.insertRowsAfter(sh.getMaxRows(), start + all.length - sh.getMaxRows());
  }
  sh.getRange(start, 2, all.length, 1).setNumberFormat('@'); // SKU — текстом
  sh.getRange(start, 1, all.length, W).setValues(all);

  // Форматы
  const n = all.length;
  ['D', 'E', 'G', 'H', 'I'].forEach(c => sh.getRange(`${c}${start}:${c}${start + n - 1}`).setNumberFormat('#,##0.00'));
  ['F', 'J', 'K'].forEach(c => sh.getRange(`${c}${start}:${c}${start + n - 1}`).setNumberFormat('0.0%'));
  sh.getRange(`A${start}:A${start + n - 1}`).setHorizontalAlignment('center').setFontColor('#737272');
  sh.getRange(`L${start}:M${start + n - 1}`).setHorizontalAlignment('center').setFontWeight('bold');

  // Цвета ABC / XYZ и подсветка SKU без себестоимости
  if (matrix.length) {
    const ABC_BG = { A: '#e6f4ea', B: '#fff4d6', C: '#fde8e1' };
    const XYZ_BG = { X: '#e6f4ea', Y: '#fff4d6', Z: '#fde8e1' };
    sh.getRange(start, 12, matrix.length, 2).setBackgrounds(
      res.rows.map(r => [XYZ_BG[r.xyz] || null, ABC_BG[r.abc] || null])
    );
    sh.getRange(start, 8, matrix.length, 1).setBackgrounds(
      res.rows.map(r => [r.hasCost ? null : '#fff5f1'])
    );
  }
  // Служебные строки
  const firstExtra = start + matrix.length;
  sh.getRange(firstExtra, 1, extraRows.length, W).setFontWeight('bold').setBackground('#f3f3f3');
  sh.getRange(firstExtra + extraRows.length - 1, 1, 1, W).setBackground('#fff8f5');

  // Пояснение под таблицей
  const note = start + n + 1;
  sh.getRange(note, 2).setValue(
    `Период: ${res.period.from} — ${res.period.to}. Пересчитано: ${res.builtAt}. ` +
    `Себестоимость — лист ${SKUCALC_COST_SHEET}` +
    (res.missingCost ? ` (не заполнена для ${res.missingCost} SKU — выделены цветом).` : '.') +
    ` ABC — по выручке (A ≤ ${SKUCALC_ABC_A * 100}%, B ≤ ${SKUCALC_ABC_B * 100}%).` +
    ` XYZ — вариация недельных продаж, шт. (X ≤ ${SKUCALC_XYZ_X * 100}%, Y ≤ ${SKUCALC_XYZ_Y * 100}%, «—» если < ${SKUCALC_XYZ_MIN_WEEKS} полных недель).`
  ).setFontColor('#737272').setFontStyle('italic');

  sh.setFrozenRows(SKUCALC_HEADER_ROW);
  sh.setFrozenColumns(2);
  sh.setColumnWidth(1, 45);
  sh.setColumnWidth(2, 190);
  sh.setColumnWidth(3, 200);
  for (let c = 4; c <= 11; c++) sh.setColumnWidth(c, 110);
  sh.setColumnWidth(12, 55);
  sh.setColumnWidth(13, 55);
}

/* =================== КЭШ =================== */

/**
 * Подпись состояния: период + версия данных Data_wb + себестоимость.
 * Если подпись не изменилась — пересчитывать нечего.
 */
function SkuCalc_signature_() {
  const p = SkuCalc_period_();
  const ss = SpreadsheetApp.getActive();
  const data = ss.getSheetByName(SHEET_DATA);
  const cost = ss.getSheetByName(SKUCALC_COST_SHEET);
  const ver = PropertiesService.getScriptProperties().getProperty('WB_DATA_VERSION') || '0';
  let costDigest = '';
  if (cost && cost.getLastRow() > 1) {
    const vals = cost.getRange(2, 1, cost.getLastRow() - 1, 4).getValues()
      .map(r => r[0] + ':' + r[3]).join('|');
    costDigest = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, vals));
  }
  return [p.fromKey, p.toKey, data ? data.getLastRow() : 0, ver, costDigest].join('#');
}

function SkuCalc_cachePut_(sig, obj) {
  SkuCalc_cachePutJson_(SKUCALC_CACHE_PREFIX, sig, obj);
}

function SkuCalc_cacheGet_(sig) {
  return SkuCalc_cacheGetJson_(SKUCALC_CACHE_PREFIX, sig);
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
