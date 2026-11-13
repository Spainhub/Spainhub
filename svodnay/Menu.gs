/**
 * Menu.gs — пользовательское меню таблицы.
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Ozon')
    .addItem('1. Добавить API-ключ', 'ozonMenuAddApiKey')
    .addItem('1.1 Добавить Seller ID', 'ozonMenuAddClientId')
    .addSeparator()
    .addItem('2. Заменить API-ключ', 'ozonMenuReplaceApiKey')
    .addItem('2.1 Заменить Seller ID', 'ozonMenuReplaceClientId')
    .addSeparator()
    .addItem('3. Удалить API-ключ и Seller ID', 'ozonMenuRemoveCredentials')
    .addSeparator()
    .addSubMenu(SpreadsheetApp.getUi().createMenu('4. Включить обновление данных')
      .addItem('Обновить сейчас', 'ozonMenuRunFull')
      .addSeparator()
      .addItem('Включить автообновление: раз в сутки', 'ozonMenuEnableDaily')
      .addItem('Включить автообновление: каждый час', 'ozonMenuEnableHourly')
      .addItem('Отключить автообновление', 'ozonMenuDisableAuto')
      .addSeparator()
      .addItem('Статус', 'ozonMenuStatus')
      .addItem('Сбросить зависший запуск', 'ozonMenuResetFailedRun')
      .addItem('Удалить служебные листы', 'ozonMenuDeleteTemporarySheets'))
    .addToUi();
}

/** Проверка, что оба значения доступа заданы; иначе подсказываем что делать. */
function ozonEnsureCredentialsOrAlert_() {
  if (ozonHasClientId_() && ozonHasApiKey_()) return true;
  SpreadsheetApp.getUi().alert('Нет доступа к Ozon',
    'Сначала добавьте ' + (ozonHasApiKey_() ? '' : 'API-ключ (пункт 1) ') +
    (ozonHasClientId_() ? '' : 'Seller ID (пункт 1.1)') + '.', SpreadsheetApp.getUi().ButtonSet.OK);
  return false;
}

function ozonMenuRunFull() {
  if (!ozonEnsureCredentialsOrAlert_()) return;
  const ui = SpreadsheetApp.getUi();
  ui.alert('Обновление запущено',
    'Загрузка идёт до ~4 минут. Если данных много, скрипт продолжит работу сам через триггеры.', ui.ButtonSet.OK);
  runOzonFull();
  const state = ozonGetState_();
  if (!state) {
    ui.alert('Готово', 'Данные обновлены на листе «' + ozonGetOutputSheetName_() + '».', ui.ButtonSet.OK);
  } else {
    ui.alert('Продолжение в фоне',
      'Этап: ' + state.phase + '. Загрузка продолжится автоматически, лист обновится по завершении.', ui.ButtonSet.OK);
  }
}

function ozonMenuEnableDaily() {
  if (!ozonEnsureCredentialsOrAlert_()) return;
  ozonEnableAutoUpdate_('daily');
  SpreadsheetApp.getUi().alert('Автообновление включено: ежедневно около ' + OZON_CONFIG.dailyTriggerHour + ':00 (' + OZON_CONFIG.timezone + ').');
}

function ozonMenuEnableHourly() {
  if (!ozonEnsureCredentialsOrAlert_()) return;
  ozonEnableAutoUpdate_('hourly');
  SpreadsheetApp.getUi().alert('Автообновление включено: каждый час.');
}

function ozonMenuDisableAuto() {
  ozonDisableAutoUpdate_();
  SpreadsheetApp.getUi().alert('Автообновление отключено.');
}

function ozonMenuResetFailedRun() {
  ozonResetFailedRun();
  SpreadsheetApp.getUi().alert('Состояние запуска сброшено.');
}

function ozonMenuDeleteTemporarySheets() {
  ozonDeleteTemporarySheets_();
  SpreadsheetApp.getUi().alert('Служебные листы Ozon удалены.');
}

/** Сводка: что настроено, расписание, состояние текущего/последнего запуска. */
function ozonMenuStatus() {
  const props = PropertiesService.getScriptProperties();
  const mode = ozonGetAutoUpdateMode_();
  const state = ozonGetState_();
  const lines = [
    'Seller ID: ' + (ozonHasClientId_() ? ozonMask_(props.getProperty(OZON_CONFIG.clientIdProperty)) : 'не задан'),
    'API-ключ: ' + (ozonHasApiKey_() ? ozonMask_(props.getProperty(OZON_CONFIG.apiKeyProperty)) : 'не задан'),
    'Автообновление: ' + (mode === 'daily' ? 'ежедневно' : mode === 'hourly' ? 'каждый час' : 'выключено'),
    'Лист с данными: ' + ozonGetOutputSheetName_(),
    'Запуск: ' + (state ? state.status + ', этап ' + state.phase + (state.lastError ? '\nПоследняя ошибка: ' + String(state.lastError).slice(0, 300) : '') : 'нет активного запуска')
  ];
  SpreadsheetApp.getUi().alert('Статус', lines.join('\n'), SpreadsheetApp.getUi().ButtonSet.OK);
}
