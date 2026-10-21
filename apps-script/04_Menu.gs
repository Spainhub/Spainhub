/**********************************************************************
 * 04_Menu.gs — МЕНЮ «Отчёты МП», открытие Web App (doGet)
 *
 * Единое меню проекта. Ключи API вводятся в ОДНОМ месте — подменю
 * «Wildberries» / «Ozon» (см. 03_Auth.gs). Загрузчики данных лежат в
 * файлах 05–08, контроль данных — 09_Data_Check.gs.
 **********************************************************************/
function onOpen() {
  const ui = SpreadsheetApp.getUi();
  ui.createMenu('Отчёты МП')
    .addSubMenu(
      ui.createMenu('Wildberries')
        .addItem('Добавить API-ключ', 'Auth_setWbToken')
        .addItem('Удалить токен Wildberries API', 'Auth_removeWbToken')
        .addItem('Загрузить данные за 3 месяца (первый запуск)', 'firstRun')
        .addItem('Включить ежедневную автозагрузку (6:00 МСК)', 'installDailyTrigger')
    )
    .addSubMenu(
      ui.createMenu('Ozon')
        .addItem('Добавить Ozon Client ID', 'Auth_setOzonCredentials')
        .addItem('Удалить токен и ID Ozon', 'Auth_removeOzonCredentials')
        .addItem('Загрузить данные за 3 месяца (первый запуск)', 'OzFin1_firstRun')
        .addItem('Включить ежемесячную автозагрузку (10-го числа)', 'OzFin1_installMonthlyTrigger')
    )
    .addSeparator()
    .addItem('Открыть отчёт', 'openWebApp')
    .addSeparator()
    .addSubMenu(
      ui.createMenu('Листы')
        .addItem('Проверить структуру листов', 'Setup_checkSheets')
        .addItem('Создать недостающие листы', 'Setup_createMissing')
        .addItem('Расставить листы по порядку', 'Setup_orderSheets')
        .addSeparator()
        .addItem('Создать шапку листа ТОВАРЫ', 'Goods_setupSheet')
        .addItem('Формулы активного листа → на русском', 'Formulas_activeSheetToRussian')
        .addItem('Обновить INFO', 'Info_build')
    )
    .addSubMenu(
      ui.createMenu('Дополнительно')
        .addItem('Wildberries: обновить за последние дни (сейчас)', 'dailyUpdate')
        .addItem('Wildberries: загрузить за период...', 'loadCustomPeriod')
        .addItem('Wildberries: очистить старше 3 месяцев', 'cleanupOldRows')
        .addItem('Wildberries: список товаров (SKU_WB)', 'WbSku_loadGoods')
        .addItem('Wildberries: финансовый отчёт (эквайринг)', 'WbAcq2_loadReport')
        .addItem('Ozon: список товаров (SKU_OZ)', 'OzSku_loadProducts')
        .addSeparator()
        .addItem('Контроль данных: проверить пропуски', 'Gap_checkMenu')
        .addItem('Контроль данных: дозагрузить пропуски', 'Gap_healMenu')
    )
    .addToUi();
}

function openWebApp() {
  const url = ScriptApp.getService().getUrl();
  if (!url) {
    SpreadsheetApp.getUi().alert(
      'Web App ещё не развёрнут.\n\n' +
      'Развернуть → Новое развёртывание → Веб-приложение.'
    );
    return;
  }
  const html = HtmlService.createHtmlOutput(
    `<script>window.open('${url}', '_blank');google.script.host.close();</script>`
  ).setWidth(100).setHeight(50);
  SpreadsheetApp.getUi().showModalDialog(html, 'Открываю отчёт...');
}

/** Точка входа Web App: страница Index.html (стили и скрипты — HTML-файлы Css, Js_*). */
function doGet(e) {
  const tmpl = HtmlService.createTemplateFromFile('Index');
  return tmpl.evaluate()
    .setTitle('P&L Report Wildberries')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/** Вставка HTML-файла проекта в шаблон: <?!= include('Css') ?> */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}
