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
// Лист «Митинг»: встречи и протоколы; связь с Таблицей — по «Этап / Задача / Под-задача», а если они пусты — по «№».
// Лист «Главная»: содержимое A1:H40 (текст, ссылки, цвета, объединения) показывается на вкладке «Главная».
// Заголовок страницы: список проектов берётся из колонки «Проекты» листа «Справочник».
// Если в «Таблице» есть колонка «Проект», строки фильтруются по выбранному проекту.
// ============================================================

// 'depends_on' — «ID Связи» = от каких строк зависит эта (они -> эта)
// 'feeds'      — «ID Связи» = какие строки зависят от этой (эта -> они)
const LINK_MODE = 'depends_on';

const SHEET_NAME = 'Таблица';
const SHEET_NAME_OLD = 'Data';
const MEET_SHEET_NAME = 'Митинг';   // встречи, привязанные к этапам / задачам / под-задачам
const HOME_SHEET_NAME = 'Главная';  // диапазон A1:H40 выводится на вкладке «Главная»
const HOME_RANGE = { rows: 40, cols: 8 };
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
    const meet = safe_(() => readMeetings_(rows, project), { missing: false, items: [] });
    return {
      headers: parsed.headers,
      rows: rows,
      options: options,
      project: project || '',
      exchange: buildExchange_(rows),
      meetings: meet.items,
      meetingsMissing: meet.missing,
      home: safe_(readHome_, null),
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
    // Блокер источника — по колонкам таблицы «Блокер» / «Кем заблок.» / «С какого числа»
    const srcBlocker = s ? String(s['Блокер'] || '').trim() : '';
    const srcBlockedBy = s ? String(s['Кем заблок.'] || '').trim() : '';
    const srcSince = s ? String(s['С какого числа'] || '').trim() : '';
    const srcBlocked = !!(srcBlocker || srcBlockedBy);

    // Статус передачи определяется СТАТУСОМ ЗАДАЧИ-ИСТОЧНИКА (колонки таблицы), по приоритету:
    //  Передано (Готово) > Блокирует (заполнен Блокер / Кем заблок.) > Риск срока (просрочен Финиш
    //  или Финиш источника позже Старта получателя) > В работе (В процессе) > Запланировано
    let state = 'planned', reason = '';
    if (srcDone || dstStatus === 'Готово') {
      state = 'done';
    } else if (srcBlocked) {
      state = 'blocking';
      reason = 'Источник заблокирован: ' + [srcBlocker, srcBlockedBy ? 'кем: ' + srcBlockedBy : ''].filter(Boolean).join(', ') + (srcSince ? ' (с ' + srcSince + ')' : '');
    } else if (dueD && dueD < today) {
      state = 'risk';
      reason = `срок передачи просрочен (Финиш источника ${s['Финиш']})`;
    } else if (dueD && needD && dueD > needD) {
      state = 'risk';
      reason = `источник заканчивает ${s['Финиш']}, а получателю нужно с ${d['Старт']}`;
    } else if (srcStatus === 'В процессе') {
      state = 'progress';
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
      srcOwner: s ? splitPeople_(s['Владелец результата']).join(', ') : '',
      srcDecider: s ? String(s['Решающий'] || '').trim() : '',
      srcBlocker: srcBlocker, srcBlockedBy: srcBlockedBy, srcSince: srcSince,
      info: result,
      due: s ? String(s['Финиш'] || '') : '', need: d ? String(d['Старт'] || '') : '',
      srcStatus: srcStatus, dstStatus: dstStatus,
      state: state, reason: reason
    };
  });

  return { edges: edges, warnings: warnings };
}

function levelOf_(r) { return r['Под-задача'] ? 'Под-задача' : (r['Задача'] ? 'Задача' : 'Этап'); }



// ============================================================
// ВСПОМОГАТЕЛЬНОЕ
// ============================================================

// Ошибка в дополнительном блоке (митинги, главная) не должна ломать основную загрузку
function safe_(fn, fallback) {
  try { return fn(); } catch (e) { console.error(e); return fallback; }
}

// Ссылки в колонке (для «Протокол встречи», «Повестка встречи»): по ячейкам, как для «Документ»
function readLinkColumn_(sheet, range, nRows, colIdx) {
  if (colIdx < 0 || nRows < 1) return null;
  const col = sheet.getRange(2, range.getColumn() + colIdx, nRows, 1);
  return { rich: col.getRichTextValues(), formulas: col.getFormulas() };
}

// ============================================================
// МИТИНГИ (лист «Митинг»)
// ============================================================

function readMeetings_(rows, project) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(MEET_SHEET_NAME) || ss.getSheetByName('Митинги');
  if (!sh) return { missing: true, items: [] };
  const range = sh.getDataRange();
  const data = range.getDisplayValues();
  if (data.length < 2) return { missing: false, items: [] };

  const headers = data[0].map(h => String(h || '').trim());
  const n = data.length - 1;
  const protocol = readLinkColumn_(sh, range, n, headers.indexOf('Протокол встречи'));
  const agenda = readLinkColumn_(sh, range, n, headers.indexOf('Повестка встречи'));

  // Индексы для привязки к Таблице
  const norm = v => String(v == null ? '' : v).trim().toLowerCase();
  const normNum = v => String(v == null ? '' : v).trim().replace(/,$/, '').replace(/\s+/g, '');
  const byNum = {};
  rows.forEach(r => { const k = normNum(r['№']); if (k && !byNum[k]) byNum[k] = r; });

  function findTask(m) {
    const st = norm(m['Этап']), tk = norm(m['Задача']), sb = norm(m['Под-задача']);
    let hit = null;
    if (sb) hit = rows.find(r => norm(r['Под-задача']) === sb && (!tk || norm(r['Задача']) === tk) && (!st || norm(r['Этап']) === st));
    else if (tk) hit = rows.find(r => !norm(r['Под-задача']) && norm(r['Задача']) === tk && (!st || norm(r['Этап']) === st));
    else if (st) hit = rows.find(r => !norm(r['Задача']) && !norm(r['Под-задача']) && norm(r['Этап']) === st);
    if (hit) return hit;
    // имена не заданы или не найдены — пробуем «№» (структурный номер из Таблицы)
    const num = normNum(m['№']);
    return num && byNum[num] ? byNum[num] : null;
  }

  const items = [];
  data.slice(1).forEach((row, i) => {
    const m = { _rowIndex: i + 2 };
    headers.forEach((h, c) => { if (h) m[h] = row[c]; });
    const has = ['ID', 'Дата', 'Тема встречи', 'Повестка встречи', 'Протокол встречи', 'Участники встречи']
      .some(h => String(m[h] || '').trim() !== '');
    if (!has) return;
    if (project && headers.indexOf('Проект') >= 0 && String(m['Проект'] || '').trim() !== project) return;
    const t = findTask(m);
    m._taskRow = t ? t._rowIndex : null;
    m._taskName = t ? rowName_(t) : '';
    m._taskLevel = t ? levelOf_(t) : '';
    m._protocolUrl = protocol ? extractUrl_(protocol.rich[i][0], protocol.formulas[i][0], row[headers.indexOf('Протокол встречи')]) : '';
    m._agendaUrl = agenda ? extractUrl_(agenda.rich[i][0], agenda.formulas[i][0], row[headers.indexOf('Повестка встречи')]) : '';
    items.push(m);
  });
  return { missing: false, items: items };
}

// ============================================================
// ГЛАВНАЯ: диапазон A1:H40 листа «Главная» (текст, ссылки, цвета, объединённые ячейки)
// ============================================================

function readHome_() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(HOME_SHEET_NAME);
  if (!sh) return null;
  const R = HOME_RANGE.rows, C = HOME_RANGE.cols;
  const rng = sh.getRange(1, 1, R, C);
  const disp = rng.getDisplayValues(), rich = rng.getRichTextValues(), fml = rng.getFormulas();
  const bgs = rng.getBackgrounds(), fw = rng.getFontWeights(), fc = rng.getFontColors();
  const fsz = rng.getFontSizes(), ha = rng.getHorizontalAlignments(), fst = rng.getFontStyles();

  const isWhite = c => !c || /^#?f{6}$/i.test(String(c).replace('#', ''));
  const cells = [];
  let lastR = -1, lastC = -1;
  for (let r = 0; r < R; r++) {
    const rowArr = [];
    for (let c = 0; c < C; c++) {
      const text = disp[r][c];
      const bg = isWhite(bgs[r][c]) ? '' : bgs[r][c];
      if (text === '' && !bg) { rowArr.push(null); continue; }
      let runs = [];
      try {
        runs = (rich[r][c] ? rich[r][c].getRuns() : []).map(run => {
          const st = run.getTextStyle();
          let col = '';
          try { col = st.getForegroundColor() || ''; } catch (e) { /* нет цвета */ }
          return { t: run.getText(), u: run.getLinkUrl() || '', b: st.isBold(), i: st.isItalic(), c: col };
        });
      } catch (e) { runs = []; }
      if (!runs.length) runs = [{ t: text, u: '', b: false, i: false, c: '' }];
      // формула =HYPERLINK("url";"текст"): ссылка на всю ячейку
      const f = String(fml[r][c] || '').match(/HYPERLINK\(\s*"([^"]+)"/i);
      if (f && !runs.some(x => x.u)) runs.forEach(x => { x.u = f[1]; });
      rowArr.push({
        runs: runs, bg: bg,
        b: String(fw[r][c]) === 'bold', i: String(fst[r][c]) === 'italic',
        c: fc[r][c] && fc[r][c] !== '#000000' ? fc[r][c] : '',
        fs: fsz[r][c], ha: ha[r][c]
      });
      lastR = Math.max(lastR, r); lastC = Math.max(lastC, c);
    }
    cells.push(rowArr);
  }
  if (lastR < 0) return { rows: 0, cols: 0, cells: [], widths: [], heights: [], merges: [] };

  const merges = rng.getMergedRanges().map(m => ({
    r: m.getRow() - 1, c: m.getColumn() - 1, rs: m.getNumRows(), cs: m.getNumColumns()
  }));
  merges.forEach(m => { lastR = Math.max(lastR, m.r + m.rs - 1); lastC = Math.max(lastC, m.c + m.cs - 1); });
  lastR = Math.min(lastR, R - 1); lastC = Math.min(lastC, C - 1);

  const widths = [], heights = [];
  for (let c = 0; c <= lastC; c++) widths.push(sh.getColumnWidth(c + 1));
  for (let r = 0; r <= lastR; r++) heights.push(sh.getRowHeight(r + 1));
  return {
    rows: lastR + 1, cols: lastC + 1,
    cells: cells.slice(0, lastR + 1).map(row => row.slice(0, lastC + 1)),
    widths: widths, heights: heights,
    merges: merges.filter(m => m.r <= lastR && m.c <= lastC)
  };
}
