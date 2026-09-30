/**********************************************************************
 * Report_finans_oz_1.gs
 * Метод: Ozon — финансовый отчёт (cash-flow-statement) → лист
 * "Report_finans_oz_1"
 *
 * API: POST /v1/finance/cash-flow-statement/list
 * Документация: Финансы → Баланс → Доходы и расходы
 *
 * Ключи Ozon (Client-Id / Api-Key) берутся из единого хранилища —
 * Auth.gs (меню «Отчёты МП» → «Ключи API» → «Ozon: ввести Client-Id
 * и Api-Key»). Здесь их вводить/хранить не нужно.
 *
 * ВАЖНО: все имена в этом файле имеют префикс OZFIN1_ / OzFin1_,
 * чтобы не конфликтовать с одноимёнными сущностями в других .gs
 * файлах проекта (в Apps Script все файлы делят одно глобальное
 * пространство имён — совпадающие const/function приводят к ошибке
 * при сохранении проекта).
 **********************************************************************/

const OZFIN1_SHEET_NAME = 'Report_finans_oz_1';
const OZFIN1_BASE_URL = 'https://api-seller.ozon.ru';

// Период отчёта (ISO 8601). Ozon отдаёт данные только за периоды 01–15 и 16–31.
const OZFIN1_DATE_FROM = '2026-01-01T00:00:00.000Z';
const OZFIN1_DATE_TO = '2026-12-31T00:00:00.000Z';

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
 * Точка входа метода (вызывается из меню «Отчёты МП» →
 * «Ozon — отчёты» → «Финансовый отчёт (Cash Flow)»).
 */
function OzFin1_loadReport() {
  const creds = Auth_getOzonCredentials();

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(OZFIN1_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(OZFIN1_SHEET_NAME);
  sheet.clear();

  const allRows = [];
  let page = 1;
  let pageCount = 1;

  do {
    const payload = {
      date: {
        from: OZFIN1_DATE_FROM,
        to: OZFIN1_DATE_TO
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
      allRows.push(OzFin1_buildRow_(cf, details));
    });

    Logger.log(`Страница ${page} из ${pageCount}. Получено записей: ${cashFlows.length}`);
    page++;
  } while (page <= pageCount && page <= OZFIN1_MAX_PAGES);

  if (allRows.length === 0) {
    sheet.getRange(1, 1).setValue('Нет данных за указанный период');
    SpreadsheetApp.getActive().toast('Ozon: данных за указанный период нет.', 'Ozon', 6);
    return;
  }

  sheet.getRange(1, 1, 1, OZFIN1_HEADERS.length).setValues([OZFIN1_HEADERS])
    .setFontWeight('bold')
    .setBackground('#f0f0f0');
  sheet.getRange(2, 1, allRows.length, OZFIN1_HEADERS.length).setValues(allRows);
  sheet.setFrozenRows(1);
  sheet.autoResizeColumns(1, OZFIN1_HEADERS.length);

  Logger.log(`Готово. Всего записей: ${allRows.length}`);
  SpreadsheetApp.getActive().toast(`Ozon: загружено строк ${allRows.length}`, 'Ozon', 8);
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

/* --------- Триггер (запуск раз в день, вручную из редактора) --------- */
function OzFin1_createDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'OzFin1_loadReport') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('OzFin1_loadReport')
    .timeBased()
    .everyDays(1)
    .atHour(6)
    .create();
}
