/**********************************************************************
 * Oz Sales Report — отчёт о реализации Ozon по дням → Google Sheets
 *
 * Метод Ozon: POST /v1/finance/realization/by-day
 *   (нужна подписка Premium Plus / Premium Pro; данные — не глубже 32 дней)
 *
 * Логика:
 *  - первый запуск загружает последние 30 дней;
 *  - далее раз в сутки (триггер) перезагружаются последние 3 дня
 *    (Ozon может корректировать данные задним числом): старые строки
 *    этих дат удаляются и заменяются свежими, остальное накапливается;
 *  - строки старше 3 месяцев удаляются при каждом обновлении.
 *
 * Ключи хранятся в UserProperties (видны только тому, кто их ввёл).
 **********************************************************************/

var OZ = {
  SHEET: 'Ozon Sales',
  URL: 'https://api-seller.ozon.ru/v1/finance/realization/by-day',
  INITIAL_DAYS: 30,        // первая загрузка
  REFRESH_DAYS: 3,         // ежедневное обновление (перезапись последних дней)
  KEEP_MONTHS: 3,          // срок хранения данных
  TRIGGER_HOUR: 6,         // час запуска автообновления (время таблицы)
  PAUSE_MS: 400,           // пауза между запросами
  P_KEY: 'OZ_API_KEY',
  P_ID: 'OZ_CLIENT_ID',
  P_INIT: 'OZ_INITIAL_DONE',
  P_STATUS: 'OZ_LAST_STATUS'
};

var OZ_BLOCK = ['amount', 'bonus', 'commission', 'compensation', 'price_per_instance',
  'quantity', 'standard_fee', 'bank_coinvestment', 'stars', 'pick_up_point_coinvestment', 'total'];

/* ============================ МЕНЮ ============================ */

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Ozon Sales')
    .addItem('Add API key', 'addApiKey')
    .addItem('Add ID', 'addClientId')
    .addItem('Replace API key', 'replaceApiKey')
    .addItem('Replace ID', 'replaceClientId')
    .addItem('Delete key and ID', 'deleteCredentials')
    .addSeparator()
    .addItem('Update now', 'updateNow')
    .addItem('Enable auto-update (every 24h)', 'enableAutoUpdate')
    .addItem('Disable auto-update', 'disableAutoUpdate')
    .addItem('Status', 'showStatus')
    .addToUi();
}

/* ====================== КЛЮЧ И CLIENT-ID ====================== */

function addApiKey() { setCred_(OZ.P_KEY, 'API key', false); }
function addClientId() { setCred_(OZ.P_ID, 'Client ID', false); }
function replaceApiKey() { setCred_(OZ.P_KEY, 'API key', true); }
function replaceClientId() { setCred_(OZ.P_ID, 'Client ID', true); }

function setCred_(prop, label, replace) {
  var ui = SpreadsheetApp.getUi();
  var props = PropertiesService.getUserProperties();
  var exists = !!props.getProperty(prop);
  if (!replace && exists) {
    ui.alert(label + ' уже сохранён. Используйте «Replace ' + label + '».');
    return;
  }
  if (replace && !exists) {
    ui.alert(label + ' ещё не добавлен. Используйте «Add ' + label + '».');
    return;
  }
  var r = ui.prompt((replace ? 'Replace ' : 'Add ') + label, 'Введите ' + label + ' из кабинета Ozon Seller:', ui.ButtonSet.OK_CANCEL);
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
    'Загрузить данные за последние ' + OZ.INITIAL_DAYS + ' дней и включить автообновление раз в 24 часа?',
    ui.ButtonSet.YES_NO);
  if (r === ui.Button.YES) updateNow();
}

function deleteCredentials() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.alert('Delete key and ID',
    'Удалить API key и Client ID и отключить автообновление? Загруженные данные на листе останутся.',
    ui.ButtonSet.YES_NO);
  if (r !== ui.Button.YES) return;
  var props = PropertiesService.getUserProperties();
  props.deleteProperty(OZ.P_KEY);
  props.deleteProperty(OZ.P_ID);
  props.deleteProperty(OZ.P_INIT);
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
    'Автообновление: ' + (hasTrigger_() ? 'включено' : 'выключено') + '\n\n' +
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
    if (!key || !id) throw new Error('Не заданы API key и/или Client ID (меню Ozon Sales).');

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var tz = ss.getSpreadsheetTimeZone();
    var sheet = getSheet_(ss);
    var isInitial = !props.getProperty(OZ.P_INIT);
    var days = isInitial ? OZ.INITIAL_DAYS : OZ.REFRESH_DAYS;

    var today = new Date();
    var fetched = {};   // dateKey -> rows[]
    var failed = [];
    var okDays = 0;

    for (var i = days - 1; i >= 0; i--) {
      var d = new Date(today.getFullYear(), today.getMonth(), today.getDate() - i);
      var dk = Utilities.formatDate(d, tz, 'yyyy-MM-dd');
      try {
        fetched[dk] = fetchDay_(d, dk, id, key);
        okDays++;
      } catch (e) {
        if (e.fatal) throw e;          // 401/403 — дальше нет смысла
        failed.push(dk + ': ' + e.message);
      }
      Utilities.sleep(OZ.PAUSE_MS);
    }
    if (okDays === 0) throw new Error('Не удалось загрузить ни одного дня. ' + failed.join('; '));

    // Существующие данные (без заголовка), дни из свежей выгрузки заменяются целиком.
    var last = sheet.getLastRow();
    var existing = last > 1 ? sheet.getRange(2, 1, last - 1, headers_().length).getValues() : [];
    var cutoff = cutoffKey_(tz);
    var kept = existing.filter(function (r) {
      var k = keyOf_(r[0], tz);
      return k && k >= cutoff && !(k in fetched);
    });
    var added = [];
    Object.keys(fetched).forEach(function (k) {
      if (k >= cutoff) added = added.concat(fetched[k]);
    });
    var all = kept.concat(added);
    all.sort(function (a, b) { return keyOf_(a[0], tz) < keyOf_(b[0], tz) ? -1 : keyOf_(a[0], tz) > keyOf_(b[0], tz) ? 1 : 0; });

    writeSheet_(sheet, all);
    props.setProperty(OZ.P_INIT, '1');

    var expired = existing.filter(function (r) { var k = keyOf_(r[0], tz); return !k || k < cutoff; }).length;
    var msg = 'Загружено дней: ' + okDays + ' из ' + days + ', новых строк: ' + added.length +
      ', всего на листе: ' + all.length + ', удалено старше ' + OZ.KEEP_MONTHS + ' мес.: ' + expired + '.' +
      (failed.length ? '\nНе удалось: ' + failed.join('; ') : '');
    saveStatus_(Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm') + ' — ' + msg);
    return msg;
  } finally {
    lock.releaseLock();
  }
}

/* ============================ OZON API ============================ */

function fetchDay_(date, dateKey, clientId, apiKey) {
  var body = JSON.stringify({ day: date.getDate(), month: date.getMonth() + 1, year: date.getFullYear() });
  var opts = {
    method: 'post',
    contentType: 'application/json',
    headers: { 'Client-Id': clientId, 'Api-Key': apiKey },
    payload: body,
    muteHttpExceptions: true
  };
  var resp, code, text;
  for (var attempt = 1; attempt <= 4; attempt++) {
    resp = UrlFetchApp.fetch(OZ.URL, opts);
    code = resp.getResponseCode();
    text = resp.getContentText();
    if (code === 429 || code >= 500) { Utilities.sleep(1000 * attempt * attempt); continue; }
    break;
  }
  if (code === 404) return [];  // за этот день отчёта нет
  if (code !== 200) {
    var m = text;
    try { m = JSON.parse(text).message || text; } catch (ignore) {}
    var err = new Error('HTTP ' + code + ' — ' + m);
    if (code === 401 || code === 403) {
      err.message += '. Проверьте Client ID / API key и наличие подписки Premium Plus/Pro.';
      err.fatal = true;
    }
    throw err;
  }
  var rows = (JSON.parse(text).rows) || [];
  var dateCell = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return rows.map(function (r) { return rowToArray_(dateCell, r); });
}

function rowToArray_(date, r) {
  var item = r.item || {};
  var out = [date, r.rowNumber, item.sku, item.offer_id, item.name, item.barcode,
    r.seller_price_per_instance, r.commission_ratio];
  [r.delivery_commission || {}, r.return_commission || {}].forEach(function (b) {
    OZ_BLOCK.forEach(function (f) { out.push(b[f] === undefined ? 0 : b[f]); });
  });
  return out;
}

/* ============================== ЛИСТ ============================== */

function headers_() {
  var h = ['Дата', '№ строки', 'SKU', 'Артикул (offer_id)', 'Название', 'Штрихкод',
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
  sheet.getRange(2, 6, rows.length, 1).setNumberFormat('@');       // штрихкод как текст
  sheet.getRange(2, 7, rows.length, 1).setNumberFormat('#,##0.00');
  sheet.getRange(2, 8, rows.length, 1).setNumberFormat('0.00%');
  sheet.getRange(2, 9, rows.length, width - 8).setNumberFormat('#,##0.00');
  sheet.getRange(2, 9 + 5, rows.length, 1).setNumberFormat('0');    // кол-во (доставка)
  sheet.getRange(2, 9 + 11 + 5, rows.length, 1).setNumberFormat('0'); // кол-во (возврат)
  sheet.autoResizeColumns(1, 4);
  sheet.setColumnWidth(5, 300);
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

function toast_(s) { try { SpreadsheetApp.getActiveSpreadsheet().toast(s, 'Ozon Sales', 5); } catch (e) {} }
