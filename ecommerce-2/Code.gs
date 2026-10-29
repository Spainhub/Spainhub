/**
 * E-commerce 2.0 — система управления проектом.
 * Серверная часть (Google Apps Script). Google Sheets используется как база данных.
 *
 * Файлы проекта: Code.gs, Index.html, Styles.html, JavaScript.html, appsscript.json
 *
 * Все публичные методы (без «_» в конце имени) доступны клиенту через google.script.run
 * и возвращают JSON-совместимый объект: { ok: true, data } или { ok: false, error }.
 * Функции с «_» на конце — внутренние, из браузера они недоступны.
 */

/* ============================================================================
 * 1. КОНФИГУРАЦИЯ И СХЕМА ДАННЫХ
 * ========================================================================== */

var APP_TITLE = 'E-commerce 2.0';
var DEFAULT_PASSWORD = '2026';          // значение по умолчанию, хранится в Script Properties (APP_PASSWORD)
var SESSION_TTL_SEC = 21600;            // время жизни сессии (максимум для CacheService — 6 часов)
var MAX_FAILS = 5;                      // число неудачных попыток входа до временной блокировки
var LOCK_SEC = 300;                     // длительность блокировки входа, сек
var DT_FORMAT = 'yyyy-MM-dd HH:mm:ss';  // формат метки времени в таблице (хранится текстом)

/** Справочники значений. value — что пишется в таблицу, label — что видит пользователь. */
var ENUMS = {
  status: [
    { value: 'Not Started', label: 'Не начато' },
    { value: 'In Progress', label: 'В работе' },
    { value: 'Under Review', label: 'На проверке' },
    { value: 'Done', label: 'Готово' },
    { value: 'Blocked', label: 'Заблокировано' }
  ],
  meeting_status: [
    { value: 'Planned', label: 'Запланирована' },
    { value: 'Held', label: 'Проведена' },
    { value: 'Cancelled', label: 'Отменена' }
  ],
  approval_status: [
    { value: 'Pending', label: 'Ожидает решения' },
    { value: 'In Progress', label: 'В процессе' },
    { value: 'Approved', label: 'Согласовано' },
    { value: 'Rejected', label: 'Отклонено' }
  ],
  task_type: ['Разработка', 'Дизайн', 'Контент', 'Логистика', 'Маркетинг', 'Аналитика', 'Прочее'].map(function (x) {
    return { value: x, label: x };
  }),
  link_type: [
    { value: 'parent', label: 'Входит в' },
    { value: 'blocks', label: 'Блокирует' },
    { value: 'handoff', label: 'Передаёт информацию' },
    { value: 'approval', label: 'Требует согласования' },
    { value: 'related', label: 'Связан с' }
  ],
  // Варианты голоса участника (значение хранится в ApprovalsRegister.vote)
  vote: [
    { value: 'Agree', label: 'Согласен' },
    { value: 'Discussed', label: 'Обсуждение' },
    { value: 'No Decision', label: 'Нет решения' },
    { value: 'Disagree', label: 'Не согласен' }
  ]
};

/** Варианты связи в форме создания: направление считается относительно СОЗДАВАЕМОГО объекта. */
var CREATE_LINK_OPTIONS = [
  { value: 'parent', label: 'Входит в (родитель)' },
  { value: 'blocks_in', label: 'Блокируется объектом' },
  { value: 'blocks_out', label: 'Блокирует объект' },
  { value: 'handoff_in', label: 'Получает информацию от' },
  { value: 'handoff_out', label: 'Передаёт информацию в' },
  { value: 'approval_out', label: 'Требует согласования (выбрать согласование)' },
  { value: 'approval_in', label: 'Является согласованием для' },
  { value: 'related', label: 'Связан с' }
];

/** Как вариант из формы создания превращается в запись Links: dir 'out' — новый объект источник, 'in' — получатель. */
var CREATE_LINK_MAP = {
  parent: { dir: 'out', type: 'parent' },
  blocks_in: { dir: 'in', type: 'blocks' }, blocks_out: { dir: 'out', type: 'blocks' },
  handoff_in: { dir: 'in', type: 'handoff' }, handoff_out: { dir: 'out', type: 'handoff' },
  approval_in: { dir: 'in', type: 'approval' }, approval_out: { dir: 'out', type: 'approval' },
  related: { dir: 'out', type: 'related' }
};

/**
 * Описание полей. Один справочник — для валидации на сервере и для генерации форм на клиенте.
 * type: text | textarea | date | time | select | user | bool | progress
 */
var FIELDS = {
  name:         { label: 'Название', type: 'text', required: true, max: 200 },
  description:  { label: 'Описание', type: 'textarea', required: true, max: 5000 },
  task_type:    { label: 'Тип задачи', type: 'select', enum: 'task_type' },
  assignee:     { label: 'Исполнитель', type: 'user' },
  start_date:   { label: 'Дата начала', type: 'date' },
  deadline:     { label: 'Срок (дедлайн)', type: 'date', required: true },
  status:       { label: 'Статус', type: 'select', enum: 'status', dflt: 'Not Started', required: true },
  progress:     { label: 'Прогресс, %', type: 'progress', dflt: 0 },
  blocked:      { label: 'Заблокировано', type: 'bool', dflt: false },
  blocked_by:   { label: 'Кем заблокировано', type: 'user', showIf: 'blocked' },
  block_reason: { label: 'Причина блокировки', type: 'textarea', showIf: 'blocked', max: 2000 },
  comment:      { label: 'Комментарий', type: 'textarea', max: 5000 },
  meeting_date: { label: 'Дата встречи', type: 'date', required: true },
  meeting_time: { label: 'Начало', type: 'time', required: true },
  end_time:     { label: 'Окончание', type: 'time' },
  participants: { label: 'Участники (через запятую)', type: 'textarea', max: 2000 },
  location:     { label: 'Место / ссылка на звонок', type: 'text', max: 500 },
  initiator:    { label: 'Инициатор', type: 'user', required: true },
  approver:     { label: 'Согласующий', type: 'user', required: true }
};

var COMMON_WORK_FIELDS = ['name', 'description', 'assignee', 'start_date', 'deadline', 'status', 'progress',
  'blocked', 'blocked_by', 'block_reason', 'comment'];

/**
 * Типы сущностей. fields — порядок полей в форме и в листе (после столбца id).
 * overrides — переопределения описания поля для конкретного типа.
 */
var TYPES = {
  stage: {
    sheet: 'Stages', prefix: 'STG', label: 'Этап', newLabel: 'Новый этап',
    fields: COMMON_WORK_FIELDS, overrides: {}
  },
  task: {
    sheet: 'Tasks', prefix: 'TSK', label: 'Задача', newLabel: 'Новая задача',
    fields: ['name', 'description', 'task_type', 'assignee', 'start_date', 'deadline', 'status', 'progress',
      'blocked', 'blocked_by', 'block_reason', 'comment'],
    overrides: {}
  },
  subtask: {
    sheet: 'Subtasks', prefix: 'SUB', label: 'Подзадача', newLabel: 'Новая подзадача',
    fields: COMMON_WORK_FIELDS, overrides: {}
  },
  meeting: {
    sheet: 'Meetings', prefix: 'MTG', label: 'Встреча', newLabel: 'Новая встреча',
    fields: ['name', 'description', 'assignee', 'meeting_date', 'meeting_time', 'end_time', 'participants',
      'location', 'status', 'comment'],
    overrides: {
      assignee: { label: 'Организатор' },
      status: { enum: 'meeting_status', dflt: 'Planned' }
    }
  },
  approval: {
    sheet: 'Approvals', prefix: 'APR', label: 'Согласование', newLabel: 'Новое согласование',
    fields: ['name', 'description', 'initiator', 'approver', 'assignee', 'deadline', 'status',
      'blocked', 'blocked_by', 'block_reason', 'comment'],
    overrides: {
      assignee: { label: 'Ответственный за подготовку' },
      deadline: { label: 'Срок решения' },
      status: { enum: 'approval_status', dflt: 'Pending' },
      comment: { label: 'Комментарий / решение' }
    }
  }
};
var TYPE_ORDER = ['stage', 'task', 'subtask', 'meeting', 'approval'];

/** Кто в кого может входить (иерархия). Ключ — дочерний тип, значение — допустимые родительские типы. */
var PARENT_RULES = {
  task: ['stage'],
  subtask: ['task'],
  approval: ['stage', 'task', 'subtask'],
  meeting: ['stage', 'task', 'subtask']
};

/** Служебные листы: имя листа -> столбцы. */
var AUX = {
  Links: ['link_id', 'source_id', 'source_type', 'target_id', 'target_type', 'link_type', 'note', 'created_by', 'created_at'],
  Documents: ['doc_id', 'entity_id', 'entity_type', 'doc_name', 'doc_url', 'added_by', 'created_at'],
  Users: ['name', 'email', 'role'],
  Log: ['timestamp', 'user', 'action', 'entity_type', 'entity_id', 'field', 'old_value', 'new_value'],
  Settings: ['key', 'value'],
  // Реестр согласований: одна строка = один участник голосования по одному согласованию
  ApprovalsRegister: ['approval_id', 'title', 'initiator', 'created_at', 'deadline', 'status',
    'voter', 'vote', 'vote_comment', 'vote_date']
};

/** Свободный лист «Файлы проекта»: читается диапазон A1:K50 (название папки + ссылка). */
var INFO_SHEET = 'Info';
var INFO_ROWS = 50;
var INFO_COLS = 11;

/** Колонка Kanban -> статус. Колонка «awaiting» заполняется автоматически (просрочка), статуса у неё нет. */
var KANBAN_STATUS = { progress: 'In Progress', planned: 'Not Started', done: 'Done' };

/** Столбцы, которые НЕ переводятся в текстовый формат (остальные хранятся как текст, чтобы Sheets не «портил» даты). */
var NON_TEXT_COLS = { progress: true, blocked: true };

/** Ключи настроек, разрешённые к изменению из интерфейса. */
var SETTING_KEYS = ['project_description'];

var SS_CACHE_ = null;

/* ============================================================================
 * 2. ТОЧКИ ВХОДА (Web App) И МЕНЮ
 * ========================================================================== */

/** Отдаёт страницу приложения. Параметр ?api=ping — проверка работоспособности в формате JSON. */
function doGet(e) {
  if (e && e.parameter && e.parameter.api === 'ping') {
    return jsonOut_({ ok: true, data: 'pong' });
  }
  setupIfNeeded_();
  var tpl = HtmlService.createTemplateFromFile('Index');
  return tpl.evaluate()
    .setTitle(APP_TITLE)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1')
    .setSandboxMode(HtmlService.SandboxMode.IFRAME);
}

/**
 * JSON-API для внешних клиентов: POST с телом {"action":"getAllData","args":["<token>"]}.
 * Список допустимых действий — в apiTable_().
 */
function doPost(e) {
  var out;
  try {
    var req = JSON.parse(e.postData.contents);
    var fn = apiTable_()[req.action];
    out = fn ? fn.apply(null, req.args || []) : { ok: false, error: 'Неизвестное действие: ' + req.action };
  } catch (err) {
    out = { ok: false, error: String(err && err.message || err) };
  }
  return jsonOut_(out);
}

function apiTable_() {
  return {
    login: login, logout: logout, checkSession: checkSession,
    getAllData: getAllData, getLog: getLog,
    createEntity: createEntity, updateEntity: updateEntity, deleteEntity: deleteEntity,
    createLink: createLink, updateLink: updateLink, deleteLink: deleteLink, setParent: setParent,
    addDocument: addDocument, updateDocument: updateDocument, deleteDocument: deleteDocument,
    addUser: addUser, saveSetting: saveSetting,
    getInfo: getInfo, getApprovalsRegister: getApprovalsRegister, setApprovalVoters: setApprovalVoters,
    castVote: castVote, moveTask: moveTask, getExchangeCards: getExchangeCards
  };
}

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Подключение частей HTML (<?!= include('Styles') ?>). */
function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

/** Меню таблицы (работает, если скрипт привязан к таблице). */
function onOpen() {
  try {
    SpreadsheetApp.getUi().createMenu(APP_TITLE)
      .addItem('Инициализировать листы', 'setup')
      .addItem('Загрузить демо-данные', 'seedDemo')
      .addItem('Пересчитать реестр согласований', 'syncApprovalsRegister')
      .addItem('Сменить пароль входа', 'changePasswordDialog')
      .addToUi();
  } catch (e) { /* автономный скрипт — меню не нужно */ }
  setupIfNeeded_();
}

/* ============================================================================
 * 3. ИНИЦИАЛИЗАЦИЯ ТАБЛИЦЫ
 * ========================================================================== */

/** Таблица базы данных: привязанная к скрипту, иначе по SPREADSHEET_ID, иначе создаётся новая. */
function ss_() {
  if (SS_CACHE_) return SS_CACHE_;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    var props = PropertiesService.getScriptProperties();
    var id = props.getProperty('SPREADSHEET_ID');
    if (id) {
      ss = SpreadsheetApp.openById(id);
    } else {
      ss = SpreadsheetApp.create(APP_TITLE + ' — база данных');
      props.setProperty('SPREADSHEET_ID', ss.getId());
    }
  }
  SS_CACHE_ = ss;
  return ss;
}

/** Список всех листов и их столбцов. */
function sheetDefs_() {
  var defs = {};
  TYPE_ORDER.forEach(function (t) { defs[TYPES[t].sheet] = headersForType_(t); });
  Object.keys(AUX).forEach(function (n) { defs[n] = AUX[n]; });
  return defs;
}

function headersForType_(type) {
  return ['id'].concat(TYPES[type].fields).concat(['created_at', 'updated_at']);
}

/**
 * Создаёт недостающие листы и столбцы (идемпотентно, существующие данные не трогает).
 * Запускается автоматически при первом открытии и из меню.
 */
function setup() {
  var ss = ss_();
  var defs = sheetDefs_();
  Object.keys(defs).forEach(function (name) { ensureSheet_(ss, name, defs[name]); });

  // Убираем пустой стандартный лист
  ['Sheet1', 'Лист1'].forEach(function (n) {
    var sh = ss.getSheetByName(n);
    if (sh && ss.getSheets().length > 1 && sh.getLastRow() === 0) ss.deleteSheet(sh);
  });

  ensureInfoSheet_(ss);

  var props = PropertiesService.getScriptProperties();
  if (props.getProperty('APP_PASSWORD') === null) props.setProperty('APP_PASSWORD', DEFAULT_PASSWORD);
  if (props.getProperty('SESSION_EPOCH') === null) props.setProperty('SESSION_EPOCH', '0');
  if (!getSettings_().project_description) {
    setSetting_('project_description', 'Запуск и развитие интернет-магазина: этапы, задачи, согласования и встречи команды.');
  }
  props.setProperty('SETUP_DONE', '1');
  return { ok: true, data: 'Листы подготовлены' };
}

function setupIfNeeded_() {
  if (PropertiesService.getScriptProperties().getProperty('SETUP_DONE') !== '1') setup();
}

/** Лист Info создаётся пустым (структуру задаёт пользователь), в A1 — подсказка-примечание. */
function ensureInfoSheet_(ss) {
  var sh = ss.getSheetByName(INFO_SHEET);
  if (!sh) {
    sh = ss.insertSheet(INFO_SHEET);
    sh.getRange(1, 1).setNote('Столбец A — название папки, столбец B — ссылка (http/https). ' +
      'Читается диапазон A1:K50; ячейку можно оформить и как гиперссылку. ' +
      'Строка с одним названием без ссылки показывается как заголовок группы.');
  }
  return sh;
}

/** Создаёт лист, дописывает недостающие заголовки, оформляет шапку и текстовый формат столбцов. */
function ensureSheet_(ss, name, headers) {
  var sh = ss.getSheetByName(name) || ss.insertSheet(name);
  var lastCol = sh.getLastColumn();
  var existing = lastCol > 0 ? sh.getRange(1, 1, 1, lastCol).getValues()[0].map(String) : [];
  var changed = false;
  headers.forEach(function (h) {
    if (existing.indexOf(h) === -1) { existing.push(h); changed = true; }
  });
  if (changed) sh.getRange(1, 1, 1, existing.length).setValues([existing]);

  sh.getRange(1, 1, 1, existing.length).setFontWeight('bold').setBackground('#eef1f6');
  sh.setFrozenRows(1);
  var rows = Math.max(sh.getMaxRows() - 1, 1);
  existing.forEach(function (h, i) {
    if (h && !NON_TEXT_COLS[h]) sh.getRange(2, i + 1, rows, 1).setNumberFormat('@');
  });
  return sh;
}

/** Лист по имени; при отсутствии создаётся заново. */
function sheet_(name) {
  var ss = ss_();
  var sh = ss.getSheetByName(name);
  if (!sh) sh = ensureSheet_(ss, name, sheetDefs_()[name]);
  return sh;
}

/* ============================================================================
 * 4. НИЗКОУРОВНЕВАЯ РАБОТА С ЛИСТАМИ
 * ========================================================================== */

function nowStr_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), DT_FORMAT);
}

function todayStr_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function headersOf_(sh) {
  var n = sh.getLastColumn();
  return n > 0 ? sh.getRange(1, 1, 1, n).getValues()[0].map(function (h) { return String(h).trim(); }) : [];
}

/** Словарь описаний полей типа: key -> def. */
function fieldDef_(type, key) {
  var base = FIELDS[key] || { label: key, type: 'text' };
  var ov = (TYPES[type].overrides || {})[key] || {};
  var def = {};
  Object.keys(base).forEach(function (k) { def[k] = base[k]; });
  Object.keys(ov).forEach(function (k) { def[k] = ov[k]; });
  def.key = key;
  return def;
}

function defsMap_(type) {
  var m = {};
  TYPES[type].fields.forEach(function (k) { m[k] = fieldDef_(type, k); });
  return m;
}

/** Приведение значения ячейки к виду, удобному клиенту. */
function cellOut_(v, def) {
  var tz = Session.getScriptTimeZone();
  if (Object.prototype.toString.call(v) === '[object Date]') {
    if (def && def.type === 'date') return Utilities.formatDate(v, tz, 'yyyy-MM-dd');
    if (def && def.type === 'time') return Utilities.formatDate(v, tz, 'HH:mm');
    return Utilities.formatDate(v, tz, DT_FORMAT);
  }
  if (def && def.type === 'progress') { var n = Number(v); return isFinite(n) ? n : 0; }
  if (def && def.type === 'bool') return v === true || /^(true|да|1)$/i.test(String(v));
  return v === null || v === undefined ? '' : String(v);
}

/** Читает лист в массив объектов. Для строки сохраняется служебный номер _row. */
function readAll_(name, type) {
  var sh = sheet_(name);
  var cols = sh.getLastColumn();
  var last = sh.getLastRow();
  var headers = headersOf_(sh);
  var rows = [];
  if (cols > 0 && last > 1) {
    var defs = type ? defsMap_(type) : {};
    var values = sh.getRange(2, 1, last - 1, cols).getValues();
    values.forEach(function (row, i) {
      if (row[0] === '' || row[0] === null) return;   // пустая строка
      var o = { _row: i + 2 };
      headers.forEach(function (h, j) { if (h) o[h] = cellOut_(row[j], defs[h]); });
      rows.push(o);
    });
  }
  return { sh: sh, headers: headers, rows: rows };
}

/** Убирает служебные поля перед отправкой клиенту. */
function pub_(o) {
  var c = {};
  Object.keys(o).forEach(function (k) { if (k !== '_row') c[k] = o[k]; });
  return c;
}

function ser_(v) {
  return v === undefined || v === null ? '' : v;
}

function appendObj_(sh, headers, obj) {
  var row = headers.map(function (h) { return Object.prototype.hasOwnProperty.call(obj, h) ? ser_(obj[h]) : ''; });
  sh.getRange(sh.getLastRow() + 1, 1, 1, headers.length).setValues([row]);
}

function updateRow_(sh, headers, rowNum, patch) {
  var range = sh.getRange(rowNum, 1, 1, headers.length);
  var cur = range.getValues()[0];
  headers.forEach(function (h, j) {
    if (Object.prototype.hasOwnProperty.call(patch, h)) cur[j] = ser_(patch[h]);
  });
  range.setValues([cur]);
}

/**
 * Следующий идентификатор вида PREFIX-0001. Счётчик хранится в Script Properties,
 * поэтому номер удалённого объекта никогда не используется повторно.
 */
function nextId_(sheetName, prefix) {
  var props = PropertiesService.getScriptProperties();
  var key = 'SEQ_' + prefix;
  var max = parseInt(props.getProperty(key) || '0', 10);
  var sh = sheet_(sheetName);
  var last = sh.getLastRow();
  if (last > 1) {
    sh.getRange(2, 1, last - 1, 1).getValues().forEach(function (r) {
      var m = String(r[0]).match(/-(\d+)$/);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
  }
  max += 1;
  props.setProperty(key, String(max));
  return prefix + '-' + ('0000' + max).slice(-4);
}

/** Тип сущности по идентификатору (TSK-0001 -> task) или null. */
function typeOfId_(id) {
  var p = String(id || '').split('-')[0];
  for (var i = 0; i < TYPE_ORDER.length; i++) {
    if (TYPES[TYPE_ORDER[i]].prefix === p) return TYPE_ORDER[i];
  }
  return null;
}

function findEntity_(id) {
  var type = typeOfId_(id);
  if (!type) return null;
  var tbl = readAll_(TYPES[type].sheet, type);
  for (var i = 0; i < tbl.rows.length; i++) {
    if (tbl.rows[i].id === id) return { type: type, tbl: tbl, row: tbl.rows[i] };
  }
  return null;
}

/* ============================================================================
 * 5. ЖУРНАЛ ИЗМЕНЕНИЙ
 * ========================================================================== */

function logVal_(v) {
  if (v === true) return 'да';
  if (v === false) return 'нет';
  var s = v === null || v === undefined ? '' : String(v);
  return s.length > 1000 ? s.substring(0, 1000) + '…' : s;
}

/** Добавляет строки в лист Log. Строка: [action, entity_type, entity_id, field, old, new]. */
function writeLog_(user, entries) {
  if (!entries.length) return;
  var ts = nowStr_();
  var rows = entries.map(function (e) {
    return [ts, user, e[0], e[1], e[2], e[3] || '', logVal_(e[4]), logVal_(e[5])];
  });
  var sh = sheet_('Log');
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, 8).setValues(rows);
}

/**
 * История изменений. filter: { entity_type, entity_id, date_from, date_to, limit }.
 * Возвращает записи от новых к старым.
 */
function getLog(token, filter) {
  return api_(token, function () {
    filter = filter || {};
    var limit = Math.min(Math.max(Number(filter.limit) || 500, 1), 5000);
    var from = isDate_(filter.date_from) ? filter.date_from : '';
    var to = isDate_(filter.date_to) ? filter.date_to : '';
    var rows = readAll_('Log').rows.filter(function (r) {
      var day = r.timestamp.substring(0, 10);
      return (!filter.entity_type || r.entity_type === filter.entity_type) &&
        (!filter.entity_id || r.entity_id === filter.entity_id) &&
        (!from || day >= from) && (!to || day <= to);
    });
    rows.reverse();
    return { total: rows.length, rows: rows.slice(0, limit).map(pub_) };
  });
}

/* ============================================================================
 * 6. ВАЛИДАЦИЯ
 * ========================================================================== */

function isDate_(s) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return false;
  var y = +m[1], mo = +m[2], d = +m[3];
  var dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

function isTime_(s) {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(String(s || ''));
}

function enumValues_(name) {
  return (ENUMS[name] || []).map(function (x) { return x.value; });
}

/** Приводит одно значение к нужному типу; ошибки складывает в errors. */
function coerce_(def, raw, errors) {
  var v = raw === undefined || raw === null ? '' : raw;
  if (def.type === 'bool') {
    return v === true || v === 1 || /^(true|1|да)$/i.test(String(v));
  }
  if (def.type === 'progress') {
    if (v === '') return 0;
    var n = Number(v);
    if (!isFinite(n) || Math.floor(n) !== n || n < 0 || n > 100) {
      errors.push('«' + def.label + '»: целое число от 0 до 100');
      return 0;
    }
    return n;
  }
  var s = String(v).trim();
  if (!s) {
    if (def.required) errors.push('Поле «' + def.label + '» обязательно');
    return '';
  }
  var max = def.max || (def.type === 'textarea' ? 5000 : 500);
  if (s.length > max) errors.push('«' + def.label + '»: не более ' + max + ' символов');
  if (def.type === 'date' && !isDate_(s)) errors.push('«' + def.label + '»: дата в формате ГГГГ-ММ-ДД');
  if (def.type === 'time' && !isTime_(s)) errors.push('«' + def.label + '»: время в формате ЧЧ:ММ');
  if (def.type === 'select' && enumValues_(def.enum).indexOf(s) === -1) {
    errors.push('«' + def.label + '»: недопустимое значение «' + s + '»');
  }
  return s;
}

/**
 * Проверка данных сущности.
 * existing == null — создание (проверяются все поля, подставляются значения по умолчанию);
 * иначе — частичное обновление (проверяются только переданные поля).
 * Возвращает объект с очищенными значениями или бросает Error со списком ошибок.
 */
function validate_(type, data, existing) {
  var cfg = TYPES[type], errors = [], out = {};
  data = data || {};
  var has = function (k) { return cfg.fields.indexOf(k) !== -1; };

  cfg.fields.forEach(function (key) {
    var def = fieldDef_(type, key);
    var provided = Object.prototype.hasOwnProperty.call(data, key);
    if (!provided && existing) return;
    out[key] = coerce_(def, provided ? data[key] : def.dflt, errors);
  });

  var m = {};
  if (existing) Object.keys(existing).forEach(function (k) { m[k] = existing[k]; });
  Object.keys(out).forEach(function (k) { m[k] = out[k]; });

  if (m.start_date && m.deadline && m.start_date > m.deadline) {
    errors.push('Дата начала не может быть позже срока');
  }
  if (m.meeting_time && m.end_time && m.end_time <= m.meeting_time) {
    errors.push('Окончание встречи должно быть позже начала');
  }
  if (has('blocked')) {
    if (m.blocked && !String(m.block_reason || '').trim()) errors.push('Укажите причину блокировки');
    if (!m.blocked) { out.blocked_by = ''; out.block_reason = ''; }
  }
  // Статус «Готово» без явно заданного прогресса означает 100 %
  if (has('progress') && out.status === 'Done' && !Object.prototype.hasOwnProperty.call(data, 'progress')) {
    out.progress = 100;
  }

  if (errors.length) throw new Error('Проверка данных: ' + errors.join('; '));
  return out;
}

/** Имена из полей типа «user» — для автоматического пополнения справочника Users. */
function collectUsers_(type, values) {
  var names = [];
  TYPES[type].fields.forEach(function (k) {
    if (fieldDef_(type, k).type === 'user' && values[k]) names.push(values[k]);
  });
  return names;
}

/* ============================================================================
 * 7. АВТОРИЗАЦИЯ
 * ========================================================================== */

function getEpoch_() {
  return PropertiesService.getScriptProperties().getProperty('SESSION_EPOCH') || '0';
}

function safeEq_(a, b) {
  a = String(a); b = String(b);
  var diff = a.length ^ b.length;
  for (var i = 0; i < Math.max(a.length, b.length); i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function authError_() {
  var e = new Error('Требуется вход');
  e.code = 'AUTH';
  return e;
}

/** Проверяет токен сессии (CacheService), продлевает его и возвращает { user }. */
function auth_(token) {
  var cache = CacheService.getScriptCache();
  var raw = token ? cache.get('sess:' + token) : null;
  if (!raw) throw authError_();
  var s = JSON.parse(raw);
  if (String(s.epoch) !== String(getEpoch_())) throw authError_();
  cache.put('sess:' + token, raw, SESSION_TTL_SEC);
  return s;
}

/**
 * Общая обёртка API: проверка сессии, блокировка на запись, единый формат ответа.
 * opts.write = true — выполнять под LockService (защита от одновременной записи).
 */
function api_(token, fn, opts) {
  var lock = null;
  try {
    var session = auth_(token);
    if (opts && opts.write) {
      lock = LockService.getScriptLock();
      lock.waitLock(20000);
    }
    return { ok: true, data: fn(session) };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err), code: err && err.code };
  } finally {
    if (lock) lock.releaseLock();
  }
}

/** Вход по паролю. Возвращает токен сессии. */
function login(password, userName) {
  var lock = null;
  try {
    setupIfNeeded_();
    var cache = CacheService.getScriptCache();
    var fails = Number(cache.get('login_fails') || 0);
    if (fails >= MAX_FAILS) {
      return { ok: false, error: 'Слишком много неудачных попыток. Повторите через несколько минут.' };
    }
    var stored = PropertiesService.getScriptProperties().getProperty('APP_PASSWORD');
    if (!safeEq_(password || '', stored === null ? DEFAULT_PASSWORD : stored)) {
      cache.put('login_fails', String(fails + 1), LOCK_SEC);
      return { ok: false, error: 'Неверный пароль' };
    }
    cache.remove('login_fails');

    var user = String(userName || '').trim().substring(0, 100) || 'Пользователь';
    var token = Utilities.getUuid() + Utilities.getUuid().replace(/-/g, '');
    cache.put('sess:' + token, JSON.stringify({ user: user, epoch: getEpoch_() }), SESSION_TTL_SEC);

    lock = LockService.getScriptLock();
    lock.waitLock(20000);
    ensureUsers_([user]);
    writeLog_(user, [['login', 'system', '', '', '', '']]);
    return { ok: true, data: { token: token, user: user } };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  } finally {
    if (lock) lock.releaseLock();
  }
}

function logout(token) {
  try {
    if (token) CacheService.getScriptCache().remove('sess:' + token);
    return { ok: true, data: true };
  } catch (err) {
    return { ok: false, error: String(err && err.message || err) };
  }
}

function checkSession(token) {
  return api_(token, function (s) { return { user: s.user }; });
}

/** Диалог смены пароля из меню таблицы. Все действующие сессии сбрасываются. */
function changePasswordDialog() {
  var ui = SpreadsheetApp.getUi();
  var r = ui.prompt(APP_TITLE, 'Новый пароль входа (минимум 4 символа):', ui.ButtonSet.OK_CANCEL);
  if (r.getSelectedButton() !== ui.Button.OK) return;
  var pwd = r.getResponseText();
  if (pwd.length < 4) { ui.alert('Пароль слишком короткий.'); return; }
  var props = PropertiesService.getScriptProperties();
  props.setProperty('APP_PASSWORD', pwd);
  props.setProperty('SESSION_EPOCH', String(Number(getEpoch_()) + 1));
  ui.alert('Пароль изменён, все активные сессии завершены.');
}

/* ============================================================================
 * 8. ЧТЕНИЕ ВСЕХ ДАННЫХ
 * ========================================================================== */

/** Метаданные для клиента: поля форм, справочники, правила иерархии. */
function buildMeta_() {
  var types = {}, fieldLabels = {};
  TYPE_ORDER.forEach(function (t) {
    var cfg = TYPES[t];
    types[t] = {
      label: cfg.label, newLabel: cfg.newLabel, prefix: cfg.prefix,
      fields: cfg.fields.map(function (k) { return fieldDef_(t, k); }),
      parents: PARENT_RULES[t] || []
    };
    cfg.fields.forEach(function (k) { fieldLabels[k] = fieldLabels[k] || fieldDef_(t, k).label; });
  });
  var extra = { id: 'ID', link: 'Связь', document: 'Документ', created_at: 'Создано', updated_at: 'Изменено',
    project_description: 'Описание проекта' };
  Object.keys(extra).forEach(function (k) { fieldLabels[k] = extra[k]; });
  return {
    title: APP_TITLE, today: todayStr_(), typeOrder: TYPE_ORDER, types: types, enums: ENUMS,
    fieldLabels: fieldLabels, createLinkOptions: CREATE_LINK_OPTIONS
  };
}

function getSettings_() {
  var s = {};
  readAll_('Settings').rows.forEach(function (r) { s[r.key] = r.value; });
  return s;
}

function setSetting_(key, value) {
  var tbl = readAll_('Settings');
  for (var i = 0; i < tbl.rows.length; i++) {
    if (tbl.rows[i].key === key) {
      updateRow_(tbl.sh, tbl.headers, tbl.rows[i]._row, { value: value });
      return;
    }
  }
  appendObj_(tbl.sh, tbl.headers, { key: key, value: value });
}

/** Полный снимок данных для интерфейса. */
function getAllData(token) {
  return api_(token, function (session) {
    var entities = {};
    TYPE_ORDER.forEach(function (t) {
      entities[t] = readAll_(TYPES[t].sheet, t).rows.map(pub_);
    });
    var logSh = sheet_('Log');
    var logLast = logSh.getLastRow();
    var recent = [];
    if (logLast > 1) {
      var n = Math.min(5, logLast - 1);
      var vals = logSh.getRange(logLast - n + 1, 1, n, 8).getValues();
      recent = vals.reverse().map(function (r) {
        return { timestamp: String(r[0]), user: r[1], action: r[2], entity_type: r[3], entity_id: r[4],
          field: r[5], old_value: String(r[6]), new_value: String(r[7]) };
      });
    }
    var register = readAll_('ApprovalsRegister').rows;
    // Сверка Approvals и реестра: если голос поправили прямо в таблице, статус пересчитывается и пишется в Log
    var stale = approvalsOutOfSync_(entities.approval, register);
    if (stale.length) {
      var lock = LockService.getScriptLock();
      lock.waitLock(20000);
      try {
        stale.forEach(function (id) { syncApproval_(id, 'Система'); });
      } finally {
        lock.releaseLock();
      }
      entities.approval = readAll_('Approvals', 'approval').rows.map(pub_);
      register = readAll_('ApprovalsRegister').rows;
    }
    return {
      meta: buildMeta_(),
      user: session.user,
      register: register.map(pub_),
      entities: entities,
      links: readAll_('Links').rows.map(pub_),
      documents: readAll_('Documents').rows.map(pub_),
      users: readAll_('Users').rows.map(pub_),
      settings: getSettings_(),
      recentLog: recent
    };
  });
}

/* ============================================================================
 * 9. CRUD СУЩНОСТЕЙ
 * ========================================================================== */

/** Добавляет в Users имена, которых там ещё нет (без учёта регистра). */
function ensureUsers_(names) {
  var tbl = readAll_('Users');
  var known = {};
  tbl.rows.forEach(function (r) { known[r.name.toLowerCase()] = true; });
  names.forEach(function (n) {
    n = String(n || '').trim();
    if (n && !known[n.toLowerCase()]) {
      appendObj_(tbl.sh, tbl.headers, { name: n, email: '', role: '' });
      known[n.toLowerCase()] = true;
    }
  });
}

function addUser(token, user) {
  return api_(token, function () {
    user = user || {};
    var name = String(user.name || '').trim();
    if (!name) throw new Error('Укажите имя');
    var tbl = readAll_('Users');
    if (tbl.rows.some(function (r) { return r.name.toLowerCase() === name.toLowerCase(); })) {
      throw new Error('Такой пользователь уже есть');
    }
    appendObj_(tbl.sh, tbl.headers, { name: name, email: String(user.email || '').trim(), role: String(user.role || '').trim() });
    return { name: name };
  }, { write: true });
}

/**
 * Создание сущности.
 * link (необязательно): { other_id, link_type: parent | handoff_in | handoff_out | related }.
 */
function createEntity(token, type, data, link) {
  return api_(token, function (session) {
    return doCreate_(type, data, link, session.user);
  }, { write: true });
}

function doCreate_(type, data, linkSpec, user) {
  if (!TYPES[type]) throw new Error('Неизвестный тип: ' + type);
  var cfg = TYPES[type];
  var clean = validate_(type, data, null);
  var voters = [];
  if (type === 'approval') {
    // Участники голосования обязательны; статус согласования выводится из голосов (до первого голоса — «Ожидает решения»)
    voters = normalizeVoters_(data && data.voters);
    if (!voters.length) throw new Error('Проверка данных: укажите участников голосования');
    clean.status = 'Pending';
  }
  var id = nextId_(cfg.sheet, cfg.prefix);

  // Связь проверяем ДО записи объекта, чтобы не оставлять «полусозданные» данные
  var link = null;
  if (linkSpec && linkSpec.other_id) {
    var o = String(linkSpec.other_id), map = CREATE_LINK_MAP[linkSpec.link_type];
    if (!map) throw new Error('Неизвестный тип связи');
    var raw = { source_id: map.dir === 'out' ? id : o, target_id: map.dir === 'out' ? o : id,
      link_type: map.type, note: linkSpec.note };
    link = checkLink_(raw, readAll_('Links').rows, { newId: id, newType: type });
  }

  var now = nowStr_();
  var obj = { id: id, created_at: now, updated_at: now };
  Object.keys(clean).forEach(function (k) { obj[k] = clean[k]; });

  var sh = sheet_(cfg.sheet);
  appendObj_(sh, headersOf_(sh), obj);
  writeLog_(user, [['create', type, id, 'name', '', clean.name]]);
  ensureUsers_(collectUsers_(type, clean));

  var linkOut = link ? addLink_(link, user) : null;
  if (type === 'approval') {
    addVoterRows_(obj, voters);
    ensureUsers_(voters);
    writeLog_(user, [['create', type, id, 'voters', '', voters.join(', ')]]);
  }
  return { entity: obj, link: linkOut };
}

/** Частичное обновление. Каждое реально изменившееся поле пишется в Log отдельной строкой. */
function updateEntity(token, id, changes) {
  return api_(token, function (session) {
    return doUpdate_(id, changes, session.user);
  }, { write: true });
}

function doUpdate_(id, changes, user) {
  var f = findEntity_(id);
  if (!f) throw new Error('Объект не найден: ' + id);
  var clean = validate_(f.type, changes, f.row);

  // Статус согласования с голосованием определяется голосами и вручную не меняется
  if (f.type === 'approval' && clean.status !== undefined && String(clean.status) !== String(f.row.status) &&
      registerRowsOf_(id).length) {
    throw new Error('Статус согласования определяется голосованием участников');
  }

  var patch = {}, entries = [];
  Object.keys(clean).forEach(function (k) {
    if (String(f.row[k]) !== String(clean[k])) {
      patch[k] = clean[k];
      entries.push(['update', f.type, id, k, f.row[k], clean[k]]);
    }
  });
  if (!entries.length) return { entity: pub_(f.row), changed: 0 };

  patch.updated_at = nowStr_();
  updateRow_(f.tbl.sh, f.tbl.headers, f.row._row, patch);
  writeLog_(user, entries);
  ensureUsers_(collectUsers_(f.type, clean));
  if (f.type === 'approval') syncApproval_(id, user);   // название, срок, инициатор -> ApprovalsRegister

  var merged = pub_(f.row);
  Object.keys(patch).forEach(function (k) { merged[k] = patch[k]; });
  return { entity: merged, changed: entries.length };
}

/** Удаление сущности вместе с её связями и документами. */
function deleteEntity(token, id) {
  return api_(token, function (session) {
    var f = findEntity_(id);
    if (!f) throw new Error('Объект не найден: ' + id);
    var entries = [['delete', f.type, id, 'name', f.row.name, '']];

    var links = readAll_('Links');
    links.rows.slice().reverse().forEach(function (l) {   // с конца, чтобы не сбивались номера строк
      if (l.source_id === id || l.target_id === id) {
        links.sh.deleteRow(l._row);
        entries.push(['link_delete', f.type, id, 'link', describeLink_(l), '']);
      }
    });
    var docs = readAll_('Documents');
    docs.rows.slice().reverse().forEach(function (d) {
      if (d.entity_id === id) {
        docs.sh.deleteRow(d._row);
        entries.push(['doc_delete', f.type, id, 'document', d.doc_name + ' — ' + d.doc_url, '']);
      }
    });
    if (f.type === 'approval') {
      var reg = readAll_('ApprovalsRegister'), removed = [];
      reg.rows.slice().reverse().forEach(function (r) {
        if (r.approval_id === id) { reg.sh.deleteRow(r._row); removed.unshift(r.voter); }
      });
      if (removed.length) entries.push(['update', f.type, id, 'voters', removed.join(', '), '']);
    }
    f.tbl.sh.deleteRow(f.row._row);
    writeLog_(session.user, entries);
    return { id: id };
  }, { write: true });
}

/* ============================================================================
 * 10. СВЯЗИ (лист Links)
 * ========================================================================== */

function linkLabel_(t) {
  var x = ENUMS.link_type.filter(function (e) { return e.value === t; })[0];
  return x ? x.label : t;
}

function describeLink_(l) {
  return l.source_id + ' — ' + linkLabel_(l.link_type) + ' — ' + l.target_id;
}

/**
 * Проверка связи. opts: { ignoreLinkId } — пропустить саму связь при редактировании;
 * { newId, newType } — объект, который создаётся прямо сейчас и в таблицах ещё отсутствует.
 */
function checkLink_(l, links, opts) {
  opts = opts || {};
  var typeOf = function (id) { return id === opts.newId ? opts.newType : typeOfId_(id); };
  var st = typeOf(l.source_id), tt = typeOf(l.target_id);
  if (!st) throw new Error('Неизвестный объект: ' + l.source_id);
  if (!tt) throw new Error('Неизвестный объект: ' + l.target_id);
  if (l.source_id === l.target_id) throw new Error('Нельзя связать объект с самим собой');
  if (enumValues_('link_type').indexOf(l.link_type) === -1) throw new Error('Неизвестный тип связи');
  [l.source_id, l.target_id].forEach(function (id) {
    if (id !== opts.newId && !findEntity_(id)) throw new Error('Объект не найден: ' + id);
  });

  if (l.link_type === 'approval') {
    if (tt !== 'approval') throw new Error('Связь «Требует согласования» должна вести на согласование');
    if (st === 'approval' || st === 'meeting') throw new Error('«' + TYPES[st].label + '» не может требовать согласования');
  }
  if (l.link_type === 'parent') {
    if ((PARENT_RULES[st] || []).indexOf(tt) === -1) {
      throw new Error('«' + TYPES[st].label + '» не может входить в «' + TYPES[tt].label + '»');
    }
    links.forEach(function (x) {
      if (x.link_type === 'parent' && x.source_id === l.source_id && x.link_id !== opts.ignoreLinkId) {
        throw new Error('У объекта ' + l.source_id + ' уже есть родитель (' + x.target_id + ')');
      }
    });
  }
  links.forEach(function (x) {
    if (x.link_id === opts.ignoreLinkId || x.link_type !== l.link_type) return;
    var same = x.source_id === l.source_id && x.target_id === l.target_id;
    var mirrored = l.link_type === 'related' && x.source_id === l.target_id && x.target_id === l.source_id;
    if (same || mirrored) throw new Error('Такая связь уже существует');
  });

  var note = String(l.note || '').trim();
  if (note.length > 500) throw new Error('Примечание: не более 500 символов');
  return { source_id: l.source_id, source_type: st, target_id: l.target_id, target_type: tt,
    link_type: l.link_type, note: note };
}

/** Записывает проверенную связь и пишет в журнал. */
function addLink_(link, user) {
  var tbl = readAll_('Links');
  link.link_id = nextId_('Links', 'LNK');
  link.created_by = user;
  link.created_at = nowStr_();
  appendObj_(tbl.sh, tbl.headers, link);
  writeLog_(user, [['link_add', link.source_type, link.source_id, 'link', '', describeLink_(link)]]);
  return link;
}

function createLink(token, l) {
  return api_(token, function (session) {
    var link = checkLink_(l || {}, readAll_('Links').rows);
    return addLink_(link, session.user);
  }, { write: true });
}

function updateLink(token, linkId, changes) {
  return api_(token, function (session) {
    var tbl = readAll_('Links');
    var cur = tbl.rows.filter(function (r) { return r.link_id === linkId; })[0];
    if (!cur) throw new Error('Связь не найдена: ' + linkId);
    var next = { source_id: cur.source_id, target_id: cur.target_id, link_type: cur.link_type, note: cur.note };
    ['source_id', 'target_id', 'link_type', 'note'].forEach(function (k) {
      if (changes && Object.prototype.hasOwnProperty.call(changes, k)) next[k] = changes[k];
    });
    var link = checkLink_(next, tbl.rows, { ignoreLinkId: linkId });
    if (describeLink_(link) === describeLink_(cur) && link.note === cur.note) return pub_(cur);
    updateRow_(tbl.sh, tbl.headers, cur._row, link);
    writeLog_(session.user, [['link_update', link.source_type, link.source_id, 'link', describeLink_(cur), describeLink_(link)]]);
    var out = pub_(cur);
    Object.keys(link).forEach(function (k) { out[k] = link[k]; });
    return out;
  }, { write: true });
}

function deleteLink(token, linkId) {
  return api_(token, function (session) {
    var tbl = readAll_('Links');
    var cur = tbl.rows.filter(function (r) { return r.link_id === linkId; })[0];
    if (!cur) throw new Error('Связь не найдена: ' + linkId);
    tbl.sh.deleteRow(cur._row);
    writeLog_(session.user, [['link_delete', cur.source_type, cur.source_id, 'link', describeLink_(cur), '']]);
    return { link_id: linkId };
  }, { write: true });
}

/** Меняет родителя объекта (пустой parentId — снять родителя). */
function setParent(token, id, parentId) {
  return api_(token, function (session) {
    var tbl = readAll_('Links');
    var old = tbl.rows.filter(function (r) { return r.link_type === 'parent' && r.source_id === id; })[0];
    if (old && old.target_id === parentId) return { changed: false };
    var link = null;
    if (parentId) {
      // проверяем с учётом того, что прежняя связь будет заменена
      link = checkLink_({ source_id: id, target_id: parentId, link_type: 'parent' }, tbl.rows,
        { ignoreLinkId: old ? old.link_id : undefined });
    }
    if (old) {
      tbl.sh.deleteRow(old._row);
      writeLog_(session.user, [['link_delete', old.source_type, id, 'link', describeLink_(old), '']]);
    }
    if (link) addLink_(link, session.user);
    return { changed: true };
  }, { write: true });
}

/* ============================================================================
 * 11. ДОКУМЕНТЫ (лист Documents)
 * ========================================================================== */

function checkDoc_(name, url) {
  url = String(url || '').trim();
  if (!/^https?:\/\/[^\s]+$/i.test(url)) throw new Error('Ссылка должна начинаться с http:// или https://');
  if (url.length > 2000) throw new Error('Ссылка слишком длинная');
  name = String(name || '').trim();
  if (!name) name = url.replace(/^https?:\/\//i, '').split(/[?#]/)[0].split('/').filter(Boolean).pop() || url;
  if (name.length > 200) throw new Error('Название документа: не более 200 символов');
  return { doc_name: name, doc_url: url };
}

function addDocument(token, entityId, name, url) {
  return api_(token, function (session) {
    var f = findEntity_(entityId);
    if (!f) throw new Error('Объект не найден: ' + entityId);
    var d = checkDoc_(name, url);
    var tbl = readAll_('Documents');
    var doc = { doc_id: nextId_('Documents', 'DOC'), entity_id: entityId, entity_type: f.type,
      doc_name: d.doc_name, doc_url: d.doc_url, added_by: session.user, created_at: nowStr_() };
    appendObj_(tbl.sh, tbl.headers, doc);
    writeLog_(session.user, [['doc_add', f.type, entityId, 'document', '', d.doc_name + ' — ' + d.doc_url]]);
    return doc;
  }, { write: true });
}

function updateDocument(token, docId, changes) {
  return api_(token, function (session) {
    var tbl = readAll_('Documents');
    var cur = tbl.rows.filter(function (r) { return r.doc_id === docId; })[0];
    if (!cur) throw new Error('Документ не найден: ' + docId);
    changes = changes || {};
    var d = checkDoc_(
      Object.prototype.hasOwnProperty.call(changes, 'doc_name') ? changes.doc_name : cur.doc_name,
      Object.prototype.hasOwnProperty.call(changes, 'doc_url') ? changes.doc_url : cur.doc_url);
    updateRow_(tbl.sh, tbl.headers, cur._row, d);
    writeLog_(session.user, [['doc_update', cur.entity_type, cur.entity_id, 'document',
      cur.doc_name + ' — ' + cur.doc_url, d.doc_name + ' — ' + d.doc_url]]);
    var out = pub_(cur);
    out.doc_name = d.doc_name; out.doc_url = d.doc_url;
    return out;
  }, { write: true });
}

function deleteDocument(token, docId) {
  return api_(token, function (session) {
    var tbl = readAll_('Documents');
    var cur = tbl.rows.filter(function (r) { return r.doc_id === docId; })[0];
    if (!cur) throw new Error('Документ не найден: ' + docId);
    tbl.sh.deleteRow(cur._row);
    writeLog_(session.user, [['doc_delete', cur.entity_type, cur.entity_id, 'document', cur.doc_name + ' — ' + cur.doc_url, '']]);
    return { doc_id: docId };
  }, { write: true });
}

/* ============================================================================
 * 12. НАСТРОЙКИ ПРОЕКТА
 * ========================================================================== */

function saveSetting(token, key, value) {
  return api_(token, function (session) {
    if (SETTING_KEYS.indexOf(key) === -1) throw new Error('Недопустимая настройка');
    value = String(value === undefined || value === null ? '' : value).trim();
    if (value.length > 5000) throw new Error('Не более 5000 символов');
    var old = getSettings_()[key] || '';
    if (old === value) return { changed: false };
    setSetting_(key, value);
    writeLog_(session.user, [['setting', 'project', 'PRJ', key, old, value]]);
    return { changed: true };
  }, { write: true });
}

/* ============================================================================
 * 12a. РЕЕСТР СОГЛАСОВАНИЙ (лист ApprovalsRegister) И ГОЛОСОВАНИЕ
 * Одна строка реестра = один участник голосования по одному согласованию.
 * Итоговый статус согласования выводится из голосов и записывается в Approvals.
 * ========================================================================== */

function normalizeVoters_(list) {
  if (Object.prototype.toString.call(list) !== '[object Array]') list = [];
  var seen = {}, out = [];
  list.forEach(function (n) {
    n = String(n === null || n === undefined ? '' : n).trim();
    if (!n) return;
    if (n.length > 100) throw new Error('Имя участника: не более 100 символов');
    if (!seen[n.toLowerCase()]) { seen[n.toLowerCase()] = true; out.push(n); }
  });
  if (out.length > 50) throw new Error('Участников голосования не более 50');
  return out;
}

/** Итог по голосам: любой «Не согласен» — Rejected; все «Согласен» — Approved; нет ни одного решения — Pending; иначе In Progress. */
function deriveApprovalStatus_(votes) {
  if (!votes.length) return 'Pending';
  if (votes.some(function (v) { return v === 'Disagree'; })) return 'Rejected';
  if (votes.every(function (v) { return v === 'Agree'; })) return 'Approved';
  if (votes.every(function (v) { return v === 'No Decision' || v === ''; })) return 'Pending';
  return 'In Progress';
}

function registerRowsOf_(approvalId) {
  return readAll_('ApprovalsRegister').rows.filter(function (r) { return r.approval_id === approvalId; });
}

/** Добавляет строки реестра для новых участников (голос по умолчанию — «Нет решения»). */
function addVoterRows_(approval, voters) {
  var reg = readAll_('ApprovalsRegister');
  voters.forEach(function (v) {
    appendObj_(reg.sh, reg.headers, {
      approval_id: approval.id, title: approval.name, initiator: approval.initiator,
      created_at: String(approval.created_at).substring(0, 10), deadline: approval.deadline,
      status: approval.status, voter: v, vote: 'No Decision', vote_comment: '', vote_date: ''
    });
  });
}

/**
 * Приводит в соответствие Approvals и ApprovalsRegister для одного согласования:
 * статус пересчитывается по голосам, шапка (название, срок, инициатор, статус) копируется в строки реестра.
 * Возвращает true, если что-то изменилось.
 */
function syncApproval_(approvalId, user) {
  var f = findEntity_(approvalId);
  if (!f || f.type !== 'approval') return false;
  var reg = readAll_('ApprovalsRegister');
  var rows = reg.rows.filter(function (r) { return r.approval_id === approvalId; });
  if (!rows.length) return false;
  var changed = false;

  var status = deriveApprovalStatus_(rows.map(function (r) { return r.vote; }));
  if (status !== f.row.status) {
    updateRow_(f.tbl.sh, f.tbl.headers, f.row._row, { status: status, updated_at: nowStr_() });
    writeLog_(user, [['update', 'approval', approvalId, 'status', f.row.status, status]]);
    changed = true;
  }
  var head = { title: f.row.name, initiator: f.row.initiator, created_at: String(f.row.created_at).substring(0, 10),
    deadline: f.row.deadline, status: status };
  rows.forEach(function (r) {
    var patch = {}, any = false;
    Object.keys(head).forEach(function (k) { if (String(r[k]) !== String(head[k])) { patch[k] = head[k]; any = true; } });
    if (any) { updateRow_(reg.sh, reg.headers, r._row, patch); changed = true; }
  });
  return changed;
}

/** Согласования, у которых статус или шапка расходятся с реестром (например, голос поправили прямо в таблице). */
function approvalsOutOfSync_(approvals, regRows) {
  var by = {};
  regRows.forEach(function (r) { (by[r.approval_id] = by[r.approval_id] || []).push(r); });
  return approvals.filter(function (a) {
    var rows = by[a.id];
    if (!rows) return false;
    var st = deriveApprovalStatus_(rows.map(function (r) { return r.vote; }));
    return st !== a.status || rows.some(function (r) {
      return r.title !== a.name || r.deadline !== a.deadline || r.initiator !== a.initiator || r.status !== st;
    });
  }).map(function (a) { return a.id; });
}

/** Чтение реестра: все строки или только одного согласования. */
function getApprovalsRegister(token, approvalId) {
  return api_(token, function () {
    return readAll_('ApprovalsRegister').rows.filter(function (r) {
      return !approvalId || r.approval_id === approvalId;
    }).map(pub_);
  });
}

/** Изменение состава голосующих: новые получают «Нет решения», у оставшихся голоса сохраняются. */
function setApprovalVoters(token, approvalId, voters) {
  return api_(token, function (session) {
    var f = findEntity_(approvalId);
    if (!f || f.type !== 'approval') throw new Error('Согласование не найдено: ' + approvalId);
    var list = normalizeVoters_(voters);
    if (!list.length) throw new Error('Укажите хотя бы одного участника голосования');

    var reg = readAll_('ApprovalsRegister');
    var mine = reg.rows.filter(function (r) { return r.approval_id === approvalId; });
    var keep = {}; list.forEach(function (n) { keep[n.toLowerCase()] = true; });
    var have = {}; mine.forEach(function (r) { have[r.voter.toLowerCase()] = true; });
    var oldNames = mine.map(function (r) { return r.voter; });

    mine.slice().reverse().forEach(function (r) {              // с конца, чтобы не сбивались номера строк
      if (!keep[r.voter.toLowerCase()]) reg.sh.deleteRow(r._row);
    });
    addVoterRows_(f.row, list.filter(function (n) { return !have[n.toLowerCase()]; }));
    ensureUsers_(list);
    if (oldNames.join(', ') !== list.join(', ')) {
      writeLog_(session.user, [['update', 'approval', approvalId, 'voters', oldNames.join(', '), list.join(', ')]]);
    }
    syncApproval_(approvalId, session.user);
    return { voters: list };
  }, { write: true });
}

/** Голос участника. Голосовать можно только от своего имени (имя входа = участник). */
function castVote(token, approvalId, voter, vote, comment) {
  return api_(token, function (session) {
    var f = findEntity_(approvalId);
    if (!f || f.type !== 'approval') throw new Error('Согласование не найдено: ' + approvalId);
    voter = String(voter || '').trim();
    if (voter.toLowerCase() !== String(session.user).toLowerCase()) {
      throw new Error('Голосовать можно только от своего имени. Войдите под именем участника.');
    }
    if (enumValues_('vote').indexOf(vote) === -1) throw new Error('Недопустимый вариант голоса');
    comment = String(comment || '').trim();
    if (comment.length > 1000) throw new Error('Комментарий: не более 1000 символов');

    var reg = readAll_('ApprovalsRegister');
    var row = reg.rows.filter(function (r) {
      return r.approval_id === approvalId && r.voter.toLowerCase() === voter.toLowerCase();
    })[0];
    if (!row) throw new Error('Вы не входите в число участников голосования');
    if (row.vote === vote && row.vote_comment === comment) return { changed: false, status: f.row.status };

    updateRow_(reg.sh, reg.headers, row._row, { vote: vote, vote_comment: comment, vote_date: nowStr_() });
    var entries = [];
    if (row.vote !== vote) entries.push(['vote', 'approval', approvalId, 'vote', row.vote, vote]);
    if (row.vote_comment !== comment) entries.push(['vote', 'approval', approvalId, 'vote_comment', row.vote_comment, comment]);
    writeLog_(session.user, entries);
    syncApproval_(approvalId, session.user);
    return { changed: true, status: findEntity_(approvalId).row.status };
  }, { write: true });
}

/** Пункт меню: пересчитать статусы всех согласований по реестру (после ручных правок листа). */
function syncApprovalsRegister() {
  setupIfNeeded_();
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var n = 0;
    readAll_('Approvals', 'approval').rows.forEach(function (a) { if (syncApproval_(a.id, 'Меню')) n++; });
    try { SpreadsheetApp.getUi().alert(APP_TITLE, 'Согласований обновлено: ' + n, SpreadsheetApp.getUi().ButtonSet.OK); } catch (e) { /* без UI */ }
    return n;
  } finally {
    lock.releaseLock();
  }
}

/* ============================================================================
 * 12b. KANBAN: перенос карточки между колонками
 * ========================================================================== */

/**
 * Перенос карточки. column: progress | planned | done.
 * Колонка «Ожидают решения» (awaiting) формируется автоматически по просрочке, переносить в неё нельзя.
 */
function moveTask(token, id, column) {
  return api_(token, function (session) {
    var f = findEntity_(id);
    if (!f || ['stage', 'task', 'subtask'].indexOf(f.type) === -1) {
      throw new Error('Переносить можно только этапы, задачи и подзадачи');
    }
    if (column === 'awaiting') {
      throw new Error('Колонка «Ожидают решения» заполняется автоматически: в неё попадают просроченные задачи');
    }
    var status = KANBAN_STATUS[column];
    if (!status) throw new Error('Неизвестная колонка: ' + column);

    var changes = { status: status };
    // Возобновлённая задача не может оставаться на 100 %
    if (f.row.status === 'Done' && status !== 'Done' && Number(f.row.progress) >= 100) {
      changes.progress = status === 'Not Started' ? 0 : 99;
    }
    var res = doUpdate_(id, changes, session.user);
    res.overdue = !!f.row.deadline && f.row.deadline < todayStr_() && status !== 'Done';
    return res;
  }, { write: true });
}

/* ============================================================================
 * 12c. ФАЙЛЫ ПРОЕКТА (лист Info, диапазон A1:K50)
 * ========================================================================== */

function safeUrl_(u) {
  u = String(u || '').trim();
  return /^https?:\/\/[^\s]+$/i.test(u) && u.length <= 1000 ? u : '';
}

/** Ссылка ячейки: гиперссылка в тексте (в т. ч. частичная) или формула =HYPERLINK("url";"имя"). */
function cellLink_(rich, formula) {
  var m = /^=\s*HYPERLINK\(\s*"([^"]+)"\s*(?:[,;]\s*"([^"]*)")?\s*\)\s*$/i.exec(String(formula || ''));
  if (m) return { url: safeUrl_(m[1]), name: m[2] || '' };
  var url = '';
  try {
    url = rich.getLinkUrl() || '';
    if (!url) {
      rich.getRuns().some(function (r) { url = r.getLinkUrl() || ''; return !!url; });
    }
  } catch (e) { url = ''; }
  return { url: safeUrl_(url), name: '' };
}

/**
 * Читает Info!A1:K50. Возвращает строки, в каждой — непустые элементы { name, url }.
 * Ссылка, записанная отдельной ячейкой справа от названия, присоединяется к названию.
 */
function getInfo(token) {
  return api_(token, function () {
    var ss = ss_();
    var sh = ensureInfoSheet_(ss);
    var rng = sh.getRange(1, 1, INFO_ROWS, INFO_COLS);
    var values = rng.getDisplayValues ? rng.getDisplayValues() : rng.getValues();
    var rich = rng.getRichTextValues();
    var formulas = rng.getFormulas();
    var rows = [], count = 0;

    values.forEach(function (row, i) {
      var items = [];
      row.forEach(function (cell, j) {
        var text = String(cell === null || cell === undefined ? '' : cell).trim();
        var link = cellLink_(rich[i][j], formulas[i][j]);
        if (!text && !link.url) return;
        if (!text || (link.name && text.charAt(0) === '=')) text = link.name;
        var asUrl = safeUrl_(text);
        if (!link.url && asUrl) {                       // ячейка с голой ссылкой
          var prev = items[items.length - 1];
          if (prev && !prev.url) { prev.url = asUrl; return; }
          link.url = asUrl;
        }
        items.push({ name: text, url: link.url });
      });
      if (items.length) { rows.push(items); count += items.length; }
    });
    return { rows: rows, count: count, sheet_url: ss.getUrl() + '#gid=' + sh.getSheetId() };
  });
}

/* ============================================================================
 * 12d. ОБМЕН: карточки «кто — кому — что — когда»
 * ========================================================================== */

function ownerOf_(e) {
  return e._type === 'approval' ? (e.approver || e.assignee || '') : (e.assignee || '');
}

function statusLabelOf_(type, value) {
  var en = fieldDef_(type, 'status').enum;
  var x = ENUMS[en].filter(function (o) { return o.value === value; })[0];
  return x ? x.label : value;
}

function isClosed_(e) {
  return ['Done', 'Approved', 'Rejected', 'Held', 'Cancelled'].indexOf(e.status) !== -1;
}

/** Состояние передачи по связи: code ok | wait | bad | none (клиент красит метку по коду). */
function handoverState_(l, s, t, today) {
  if (l.link_type === 'parent' || l.link_type === 'related') return { code: 'none', label: '—' };
  if (l.link_type === 'approval') {
    if (t.status === 'Approved') return { code: 'ok', label: 'Согласовано' };
    if (t.status === 'Rejected') return { code: 'bad', label: 'Отклонено' };
    if (t.deadline && t.deadline < today) return { code: 'bad', label: 'Просрочено' };
    return { code: 'wait', label: 'Ожидает решения' };
  }
  var done = l.link_type === 'blocks' ? 'Блокировка снята' : 'Передано';
  if (isClosed_(s)) return { code: 'ok', label: done };
  if (s.blocked === true || s.status === 'Blocked') return { code: 'bad', label: 'Заблокировано' };
  var due = s.deadline || s.meeting_date;
  if (due && due < today) return { code: 'bad', label: 'Просрочено' };
  return { code: 'wait', label: l.link_type === 'blocks' ? 'Блокирует' : 'Ожидается' };
}

/**
 * Данные карточек вкладки «Обмен». filter.type: flow (все, кроме иерархии, по умолчанию) | all | значение link_type.
 * Для каждой связи — источник, получатель (участник, задача, статус, дата), дополнительные сведения и состояние передачи.
 */
function getExchangeCards(token, filter) {
  return api_(token, function () {
    var ftype = (filter && filter.type) || 'flow';
    var today = todayStr_(), byId = {}, docsBy = {};
    TYPE_ORDER.forEach(function (t) {
      readAll_(TYPES[t].sheet, t).rows.forEach(function (e) { e._type = t; byId[e.id] = e; });
    });
    readAll_('Documents').rows.forEach(function (d) {
      (docsBy[d.entity_id] = docsBy[d.entity_id] || []).push({ name: d.doc_name, url: d.doc_url });
    });
    var brief = function (e) {
      return { id: e.id, type: e._type, type_label: TYPES[e._type].label, name: e.name,
        status: e.status, status_label: statusLabelOf_(e._type, e.status), owner: ownerOf_(e),
        date: e.meeting_date || e.deadline || '', comment: e.comment || '', docs: docsBy[e.id] || [] };
    };
    var cards = [];
    readAll_('Links').rows.forEach(function (l) {
      if (ftype === 'flow' ? l.link_type === 'parent' : (ftype !== 'all' && l.link_type !== ftype)) return;
      var s = byId[l.source_id], t = byId[l.target_id];
      if (!s || !t) return;
      var h = handoverState_(l, s, t, today);
      h.date = l.link_type === 'approval' ? (t.deadline || '') : (s.meeting_date || s.deadline || '');
      cards.push({ link_id: l.link_id, link_type: l.link_type, type_label: linkLabel_(l.link_type),
        note: l.note, source: brief(s), target: brief(t), handover: h });
    });
    return { cards: cards };
  });
}

/* ============================================================================
 * 13. ДЕМО-ДАННЫЕ (меню «Загрузить демо-данные»)
 * ========================================================================== */

function addDays_(n) {
  var d = new Date(todayStr_() + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
}

function seedDemo() {
  setupIfNeeded_();
  var me = 'Демо', ok = true;
  try {
    var ui = SpreadsheetApp.getUi();
    ok = ui.alert(APP_TITLE, 'Добавить демонстрационные данные в таблицу?', ui.ButtonSet.OK_CANCEL) === ui.Button.OK;
  } catch (e) { /* без интерфейса — просто выполняем */ }
  if (!ok) return;

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    ensureUsers_(['Анна Смирнова', 'Иван Петров', 'Мария Кузнецова', 'Дмитрий Орлов']);
    var mk = function (type, data, parent) {
      return doCreate_(type, data, parent ? { other_id: parent, link_type: 'parent' } : null, me).entity.id;
    };
    var hand = function (a, b) {
      addLink_(checkLink_({ source_id: a, target_id: b, link_type: 'handoff' }, readAll_('Links').rows), me);
    };
    var s1 = mk('stage', { name: 'Подготовка запуска', description: 'Ассортимент, поставщики, карточки товаров.',
      assignee: 'Анна Смирнова', start_date: addDays_(-20), deadline: addDays_(10), status: 'In Progress' });
    var s2 = mk('stage', { name: 'Запуск продаж', description: 'Витрина, реклама, первые заказы.',
      assignee: 'Иван Петров', start_date: addDays_(5), deadline: addDays_(45), status: 'Not Started' });
    var s3 = mk('stage', { name: 'Масштабирование', description: 'Аналитика и расширение каталога.',
      assignee: 'Мария Кузнецова', start_date: addDays_(40), deadline: addDays_(90), status: 'Not Started' });

    var t1 = mk('task', { name: 'Выбор поставщиков', description: 'Сравнить предложения и подписать договоры.',
      task_type: 'Логистика', assignee: 'Анна Смирнова', start_date: addDays_(-20), deadline: addDays_(-8),
      status: 'Done' }, s1);
    var t2 = mk('task', { name: 'Карточки товаров', description: 'Фото, тексты, характеристики.',
      task_type: 'Контент', assignee: 'Мария Кузнецова', start_date: addDays_(-10), deadline: addDays_(8),
      status: 'In Progress', progress: 60 }, s1);
    var t3 = mk('task', { name: 'Настройка логистики', description: 'Склад, доставка, возвраты.',
      task_type: 'Логистика', assignee: 'Дмитрий Орлов', start_date: addDays_(-6), deadline: addDays_(-1),
      status: 'In Progress', progress: 30, blocked: true, blocked_by: 'Иван Петров',
      block_reason: 'Ждём подписанный договор с логистическим оператором' }, s1);
    var t4 = mk('task', { name: 'Рекламная кампания', description: 'Креативы и медиаплан.',
      task_type: 'Маркетинг', assignee: 'Иван Петров', start_date: addDays_(6), deadline: addDays_(30),
      status: 'In Progress', progress: 20 }, s2);
    var t5 = mk('task', { name: 'Запуск витрины', description: 'Публикация каталога и приём заказов.',
      task_type: 'Разработка', assignee: 'Дмитрий Орлов', start_date: addDays_(20), deadline: addDays_(44),
      status: 'Not Started' }, s2);
    var t6 = mk('task', { name: 'Аналитика продаж', description: 'Дашборды и еженедельные отчёты.',
      task_type: 'Аналитика', assignee: 'Мария Кузнецова', start_date: addDays_(45), deadline: addDays_(80),
      status: 'Not Started' }, s3);

    mk('subtask', { name: 'Фотосъёмка', description: 'Предметная съёмка 120 позиций.', assignee: 'Мария Кузнецова',
      start_date: addDays_(-10), deadline: addDays_(0), status: 'In Progress', progress: 80 }, t2);
    mk('subtask', { name: 'Тексты описаний', description: 'Описания и SEO-теги.', assignee: 'Анна Смирнова',
      start_date: addDays_(-4), deadline: addDays_(8), status: 'In Progress', progress: 40 }, t2);
    mk('subtask', { name: 'Договор с оператором', description: 'Согласование условий и подписание.',
      assignee: 'Иван Петров', start_date: addDays_(-6), deadline: addDays_(-1), status: 'In Progress', progress: 50,
      blocked: true, blocked_by: 'Анна Смирнова', block_reason: 'Юридический отдел вернул договор на доработку' }, t3);

    var a1 = mk('approval', { name: 'Согласование ассортимента', description: 'Утверждение финального списка товаров.',
      initiator: 'Анна Смирнова', approver: 'Иван Петров', assignee: 'Анна Смирнова', deadline: addDays_(3),
      voters: ['Иван Петров', 'Анна Смирнова', 'Мария Кузнецова'] }, s1);
    var a2 = mk('approval', { name: 'Бюджет рекламы', description: 'Утверждение медиаплана и бюджета.',
      initiator: 'Иван Петров', approver: 'Анна Смирнова', deadline: addDays_(14),
      voters: ['Анна Смирнова', 'Дмитрий Орлов'] }, t4);
    // Несколько голосов для примера: у первого согласования решение ещё не принято
    var vote = function (id, who, v, c) {
      var reg = readAll_('ApprovalsRegister');
      reg.rows.forEach(function (r) {
        if (r.approval_id === id && r.voter === who) {
          updateRow_(reg.sh, reg.headers, r._row, { vote: v, vote_comment: c, vote_date: nowStr_() });
        }
      });
      writeLog_(who, [['vote', 'approval', id, 'vote', 'No Decision', v]]);
      syncApproval_(id, who);
    };
    vote(a1, 'Иван Петров', 'Agree', 'Ассортимент устраивает');
    vote(a1, 'Анна Смирнова', 'Discussed', 'Нужно уточнить маржинальность по трём позициям');

    mk('meeting', { name: 'Статус проекта', description: 'Еженедельный созвон по статусам.', assignee: 'Анна Смирнова',
      meeting_date: addDays_(2), meeting_time: '10:00', end_time: '11:00',
      participants: 'Анна Смирнова, Иван Петров, Мария Кузнецова', location: 'Переговорная 2', status: 'Planned' }, s1);
    mk('meeting', { name: 'Планирование запуска', description: 'Подготовка к старту продаж.', assignee: 'Иван Петров',
      meeting_date: addDays_(9), meeting_time: '15:30', end_time: '16:30',
      participants: 'Иван Петров, Дмитрий Орлов', location: 'https://meet.google.com', status: 'Planned' }, s2);

    var link = function (a, b, type) {
      addLink_(checkLink_({ source_id: a, target_id: b, link_type: type }, readAll_('Links').rows), me);
    };
    hand(t1, t2); hand(t4, t6);
    link(t3, t5, 'blocks'); link(t2, t5, 'blocks');
    link(t2, a1, 'approval'); link(t4, a2, 'approval');

    // Пример содержимого листа «Файлы проекта», если он пуст
    var info = ensureInfoSheet_(ss_());
    if (info.getLastRow() === 0) {
      info.getRange(1, 1, 5, 2).setValues([
        ['Общие материалы', ''],
        ['Папка проекта', 'https://drive.google.com'],
        ['Договоры и юридические документы', 'https://drive.google.com'],
        ['Фото и видео товаров', 'https://drive.google.com'],
        ['Отчёты и аналитика', 'https://drive.google.com']
      ]);
    }
  } finally {
    lock.releaseLock();
  }
}
