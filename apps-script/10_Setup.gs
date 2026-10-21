/**********************************************************************
 * 10_Setup.gs — СТРУКТУРА ЛИСТОВ: проверка, создание недостающих, порядок
 *
 * Меню «Отчёты МП» → «Листы»:
 *  - Проверить структуру листов — какие листы из 00_Config.gs есть/нет и
 *    базовые проверки раскладки (заголовки в строке 6, выпадающие списки);
 *  - Создать недостающие листы — только ОТСУТСТВУЮЩИЕ (существующие не
 *    трогаются); служебные листы данных (DATA_WB, LOG, DATA_CHECK, SKU_*,
 *    REPORT_*) создаются сами при первой загрузке;
 *  - Расставить листы по порядку — SHEET_ORDER (INFO … СПРАВКА).
 **********************************************************************/

/** Роли листов — для отчёта проверки и INFO. */
function Setup_roles_() {
  return [
    [SHEET_INFO, 'README проекта (создаётся скриптом: меню «Листы» → «Обновить INFO»)'],
    [SHEET_LOG, 'журнал загрузок (создаётся при первой загрузке)'],
    [SHEET_DATA_CHECK, 'контроль полноты DATA_WB (создаётся при проверке)'],
    [SHEET_SKU_WB, 'товары Wildberries (меню «Дополнительно»)'],
    [SHEET_SKU_OZ, 'товары Ozon (меню «Дополнительно»)'],
    [SHEET_COGS, 'себестоимость (заполняет пользователь)'],
    [SHEET_REPORT_OZ, 'данные Ozon: финансовый отчёт (меню Ozon)'],
    [SHEET_DATA, 'данные Wildberries (меню Wildberries)'],
    [SHEET_PARAMS, 'вкладка 1 Web App: параметры (выпадающие списки в C)'],
    [SHEET_PNL, 'вкладка 2 Web App: отчёт P&L'],
    [SHEET_GOODS, 'вкладка 3 Web App: P&L по товарам'],
    [SHEET_UNIT, 'вкладка 4 Web App: unit-экономика артикула'],
    [SHEET_REF, 'вкладка 5 Web App: справка по странам (номер отчёта в B2)']
  ];
}

/** Проверка без изменений. Возвращает { rows: [{name, role, exists}], issues: [текст] }. */
function Setup_inspect_() {
  const ss = SpreadsheetApp.getActive();
  const get = n => ss.getSheetByName(n);
  const issues = [];
  const rows = Setup_roles_().map(r => ({ name: r[0], role: r[1], exists: !!get(r[0]) }));
  rows.filter(r => !r.exists).forEach(r => issues.push(`Нет листа «${r.name}».`));

  const hdr = (sh, row, cols) => sh.getRange(row, 1, 1, cols).getDisplayValues()[0].map(s => String(s).trim());
  const low = s => String(s).toLowerCase();

  let sh = get(SHEET_PARAMS);
  if (sh) {
    const h = hdr(sh, PARAMS_HEADER_ROW, 3);
    if (low(h[1]) !== 'параметры' || !h[2]) issues.push(`«${SHEET_PARAMS}»: в A6:C6 ожидаются заголовки «№ | Параметры | Выбор и ввод данных».`);
    const rules = sh.getRange(PARAMS_FIRST_ROW, PARAMS_VALUE_COL, Math.max(1, sh.getMaxRows() - PARAMS_FIRST_ROW + 1), 1).getDataValidations();
    if (!rules.some(r => r[0])) issues.push(`«${SHEET_PARAMS}»: в колонке C нет выпадающих списков (проверка данных) — в приложении будут поля ввода.`);
  }
  sh = get(SHEET_PNL);
  if (sh) {
    const h = hdr(sh, PNL_HEADER_ROW, Math.max(sh.getLastColumn(), 5));
    if (!h.slice(PNL_FIRST_PERIOD_COL - 1).some(x => cellDateKey_(x))) issues.push(`«${SHEET_PNL}»: в строке 6 (с колонки E) нет дат периодов.`);
  }
  sh = get(SHEET_GOODS);
  if (sh && !hdr(sh, GOODS_HEADER_ROW, 3).some(x => x)) issues.push(`«${SHEET_GOODS}»: пустые заголовки в строке 6.`);
  sh = get(SHEET_UNIT);
  if (sh && !sh.getRange(UNIT_SKU_CELL).getDataValidation()) issues.push(`«${SHEET_UNIT}»: в ${UNIT_SKU_CELL} нет выпадающего списка артикулов (список возьмётся из «${SHEET_GOODS}»).`);
  sh = get(SHEET_REF);
  if (sh) {
    if (!sh.getRange(REF_SELECT_CELL).getDataValidation()) issues.push(`«${SHEET_REF}»: в ${REF_SELECT_CELL} нет выпадающего списка номеров отчёта.`);
    if (!hdr(sh, REF_HEADER_ROW, 4).slice(2).some(x => x)) issues.push(`«${SHEET_REF}»: в строке 6 нет заголовков колонок (Итого, страны…).`);
  }
  sh = get(SHEET_DATA);
  if (sh && sh.getLastRow() > 0) {
    const h = hdr(sh, 1, Math.max(sh.getLastColumn(), 1));
    ['rrdId', 'rrDate', 'nmId'].forEach(c => { if (h.indexOf(c) < 0) issues.push(`«${SHEET_DATA}»: нет колонки ${c}.`); });
  }
  return { rows: rows, issues: issues };
}

function Setup_checkSheets() {
  const res = Setup_inspect_();
  const text = res.rows.map(r => `${r.exists ? '✓' : '✗'} ${r.name} — ${r.role}`).join('\n') +
    '\n\n' + (res.issues.length ? 'Замечания:\n' + res.issues.map(i => '• ' + i).join('\n') : 'Замечаний нет.');
  try { SpreadsheetApp.getUi().alert('Структура листов', text, SpreadsheetApp.getUi().ButtonSet.OK); }
  catch (e) { Logger.log(text); }
  return res;
}

/** Создаёт только отсутствующие листы (с шапкой-заготовкой) и расставляет порядок. */
function Setup_createMissing() {
  const ss = SpreadsheetApp.getActive();
  const templates = {};
  templates[SHEET_PARAMS] = Setup_templateParams_;
  templates[SHEET_PNL] = Setup_templatePnl_;
  templates[SHEET_GOODS] = Goods_initHeader_;
  templates[SHEET_UNIT] = Setup_templateUnit_;
  templates[SHEET_REF] = Setup_templateRef_;
  templates[SHEET_COGS] = sh => sh.getRange('A1').setValue('Себестоимость — заполняет пользователь (на неё ссылаются формулы листа ' + SHEET_GOODS + ')');
  const created = [];
  if (!ss.getSheetByName(SHEET_INFO)) { Info_build(); created.push(SHEET_INFO); }   // INFO сам создаёт лист
  Object.keys(templates).forEach(name => {
    if (ss.getSheetByName(name)) return;
    const sh = ss.insertSheet(name);
    templates[name](sh);
    created.push(name);
  });
  Setup_orderSheets_();
  const msg = created.length ? 'Созданы листы: ' + created.join(', ') + '.' : 'Все листы уже есть — ничего не создано.';
  try { SpreadsheetApp.getActive().toast(msg, 'Листы', 8); } catch (e) { Logger.log(msg); }
  return created;
}

function Setup_orderSheets() {
  Setup_orderSheets_();
  try { SpreadsheetApp.getActive().toast('Листы расставлены по порядку (00_Config.gs → SHEET_ORDER).', 'Листы', 6); } catch (e) { /* триггер */ }
}

function Setup_orderSheets_() {
  const ss = SpreadsheetApp.getActive();
  const active = ss.getActiveSheet();
  let pos = 1;
  SHEET_ORDER.forEach(name => {
    const sh = ss.getSheetByName(name);
    if (!sh) return;
    ss.setActiveSheet(sh);
    ss.moveActiveSheet(pos++);
  });
  if (active) ss.setActiveSheet(active);
}

/* ---------- заготовки новых листов (только для ОТСУТСТВУЮЩИХ листов) ---------- */

function Setup_headerStyle_(sh, row, n) {
  sh.getRange(row, 1, 1, n).setFontWeight('bold').setBackground('#efefef');
}

function Setup_templateParams_(sh) {
  sh.getRange('A1').setValue('ПАРАМЕТРЫ').setFontSize(14).setFontWeight('bold');
  sh.getRange('A2').setValue('Значения из выпадающих списков синхронизируются с вкладкой «ПАРАМЕТРЫ» Web App.');
  sh.getRange(PARAMS_HEADER_ROW, 1, 1, 3).setValues([['№', 'Параметры', 'Выбор и ввод данных']]);
  Setup_headerStyle_(sh, PARAMS_HEADER_ROW, 3);
  sh.getRange('B7').setValue('Основные параметры').setFontWeight('bold');
  sh.getRange(8, 1, 4, 3).setValues([
    [1, 'Страна', 'Беларусь'], [2, 'Система налогообложения', 'ОСНО'], [3, 'Плательщик НДС', 'Да'], [4, 'Ставка НДС', '20%']
  ]);
  const list = vals => SpreadsheetApp.newDataValidation().requireValueInList(vals, true).setAllowInvalid(false).build();
  sh.getRange('C8').setDataValidation(list(['Армения', 'Беларусь', 'Казахстан', 'Киргизия', 'Россия']));
  sh.getRange('C9').setDataValidation(list(['ОСНО', 'УСН (доходы)', 'УСН (доходы − расходы)']));
  sh.getRange('C10').setDataValidation(list(['Да', 'Нет']));
  sh.getRange('C11').setDataValidation(list(['0%', '10%', '20%']));
  sh.setColumnWidth(1, 45); sh.setColumnWidth(2, 260); sh.setColumnWidth(3, 240);
  sh.setFrozenRows(PARAMS_HEADER_ROW);
}

function Setup_templatePnl_(sh) {
  Goods_initHeader_(sh);   // та же шапка: название, продавец, фильтр периода E2/G2, E4/G4
  sh.getRange(PNL_HEADER_ROW, 1, 1, GOODS_HEADERS.length).clearContent();
  sh.getRange(PNL_HEADER_ROW, 1, 1, 4).setValues([['№', 'Наименование показателя', 'Сумма', 'Доля, %']]);
  Setup_headerStyle_(sh, PNL_HEADER_ROW, GOODS_HEADERS.length);
  sh.getRange(PNL_PARAMS_ROW, 2).setValue('Параметры');
  sh.getRange('A1').setValue('P&L REPORT Wildberries');
  sh.setFrozenColumns(2);
}

function Setup_templateUnit_(sh) {
  Goods_initHeader_(sh);
  sh.getRange(UNIT_HEADER_ROW, 1, 1, GOODS_HEADERS.length).clearContent();
  sh.getRange(UNIT_HEADER_ROW, 1, 1, 4).setValues([['№', 'Данные за период', 'ИТОГО', 'Доля, %']]);
  Setup_headerStyle_(sh, UNIT_HEADER_ROW, GOODS_HEADERS.length);
  sh.getRange('B5').setValue('Артикул WB:').setFontWeight('bold');
  sh.getRange('A1').setValue('UNIT');
}

function Setup_templateRef_(sh) {
  sh.getRange('A1').setValue('СПРАВКА').setFontSize(14).setFontWeight('bold');
  sh.getRange(REF_LABEL_CELL).setValue('Номер отчёта:').setFontWeight('bold');
  sh.getRange(REF_SELECT_CELL).setValue(1).setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(['1', '2', '3'], true).setAllowInvalid(false).build());
  sh.getRange(REF_HEADER_ROW, 1, 1, 8).setValues([['№', 'Страна:', 'Итого', 'Армения', 'Беларусь', 'Казахстан', 'Киргизия', 'Россия']]);
  Setup_headerStyle_(sh, REF_HEADER_ROW, 8);
  sh.setColumnWidth(1, 45); sh.setColumnWidth(2, 260);
  sh.setFrozenRows(REF_HEADER_ROW);
}
