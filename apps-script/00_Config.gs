/**********************************************************************
 * 00_Config.gs — ОБЩАЯ КОНФИГУРАЦИЯ ПРОЕКТА (загружается первым)
 *
 * ВСЕ имена листов, раскладка листов и настройки — только здесь. Если
 * переименуете лист в таблице, измените ОДНУ строку ниже (и вкладка
 * Web App переименуется сама: заголовки вкладок = имена листов).
 *
 * Порядок файлов в проекте Apps Script (слева направо) — по номерам:
 *   00_Config … 17_Web_Ref, затем HTML-файлы Index, Css, Js_* (см. README.md).
 * В Apps Script все файлы делят одно глобальное пространство имён, поэтому
 * имена функций имеют префикс модуля: Util_, Formulas_, Auth_, Wb_, Gap_,
 * WbAcq2_, WbSku_, OzFin1_, OzSku_, Setup_, Info_, App_, Params_, Pnl_,
 * Goods_, Unit_, Ref_. Загрузчик WB сохраняет старые имена (firstRun, dailyUpdate …) —
 * на них могут быть созданы триггеры.
 **********************************************************************/

/* ===================== ЛИСТЫ ТАБЛИЦЫ ===================== */
// Служебные
const SHEET_INFO = 'INFO';              // README проекта
const SHEET_LOG = 'LOG';                // журнал загрузок
const SHEET_DATA_CHECK = 'DATA_CHECK';  // контроль полноты DATA_WB
const SHEET_SKU_WB = 'SKU_WB';          // товары Wildberries
const SHEET_SKU_OZ = 'SKU_OZ';          // товары Ozon
const SHEET_COGS = 'COGS';              // себестоимость (заполняет пользователь)
const SHEET_REPORT_OZ = 'REPORT_OZ';    // данные Ozon (cash flow)
const SHEET_REPORT_WB = 'REPORT_WB';    // WB: эквайринг (в вашем списке листов его нет — при необходимости переименуйте)
const SHEET_DATA = 'DATA_WB';           // данные Wildberries (реализация)
// Листы, которые показывает Web App (вкладки 1–5)
const SHEET_PARAMS = 'ПАРАМЕТРЫ';       // вкладка 1
const SHEET_PNL = 'P&L ОТЧЕТ';          // вкладка 2
const SHEET_GOODS = 'ТОВАРЫ';           // вкладка 3
const SHEET_UNIT = 'UNIT';              // вкладка 4
const SHEET_REF = 'СПРАВКА';            // вкладка 5

// Порядок листов в таблице (меню «Листы → Расставить по порядку»)
const SHEET_ORDER = [
  SHEET_INFO, SHEET_LOG, SHEET_DATA_CHECK, SHEET_SKU_WB, SHEET_SKU_OZ, SHEET_COGS,
  SHEET_REPORT_OZ, SHEET_DATA, SHEET_PARAMS, SHEET_PNL, SHEET_GOODS, SHEET_UNIT, SHEET_REF
];

// Вкладки Web App в порядке отображения (id используется в HTML)
const WEB_TABS = [
  { id: 'params', sheet: SHEET_PARAMS },
  { id: 'pnl',    sheet: SHEET_PNL },
  { id: 'goods',  sheet: SHEET_GOODS },
  { id: 'unit',   sheet: SHEET_UNIT },
  { id: 'ref',    sheet: SHEET_REF }
];

/* ===================== РАСКЛАДКА ЛИСТОВ ===================== */
// Фильтр периода: ячейки E2 («Дата от») и G2 («Дата до») на листах
// P&L ОТЧЕТ, ТОВАРЫ и UNIT; рабочий период — E4 / G4 (формулы листа).
const PERIOD_SHEETS = [SHEET_PNL, SHEET_GOODS, SHEET_UNIT];
const PERIOD_FROM_CELL = 'E2';
const PERIOD_TO_CELL = 'G2';
const PERIOD_FROM_USED = 'E4';
const PERIOD_TO_USED = 'G4';

// P&L ОТЧЕТ: шапка в строках 1–4 (A1 название, A2 подзаголовок, A3 продавец),
// заголовки таблицы в строке 6 (№ | Наименование | Сумма | Доля, % | периоды E…),
// строка 7 — «Параметры» (у месяца дата конца месяца, у дня — день недели).
// Нумерация строк в колонке A: 1, 1.1, 2, 2.1, 2.1.1 … — по ней сворачиваются строки.
const PNL_HEADER_ROW = 6;
const PNL_PARAMS_ROW = 7;
const PNL_FIRST_PERIOD_COL = 5;   // E

// Шапка страницы Web App. Валюта для ВСЕХ вкладок — ячейка B5 листа P&L ОТЧЕТ (BYN, RUS …).
const HEADER_CURRENCY_CELL = 'B5';
// UNIT: дата формирования отчёта — C4
const UNIT_GENERATED_CELL = 'C4';
// СПРАВКА: свои значения шапки (если H4 пусто — валюта берётся из P&L ОТЧЕТ!B5)
const REF_HEADER_CELLS = { supplier: 'B4', generated: 'D2', from: 'D4', to: 'F4', currency: 'H4' };
const REF_SUBTITLE = 'Сверка расчетов Wildberries';   // подзаголовок страницы на вкладке СПРАВКА

// ТОВАРЫ: шапка как у P&L ОТЧЕТ, заголовки в строке 6, данные с 7-й строки
const GOODS_HEADER_ROW = 6;
const GOODS_FIRST_ROW = 7;
const GOODS_CACHE_PREFIX = 'GOODS_W2_';
const GOODS_HEADERS = [
  '№', 'Артикул WB', 'Артикул', 'Категория товара', 'Выручка', 'Логистика',
  'Логистика %', 'Расходы', 'Себестоимость', 'ВП', 'Маржа, %', 'Доля, %', 'XYZ', 'ABC'
];

// UNIT: артикул в C5 (выпадающий список), артикул продавца в E5, категория в G5,
// заголовки в строке 6, данные с 7-й строки, даты в колонках E:CR
const UNIT_SKU_CELL = 'C5';
const UNIT_ARTICLE_CELL = 'E5';
const UNIT_CATEGORY_CELL = 'G5';
const UNIT_HEADER_ROW = 6;
const UNIT_FIRST_COL = 5;   // E
const UNIT_LAST_COL = 96;   // CR

// ПАРАМЕТРЫ: заголовки A6:C6 (№ | Параметры | Выбор и ввод данных), параметры с 7-й строки
const PARAMS_HEADER_ROW = 6;
const PARAMS_FIRST_ROW = 7;
const PARAMS_VALUE_COL = 3;       // C

// СПРАВКА: номер отчёта — выпадающий список в B2; заголовки в строке 6
// (№ | Страна: | Итого | Армения | Беларусь | Казахстан | …), данные с 7-й строки
const REF_SELECT_CELL = 'B2';
const REF_LABEL_CELL = 'A2';
const REF_HEADER_ROW = 6;
const REF_FIRST_ROW = 7;

/* ===================== ДАННЫЕ WB (DATA_WB) ===================== */
// Колонки DATA_WB, на которые опираются формулы отчётов (буквы колонок листа)
const DATA_COLS = {
  amount: 'V',     // сумма продажи/возврата
  oper: 'Z',       // тип операции ("Продажа", "Возвраты", "Логистика" …)
  date: 'AB',      // rrDate — дата строки отчёта
  logistics: 'AH', // логистика
  forPay: 'AR',    // к перечислению
  penalty: 'BI',   // штрафы
  storage: 'BL',   // хранение
  deduction: 'BM'  // прочие удержания
};
// Значения колонки Z — такие же, как в формулах отчётов
const OPER_SALE = 'Продажа';
const OPER_RETURN = 'Возвраты';
const OPER_LOGISTICS = 'Логистика';
// Колонки DATA_WB, которые ищем по имени заголовка (берётся первое найденное)
const DATA_NAME_FIELDS = {
  sku: ['nmId', 'nm_id'],
  category: ['subjectName', 'subject_name', 'subject'],
  article: ['saName', 'sa_name', 'supplierArticle', 'vendorCode'],
  qty: ['quantity']
};

/* ===================== ЗАГРУЗКА WB ===================== */
const API_URL = 'https://finance-api.wildberries.ru/api/finance/v1/sales-reports/detailed';
const MAX_MONTHS_BACK = 3;        // окно хранения: с 1-го числа месяца N месяцев назад
const PAGE_LIMIT = 100000;
const REQUEST_PAUSE_MS = 62000;   // лимит WB: 1 запрос в минуту
const MAX_RUNTIME_MS = 5.5 * 60 * 1000;
const REQUEST_BUDGET_MS = 90 * 1000; // запас времени на один запрос + запись
const SELLER_NAME = 'ООО "Users"';   // подпись продавца, если A3 на листе пуста

const TZ_MSK = 'Europe/Moscow';
const CHUNK_DAYS = 30;            // период одного запроса к API
const DAILY_OVERLAP_DAYS = 7;     // сколько последних дней перезапрашивать каждый день
const DAILY_TRIGGER_HOUR = 6;     // час запуска dailyUpdate (МСК)
const LOAD_MAX_JOB_ERRORS = 3;    // после N ошибок подряд задание снимается
const LOAD_RETRY_DELAY_MS = 15 * 60 * 1000; // повтор после ошибки через 15 мин
const LOAD_LOG_MAX_ROWS = 1000;
const PROP_LOAD_QUEUE = 'WB_LOAD_QUEUE';
const PROP_LAST_REQUEST = 'WB_LAST_REQUEST_AT';
const PROP_AFTERLOAD = 'WB_AFTERLOAD_PENDING';
const PROP_DATA_VERSION = 'WB_DATA_VERSION';

// Сдвиг UTC → MSK (часы) — только для определения дня в дата-времени
const MSK_OFFSET_HOURS = 3;

/* ===================== ГРАФИКИ ПРИ НАВЕДЕНИИ (P&L ОТЧЕТ) ===================== */
// Дневной ряд за весь период (из DATA_WB) строится для строк, чьё название
// подходит под правило (первое совпавшее). Правила можно менять/дополнять.
// id → ключ ряда, который считает Pnl_computeSeries_ (12 показателей).
const PNL_SERIES_RULES = [
  { id: 'income',        re: /^доходы$/i },
  { id: 'revenue',       re: /чистая выручка|net sales/i },
  { id: 'returns',       re: /^возвраты/i },
  { id: 'forPay',        re: /к перечислению|forpay/i },
  { id: 'spp',           re: /внереализационн|\(спп\)/i },
  { id: 'mpExpenses',    re: /итого расходы маркетплейса/i },
  { id: 'commissionPct', re: /комисси.*%/i },
  { id: 'commission',    re: /комисси.*нетто/i },
  { id: 'logisticsPct',  re: /логистик.*%/i },
  { id: 'logistics',     re: /логистик.*нетто/i },
  { id: 'storage',       re: /хранени/i },
  { id: 'penalties',     re: /штраф/i }
];
// Если у строки нет ряда из DATA_WB, график строится по её дневным колонкам
// листа (как на UNIT), когда числовых значений не меньше порога:
const CHART_MIN_POINTS_HEADER = 2;   // у итоговых строк (заголовков с подстроками)
const CHART_MIN_POINTS_LEAF = 14;    // у остальных строк

/* ===================== БЕЗОПАСНОСТЬ WEB APP ===================== */
// true — записывать в таблицу из Web App могут только редакторы таблицы
// (параметры, артикул UNIT, номер отчёта СПРАВКИ, фильтр периода).
// Работает, если Web App развёрнут «Выполнять от имени: пользователя, открывшего
// приложение»; при «от моего имени» email пользователя скрыт, оставьте false.
const WEB_REQUIRE_EDITOR = false;
