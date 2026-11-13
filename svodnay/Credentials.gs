/**
 * Credentials.gs — хранение Seller ID (Client-Id) и API-ключа Ozon.
 *
 * Значения лежат в Script Properties: переживают перезагрузку страницы и доступны триггерам,
 * поэтому вводить их повторно не нужно. Видны только редакторам скрипта.
 */

function ozonGetClientId_() {
  const value = PropertiesService.getScriptProperties().getProperty(OZON_CONFIG.clientIdProperty);
  if (!value) throw new Error('Не задан Seller ID. Меню «Ozon» → «1.1 Добавить Seller ID».');
  return value.trim();
}

function ozonGetApiKey_() {
  const value = PropertiesService.getScriptProperties().getProperty(OZON_CONFIG.apiKeyProperty);
  if (!value) throw new Error('Не задан API-ключ. Меню «Ozon» → «1. Добавить API-ключ».');
  return value.trim();
}

function ozonHasClientId_() {
  return !!PropertiesService.getScriptProperties().getProperty(OZON_CONFIG.clientIdProperty);
}

function ozonHasApiKey_() {
  return !!PropertiesService.getScriptProperties().getProperty(OZON_CONFIG.apiKeyProperty);
}

/** Имя листа с итоговой таблицей (можно переопределить в Script Properties: OZON_SHEET_NAME). */
function ozonGetOutputSheetName_() {
  return (
    PropertiesService.getScriptProperties().getProperty(OZON_CONFIG.sheetNameProperty) ||
    OZON_CONFIG.defaultSheetName
  ).trim();
}

/** Маска для показа в интерфейсе: видны только последние 4 символа. */
function ozonMask_(value) {
  const s = String(value || '');
  if (s.length <= 4) return '****';
  return '••••' + s.slice(-4);
}

/** Seller ID в Ozon — число (например 123456). */
function ozonValidateClientId_(value) {
  return /^\d{3,}$/.test(value);
}

/** API-ключ Ozon — как правило UUID, но не требуем строго: достаточно длины и отсутствия пробелов. */
function ozonValidateApiKey_(value) {
  return value.length >= 16 && !/\s/.test(value);
}

/**
 * Универсальный диалог ввода значения и сохранения в Script Properties.
 * @param {string} property  ключ в Script Properties
 * @param {string} title     заголовок окна
 * @param {string} prompt    подсказка
 * @param {function} validate  функция проверки значения
 * @param {string} errorText текст при неверном формате
 * @param {boolean} mustExist  true = «заменить» (значение должно уже существовать), false = «добавить» (не должно)
 */
function ozonPromptAndSave_(property, title, prompt, validate, errorText, mustExist) {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getScriptProperties();
  const exists = !!props.getProperty(property);

  if (!mustExist && exists) {
    ui.alert(title, 'Значение уже сохранено. Для изменения используйте пункты «Заменить».', ui.ButtonSet.OK);
    return false;
  }
  if (mustExist && !exists) {
    ui.alert(title, 'Значение ещё не задано. Сначала используйте пункты «Добавить».', ui.ButtonSet.OK);
    return false;
  }

  const answer = ui.prompt(title, prompt, ui.ButtonSet.OK_CANCEL);
  if (answer.getSelectedButton() !== ui.Button.OK) return false;

  const value = String(answer.getResponseText() || '').trim();
  if (!validate(value)) {
    ui.alert('Ошибка', errorText, ui.ButtonSet.OK);
    return false;
  }
  props.setProperty(property, value);
  return true;
}

/** После сохранения: если заданы оба значения — проверяем доступ и сообщаем результат. */
function ozonAfterCredentialsSaved_(savedWhat) {
  const ui = SpreadsheetApp.getUi();
  if (!ozonHasClientId_() || !ozonHasApiKey_()) {
    ui.alert('Сохранено', savedWhat + ' сохранён(о).\nОсталось добавить ' +
      (ozonHasClientId_() ? 'API-ключ' : 'Seller ID') + '.', ui.ButtonSet.OK);
    return;
  }
  const check = ozonCheckConnection_();
  ui.alert(check.ok ? 'Готово' : 'Сохранено, но доступ не подтверждён',
    savedWhat + ' сохранён(о).\n' + check.message, ui.ButtonSet.OK);
}

// ---------- Обработчики пунктов меню ----------

/** 1. Добавить API-ключ */
function ozonMenuAddApiKey() {
  if (ozonPromptAndSave_(OZON_CONFIG.apiKeyProperty, 'Добавить API-ключ',
      'Введите API-ключ Ozon (Seller → Настройки → API-ключи):',
      ozonValidateApiKey_, 'Ключ выглядит неверно: минимум 16 символов, без пробелов.', false)) {
    ozonAfterCredentialsSaved_('API-ключ');
  }
}

/** 1.1 Добавить Seller ID */
function ozonMenuAddClientId() {
  if (ozonPromptAndSave_(OZON_CONFIG.clientIdProperty, 'Добавить Seller ID',
      'Введите Seller ID (Client-Id) — число из раздела API-ключей:',
      ozonValidateClientId_, 'Seller ID должен состоять только из цифр.', false)) {
    ozonAfterCredentialsSaved_('Seller ID');
  }
}

/** 2. Заменить API-ключ */
function ozonMenuReplaceApiKey() {
  if (ozonPromptAndSave_(OZON_CONFIG.apiKeyProperty, 'Заменить API-ключ',
      'Введите новый API-ключ Ozon:',
      ozonValidateApiKey_, 'Ключ выглядит неверно: минимум 16 символов, без пробелов.', true)) {
    ozonAfterCredentialsSaved_('Новый API-ключ');
  }
}

/** 2.1 Заменить Seller ID */
function ozonMenuReplaceClientId() {
  if (ozonPromptAndSave_(OZON_CONFIG.clientIdProperty, 'Заменить Seller ID',
      'Введите новый Seller ID (Client-Id):',
      ozonValidateClientId_, 'Seller ID должен состоять только из цифр.', true)) {
    ozonAfterCredentialsSaved_('Новый Seller ID');
  }
}

/** 3. Удалить API-ключ и Seller ID (заодно отключает автообновление и сбрасывает незавершённый запуск) */
function ozonMenuRemoveCredentials() {
  const ui = SpreadsheetApp.getUi();
  const answer = ui.alert('Удалить доступы',
    'Будут удалены API-ключ и Seller ID, отключено автообновление.\nДанные на листе «' +
    ozonGetOutputSheetName_() + '» останутся. Продолжить?', ui.ButtonSet.YES_NO);
  if (answer !== ui.Button.YES) return;

  const props = PropertiesService.getScriptProperties();
  props.deleteProperty(OZON_CONFIG.apiKeyProperty);
  props.deleteProperty(OZON_CONFIG.clientIdProperty);
  ozonDisableAutoUpdate_();
  ozonResetFailedRun();
  ui.alert('Готово', 'API-ключ и Seller ID удалены, автообновление отключено.', ui.ButtonSet.OK);
}
