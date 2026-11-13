/**********************************************************************
 * Oz Sales Report — отчёт Ozon о реализации → Google Sheets
 *
 * Два метода Ozon (гибкая загрузка):
 *  - ежедневный  POST /v1/finance/realization/by-day  (Premium Plus / Pro,
 *    данные не глубже 32 дней);
 *  - ежемесячный POST /v2/finance/realization          (базовый тариф,
 *    отчёт за месяц приходит не позднее 5-го числа следующего месяца).
 *
 * Логика:
 *  - первый запуск: сначала 3 последних месяца (месячный метод), затем
 *    попытка загрузить 30 последних дней (дневной метод). Если дневной
 *    метод вернул 403 (нет Premium) — остаются месячные данные;
 *  - автообновление раз в сутки: пробуем дневной метод (последние 3 дня);
 *    нет Premium — обновляем текущий и прошлый месяц месячным методом;
 *  - если по месяцу есть дневные строки, его месячные строки убираются
 *    (чтобы не было двойного учёта);
 *  - строки старше 3 месяцев удаляются при каждом обновлении.
 *
 * Ключи хранятся в UserProperties (видны только тому, кто их ввёл).
 **********************************************************************/

var OZ = {
  SHEET: 'Реализация Ozon',
  URL_DAY: 'https://api-seller.ozon.ru/v1/finance/realization/by-day',
  URL_MONTH: 'https://api-seller.ozon.ru/v2/finance/realization',
  INITIAL_MONTHS: 3,       // первая загрузка: месяцев (месячный метод)
  INITIAL_DAYS: 30,        // первая загрузка: дней (дневной метод)
  REFRESH_DAYS: 3,         // ежедневное обновление: дней (Premium)
  REFRESH_MONTHS: 2,       // ежедневное обновление без Premium: месяцев
  KEEP_MONTHS: 3,          // срок хранения данных
  TRIGGER_HOUR: 6,         // час запуска автообновления (время таблицы)
  PAUSE_MS: 400,           // пауза между запросами
  TYPE_DAY: 'День',
  TYPE_MONTH: 'Месяц',
  P_KEY: 'OZ_API_KEY',
  P_ID: 'OZ_CLIENT_ID',
  P_INIT: 'OZ_INITIAL_DONE',
  P_MODE: 'OZ_MODE',
  P_STATUS: 'OZ_LAST_STATUS'
};

var OZ_BLOCK = ['amount', 'bonus', 'commission', 'compensation', 'price_per_instance',
  'quantity', 'standard_fee', 'bank_coinvestment', 'stars', 'pick_up_point_coinvestment', 'total'];

/* ============================ МЕНЮ ============================ */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Отчёт Ozon')
    .addItem('Добавить API-ключ', 'addApiKey')
    .addItem('Добавить ID', 'addClientId')
    .addItem('Заменить API-ключ', 'replaceApiKey')
    .addItem('Заменить ID', 'replaceClientId')
    .addItem('Удалить ключ и ID', 'deleteCredentials')
    .addSeparator()
    .addItem('Обновить сейчас', 'updateNow')
    .addItem('Включить автообновление (раз в 24 часа)', 'enableAutoUpdate')
    .addItem('Отключить автообновление', 'disableAutoUpdate')
    .addItem('Статус', 'showStatus')
    .addToUi();
}

/* ====================== КЛЮЧ И CLIENT-ID ====================== */

function addApiKey() { setCred_(OZ.P_KEY, 'API-ключ', 'Добавить', false); }
function addClientId() { setCred_(OZ.P_ID, 'Client ID', 'Добавить', false); }
function replaceApiKey() { setCred_(OZ.P_KEY, 'API-ключ', 'Заменить', true); }
function replaceClientId() { setCred_(OZ.P_ID, 'Client ID', 'Заменить', true); }

function setCred_(prop, label, verb, replace) {
  var ui = SpreadsheetApp.getUi();
  var props = PropertiesService.getUserProperties();
  var exists = !!props.getProperty(prop);
  if (!replace && exists) {
    ui.alert(label + ' уже сохранён. Используйте пункт «Заменить».');
    return;
  }
  if (replace && !exists) {
    ui.alert(label + ' ещё не добавлен. Используйте пункт «Добавить».');
    return;
  }
  var r = ui.prompt(verb + ': ' + label, 'Введите значение из кабинета Ozon Seller (Настройки → API-ключи):', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var v = String(r.getResponseText() || '').trim();
  if (!v) { ui.alert('Пустое значение — ничего не сохранено.'); return; }
  props.setProperty(prop, v);
  ui.alert(label + ' сохранён.');
  offerInitialLoad_();
}

// Когда есть и ключ, и ID, а данных ещё не загружали — предлагаем первую загрузку.
function offerInitialLoad_() {
  var props = PropertiesService.getUserProperties();
  if (!props.getProperty(OZ.P_KEY) || !props.getProperty(OZ.P_ID)) return;
  if (props.getProperty(OZ.P_INIT)) return;
  var ui = SpreadsheetApp.getUi();
  var r = ui.alert('Ключ и ID добавлены',
    'Загрузить данные (последние ' + OZ.INITIAL_MONTHS + ' месяца, а при подписке Premium — ещё и по дням за ' +
    OZ.INITIAL_DAYS + ' дней) и включить автообновление раз в 24 часа?',
    ui.ButtonSet.YES_NO);
  if (r === ui.Button.YES) updateNow();
}

function deleteCredentials() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.alert('Удалить ключ и ID',
    'Удалить API-ключ и Client ID и отключить автообновление? Загруженные данные на листе останутся.',
    ui.ButtonSet.YES_NO);
  if (r !== ui.Button.YES) return;
  var props = PropertiesService.getUserProperties();
  props.deleteProperty(OZ.P_KEY);
  props.deleteProperty(OZ.P_ID);
  props.deleteProperty(OZ.P_INIT);
  props.deleteProperty(OZ.P_MODE);
  removeTriggers_();
  ui.alert('Ключ и ID удалены, автообновление отключено.');
}

/* ======================== АВТООБНОВЛЕНИЕ ======================== */

function enableAutoUpdate() {
  removeTriggers_();
  ScriptApp.newTrigger('scheduledUpdate').timeBased().everyDays(1).atHour(OZ.TRIGGER_HOUR).create();
  toast_('Автообновление включено: раз в 24 часа (~' + OZ.TRIGGER_HOUR + ':00).');
}

function disableAutoUpdate() {
  removeTriggers_();
  toast_('Автообновление отключено.');
}

function removeTriggers_() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'scheduledUpdate') ScriptApp.deleteTrigger(t);
  });
}

function hasTrigger_() {
  return ScriptApp.getProjectTriggers().some(function (t) { return t.getHandlerFunction() === 'scheduledUpdate'; });
}

// Вызывается триггером (без UI).
function scheduledUpdate() {
  try {
    runUpdate_();
  } catch (e) {
    saveStatus_('ОШИБКА: ' + e.message);
    console.error(e);
    throw e; // попадёт в уведомления о сбоях триггера
  }
}

// Вызывается из меню.
function updateNow() {
  var ui = SpreadsheetApp.getUi();
  try {
    toast_('Загрузка данных Ozon…');
    var msg = runUpdate_();
    if (!hasTrigger_()) enableAutoUpdate();
    ui.alert('Готово', msg, ui.ButtonSet.OK);
  } catch (e) {
    saveStatus_('ОШИБКА: ' + e.message);
    ui.alert('Ошибка', e.message, ui.ButtonSet.OK);
  }
}

function showStatus() {
  var p = PropertiesService.getUserProperties();
  SpreadsheetApp.getUi().alert('Статус',
    'API key: ' + (p.getProperty(OZ.P_KEY) ? 'есть' : 'нет') + '\n' +
    'Client ID: ' + (p.getProperty(OZ.P_ID) ? 'есть' : 'нет') + '\n' +
    'Автообновление: ' + (hasTrigger_() ? 'включено' : 'выключено') + '\n' +
    'Режим загрузки: ' + (p.getProperty(OZ.P_MODE) || '—') + '\n\n' +
    'Последнее обновление:\n' + (p.getProperty(OZ.P_STATUS) || '—'),
    SpreadsheetApp.getUi().ButtonSet.OK);
}

/* ========================= ОСНОВНОЙ ПРОЦЕСС ========================= */

function runUpdate_() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Обновление уже выполняется, повторите позже.');
  try {
    var props = PropertiesService.getUserProperties();
    var key = props.getProperty(OZ.P_KEY), id = props.getProperty(OZ.P_ID);
    if (!key || !id) throw new Error('Не заданы API-ключ и/или Client ID (меню «Отчёт Ozon»).');

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var tz = ss.getSpreadsheetTimeZone();
    var sheet = getSheet_(ss);
    var isInitial = !props.getProperty(OZ.P_INIT);
    var ctx = { id: id, key: key, tz: tz, fetched: {}, failed: [], okCalls: 0 };

    var dayStatus;
    if (isInitial) {
      loadMonths_(ctx, OZ.INITIAL_MONTHS);
      dayStatus = loadDays_(ctx, OZ.INITIAL_DAYS);
    } else {
      dayStatus = loadDays_(ctx, OZ.REFRESH_DAYS);
      if (dayStatus !== 'ok') loadMonths_(ctx, OZ.REFRESH_MONTHS);
    }
    if (ctx.okCalls === 0) throw new Error('Не удалось загрузить данные. ' + ctx.failed.join('; '));

    var mode = dayStatus === 'ok' ? 'ежедневный (Premium)' : 'ежемесячный (базовый тариф)';
    props.setProperty(OZ.P_MODE, mode);

    // Объединяем с существующими данными; загруженные периоды заменяются целиком.
    var last = sheet.getLastRow();
    var existing = last > 1 ? sheet.getRange(2, 1, last - 1, headers_().length).getValues() : [];
    var cutoff = cutoffKey_(tz);
    var cutoffMonth = cutoff.slice(0, 8) + '01';
    var expired = 0;
    var kept = existing.filter(function (r) {
      var k = keyOf_(r[0], tz);
      var isMonth = r[1] === OZ.TYPE_MONTH;
      if (!k || k < (isMonth ? cutoffMonth : cutoff)) { expired++; return false; }
      return !((r[1] + '|' + k) in ctx.fetched);
    });
    var added = [];
    Object.keys(ctx.fetched).forEach(function (pk) {
      var parts = pk.split('|');
      var isMonth = parts[0] === OZ.TYPE_MONTH;
      if (parts[1] >= (isMonth ? cutoffMonth : cutoff)) added = added.concat(ctx.fetched[pk]);
    });
    var all = kept.concat(added);

    // Если по месяцу есть дневные строки — месячные строки этого месяца убираем (без двойного учёта).
    var dayMonths = {};
    all.forEach(function (r) { if (r[1] === OZ.TYPE_DAY) dayMonths[keyOf_(r[0], tz).slice(0, 7)] = true; });
    var before = all.length;
    all = all.filter(function (r) { return !(r[1] === OZ.TYPE_MONTH && dayMonths[keyOf_(r[0], tz).slice(0, 7)]); });
    var replacedByDaily = before - all.length;

    all.sort(function (a, b) {
      var ka = keyOf_(a[0], tz), kb = keyOf_(b[0], tz);
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    writeSheet_(sheet, all);
    props.setProperty(OZ.P_INIT, '1');

    var msg = 'Режим: ' + mode + '. Новых строк: ' + added.length + ', всего на листе: ' + all.length +
      ', удалено устаревших (старше ' + OZ.KEEP_MONTHS + ' мес.): ' + expired +
      (replacedByDaily ? ', месячных строк заменено дневными: ' + replacedByDaily : '') + '.' +
      (ctx.failed.length ? '\nНе удалось: ' + ctx.failed.join('; ') : '');
    saveStatus_(Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm') + ' — ' + msg);
    return msg;
  } finally {
    lock.releaseLock();
  }
}

// Месячный (базовый) метод: текущий месяц и n-1 предыдущих. Недоступный месяц — не ошибка.
function loadMonths_(ctx, n) {
  var now = new Date();
  for (var i = n - 1; i >= 0; i--) {
    var d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    var mk = Utilities.formatDate(d, ctx.tz, 'yyyy-MM-dd');
    try {
      ctx.fetched[OZ.TYPE_MONTH + '|' + mk] = fetchMonth_(d, ctx);
      ctx.okCalls++;
    } catch (e) {
      if (e.fatal) throw e;
      ctx.failed.push('месяц ' + mk.slice(0, 7) + ': ' + e.message);
    }
    Utilities.sleep(OZ.PAUSE_MS);
  }
}

// Дневной метод (Premium). Возвращает 'ok' | 'nopremium' | 'error'.
function loadDays_(ctx, n) {
  var now = new Date(), okDays = 0;
  for (var i = n - 1; i >= 0; i--) {
    var d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    var dk = Utilities.formatDate(d, ctx.tz, 'yyyy-MM-dd');
    try {
      ctx.fetched[OZ.TYPE_DAY + '|' + dk] = fetchDay_(d, ctx);
      okDays++;
      ctx.okCalls++;
    } catch (e) {
      if (e.fatal) throw e;
      if (e.noPremium && okDays === 0) return 'nopremium';
      ctx.failed.push('день ' + dk + ': ' + e.message);
    }
    Utilities.sleep(OZ.PAUSE_MS);
  }
  return okDays > 0 ? 'ok' : 'error';
}

/* ============================ OZON API ============================ */

function post_(url, bodyObj, ctx) {
  var opts = {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Client-Id': ctx.id, 'Api-Key': ctx.key },
    payload: JSON.stringify(bodyObj),
    muteHttpExceptions: true
  };
  var resp, code, text;
  for (var attempt = 1; attempt <= 4; attempt++) {
    resp = UrlFetchApp.fetch(url, opts);
    code = resp.getResponseCode();
    text = resp.getContentText();
    if (code === 429 || code >= 500) { Utilities.sleep(1000 * attempt * attempt); continue; }
    break;
  }
  return { code: code, text: text };
}

function apiError_(res) {
  var m = res.text;
  try { m = JSON.parse(res.text).message || res.text; } catch (ignore) {}
  return new Error('HTTP ' + res.code + ' — ' + m);
}

// Дневной метод. 403 = нет подписки Premium (или неверные данные — это выяснится на месячном методе).
function fetchDay_(date, ctx) {
  var res = post_(OZ.URL_DAY, { day: date.getDate(), month: date.getMonth() + 1, year: date.getFullYear() }, ctx);
  if (res.code === 404) return [];
  if (res.code === 403) { var e403 = apiError_(res); e403.noPremium = true; throw e403; }
  if (res.code === 401) { var e401 = apiError_(res); e401.fatal = true; e401.message += '. Проверьте Client ID и API-ключ.'; throw e401; }
  if (res.code !== 200) throw apiError_(res);
  var cell = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return ((JSON.parse(res.text).rows) || []).map(function (r) { return rowToArray_(cell, OZ.TYPE_DAY, r); });
}

// Месячный метод. 401/403 = неверные данные доступа.
function fetchMonth_(date, ctx) {
  var res = post_(OZ.URL_MONTH, { month: date.getMonth() + 1, year: date.getFullYear() }, ctx);
  if (res.code === 404) return [];
  if (res.code === 401 || res.code === 403) {
    var e = apiError_(res); e.fatal = true;
    e.message += '. Проверьте Client ID и API-ключ.';
    throw e;
  }
  if (res.code !== 200) throw apiError_(res);
  var result = JSON.parse(res.text).result || {};
  var cell = new Date(date.getFullYear(), date.getMonth(), 1);
  return (result.rows || []).map(function (r) { return rowToArray_(cell, OZ.TYPE_MONTH, r); });
}

function rowToArray_(date, type, r) {
  var item = r.item || {};
  var out = [date, type, r.rowNumber, item.sku, item.offer_id, item.name, item.barcode,
    r.seller_price_per_instance, r.commission_ratio];
  [r.delivery_commission || {}, r.return_commission || {}].forEach(function (b) {
    OZ_BLOCK.forEach(function (f) { out.push(b[f] === undefined ? 0 : b[f]); });
  });
  return out;
}

/* ============================== ЛИСТ ============================== */

function headers_() {
  var h = ['Период', 'Тип', '№ строки', 'SKU', 'Артикул (offer_id)', 'Название', 'Штрихкод',
    'Цена продавца с учётом скидки', 'Доля комиссии'];
  var label = {
    amount: 'Сумма', bonus: 'Бонус', commission: 'Комиссия', compensation: 'Компенсация',
    price_per_instance: 'Цена за ед.', quantity: 'Кол-во', standard_fee: 'Станд. комиссия',
    bank_coinvestment: 'Софинанс. банка', stars: 'Баллы', pick_up_point_coinvestment: 'Софинанс. ПВЗ',
    total: 'Итого'
  };
  ['Доставка: ', 'Возврат: '].forEach(function (p) {
    OZ_BLOCK.forEach(function (f) { h.push(p + label[f]); });
  });
  return h;
}

function getSheet_(ss) {
  var sh = ss.getSheetByName(OZ.SHEET) || ss.insertSheet(OZ.SHEET);
  var h = headers_();
  sh.getRange(1, 1, 1, h.length).setValues([h])
    .setFontWeight('bold').setBackground('#1a73e8').setFontColor('#ffffff')
    .setWrap(true).setVerticalAlignment('middle');
  sh.setFrozenRows(1);
  return sh;
}

function writeSheet_(sheet, rows) {
  var width = headers_().length;
  var last = sheet.getLastRow();
  if (last > 1) sheet.getRange(2, 1, last - 1, width).clearContent();
  if (!rows.length) return;
  if (sheet.getMaxRows() < rows.length + 1) sheet.insertRowsAfter(sheet.getMaxRows(), rows.length + 1 - sheet.getMaxRows());
  sheet.getRange(2, 1, rows.length, width).setValues(rows);
  sheet.getRange(2, 1, rows.length, 1).setNumberFormat('yyyy-mm-dd');
  sheet.getRange(2, 7, rows.length, 1).setNumberFormat('@');          // штрихкод как текст
  sheet.getRange(2, 8, rows.length, 1).setNumberFormat('#,##0.00');
  sheet.getRange(2, 9, rows.length, 1).setNumberFormat('0.00%');
  sheet.getRange(2, 10, rows.length, width - 9).setNumberFormat('#,##0.00');
  sheet.getRange(2, 10 + 5, rows.length, 1).setNumberFormat('0');       // кол-во (доставка)
  sheet.getRange(2, 10 + 11 + 5, rows.length, 1).setNumberFormat('0');  // кол-во (возврат)
  sheet.autoResizeColumns(1, 5);
  sheet.setColumnWidth(6, 300);
  if (sheet.getFilter()) sheet.getFilter().remove();
  sheet.getRange(1, 1, rows.length + 1, width).createFilter();
}

/* ============================ УТИЛИТЫ ============================ */

function keyOf_(v, tz) {
  if (v instanceof Date) return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
  return v ? String(v).slice(0, 10) : '';
}

function cutoffKey_(tz) {
  var d = new Date();
  d.setMonth(d.getMonth() - OZ.KEEP_MONTHS);
  return Utilities.formatDate(d, tz, 'yyyy-MM-dd');
}

function saveStatus_(s) { PropertiesService.getUserProperties().setProperty(OZ.P_STATUS, s); }

function toast_(s) { try { SpreadsheetApp.getActiveSpreadsheet().toast(s, 'Отчёт Ozon', 5); } catch (e) {} }
