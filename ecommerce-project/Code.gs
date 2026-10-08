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
// Вкладка «Обмен» в веб-приложении только показывает данные — в таблицу ничего не пишется.
// Заголовок страницы: список проектов берётся из колонки «Проекты» листа «Справочник».
// Если в «Таблице» есть колонка «Проект», строки фильтруются по выбранному проекту.
// ============================================================

// 'depends_on' — «ID Связи» = от каких строк зависит эта (они -> эта)
// 'feeds'      — «ID Связи» = какие строки зависят от этой (эта -> они)
const LINK_MODE = 'depends_on';

const SHEET_NAME = 'Таблица';
const SHEET_NAME_OLD = 'Data';
const REF_SHEET_NAME = 'Справочник';
const EXPECTED_HEADERS = [
  'ID', 'ID Связи', '№', 'Этап', 'Задача', 'Под-задача', 'Владелец результата', 'Ответственный',
  'Решающий', 'Информируемые', 'От кого получаем инф.', 'Кому передаем инф.', 'Старт', 'Финиш',
  'Статус', 'Блокер', 'Кем заблок.', 'С какого числа', 'Прогресс', 'Документ', 'Результат', 'Комментарий'
];

function doGet() {
  return HtmlService.createTemplateFromFile('Index')
    .evaluate()
    .setTitle('E-commerce Project 1.0')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL)
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
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

// Ссылка из ячейки «Документ»: гиперссылка на всю ячейку / на часть текста / формула HYPERLINK / URL в тексте
function extractUrl_(rich, formula, text) {
  try {
    if (rich) {
      const u = rich.getLinkUrl();
      if (u) return u;
      const runs = rich.getRuns();
      for (let i = 0; i < runs.length; i++) { const ru = runs[i].getLinkUrl(); if (ru) return ru; }
    }
  } catch (e) { /* нет ссылки */ }
  const f = String(formula || '').match(/HYPERLINK\(\s*"([^"]+)"/i);
  if (f) return f[1];
  const m = String(text || '').match(/https?:\/\/[^\s)]+/i);
  return m ? m[0] : '';
}

function readRows_(sheet) {
  const range = sheet.getDataRange();
  const data = range.getDisplayValues();
  if (data.length < 2) return null;
  const headers = data[0].map(canonHeader_);
  const numIdx = headers.indexOf('№');
  const docIdx = headers.indexOf('Документ');

  let rich = null, formulas = null;
  if (docIdx >= 0) {
    const col = sheet.getRange(2, range.getColumn() + docIdx, data.length - 1, 1);
    rich = col.getRichTextValues();
    formulas = col.getFormulas();
  }

  const rows = data.slice(1).map((row, index) => {
    const obj = { _rowIndex: index + 2 };
    headers.forEach((h, i) => { if (h) obj[h] = row[i]; });
    obj._num = (numIdx >= 0 && String(row[numIdx] || '').trim()) ? String(row[numIdx]).trim() : String(index + 1);
    if (docIdx >= 0) obj._docUrl = extractUrl_(rich[index][0], formulas[index][0], row[docIdx]);
    return obj;
  });
  return { headers: headers, rows: rows };
}

// ---------- Главные данные ----------

function getProjectData(project) {
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = getDataSheet_();
    if (!sheet) {
      return { _error: `Лист "${SHEET_NAME}" не найден. Переименуйте лист "Data" в "${SHEET_NAME}".` };
    }
    const parsed = readRows_(sheet);
    if (!parsed) return { _error: 'Лист пуст или содержит только заголовки.' };

    const options = buildOptions(ss, parsed.rows);
    // Фильтр по проекту — только если в «Таблице» есть колонка «Проект» и проект выбран
    let rows = parsed.rows;
    if (project && parsed.headers.indexOf('Проект') >= 0) {
      rows = rows.filter(r => String(r['Проект'] || '').trim() === project);
    }
    return {
      headers: parsed.headers,
      rows: rows,
      options: options,
      project: project || '',
      exchange: buildExchange_(rows),
      _debug: `Успех! Загружено строк: ${rows.length}`
    };
  } catch (e) {
    return { _error: 'Критическая ошибка сервера: ' + e.message };
  }
}

function buildOptions(ss, rows) {
  const defaults = { Отдел: [], ФИО: [], Ответ: [], Проекты: [], Статус: ['Планируется', 'В процессе', 'Готово'], Прогресс: [] };

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
    projects: defaults.Проекты,
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

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const map = {};

  // «Результат» строк человека, который передаёт информацию (если у него нет своей строки-источника):
  // сначала строки, где он указал получателя по ID, затем строки того же этапа
  function personResult_(person, dstRow) {
    const pl = String(person || '').toLowerCase();
    if (!pl || !dstRow) return '';
    const same = n => { const x = n.toLowerCase(); return x === pl || x.indexOf(pl) === 0 || pl.indexOf(x) === 0; };
    const cands = rows.filter(x => x !== dstRow && String(x['Результат'] || '').trim() && rowPeople_(x).some(same));
    if (!cands.length) return '';
    const did = rowId_(dstRow).toLowerCase();
    let pick = cands.filter(x => splitTokens_(x['Кому передаем инф.']).some(t => t.toLowerCase().split(/\s+/).indexOf(did) >= 0));
    if (!pick.length) pick = cands.filter(x => x['Этап'] && x['Этап'] === dstRow['Этап']);
    const vals = [];
    pick.forEach(x => { const v = String(x['Результат']).trim(); if (vals.indexOf(v) < 0) vals.push(v); });
    return vals.join('; ');
  }
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
    const srcStatus = s ? String(s['Статус'] || '').trim() : '';
    const dstStatus = d ? String(d['Статус'] || '').trim() : '';
    const dueD = s ? parseDate_(s['Финиш']) : null;
    const needD = d ? parseDate_(d['Старт']) : null;
    const srcDone = srcStatus === 'Готово';
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

    // «Результат» источника; если источник — человек вне таблицы, берём «Результат» его строк
    const result = s ? String(s['Результат'] || '').trim() : personResult_(e.srcPerson, d);
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
      state: state, reason: reason
    };
  });

  return { edges: edges, warnings: warnings };
}

function levelOf_(r) { return r['Под-задача'] ? 'Под-задача' : (r['Задача'] ? 'Задача' : 'Этап'); }

