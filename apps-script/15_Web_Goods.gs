/**********************************************************************
 * 15_Web_Goods.gs — ЛИСТ ТОВАРЫ → вкладка 3 Web App
 *
 * РАСЧЁТЫ НА ЛИСТЕ ВЫ ДЕЛАЕТЕ САМИ (свои формулы, в т.ч. по листу COGS).
 * Скрипт:
 *  - один раз создаёт лист и шапку (строки 1–6) — меню «Отчёты МП» →
 *    «Листы» → «Создать шапку листа ТОВАРЫ»;
 *  - НИЧЕГО не пишет в таблицу с A7 и не ссылается на лист P&L ОТЧЕТ;
 *  - читает лист «как есть» (значения ваших формул) и отдаёт в Web App.
 *
 * Шапка — та же, что у P&L ОТЧЕТ, но это значения и формулы ЭТОГО листа:
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
 * «Категория» — текст, остальное — деньги. Колонка с пустым заголовком или
 * «-» не показывается.
 * Строки с числом в колонке «№» — товары; строки без номера, но с текстом
 * (например, «Итого») — выводятся итоговыми внизу.
 *
 * Для графика при наведении на строку скрипт дополнительно берёт продажи
 * артикула по неделям из DATA_WB (Продажа − Возвраты) за период $G$4…$E$4
 * этого листа. В таблицу это не пишется.
 *
 * ВАЖНО: все имена в этом файле имеют префикс Goods_.
 **********************************************************************/

/** Пункт меню: создать лист (или пересоздать шапку — строки 1–6). */
function Goods_setupSheet() {
  const ss = SpreadsheetApp.getActive();
  const ui = SpreadsheetApp.getUi();
  let sh = ss.getSheetByName(SHEET_GOODS);
  if (sh) {
    const res = ui.alert('ТОВАРЫ',
      'Лист уже есть. Пересоздать шапку (строки 1–6)?\nВаши формулы с 7-й строки не изменятся.',
      ui.ButtonSet.YES_NO);
    if (res !== ui.Button.YES) return;
  } else {
    const calc = ss.getSheetByName(SHEET_PNL);
    sh = ss.insertSheet(SHEET_GOODS, calc ? calc.getIndex() : ss.getNumSheets());
  }
  Goods_initHeader_(sh);
  ss.setActiveSheet(sh);
  ui.alert('ТОВАРЫ', 'Шапка готова. Заполняйте таблицу своими формулами с A7.', ui.ButtonSet.OK);
}

/**
 * Шапка: тексты как у P&L ОТЧЕТ (значениями), фильтр E2/G2 и свои
 * формулы периода. Строки 7+ не трогаются.
 */
function Goods_initHeader_(sh) {
  const ss = SpreadsheetApp.getActive();
  const calc = ss.getSheetByName(SHEET_PNL);
  const val = (a1, def) => {
    const v = calc ? calc.getRange(a1).getValue() : '';
    return v === '' || v === null ? def : v;
  };

  sh.getRange(1, 1, GOODS_HEADER_ROW - 1, GOODS_HEADERS.length).clearContent();
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

  sh.getRange(GOODS_HEADER_ROW, 1, 1, GOODS_HEADERS.length).setValues([GOODS_HEADERS])
    .setFontWeight('bold').setBackground('#efefef').setHorizontalAlignment('center');
  sh.setFrozenRows(GOODS_HEADER_ROW);
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

/**
 * Тип колонки по её заголовку (строка 6 листа) — от него зависит формат
 * в Web App. Названия можно менять: распознаются по ключевым словам.
 */
function Goods_colType_(title) {
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
 * лист заново — изменили ячейку/формулу в ТОВАРЫ, и при
 * следующем обновлении вкладки (автоматически раз в ~40 с, кнопка
 * «Обновить») значение изменится и в приложении.
 * Колонки берутся из заголовков строки 6, значения — как в листе.
 */
function Goods_getReportData() {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(SHEET_GOODS);
  if (!sh) {
    throw new Error('Лист ТОВАРЫ не найден. Меню «Отчёты МП» → «Wildberries — P&L» → «Создать лист ТОВАРЫ (шапка)».');
  }

  const lastCol = Math.max(sh.getLastColumn(), 1);
  const headerVals = sh.getRange(GOODS_HEADER_ROW, 1, 1, lastCol).getValues()[0];
  let n = lastCol;
  while (n > 0 && String(headerVals[n - 1]).trim() === '') n--;

  const columns = [];
  for (let i = 0; i < n; i++) {
    const title = String(headerVals[i]).trim();
    if (isDashHeader_(title)) continue; // пусто или «-» — колонку не показываем
    columns.push({ i: i, title: title, type: Goods_colType_(title) });
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
  if (last >= GOODS_FIRST_ROW && columns.length) {
    const cnt = last - GOODS_FIRST_ROW + 1;
    const values = sh.getRange(GOODS_FIRST_ROW, 1, cnt, n).getValues();
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

  const period = Goods_sheetPeriod_(sh);
  const weekly = Goods_weekly_(period);
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
    header: Pnl_header_(),
    columns: columns.map(c => ({ title: c.title, type: c.type })),
    period: {
      from: Util_keyToRu_(period.fromKey),
      to: Util_keyToRu_(period.toKey),
      days: weekly.days,
      fullWeeks: Math.floor(weekly.days / 7)
    },
    weeks: weekly.weeks,
    rows: rows,
    service: service
  };
}

/** Период листа ТОВАРЫ: [min(E4,G4); max(E4,G4)], иначе — как у P&L ОТЧЕТ. */
function Goods_sheetPeriod_(sh) {
  const tz = SpreadsheetApp.getActive().getSpreadsheetTimeZone();
  const toKey = v => (v instanceof Date) ? Utilities.formatDate(v, tz, 'yyyy-MM-dd') : '';
  const a = toKey(sh.getRange('E4').getValue());
  const b = toKey(sh.getRange('G4').getValue());
  if (!a || !b) return Pnl_period_();
  return a <= b ? { fromKey: a, toKey: b } : { fromKey: b, toKey: a };
}

/**
 * Продажи по неделям из DATA_WB (Продажа − Возвраты, колонка V) — только
 * для графика при наведении. Кэш — до изменения данных или периода.
 */
function Goods_weekly_(period) {
  const days = Util_daysBetween_(period.fromKey, period.toKey) + 1;
  const weeksCount = Math.max(1, Math.ceil(days / 7));
  const data = SpreadsheetApp.getActive().getSheetByName(SHEET_DATA);
  const ver = PropertiesService.getScriptProperties().getProperty('WB_DATA_VERSION') || '0';
  const sig = [period.fromKey, period.toKey, data ? data.getLastRow() : 0, ver].join('#');

  const cached = Util_cacheGetJson_(GOODS_CACHE_PREFIX, sig);
  if (cached) return cached;

  const weeks = [];
  for (let w = 0; w < weeksCount; w++) {
    weeks.push(Util_keyToRu_(Util_addDaysKey_(period.fromKey, w * 7)));
  }
  const res = { days: days, weeks: weeks, bySku: {}, total: new Array(weeksCount).fill(0) };

  const d = Wb_readColumns_();
  if (d) {
    const dayIdx = {};
    for (let i = 0; i < d.n; i++) {
      const k = d.dayKey(i);
      if (!k || k < period.fromKey || k > period.toKey) continue;
      const op = String(d.oper[i] || '').trim();
      const sign = op === OPER_SALE ? 1 : (op === OPER_RETURN ? -1 : 0);
      if (!sign) continue;
      let di = dayIdx[k];
      if (di === undefined) di = dayIdx[k] = Util_daysBetween_(period.fromKey, k);
      const w = Math.floor(di / 7);
      const amt = sign * Util_num_(d.amount[i]);
      res.total[w] += amt;

      let sku = d.sku ? String(d.sku[i] === null ? '' : d.sku[i]).trim() : '';
      if (!sku || sku === '0') continue;
      const rec = res.bySku[sku] || (res.bySku[sku] = { rev: new Array(weeksCount).fill(0), article: '' });
      rec.rev[w] += amt;
      if (!rec.article && d.article && d.article[i]) rec.article = String(d.article[i]);
    }
  }
  res.total = res.total.map(Util_r2_);
  Object.keys(res.bySku).forEach(s => { res.bySku[s].rev = res.bySku[s].rev.map(Util_r2_); });

  Util_cachePutJson_(GOODS_CACHE_PREFIX, sig, res);
  return res;
}
