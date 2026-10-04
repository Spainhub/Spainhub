/**********************************************************************
 * Auth.gs
 * ЕДИНОЕ МЕСТО ХРАНЕНИЯ И ВВОДА API-КЛЮЧЕЙ
 *
 * Все методы проекта (WB P&L, WB-доп.отчёты, Ozon-отчёты) берут ключи
 * ТОЛЬКО отсюда. Ввод и просмотр — только через меню:
 *   "Отчёты МП" → "1. Добавить API-ключ" → ...
 *
 * Хранение: PropertiesService.getUserProperties() — ключ привязан к
 * пользователю, который его ввёл (у каждого пользователя таблицы —
 * свои ключи, они не видны другим соавторам).
 *
 * ВАЖНО про токен Wildberries: разные методы WB API требуют разные
 * категории токена (например, "Финансы" для отчётов реализации и
 * эквайринга, "Цены и скидки" для списка товаров). Формально это один
 * и тот же токен, если при создании в личном кабинете WB вы включили
 * в него все нужные категории — тогда достаточно ввести его один раз
 * здесь, и он будет работать для всех методов WB в этом проекте.
 **********************************************************************/

const AUTH_PROP_WB_TOKEN    = 'WB_TOKEN';
const AUTH_PROP_OZON_CLIENT = 'OZON_CLIENT_ID';
const AUTH_PROP_OZON_APIKEY = 'OZON_API_KEY';

/* ---------------------- Wildberries ---------------------- */

/** Пункт меню: ввести/заменить токен Wildberries. */
function Auth_setWbToken() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getUserProperties();
  const current = props.getProperty(AUTH_PROP_WB_TOKEN);

  const res = ui.prompt(
    'Wildberries API токен',
    'Вставьте токен продавца (категории «Финансы», «Цены и скидки», «Маркетплейс»):' +
      (current ? '\n\nСейчас сохранён токен, оканчивающийся на «...' + current.slice(-6) + '».' : ''),
    ui.ButtonSet.OK_CANCEL
  );
  if (res.getSelectedButton() !== ui.Button.OK) return;

  const token = res.getResponseText().trim();
  if (!token) { ui.alert('Токен пустой.'); return; }

  props.setProperty(AUTH_PROP_WB_TOKEN, token);
  ui.alert('Токен Wildberries сохранён. Он будет использован во всех методах WB.');
}

/** Пункт меню: удалить сохранённый токен Wildberries. */
function Auth_removeWbToken() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getUserProperties();
  if (!props.getProperty(AUTH_PROP_WB_TOKEN)) { ui.alert('Токен Wildberries не сохранён.'); return; }
  const res = ui.alert('Удалить токен Wildberries?',
    'Загрузка данных WB перестанет работать, пока вы не введёте токен снова.', ui.ButtonSet.YES_NO);
  if (res !== ui.Button.YES) return;
  props.deleteProperty(AUTH_PROP_WB_TOKEN);
  ui.alert('Токен Wildberries удалён.');
}

/** Возвращает сохранённый токен WB или бросает понятную ошибку. */
function Auth_getWbToken() {
  const t = PropertiesService.getUserProperties().getProperty(AUTH_PROP_WB_TOKEN);
  if (!t) {
    throw new Error(
      'Токен Wildberries не задан. Меню «Отчёты МП» → «1. Добавить API-ключ» → «1.1 Добавить токен Wildberries API».'
    );
  }
  return t;
}

/* ------------------------- Ozon --------------------------- */

/** Пункт меню: ввести/заменить Client-Id и Api-Key Ozon. */
function Auth_setOzonCredentials() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getUserProperties();

  const curClient = props.getProperty(AUTH_PROP_OZON_CLIENT);
  const r1 = ui.prompt(
    'Ozon: Client-Id',
    'Вставьте Client-Id продавца' + (curClient ? ' (сейчас: ' + curClient + ')' : '') + ':',
    ui.ButtonSet.OK_CANCEL
  );
  if (r1.getSelectedButton() !== ui.Button.OK) return;
  const clientId = r1.getResponseText().trim();
  if (!clientId) { ui.alert('Client-Id пустой.'); return; }

  const curKey = props.getProperty(AUTH_PROP_OZON_APIKEY);
  const r2 = ui.prompt(
    'Ozon: Api-Key',
    'Вставьте Api-Key продавца' +
      (curKey ? ' (сейчас оканчивается на «...' + curKey.slice(-6) + '»)' : '') + ':',
    ui.ButtonSet.OK_CANCEL
  );
  if (r2.getSelectedButton() !== ui.Button.OK) return;
  const apiKey = r2.getResponseText().trim();
  if (!apiKey) { ui.alert('Api-Key пустой.'); return; }

  props.setProperty(AUTH_PROP_OZON_CLIENT, clientId);
  props.setProperty(AUTH_PROP_OZON_APIKEY, apiKey);
  ui.alert('Ключи Ozon сохранены. Они будут использованы во всех методах Ozon.');
}

/** Пункт меню: удалить сохранённые Client-Id и Api-Key Ozon. */
function Auth_removeOzonCredentials() {
  const ui = SpreadsheetApp.getUi();
  const props = PropertiesService.getUserProperties();
  if (!props.getProperty(AUTH_PROP_OZON_CLIENT) && !props.getProperty(AUTH_PROP_OZON_APIKEY)) {
    ui.alert('Ключи Ozon не сохранены.');
    return;
  }
  const res = ui.alert('Удалить токен и ID Ozon?',
    'Загрузка данных Ozon перестанет работать, пока вы не введёте ключи снова.', ui.ButtonSet.YES_NO);
  if (res !== ui.Button.YES) return;
  props.deleteProperty(AUTH_PROP_OZON_CLIENT);
  props.deleteProperty(AUTH_PROP_OZON_APIKEY);
  ui.alert('Client-Id и Api-Key Ozon удалены.');
}

/** Возвращает { clientId, apiKey } для Ozon или бросает понятную ошибку. */
function Auth_getOzonCredentials() {
  const props = PropertiesService.getUserProperties();
  const clientId = props.getProperty(AUTH_PROP_OZON_CLIENT);
  const apiKey = props.getProperty(AUTH_PROP_OZON_APIKEY);
  if (!clientId || !apiKey) {
    throw new Error(
      'Ключи Ozon не заданы. Меню «Отчёты МП» → «1. Добавить API-ключ» → «1.3 Добавить Ozon: Client-ID и API-ключ».'
    );
  }
  return { clientId: clientId, apiKey: apiKey };
}
