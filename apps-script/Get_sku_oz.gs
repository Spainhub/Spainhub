/**********************************************************************
 * Get_sku_oz.gs
 * Метод: Ozon — список товаров → лист "Report_sku_oz"
 *
 * API: POST /v3/product/list
 *
 * Ключи Ozon (Client-Id / Api-Key) берутся из единого хранилища —
 * Auth.gs (меню «Отчёты МП» → «Ключи API» → «Ozon: ввести Client-Id
 * и Api-Key»). Здесь их вводить/хранить не нужно.
 *
 * ВАЖНО: все имена в этом файле имеют префикс OZSKU_ / OzSku_, чтобы
 * не конфликтовать с одноимёнными сущностями в других .gs файлах
 * проекта (общее глобальное пространство имён Apps Script).
 **********************************************************************/

const OZSKU_SHEET_NAME = 'Report_sku_oz';
const OZSKU_API_URL = 'https://api-seller.ozon.ru/v3/product/list';
const OZSKU_PAGE_LIMIT = 1000; // минимум 1, максимум 1000

// Заголовки таблицы
const OZSKU_HEADERS = [
  'product_id',
  'offer_id',
  'sku',
  'has_fbo_stocks',
  'has_fbs_stocks',
  'archived',
  'is_discounted',
  'quants'
];

/**
 * Точка входа метода (вызывается из меню «Отчёты МП» →
 * «Ozon — отчёты» → «Список товаров (SKU)»).
 */
function OzSku_loadProducts() {
  const creds = Auth_getOzonCredentials();

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(OZSKU_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(OZSKU_SHEET_NAME);

  // Очищаем лист и пишем заголовки
  sheet.clear();
  sheet.getRange(1, 1, 1, OZSKU_HEADERS.length).setValues([OZSKU_HEADERS]).setFontWeight('bold');
  sheet.setFrozenRows(1);

  const allRows = [];
  let lastId = '';

  // Пагинация: идём постранично, пока сервер возвращает last_id
  do {
    const payload = {
      filter: {
        visibility: 'ALL'
      },
      last_id: lastId,
      limit: OZSKU_PAGE_LIMIT
    };

    const response = OzSku_callApi_(creds, payload);
    if (!response || !response.result || !response.result.items) {
      Logger.log('Пустой ответ или отсутствует result.items: ' + JSON.stringify(response));
      break;
    }

    const items = response.result.items;
    Logger.log('Получено товаров на странице: ' + items.length + ', last_id: ' + response.result.last_id);

    for (const item of items) {
      allRows.push([
        item.product_id || '',
        item.offer_id || '',
        item.sku || '',
        item.has_fbo_stocks === true,
        item.has_fbs_stocks === true,
        item.archived === true,
        item.is_discounted === true,
        item.quants ? JSON.stringify(item.quants) : ''
      ]);
    }

    lastId = response.result.last_id || '';

    // Защита от бесконечного цикла
    Utilities.sleep(300);
  } while (lastId);

  // Записываем все данные одним вызовом
  if (allRows.length > 0) {
    sheet.getRange(2, 1, allRows.length, OZSKU_HEADERS.length).setValues(allRows);
  }

  Logger.log('Всего записано строк: ' + allRows.length);
  SpreadsheetApp.getActiveSpreadsheet().toast(
    'Загружено товаров: ' + allRows.length,
    'Ozon',
    5
  );
}

/* ==================== ВЫЗОВ API ==================== */

function OzSku_callApi_(creds, payload) {
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

  const response = UrlFetchApp.fetch(OZSKU_API_URL, options);
  const code = response.getResponseCode();
  const text = response.getContentText();

  if (code !== 200) {
    Logger.log('Ошибка API. Код: ' + code + '. Ответ: ' + text);
    throw new Error('Ozon API error ' + code + ': ' + text);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    Logger.log('Не удалось распарсить JSON: ' + text);
    throw e;
  }
}

/* ============ ТРИГГЕР (запуск раз в день, вручную из редактора) ============ */
function OzSku_createDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'OzSku_loadProducts') {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('OzSku_loadProducts')
    .timeBased()
    .everyDays(1)
    .atHour(6)
    .create();
  Logger.log('Триггер создан.');
}
