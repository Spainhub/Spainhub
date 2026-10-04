/**********************************************************************
 * Report_finans_oz_1.gs
 * Метод: Ozon — финансовый отчёт (cash-flow-statement) → лист
 * "Report_finans_oz_1"
 *
 * API: POST /v1/finance/cash-flow-statement/list
 * Документация: Финансы → Баланс → Доходы и расходы
 *
 * Ключи Ozon (Client-Id / Api-Key) берутся из единого хранилища —
 * Auth.gs (меню «Отчёты МП» → «1. Добавить API-ключ» → «1.3 Добавить Ozon»). Здесь их вводить/хранить не нужно.
 *
 * ВАЖНО: все имена в этом файле имеют префикс OZFIN1_ / OzFin1_,
 * чтобы не конфликтовать с одноимёнными сущностями в других .gs
 * файлах проекта (в Apps Script все файлы делят одно глобальное
 * пространство имён — совпадающие const/function приводят к ошибке
 * при сохранении проекта).
 **********************************************************************/

const OZFIN1_SHEET_NAME = 'Report_finans_oz_1';
const OZFIN1_BASE_URL = 'https://api-seller.ozon.ru';

// Период запроса задаётся при вызове (см. OzFin1_loadRange_). Ozon отдаёт данные
// периодами 01–15 и 16–31 (конец месяца); строки на листе обновляются по period_id.
const OZFIN1_TRIGGER_DAY = 10;   // день месяца автозагрузки
const OZFIN1_TRIGGER_HOUR = 6;   // час запуска (МСК)

const OZFIN1_PAGE_SIZE = 1000;   // количество элементов на странице
const OZFIN1_WITH_DETAILS = true; // добавлять ли детализацию в ответ
const OZFIN1_MAX_PAGES = 50;      // защита от бесконечного цикла

const OZFIN1_HEADERS = [
  'period_id',
  'period_begin',
  'period_end',
  'currency_code',
  'orders_amount',
  'returns_amount',
  'commission_amount',
  'services_amount',
  'item_delivery_and_return_amount',
  'begin_balance_amount',
  'end_balance_amount',
  'payments',
  'delivery_total',
  'return_total',
  'loan',
  'invoice_transfer',
  'rfbs_total',
  'services_total',
  'others_total'
];

/**
 * Меню «3. Ozon» → «3.1 Загрузить данные за 3 месяца (первый запуск)»:
 * с 1-го числа месяца MAX_MONTHS_BACK месяцев назад по сегодня (как у WB).
 */
function OzFin1_firstRun() {
  const creds = Auth_getOzonCredentials();
  if (!OzFin1_confirmClear_()) return;
  OzFin1_loadRange_(creds, dayKey_(retentionStart_()), dayKey_(mskToday_()), true);
}

/** Первый запуск очищает лист от старых данных — спрашиваем, если они там есть. */
function OzFin1_confirmClear_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(OZFIN1_SHEET_NAME);
  const rows = sh ? Math.max(0, sh.getLastRow() - 1) : 0;
  if (!rows) return true;
  const ui = SpreadsheetApp.getUi();
  return ui.alert('Первый запуск',
    `Лист ${OZFIN1_SHEET_NAME} содержит ${rows} строк данных. При первом запуске они будут удалены ` +
    'и загружены заново. Продолжить?', ui.ButtonSet.YES_NO) === ui.Button.YES;
}

/** Совместимость: старое имя точки входа. */
function OzFin1_loadReport() {
  OzFin1_firstRun();
}

/**
 * Запуск триггера: ПРЕДЫДУЩИЙ календарный месяц целиком (10 ноября → октябрь).
 * К 10-му числу Ozon уже закрыл оба периода месяца.
 */
function OzFin1_monthlyUpdate() {
  const creds = Auth_getOzonCredentials();
  const t = mskToday_();
  const first = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - 1, 1, 12, 0, 0, 0));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 0, 12, 0, 0, 0));
  OzFin1_loadRange_(creds, dayKey_(first), dayKey_(last));
}

/**
 * Меню «3.2 Включить ежемесячную автозагрузку»: ставит триггер на 10-е число
 * и сразу загружает данные за 3 месяца (первый запуск).
 */
function OzFin1_installMonthlyTrigger() {
  const creds = Auth_getOzonCredentials();   // понятная ошибка, если ключей нет
  if (!OzFin1_confirmClear_()) return;
  OzFin1_deleteTriggers_();
  ScriptApp.newTrigger('OzFin1_monthlyUpdate')
    .timeBased()
    .onMonthDay(OZFIN1_TRIGGER_DAY)
    .atHour(OZFIN1_TRIGGER_HOUR)
    .inTimezone(TZ_MSK)
    .create();
  const msg = `Ежемесячная автозагрузка Ozon включена: ${OZFIN1_TRIGGER_DAY}-го числа ~${OZFIN1_TRIGGER_HOUR}:00 МСК ` +
    'будет загружаться предыдущий месяц (от имени текущего пользователя — используются ЕГО ключи Ozon).\n\n' +
    'Сейчас загружаю данные за 3 месяца…';
  try { SpreadsheetApp.getActive().toast(msg, 'Ozon', 8); } catch (e) { Logger.log(msg); }
  OzFin1_loadRange_(creds, dayKey_(retentionStart_()), dayKey_(mskToday_()), true);
}

function OzFin1_deleteTriggers_() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (['OzFin1_monthlyUpdate', 'OzFin1_loadReport'].includes(t.getHandlerFunction())) {
      ScriptApp.deleteTrigger(t);
    }
  });
}

/**
 * Загружает периоды Ozon за [fromKey; toKey] ("yyyy-MM-dd") и ДОБАВЛЯЕТ их на лист:
 * строки с тем же period_id обновляются, остальные сохраняются.
 * replace = true (первый запуск) — старые данные листа удаляются; чистим только
 * ПОСЛЕ успешного ответа API, чтобы при ошибке не потерять прежние данные.
 */
function OzFin1_loadRange_(creds, fromKey, toKey, replace) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(OZFIN1_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(OZFIN1_SHEET_NAME);

  const newRows = [];
  let page = 1;
  let pageCount = 1;

  do {
    const payload = {
      date: {
        from: fromKey + 'T00:00:00.000Z',
        to: toKey + 'T23:59:59.000Z'
      },
      with_details: OZFIN1_WITH_DETAILS,
      page: page,
      page_size: OZFIN1_PAGE_SIZE
    };

    const response = OzFin1_callApi_(creds, '/v1/finance/cash-flow-statement/list', payload);
    if (!response || !response.result) {
      Logger.log('Пустой ответ на странице ' + page);
      break;
    }

    pageCount = response.page_count || 1;
    const cashFlows = response.result.cash_flows || [];
    const details = response.result.details || {};

    cashFlows.forEach(cf => {
      newRows.push(OzFin1_buildRow_(cf, details));
    });

    Logger.log(`Страница ${page} из ${pageCount}. Получено записей: ${cashFlows.length}`);
    page++;
  } while (page <= pageCount && page <= OZFIN1_MAX_PAGES);

  if (replace) sheet.clear();
  const total = OzFin1_upsertRows_(sheet, newRows);
  if (total === 0) {
    sheet.getRange(1, 1).setValue('Нет данных за указанный период');
    SpreadsheetApp.getActive().toast(`Ozon: за ${fromKey} — ${toKey} данных нет.`, 'Ozon', 6);
    return;
  }
  Logger.log(`Готово. Получено: ${newRows.length}, всего на листе: ${total}`);
  SpreadsheetApp.getActive().toast(
    `Ozon: ${fromKey} — ${toKey}: получено периодов ${newRows.length}, всего на листе ${total}`, 'Ozon', 8);
}

/** Объединяет новые строки с уже имеющимися по period_id (колонка A); возвращает число строк. */
function OzFin1_upsertRows_(sheet, newRows) {
  const nCols = OZFIN1_HEADERS.length;
  const byId = {};
  const last = sheet.getLastRow();
  if (last >= 2 && sheet.getLastColumn() >= nCols) {
    const head = sheet.getRange(1, 1, 1, nCols).getValues()[0];
    if (head.join('|') === OZFIN1_HEADERS.join('|')) {
      sheet.getRange(2, 1, last - 1, nCols).getValues().forEach(r => {
        if (r[0] !== '') byId[String(r[0])] = r;
      });
    }
  }
  newRows.forEach(r => { byId[String(r[0])] = r; });
  const rows = Object.keys(byId).map(k => byId[k])
    .sort((a, b) => String(a[1]).localeCompare(String(b[1])));
  if (!rows.length) return 0;

  sheet.clearContents();
  sheet.getRange(1, 1, 1, nCols).setValues([OZFIN1_HEADERS])
    .setFontWeight('bold')
    .setBackground('#f0f0f0');
  sheet.getRange(2, 1, rows.length, nCols).setValues(rows);
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, nCols);
  return rows.length;
}

/* ------------------ Формирование строки ------------------ */

function OzFin1_buildRow_(cashFlow, details) {
  const period = cashFlow.period || {};

  // Платежи собираем в строку "currency: сумма; ..."
  const paymentsStr = (details.payments || [])
    .map(p => `${p.currency_code || ''}: ${p.payment || 0}`)
    .join('; ');

  return [
    period.id || '',
    OzFin1_formatDate_(period.begin),
    OzFin1_formatDate_(period.end),
    cashFlow.currency_code || '',
    OzFin1_num_(cashFlow.orders_amount),
    OzFin1_num_(cashFlow.returns_amount),
    OzFin1_num_(cashFlow.commission_amount),
    OzFin1_num_(cashFlow.services_amount),
    OzFin1_num_(cashFlow.item_delivery_and_return_amount),
    OzFin1_num_(details.begin_balance_amount),
    OzFin1_num_(details.end_balance_amount),
    paymentsStr,
    OzFin1_num_(details.delivery && details.delivery.total),
    OzFin1_num_(details.return && details.return.total),
    OzFin1_num_(details.loan),
    OzFin1_num_(details.invoice_transfer),
    OzFin1_num_(details.rfbs && details.rfbs.total),
    OzFin1_num_(details.services && details.services.total),
    OzFin1_num_(details.others && details.others.total)
  ];
}

function OzFin1_num_(v) {
  return (v === undefined || v === null || isNaN(v)) ? 0 : Number(v);
}

function OzFin1_formatDate_(iso) {
  if (!iso) return '';
  try {
    return Utilities.formatDate(new Date(iso), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm:ss');
  } catch (e) {
    return iso;
  }
}

/* -------------------- Запрос к API Ozon -------------------- */

function OzFin1_callApi_(creds, path, payload) {
  const url = OZFIN1_BASE_URL + path;
  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      'Client-Id': creds.clientId,
      'Api-Key': creds.apiKey
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  const response = UrlFetchApp.fetch(url, options);
  const code = response.getResponseCode();
  const text = response.getContentText();

  if (code !== 200) {
    Logger.log(`Ошибка API (${code}): ${text}`);
    throw new Error(`Ozon API error ${code}: ${text}`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    Logger.log('Не удалось распарсить JSON: ' + text);
    return null;
  }
}
