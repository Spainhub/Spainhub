/**********************************************************************
 * 12_Web_App.gs — ОБЩИЕ ВЫЗОВЫ WEB APP (инициализация, период, права)
 *
 * Web App (Index.html) содержит 5 вкладок = 5 листов таблицы:
 *   1 ПАРАМЕТРЫ  (13_Web_Params.gs)    4 UNIT     (16_Web_Unit.gs)
 *   2 P&L ОТЧЕТ  (14_Web_Pnl.gs)       5 СПРАВКА  (17_Web_Ref.gs)
 *   3 ТОВАРЫ     (15_Web_Goods.gs)
 * Каждая вкладка при каждом обновлении перечитывает свой лист «как есть»
 * (значения ваших формул) — изменили ячейку в таблице, и через несколько
 * секунд то же значение в приложении. Изменения из приложения (параметры,
 * артикул UNIT, номер отчёта СПРАВКИ, период) записываются в лист.
 **********************************************************************/

/** Начальные данные страницы: вкладки (названия = имена листов), шапка отчёта, статус данных. */
function App_getInit() {
  const ss = SpreadsheetApp.getActive();
  return {
    tabs: WEB_TABS.map(t => ({ id: t.id, title: t.sheet, exists: !!ss.getSheetByName(t.sheet) })),
    header: Pnl_header_(),
    status: Gap_getStatus(),
    chart: { minPointsHeader: CHART_MIN_POINTS_HEADER, minPointsLeaf: CHART_MIN_POINTS_LEAF }
  };
}

/** Только шапка (после смены периода). */
function App_getHeader() {
  return Pnl_header_();
}

/**
 * Фильтр периода из Web App → ячейки E2/G2 листов P&L ОТЧЕТ, ТОВАРЫ, UNIT.
 * from/to — "дд.мм.гггг"; пустая строка очищает фильтр (период по умолчанию).
 */
function App_applyPeriod(from, to) {
  Web_assertCanWrite_();
  App_setPeriod_(App_dateCell_(from), App_dateCell_(to));
  SpreadsheetApp.flush();
  return Pnl_header_();
}

function App_resetPeriod() {
  Web_assertCanWrite_();
  App_setPeriod_('', '');
  SpreadsheetApp.flush();
  return Pnl_header_();
}

function App_setPeriod_(from, to) {
  const ss = SpreadsheetApp.getActive();
  PERIOD_SHEETS.forEach(name => {
    const sh = ss.getSheetByName(name);
    if (!sh) return;
    sh.getRange(PERIOD_FROM_CELL).setValue(from);
    sh.getRange(PERIOD_TO_CELL).setValue(to);
  });
}

/** "дд.мм.гггг" → Date (полночь в часовом поясе таблицы, как при вводе руками); иначе ''. */
function App_dateCell_(s) {
  const key = cellDateKey_(String(s === null || s === undefined ? '' : s));
  if (!key) return '';
  return Utilities.parseDate(key, SpreadsheetApp.getActive().getSpreadsheetTimeZone(), 'yyyy-MM-dd');
}

/**
 * Запись из Web App разрешена всем, у кого есть доступ к приложению, пока
 * WEB_REQUIRE_EDITOR = false (00_Config.gs). При true — только редакторам таблицы.
 */
function Web_assertCanWrite_() {
  if (!WEB_REQUIRE_EDITOR) return;
  let email = '';
  try { email = Session.getActiveUser().getEmail(); } catch (e) { email = ''; }
  const ss = SpreadsheetApp.getActive();
  const allowed = ss.getEditors().map(u => u.getEmail());
  const owner = ss.getOwner();
  if (owner) allowed.push(owner.getEmail());
  if (!email || allowed.indexOf(email) < 0) {
    throw new Error('Нет прав на изменение таблицы: запись разрешена только редакторам.');
  }
}

/** Лист вкладки или понятная ошибка. */
function Web_sheet_(name) {
  const sh = SpreadsheetApp.getActive().getSheetByName(name);
  if (!sh) throw new Error(`Лист ${name} не найден. Меню «Отчёты МП» → «Листы» → «Создать недостающие листы».`);
  return sh;
}
