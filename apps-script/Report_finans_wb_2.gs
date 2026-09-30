/**********************************************************************
 * Report_finans_wb_2.gs
 * Метод: Wildberries — детализация к отчётам об издержках на приём
 * платежей (эквайринг) → лист "Report_finans_wb_2"
 *
 * API: POST /api/finance/v1/acquiring/detailed/{reportId}
 *
 * Токен WB берётся из единого хранилища — Auth.gs (меню «Отчёты МП» →
 * «Ключи API» → «Wildberries: ввести токен»). Здесь его вводить не
 * нужно.
 *
 * ВАЖНО: все имена в этом файле имеют префикс WBACQ2_ / WbAcq2_,
 * чтобы не конфликтовать с одноимёнными сущностями в других .gs
 * файлах проекта (общее глобальное пространство имён Apps Script).
 **********************************************************************/

const WBACQ2_CONFIG = {
  REPORT_ID: 1234567, // ← укажите ID отчёта
  SHEET_NAME: 'Report_finans_wb_2',
  LIMIT: 100000, // максимум 100000
  FIELDS: [ // какие поля вернуть
    'rrdId',
    'reportId',
    'acqDate',
    'acquiringBank',
    'tin',
    'taxRegistrationReasonCode',
    'saleDate',
    'srid',
    'documentType',
    'nmId',
    'retailAmount',
    'acquiringFee',
    'acquiringFeeVat',
    'invoiceNumber',
    'invoiceDate',
    'shkId',
    'currency'
  ],
  PAUSE_MS: 61000, // пауза между запросами (лимит 1/мин)
  MAX_RETRIES: 3   // повторы при 429/5xx
};

const WBACQ2_API_URL = 'https://finance-api.wildberries.ru/api/finance/v1/acquiring/detailed/';

/**
 * Точка входа метода (вызывается из меню «Отчёты МП» →
 * «Wildberries — доп. отчёты» → «Финансовый отчёт (эквайринг)»).
 */
function WbAcq2_loadReport() {
  const token = Auth_getWbToken();

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(WBACQ2_CONFIG.SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(WBACQ2_CONFIG.SHEET_NAME);

  const headers = WBACQ2_CONFIG.FIELDS.slice();

  // Если лист пустой --- пишем заголовки
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(headers);
  } else {
    // Проверим, совпадают ли заголовки
    const existing = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
    const same = headers.every((h, i) => existing[i] === h);
    if (!same) {
      // Если заголовки другие --- перезапишем первую строку
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    }
  }

  let rrdId = 0;
  let page = 0;
  const totalFields = headers.length;

  while (true) {
    page++;
    Logger.log('Запрос страницы #' + page + ', rrdId=' + rrdId);
    const response = WbAcq2_fetchPage_(token, rrdId);

    if (response === null) {
      Logger.log('Пустой ответ --- прерываем.');
      break;
    }

    const code = response.getResponseCode();
    if (code === 204) {
      Logger.log('Получен 204 --- данные закончились.');
      break;
    }
    if (code !== 200) {
      const text = response.getContentText();
      Logger.log('Ошибка HTTP ' + code + ': ' + text);
      throw new Error('HTTP ' + code + ': ' + text);
    }

    const data = JSON.parse(response.getContentText());
    if (!Array.isArray(data) || data.length === 0) {
      Logger.log('Пустой массив --- прерываем.');
      break;
    }

    // Формируем строки для записи
    const rows = data.map(item => headers.map(h => {
      const v = item[h];
      return (v === undefined || v === null) ? '' : v;
    }));

    // Пишем одним вызовом
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, totalFields).setValues(rows);
    SpreadsheetApp.flush();
    Logger.log('Записано строк: ' + rows.length);

    // Берём rrdId из последней строки
    const last = data[data.length - 1];
    if (last.rrdId === undefined || last.rrdId === null) {
      Logger.log('В последней строке нет rrdId --- прерываем.');
      break;
    }
    if (last.rrdId === rrdId) {
      Logger.log('rrdId не изменился --- прерываем, чтобы не зациклиться.');
      break;
    }
    rrdId = last.rrdId;

    // Пауза между запросами (лимит 1 запрос/мин)
    Logger.log('Пауза ' + (WBACQ2_CONFIG.PAUSE_MS / 1000) + ' сек...');
    Utilities.sleep(WBACQ2_CONFIG.PAUSE_MS);
  }

  Logger.log('Готово. Всего страниц: ' + page);
  SpreadsheetApp.getActive().toast('WB: отчёт по эквайрингу обновлён.', 'WB', 8);
}

/**
 * Один запрос к API с повторами при 429/5xx
 */
function WbAcq2_fetchPage_(token, rrdId) {
  const url = WBACQ2_API_URL + WBACQ2_CONFIG.REPORT_ID;
  const payload = {
    limit: WBACQ2_CONFIG.LIMIT,
    rrdId: rrdId,
    fields: WBACQ2_CONFIG.FIELDS
  };
  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: {
      Authorization: token
    },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  for (let attempt = 1; attempt <= WBACQ2_CONFIG.MAX_RETRIES; attempt++) {
    const response = UrlFetchApp.fetch(url, options);
    const code = response.getResponseCode();

    if (code === 200 || code === 204) {
      return response;
    }
    // Повторяем при 429 и 5xx
    if (code === 429 || (code >= 500 && code < 600)) {
      Logger.log('Попытка ' + attempt + ' --- HTTP ' + code + '. Ждём и повторяем...');
      Utilities.sleep(WBACQ2_CONFIG.PAUSE_MS);
      continue;
    }
    // Остальные ошибки --- возвращаем как есть
    return response;
  }
  return null;
}

/**
 * Вспомогательная функция: посмотреть ответ API без записи в лист
 */
function WbAcq2_debugFetchPage() {
  const token = Auth_getWbToken();
  const resp = WbAcq2_fetchPage_(token, 0);
  if (!resp) {
    Logger.log('Нет ответа');
    return;
  }
  Logger.log('HTTP ' + resp.getResponseCode());
  Logger.log(resp.getContentText());
}
