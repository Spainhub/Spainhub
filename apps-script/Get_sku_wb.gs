/**********************************************************************
 * Get_sku_wb.gs
 * Метод: Wildberries — получение товаров с ценами → лист "Report_sku_wb"
 *
 * API: GET /api/v2/list/goods/filter
 * Документация: discounts-prices-api.wildberries.ru
 *
 * Токен WB берётся из единого хранилища — Auth.gs (меню «Отчёты МП» →
 * «Ключи API» → «Wildberries: ввести токен»). Обратите внимание: для
 * этого метода токен должен иметь категорию «Цены и скидки» — она
 * может отличаться от категории «Финансы», нужной для отчётов
 * реализации/эквайринга. Если используете один общий токен, включите
 * в него обе категории при создании в личном кабинете WB.
 *
 * ВАЖНО: все имена в этом файле имеют префикс WBSKU_ / WbSku_, чтобы
 * не конфликтовать с одноимёнными сущностями в других .gs файлах
 * проекта (общее глобальное пространство имён Apps Script).
 **********************************************************************/

const WBSKU_SHEET_NAME = 'Report_sku_wb';
const WBSKU_API_BASE = 'https://discounts-prices-api.wildberries.ru';
const WBSKU_ENDPOINT = '/api/v2/list/goods/filter';
const WBSKU_LIMIT = 1000;   // максимум 1000
const WBSKU_PAUSE_MS = 700; // пауза между запросами (лимит: 600 мс между запросами)
const WBSKU_MAX_RETRIES = 5; // попытки при 429

// Заголовки таблицы
const WBSKU_HEADERS = [
  'nmID',
  'vendorCode',
  'sizeID',
  'techSizeName',
  'price',
  'discountedPrice',
  'clubDiscountedPrice',
  'currencyIsoCode4217',
  'discount',
  'clubDiscount',
  'editableSizePrice',
  'wholesaleMinQuantity',
  'wholesaleDiscount',
  'wholesaleLevel'
];

/**
 * Точка входа метода (вызывается из меню «Отчёты МП» →
 * «Wildberries — доп. отчёты» → «Список товаров (SKU)»).
 */
function WbSku_loadGoods() {
  const token = Auth_getWbToken();

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(WBSKU_SHEET_NAME);
  if (!sheet) sheet = ss.insertSheet(WBSKU_SHEET_NAME);

  // Очищаем и пишем заголовки
  sheet.clearContents();
  sheet.getRange(1, 1, 1, WBSKU_HEADERS.length).setValues([WBSKU_HEADERS]).setFontWeight('bold');
  sheet.setFrozenRows(1);

  const rows = [];
  let offset = 0;
  let page = 0;

  while (true) {
    page++;
    const url = `${WBSKU_API_BASE}${WBSKU_ENDPOINT}?limit=${WBSKU_LIMIT}&offset=${offset}`;
    const json = WbSku_fetchWithRetry_(url, token);
    if (!json) break;

    if (json.error) {
      Logger.log(`Ошибка API: ${json.errorText || 'неизвестно'}`);
      break;
    }

    const list = (json.data && json.data.listGoods) || [];
    if (list.length === 0) break; // конец пагинации

    list.forEach(good => {
      const sizes = good.sizes || [];
      const wholesale = good.wholesaleDiscountThreshold || [];

      // Если размеров нет --- пишем строку с пустыми полями размеров
      if (sizes.length === 0) {
        rows.push(WbSku_buildRow_(good, null, wholesale[0] || null));
      } else {
        sizes.forEach(size => {
          rows.push(WbSku_buildRow_(good, size, wholesale[0] || null));
        });
      }
    });

    Logger.log(`Страница ${page}: получено ${list.length} товаров, всего строк: ${rows.length}`);

    if (list.length < WBSKU_LIMIT) break; // последняя страница
    offset += WBSKU_LIMIT;
    Utilities.sleep(WBSKU_PAUSE_MS);
  }

  if (rows.length === 0) {
    Logger.log('Нет данных для записи.');
    SpreadsheetApp.getActive().toast('WB: нет данных по товарам.', 'WB', 6);
    return;
  }

  // Пишем данные
  sheet.getRange(2, 1, rows.length, WBSKU_HEADERS.length).setValues(rows);
  sheet.autoResizeColumns(1, WBSKU_HEADERS.length);

  Logger.log(`Готово. Записано строк: ${rows.length}`);
  SpreadsheetApp.getActive().toast(`WB: загружено товаров ${rows.length}`, 'WB', 8);
}

/**
 * Формирует строку для листа.
 */
function WbSku_buildRow_(good, size, wholesale) {
  return [
    good.nmID || '',
    good.vendorCode || '',
    size ? (size.sizeID || '') : '',
    size ? (size.techSizeName || '') : '',
    size ? (size.price || '') : '',
    size ? (size.discountedPrice || '') : '',
    size ? (size.clubDiscountedPrice || '') : '',
    good.currencyIsoCode4217 || '',
    good.discount != null ? good.discount : '',
    good.clubDiscount != null ? good.clubDiscount : '',
    good.editableSizePrice != null ? good.editableSizePrice : '',
    wholesale ? (wholesale.minQuantity || '') : '',
    wholesale ? (wholesale.wholesaleDiscount || '') : '',
    wholesale ? (wholesale.level || '') : ''
  ];
}
/**
 * GET с обработкой 429 (retry) и других ошибок.
 */
function WbSku_fetchWithRetry_(url, token) {
  const options = {
    method: 'get',
    headers: { Authorization: token },
    muteHttpExceptions: true
  };

  for (let attempt = 1; attempt <= WBSKU_MAX_RETRIES; attempt++) {
    const resp = UrlFetchApp.fetch(url, options);
    const code = resp.getResponseCode();
    const text = resp.getContentText();

    if (code === 200) {
      try {
        return JSON.parse(text);
      } catch (e) {
        Logger.log('Ошибка парсинга JSON: ' + e.message);
        return null;
      }
    }
    if (code === 429) {
      const wait = WBSKU_PAUSE_MS * Math.pow(2, attempt); // экспоненциальная пауза
      Logger.log(`429 Too Many Requests. Пауза ${wait} мс (попытка ${attempt}).`);
      Utilities.sleep(wait);
      continue;
    }
    if (code === 401) {
      Logger.log('401 Не авторизован. Проверьте токен WB. ' + text);
      return null;
    }
    if (code === 402) {
      Logger.log('402 Требуется платёж. ' + text);
      return null;
    }
    if (code === 403) {
      Logger.log('403 Доступ запрещён. ' + text);
      return null;
    }
    if (code === 400) {
      Logger.log('400 Неправильный запрос. ' + text);
      return null;
    }
    Logger.log(`HTTP ${code}: ${text}`);
    return null;
  }

  Logger.log('Превышено число попыток при 429.');
  return null;
}
