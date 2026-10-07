// ============================================================
// E-commerce Project 1.0 — Google Apps Script (Backend)
// Лист с данными: "Таблица" (старое имя "Data" поддерживается)
//
// Колонки: ID | ID Связи | № | Этап | Задача | Под-задача | Владелец результата | Ответственный |
//          Решающий | Информируемые | От кого получаем инф. | Кому передаем инф. | Старт | Финиш |
//          Статус | Блокер | Кем заблок. | С какого числа | Прогресс | Документ | Результат | Комментарий
//
// Как читаются колонки:
//  • «№» (1 / 1.2 / 1.2.3) — иерархия Этап > Задача > Под-задача (если «№» пуст — по колонкам Этап/Задача/Под-задача).
//  • «ID Связи» — ID строк (задач, под-задач ИЛИ этапов), с которыми связана строка. Несколько — через ; , или пробел.
//    По умолчанию это «зависит от» (эти строки должны завершиться раньше). См. LINK_MODE.
//  • «От кого получаем инф.» / «Кому передаем инф.» — ID строк и/или ФИО/отделы (через ; , или с новой строки).
//    ID → связь с конкретной задачей/этапом; ФИО/отдел → передача между людьми в рамках этой задачи.
//  • «Результат» — ЧТО передаётся (информация/артефакт), показывается в «Обмен».
// Лист «Обмен» создаётся автоматически (меню «E-commerce»).
// ============================================================

// 'depends_on' — «ID Связи» = от каких строк зависит эта (они -> эта)
// 'feeds'      — «ID Связи» = какие строки зависят от этой (эта -> они)
const LINK_MODE = 'depends_on';

const SHEET_NAME = 'Таблица';
const SHEET_NAME_OLD = 'Data';
const REF_SHEET_NAME = 'Справочник';
const EXCHANGE_SHEET_NAME = 'Обмен';

const EXPECTED_HEADERS = [
  'ID', 'ID Связи', '№', 'Этап', 'Задача', 'Под-задача', 'Владелец результата', 'Ответственный',
  'Решающий', 'Информируемые', 'От кого получаем инф.', 'Кому передаем инф.', 'Старт', 'Финиш',
  'Статус', 'Блокер', 'Кем заблок.', 'С какого числа', 'Прогресс', 'Документ', 'Результат', 'Комментарий'
];

const EXCHANGE_HEADERS = [
  'Кто передаёт', 'Из задачи', 'ID источника', 'Что передаёт (информация)',
  'Кому', 'В задачу', 'ID получателя', 'Передать до', 'Нужно к',
  'Статус передачи', 'Получено', 'Комментарий'
];

const STATE_LABELS = {
  done: 'Передано',
  blocking: '⛔ Блокирует',
  risk: '⚠ Риск срока',
  planned: 'Запланировано'
};
const STATE_COLORS = { done: '#d1fae5', blocking: '#fee2e2', risk: '#fef3c7', planned: '#ffffff' };

function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('E-commerce Project 1.0')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu('E-commerce')
      .addItem('Обновить лист «Обмен»', 'refreshExchangeSheetMenu')
      .addToUi();
  } catch (e) { /* запуск вне таблицы */ }
}

function refreshExchangeSheetMenu() {
  const res = refreshExchangeSheet();
  SpreadsheetApp.getActive().toast(
    res.success ? `Лист «${EXCHANGE_SHEET_NAME}» обновлён: ${res.count} передач(и)` : res.message,
    'E-commerce', 5);
}

function ping() {
  return 'OK: ' + new Date().toLocaleTimeString();
}

// ---------- Вспомогательные ----------

function getDataSheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  return ss.getSheetByName(SHEET_NAME) || ss.getSheetByName(SHEET_NAME_OLD);
}

// Заголовки сравниваем без регистра, пробелов, скобок, точек
function normHeader_(h) {
  return String(h == null ? '' : h).toLowerCase().replace(/[\s().:_\-]/g, '');
}
const CANON_MAP_ = (function () {
  const m = {};
  EXPECTED_HEADERS.forEach(h => { m[normHeader_(h)] = h; });
  return m;
})();
function canonHeader_(h) {
  const t = String(h == null ? '' : h).trim();
  return CANON_MAP_[normHeader_(t)] || t;
}

function splitIds_(v) {
  return String(v == null ? '' : v).split(/[;,\s]+/).map(s => s.trim()).filter(s => s !== '');
}
function splitPeople_(v) {
  return String(v == null ? '' : v).split(/[;,]+/).map(s => s.trim()).filter(s => s !== '');
}
// ID и/или ФИО: разделители ; , и перенос строки (пробелы внутри ФИО сохраняются)
function splitTokens_(v) {
  return String(v == null ? '' : v).split(/[;,\n]+/).map(s => s.trim()).filter(s => s !== '');
}
function parseDate_(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (m) return new Date(+m[3], +m[2] - 1, +m[1]);
  const d = new Date(s);
  return isNaN(d) ? null : d;
}
function rowName_(r) { return r['Под-задача'] || r['Задача'] || r['Этап'] || '(без названия)'; }
function rowPeople_(r) {
  const p = splitPeople_(r['Ответственный']);
  return p.length ? p : splitPeople_(r['Владелец результата']);
}
function rowId_(r) { return String(r['ID'] || '').trim() || ('#' + r._rowIndex); }

function readRows_(sheet) {
  const data = sheet.getDataRange().getDisplayValues();
  if (data.length < 2) return null;
  const headers = data[0].map(canonHeader_);
  const numIdx = headers.indexOf('№');
  const rows = data.slice(1).map((row, index) => {
    const obj = { _rowIndex: index + 2 };
    headers.forEach((h, i) => { if (h) obj[h] = row[i]; });
    obj._num = (numIdx >= 0 && String(row[numIdx] || '').trim()) ? String(row[numIdx]).trim() : String(index + 1);
    return obj;
  });
  return { headers: headers, rows: rows };
}

// ---------- Главные данные ----------

function getProjectData() {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = getDataSheet_();
    if (!sheet) {
      return { _error: `Лист "${SHEET_NAME}" не найден. Переименуйте лист "Data" в "${SHEET_NAME}".` };
    }
    const parsed = readRows_(sheet);
    if (!parsed) return { _error: 'Лист пуст или содержит только заголовки.' };

    const rows = parsed.rows;
    const options = buildOptions(ss, rows);
    return {
      headers: parsed.headers,
      rows: rows,
      options: options,
      exchange: buildExchange_(rows),
      _debug: `Успех! Загружено строк: ${rows.length}`
    };
  } catch (e) {
    return { _error: 'Критическая ошибка сервера: ' + e.message };
  }
}

function buildOptions(ss, rows) {
  const defaults = { Отдел: [], ФИО: [], Ответ: [], Статус: ['Планируется', 'В процессе', 'Готово'], Прогресс: [] };

  try {
    const refSheet = ss.getSheetByName(REF_SHEET_NAME);
    if (refSheet && refSheet.getLastRow() > 1) {
      const data = refSheet.getDataRange().getDisplayValues();
      const refHeaders = data[0].map(h => String(h || '').trim());
      const body = data.slice(1);
      refHeaders.forEach((h, colIdx) => {
        if (!h || !defaults.hasOwnProperty(h)) return;
        const vals = body.map(r => String(r[colIdx] || '').trim()).filter(v => v !== '');
        defaults[h] = [...new Set(vals)];
      });
    }
  } catch (e) {
    console.error('Ошибка справочника:', e);
  }

  if (!defaults.Отдел.includes('Все')) defaults.Отдел.push('Все');

  defaults.Прогресс = defaults.Прогресс.filter(v => /^\d+%$/.test(v)).sort((a, b) => parseInt(a) - parseInt(b));
  if (!defaults.Прогресс.length) {
    defaults.Прогресс = ['0%', '10%', '20%', '30%', '40%', '50%', '60%', '70%', '80%', '90%', '100%'];
  }

  const ids = [...new Set(rows.map(r => String(r['ID'] || '').trim()).filter(v => v !== ''))];

  // Все люди: справочник + реально встречающиеся в таблице (для вкладки «Обмен»)
  const people = new Set(defaults.ФИО);
  rows.forEach(r => rowPeople_(r).forEach(p => people.add(p)));

  return {
    departments: defaults.Отдел,
    employees: defaults.ФИО,
    people: [...people].sort((a, b) => a.localeCompare(b, 'ru')),
    decision: defaults.Ответ,
    statuses: defaults.Статус,
    progress: defaults.Прогресс,
    ids: ids
  };
}

function updateCell(rowIndex, columnName, newValue) {
  try {
    const sheet = getDataSheet_();
    if (!sheet) return { success: false, message: 'Лист не найден' };
    const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0].map(canonHeader_);
    const colIndex = headers.indexOf(canonHeader_(columnName)) + 1;
    if (colIndex > 0) {
      sheet.getRange(rowIndex, colIndex).setValue(newValue);
      return { success: true };
    }
    return { success: false, message: 'Колонка не найдена: ' + columnName };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

// ============================================================
// ОБМЕН ИНФОРМАЦИЕЙ: кто → что → кому, в разрезе задач и сроков
// ============================================================

// Читает ручные данные листа «Обмен» (Получено, Комментарий) по ключу «ID источника>ID получателя»
function readExchangeManual_() {
  const res = {};
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(EXCHANGE_SHEET_NAME);
  if (!sh || sh.getLastRow() < 2) return res;
  const data = sh.getDataRange().getValues();
  const h = data[0].map(v => String(v).trim());
  const iS = h.indexOf('ID источника'), iD = h.indexOf('ID получателя');
  const iR = h.indexOf('Получено'), iC = h.indexOf('Комментарий');
  if (iS < 0 || iD < 0) return res;
  for (let i = 1; i < data.length; i++) {
    const rv = iR >= 0 ? data[i][iR] : '';
    const received = rv === true || /^(true|да|yes|✓|1)$/i.test(String(rv).trim());
    res[String(data[i][iS]).trim() + '>' + String(data[i][iD]).trim()] = {
      received: received,
      comment: iC >= 0 ? String(data[i][iC] || '') : ''
    };
  }
  return res;
}

// Строит список передач информации. Источники связей:
//  1) «ID Связи»                — зависимость строка <-> строка (в т.ч. задача <-> этап);
//  2) «От кого получаем инф.»   — ID строки ИЛИ ФИО/отдел (внешний источник);
//  3) «Кому передаем инф.»      — ID строки ИЛИ ФИО/отдел (внешний получатель).
// «Что передаётся» берётся из колонки «Результат» строки-источника.
function buildExchange_(rows) {
  const byId = {}, byIdLower = {};
  rows.forEach(r => {
    const id = String(r['ID'] || '').trim();
    if (id && !byId[id]) { byId[id] = r; byIdLower[id.toLowerCase()] = r; }
  });
  const findRow = t => byId[t] || byIdLower[t.toLowerCase()] || null;

  // Токен — это ID строки (одна или несколько через пробел) либо ФИО/отдел
  function resolveTokens_(v) {
    const res = [];
    splitTokens_(v).forEach(t => {
      const o = findRow(t);
      if (o) { res.push({ row: o }); return; }
      const parts = t.split(/\s+/);
      if (parts.length > 1 && parts.every(p => findRow(p))) parts.forEach(p => res.push({ row: findRow(p) }));
      else res.push({ row: null, name: t });
    });
    return res;
  }

  const manual = readExchangeManual_();
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const map = {};
  const warnings = [];

  // src/dst — строка или null; srcName/dstName — ФИО (если конец связи — человек)
  function add(src, dst, srcPerson, dstPerson, how) {
    if (src && dst && src === dst) return;
    const sid = src ? rowId_(src) : '👤 ' + srcPerson;
    const did = dst ? rowId_(dst) : '👤 ' + dstPerson;
    const key = sid + '>' + did;
    if (!map[key]) map[key] = { key: key, src: src, dst: dst, srcPerson: srcPerson, dstPerson: dstPerson, sid: sid, did: did, how: {} };
    map[key].how[how] = true;
  }

  rows.forEach(r => {
    // 1) ID Связи
    splitIds_(r['ID Связи']).forEach(t => {
      const o = findRow(t);
      if (!o) { warnings.push(`Строка ${r._rowIndex}: в «ID Связи» указан несуществующий ID «${t}»`); return; }
      if (LINK_MODE === 'feeds') add(r, o, '', '', 'link'); else add(o, r, '', '', 'link');
    });
    // 2) От кого получаем
    resolveTokens_(r['От кого получаем инф.']).forEach(x => {
      if (x.row) add(x.row, r, '', '', 'in'); else add(null, r, x.name, '', 'in');
    });
    // 3) Кому передаем
    resolveTokens_(r['Кому передаем инф.']).forEach(x => {
      if (x.row) add(r, x.row, '', '', 'out'); else add(r, null, '', x.name, 'out');
    });
  });

  const edges = Object.keys(map).map(k => {
    const e = map[k], s = e.src, d = e.dst;
    const man = manual[k] || { received: false, comment: '' };
    const srcStatus = s ? String(s['Статус'] || '').trim() : '';
    const dstStatus = d ? String(d['Статус'] || '').trim() : '';
    const dueD = s ? parseDate_(s['Финиш']) : null;
    const needD = d ? parseDate_(d['Старт']) : null;
    const srcDone = srcStatus === 'Готово' || man.received;
    const dstStarted = d && ((dstStatus !== '' && dstStatus !== 'Планируется') || (needD && needD <= today));

    let state = 'planned', reason = '';
    if (srcDone || dstStatus === 'Готово') {
      state = 'done';
    } else if ((dueD && dueD < today) || (s && dstStarted)) {
      state = 'blocking';
      const parts = [];
      if (dueD && dueD < today) parts.push(`источник просрочил передачу (срок ${s['Финиш']})`);
      if (s && dstStarted) parts.push('получатель уже ждёт информацию');
      reason = parts.join('; ');
    } else if (dueD && needD && dueD > needD) {
      state = 'risk';
      reason = `источник заканчивает ${s['Финиш']}, а получателю нужно с ${d['Старт']}`;
    }

    const result = s ? String(s['Результат'] || '').trim() : '';
    return {
      key: k,
      declared: Object.keys(e.how).join('+'),
      srcRow: s ? s._rowIndex : null, dstRow: d ? d._rowIndex : null,
      srcId: e.sid, dstId: e.did,
      srcName: s ? rowName_(s) : e.srcPerson, dstName: d ? rowName_(d) : e.dstPerson,
      srcStage: s ? String(s['Этап'] || '') : '', dstStage: d ? String(d['Этап'] || '') : '',
      srcLevel: s ? levelOf_(s) : '', dstLevel: d ? levelOf_(d) : '',
      from: s ? rowPeople_(s) : [e.srcPerson], to: d ? rowPeople_(d) : [e.dstPerson],
      info: result,
      due: s ? String(s['Финиш'] || '') : '', need: d ? String(d['Старт'] || '') : '',
      srcStatus: srcStatus, dstStatus: dstStatus,
      received: man.received, comment: man.comment,
      state: state, reason: reason
    };
  });

  return { edges: edges, warnings: warnings };
}

function levelOf_(r) { return r['Под-задача'] ? 'Под-задача' : (r['Задача'] ? 'Задача' : 'Этап'); }

// Перестраивает лист «Обмен». Столбцы «Получено» и «Комментарий» сохраняются.
function refreshExchangeSheet() {
  try {
    const dataSheet = getDataSheet_();
    if (!dataSheet) return { success: false, message: 'Лист "' + SHEET_NAME + '" не найден' };
    const parsed = readRows_(dataSheet);
    const ex = buildExchange_(parsed ? parsed.rows : []);
    writeExchangeSheet_(ex.edges);
    return { success: true, count: ex.edges.length, warnings: ex.warnings };
  } catch (e) {
    return { success: false, message: e.message };
  }
}

function writeExchangeSheet_(edges) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName(EXCHANGE_SHEET_NAME);
  if (!sh) sh = ss.insertSheet(EXCHANGE_SHEET_NAME);

  const cols = EXCHANGE_HEADERS.length;
  sh.getRange(1, 1, 1, cols).setValues([EXCHANGE_HEADERS]).setFontWeight('bold').setBackground('#e5e7eb');
  sh.setFrozenRows(1);

  const last = sh.getLastRow();
  if (last > 1) {
    const old = sh.getRange(2, 1, last - 1, Math.max(sh.getLastColumn(), cols));
    old.clearContent().clearDataValidations().setBackground(null);
  }
  if (!edges.length) return;

  const sorted = edges.slice().sort((a, b) =>
    (a.from.join(',') + a.srcId).localeCompare(b.from.join(',') + b.srcId, 'ru', { numeric: true }) ||
    a.dstId.localeCompare(b.dstId, 'ru', { numeric: true }));

  const values = sorted.map(e => [
    e.from.join(', '), e.srcName, e.srcId, e.info,
    e.to.join(', '), e.dstName, e.dstId, e.due, e.need,
    STATE_LABELS[e.state], e.received, e.comment
  ]);
  sh.getRange(2, 1, values.length, cols).setValues(values);
  sh.getRange(2, 11, values.length, 1).insertCheckboxes();
  sh.getRange(2, 10, values.length, 1).setBackgrounds(sorted.map(e => [STATE_COLORS[e.state]]));
  sh.getRange(2, 1, values.length, cols).setVerticalAlignment('top');
  sh.getRange(2, 4, values.length, 1).setWrapText(true);
  sh.setColumnWidths(1, 1, 150);
  sh.setColumnWidths(2, 1, 220);
  sh.setColumnWidths(4, 1, 300);
  sh.setColumnWidths(5, 1, 150);
  sh.setColumnWidths(6, 1, 220);
}

// Получатель подтверждает получение информации (галочка «Получено» в листе «Обмен»)
function setExchangeReceived(key, value) {
  try {
    let sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(EXCHANGE_SHEET_NAME);
    if (!sh) { refreshExchangeSheet(); sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(EXCHANGE_SHEET_NAME); }
    const find = () => {
      const data = sh.getDataRange().getValues();
      const h = data[0].map(v => String(v).trim());
      const iS = h.indexOf('ID источника'), iD = h.indexOf('ID получателя'), iR = h.indexOf('Получено');
      for (let i = 1; i < data.length; i++) {
        if (String(data[i][iS]).trim() + '>' + String(data[i][iD]).trim() === key) return { row: i + 1, col: iR + 1 };
      }
      return null;
    };
    let pos = find();
    if (!pos) { refreshExchangeSheet(); pos = find(); }
    if (!pos) return { success: false, message: 'Передача не найдена в листе «Обмен»' };
    sh.getRange(pos.row, pos.col).setValue(!!value);
    return { success: true };
  } catch (e) {
    return { success: false, message: e.message };
  }
}
