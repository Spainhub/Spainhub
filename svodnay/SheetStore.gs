/**
 * SheetStore.gs — работа с листами: служебные кэши (key | json) и итоговый лист.
 * Кэши нужны, чтобы данные переживали паузы между запусками (лимит ~6 минут на выполнение).
 */
function ozonSpreadsheet_() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

function ozonGetOrCreateSheet_(name, hidden) {
  const ss = ozonSpreadsheet_();
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  if (hidden && !sheet.isSheetHidden()) sheet.hideSheet();
  return sheet;
}

/** Очистка всех кэшей перед новым полным запуском (журнал запусков не трогаем). */
function ozonResetCache_() {
  Object.keys(OZON_CONFIG.cacheSheets).forEach((key) => {
    if (key === 'runs') return;
    ozonGetOrCreateSheet_(OZON_CONFIG.cacheSheets[key], true).clearContents();
  });
}

function ozonDeleteTemporarySheets_() {
  const ss = ozonSpreadsheet_();
  Object.keys(OZON_CONFIG.cacheSheets).forEach((key) => {
    const sheet = ss.getSheetByName(OZON_CONFIG.cacheSheets[key]);
    if (!sheet || ss.getSheets().length <= 1) return;
    ss.deleteSheet(sheet);
  });
}

/** Записать кэш с нуля (заменяет всё содержимое). */
function ozonWriteObjects_(sheetName, keyField, items) {
  const sheet = ozonGetOrCreateSheet_(sheetName, true);
  sheet.clearContents();
  sheet.getRange(1, 1, 1, 2).setValues([['key', 'json']]);
  if (!items || !items.length) return;
  const rows = items.map((item) => [String(item[keyField]), JSON.stringify(item)]);
  sheet.getRange(2, 1, rows.length, 2).setValues(rows);
}

/** Дописать объекты в конец кэша. Ячейка Google Sheets вмещает до 50 000 символов, поэтому объекты сужаются заранее. */
function ozonAppendObjects_(sheetName, keyField, items) {
  if (!items || !items.length) return;
  const sheet = ozonGetOrCreateSheet_(sheetName, true);
  if (sheet.getLastRow() === 0) sheet.getRange(1, 1, 1, 2).setValues([['key', 'json']]);
  const rows = items.map((item) => [String(item[keyField]), JSON.stringify(item)]);
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, 2).setValues(rows);
}

/** Только ключи (колонка A) — дешевле, чем разбирать JSON. */
function ozonReadKeys_(sheetName) {
  const sheet = ozonGetOrCreateSheet_(sheetName, true);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet.getRange(2, 1, lastRow - 1, 1).getValues().map((r) => String(r[0])).filter(Boolean);
}

/** Кэш как словарь {key: объект}. */
function ozonReadObjectMap_(sheetName) {
  const sheet = ozonGetOrCreateSheet_(sheetName, true);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return {};
  const result = {};
  sheet.getRange(2, 1, lastRow - 1, 2).getValues().forEach((row) => {
    if (!row[0] || !row[1]) return;
    result[String(row[0])] = JSON.parse(row[1]);
  });
  return result;
}

/** Кэш как массив объектов. */
function ozonReadObjects_(sheetName) {
  const sheet = ozonGetOrCreateSheet_(sheetName, true);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];
  return sheet.getRange(2, 2, lastRow - 1, 1).getValues()
    .map((row) => (row[0] ? JSON.parse(row[0]) : null))
    .filter(Boolean);
}

/**
 * Запись итоговой таблицы на лист: старое содержимое полностью заменяется (дубликатов нет).
 * Колонки «Артикул продавца» и «sku» принудительно текстовые, чтобы не терять ведущие нули
 * и чтобы ВПР/ПОИСКПОЗ по артикулу работали предсказуемо.
 */
function ozonWriteFinalValues_(values) {
  if (!values || !values.length) return;
  const sheet = ozonGetOrCreateSheet_(ozonGetOutputSheetName_(), false);
  sheet.clearContents();
  sheet.getRange(1, 2, values.length, 2).setNumberFormat('@');
  sheet.getRange(1, 1, values.length, values[0].length).setValues(values);
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, values[0].length);
}

/** Журнал шагов запуска (временный лист, удаляется после успешного завершения). */
function ozonLogRun_(state) {
  const sheet = ozonGetOrCreateSheet_(OZON_CONFIG.cacheSheets.runs, true);
  if (sheet.getLastRow() === 0) sheet.appendRow(['updatedAt', 'runId', 'phase', 'status', 'lastError']);
  sheet.appendRow([state.updatedAt, state.runId, state.phase, state.status, state.lastError || '']);
}

function ozonWriteFinalRowsCache_(values) {
  const sheet = ozonGetOrCreateSheet_(OZON_CONFIG.cacheSheets.finalRows, true);
  sheet.clearContents();
  if (!values.length) return;
  sheet.getRange(1, 2, values.length, 2).setNumberFormat('@');
  sheet.getRange(1, 1, values.length, values[0].length).setValues(values);
}

function ozonReadFinalRowsCache_() {
  const sheet = ozonGetOrCreateSheet_(OZON_CONFIG.cacheSheets.finalRows, true);
  const lastRow = sheet.getLastRow();
  const lastColumn = sheet.getLastColumn();
  if (!lastRow || !lastColumn) return [];
  return sheet.getRange(1, 1, lastRow, lastColumn).getValues();
}
