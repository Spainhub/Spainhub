/**********************************************************************
 * 16_Web_Unit.gs — ЛИСТ UNIT → вкладка 4 Web App
 *
 * Лист устроен как P&L ОТЧЕТ: шапка в строках 1–4, артикул в C5
 * (выпадающий список — по нему фильтруются все формулы листа), заголовки
 * таблицы в строке 6 (№ | Данные за период | ИТОГО | Доля % | даты E:CR),
 * данные с 7-й строки. Формулы на листе уже готовы — скрипт их НЕ пишет:
 *  - Unit_setSku(sku) пишет выбранный артикул в C5 (лист пересчитывается);
 *  - Unit_getReportData() читает лист «как есть» (значения формул).
 *
 * Нумерация строк в колонке A (1, 1.1, 2, 2.1, 2.1.1 …) задаёт иерархию:
 * строки с подстроками сворачиваются в Web App (как в P&L ОТЧЕТ).
 * Колонки E:CR — дни. Колонка, у которой вместо даты в строке 6 стоит
 * прочерк «-» (или любой не-дата), в Web App не показывается.
 * График при наведении строится в браузере из самих значений строки
 * (дневной ряд берётся из листа, отдельных запросов не нужно).
 *
 * ВАЖНО: все имена в этом файле имеют префикс Unit_.
 **********************************************************************/

/* =================== ВЫЗОВЫ ДЛЯ WEB APP =================== */

/** Выбор артикула в выпадающем списке Web App → C5 → пересчёт листа. */
function Unit_setSku(sku) {
  Web_assertCanWrite_();
  const sh = Unit_sheet_();
  const raw = String(sku === null || sku === undefined ? '' : sku).trim();
  if (!raw) throw new Error('Артикул не выбран.');
  const cell = sh.getRange(UNIT_SKU_CELL);
  cell.setValue(/^\d+$/.test(raw) ? Number(raw) : raw);
  SpreadsheetApp.flush();
  return Unit_getReportData();
}

/** Данные вкладки «UNIT». Каждый вызов читает лист заново. */
function Unit_getReportData() {
  const sh = Unit_sheet_();
  const lastRow = sh.getLastRow();
  const lastCol = Math.min(Math.max(sh.getLastColumn(), UNIT_FIRST_COL), UNIT_LAST_COL);
  const tz = SpreadsheetApp.getActive().getSpreadsheetTimeZone();

  // Колонки-даты E:CR: где в строке 6 вместо даты прочерк — колонку пропускаем.
  const headers = sh.getRange(UNIT_HEADER_ROW, UNIT_FIRST_COL, 1, lastCol - UNIT_FIRST_COL + 1).getValues()[0];
  const periods = [];
  const keep = [];                       // индексы внутри E:CR
  headers.forEach((h, i) => {
    const key = Unit_dateKey_(h);
    if (!key) return;
    keep.push(i);
    periods.push({ label: Util_keyToRu_(key), key: key });
  });

  const rows = [];
  if (lastRow > UNIT_HEADER_ROW) {
    const cnt = lastRow - UNIT_HEADER_ROW;
    const values = sh.getRange(UNIT_HEADER_ROW + 1, 1, cnt, lastCol).getValues();
    const dispA = sh.getRange(UNIT_HEADER_ROW + 1, 1, cnt, 1).getDisplayValues();
    values.forEach((r, k) => {
      const name = String(r[1] === null ? '' : r[1]).trim();
      if (name === '') return;
      rows.push({
        num: Util_numFromCell_(r[0], dispA[k][0], tz),   // «1», «1.1», «2.1.1» …
        name: name,
        isPercent: /%/.test(name),
        sum: fmtCell(r[2]),
        share: fmtCell(r[3]),
        values: keep.map(i => fmtCell(r[UNIT_FIRST_COL - 1 + i]))
      });
    });
    Util_hierAnnotate_(rows);            // level / parent / hasChildren по нумерации
  }

  const g = a1 => String(sh.getRange(a1).getValue() === null ? '' : sh.getRange(a1).getValue());
  const sku = Unit_skuString_(sh.getRange(UNIT_SKU_CELL).getValue());
  const skus = Unit_skuList_(sh);
  if (sku && !skus.some(s => s.id === sku)) skus.unshift({ id: sku, label: sku });

  return {
    header: {
      title: g('A1'),
      subtitle: g('A2'),
      periodFrom: fmtCell(sh.getRange('E4').getValue()),
      periodTo: fmtCell(sh.getRange('G4').getValue())
    },
    sku: sku,
    article: g(UNIT_ARTICLE_CELL),
    category: g(UNIT_CATEGORY_CELL),
    skus: skus,
    periods: periods,
    rows: rows
  };
}

/* =================== ВНУТРЕННЕЕ =================== */

function Unit_sheet_() {
  return Web_sheet_(SHEET_UNIT);
}

function Unit_skuString_(v) {
  if (v === null || v === undefined || v === '') return '';
  return typeof v === 'number' ? String(Math.round(v)) : String(v).trim();
}

/** Дата заголовка (Date или «дд.мм.гггг» с необязательной подписью после переноса) → "yyyy-MM-dd"; прочерк/текст → ''. */
function Unit_dateKey_(v) {
  if (v instanceof Date) return cellDateKey_(v);
  return cellDateKey_(String(v).split('\n')[0]);
}

/**
 * Список артикулов для выпадающего списка: правило проверки данных ячейки C5
 * (диапазон или список значений). Если правила нет — артикулы из листа
 * ТОВАРЫ, затем из DATA_WB. Подписи «артикул · артикул продавца» —
 * из ТОВАРЫ, если он есть.
 */
function Unit_skuList_(sh) {
  let ids = [];
  const rule = sh.getRange(UNIT_SKU_CELL).getDataValidation();
  if (rule) {
    const type = rule.getCriteriaType();
    const vals = rule.getCriteriaValues();
    if (type === SpreadsheetApp.DataValidationCriteria.VALUE_IN_RANGE && vals[0]) {
      ids = vals[0].getValues().map(r => r[0]);
    } else if (type === SpreadsheetApp.DataValidationCriteria.VALUE_IN_LIST && vals[0]) {
      ids = vals[0];
    }
  }
  const names = Unit_skuNames_();
  if (!ids.length) ids = Object.keys(names);
  if (!ids.length) {
    const d = Wb_readColumns_();
    if (d && d.sku) {
      const seen = {};
      d.sku.forEach(v => { const s = Unit_skuString_(v); if (s && s !== '0') seen[s] = 1; });
      ids = Object.keys(seen);
    }
  }
  const out = [], used = {};
  ids.forEach(v => {
    const id = Unit_skuString_(v);
    if (!id || used[id]) return;
    used[id] = 1;
    out.push({ id: id, label: names[id] ? `${id} · ${names[id]}` : id });
  });
  return out;
}

/** { nmId: артикул продавца } из ТОВАРЫ (колонки определяются по заголовкам строки 6). */
function Unit_skuNames_() {
  const res = {};
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_GOODS);
  if (!sh || sh.getLastRow() < GOODS_FIRST_ROW) return res;
  const lastCol = Math.max(sh.getLastColumn(), 1);
  const heads = sh.getRange(GOODS_HEADER_ROW, 1, 1, lastCol).getValues()[0].map(h => Goods_colType_(String(h).trim()));
  const iId = heads.indexOf('id'), iArt = heads.indexOf('art');
  if (iId < 0 || iArt < 0) return res;
  sh.getRange(GOODS_FIRST_ROW, 1, sh.getLastRow() - GOODS_FIRST_ROW + 1, lastCol).getValues().forEach(r => {
    const id = Unit_skuString_(r[iId]);
    if (id) res[id] = String(r[iArt] === null ? '' : r[iArt]).trim();
  });
  return res;
}
