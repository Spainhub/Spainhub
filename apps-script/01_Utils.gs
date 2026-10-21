/**********************************************************************
 * 01_Utils.gs — ОБЩИЕ ФУНКЦИИ (даты, числа, формат ячеек, нумерация, кэш)
 *
 * РЕШЕНИЕ ПО ДАТАМ:
 * Даты сохраняем как нативный Date БЕЗ времени (UTC-полдень).
 * UTC-полдень = «иммунитет» к сдвигу на ±1 день в любом часовом поясе:
 * ячейка не «уезжает» ни в скрипте, ни в таблице.
 * Формат ячеек — "dd.MM.yyyy" → отображается только дата, без времени.
 * Формулы СУММЕСЛИМН/ДАТА корректно работают с такими датами.
 *
 * "2026-03-16" → Date (16.03.2026, 12:00 UTC)
 * "2026-08-10T20:10:21Z" → Date (10.08.2026, 12:00 UTC) — время
 * отбрасываем, MSK (+3ч) применяем только для определения дня.
 *
 * РЕШЕНИЕ ПО ЧИСЛАМ:
 * API WB отдаёт числа строками с точкой ("25.44"). В RU-локали это ТЕКСТ.
 * Конвертируем в number (NUMERIC_FIELDS + parseNumber).
 **********************************************************************/

/* ===================== ДАТЫ ЗАГРУЗЧИКА ===================== */

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function formatDate(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function formatRu(d) {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return `${dd}.${mm}.${d.getFullYear()}`;
}

function formatTime(d) {
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mi}`;
}

// "2026-03-16" → Date(16.03.2026 12:00 UTC) — тот же формат «дня», что в DATA_WB.
function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12, 0, 0, 0));
}

function splitByDays(from, to, chunkDays) {
  const chunks = [];
  let cur = new Date(from);
  while (cur <= to) {
    let end = addDays(cur, chunkDays - 1);
    if (end > to) end = to;
    chunks.push({ from: new Date(cur), to: end });
    cur = addDays(end, 1);
  }
  return chunks;
}

/**********************************************************************
 * «ДНИ» ЗАГРУЗЧИКА: Date UTC-полдень, календарь — МСК.
 * Не зависят от часового пояса проекта (у нового проекта он может быть
 * не Москва — тогда «сегодня» и «вчера» сдвигались бы на день).
 **********************************************************************/

function mskToday_() {
  return isoDateToDate(Utilities.formatDate(new Date(), TZ_MSK, 'yyyy-MM-dd'));
}

function dayAdd_(d, n) {
  return new Date(d.getTime() + n * 86400000);
}

function dayKey_(d) {
  return Utilities.formatDate(d, 'UTC', 'yyyy-MM-dd');
}

/** 1-е число месяца MAX_MONTHS_BACK месяцев назад (начало окна хранения). */
function retentionStart_() {
  const t = mskToday_();
  return new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() - MAX_MONTHS_BACK, 1, 12, 0, 0, 0));
}

/* ===================== РАЗБОР ЗНАЧЕНИЙ ===================== */

function parseNumber(s) {
  if (s === '' || s === null || s === undefined) return '';
  const cleaned = String(s)
    .replace(/\s/g, '')
    .replace(',', '.');
  const n = Number(cleaned);
  return isNaN(n) ? '' : n;
}

/**
 * "2026-03-16" → Date(16.03.2026 12:00 UTC).
 * UTC-полдень = защита от сдвига на ±1 день в любом часовом поясе.
 */
function isoDateToDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s).trim());
  if (!m) return '';
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12, 0, 0, 0));
}

/**
 * "2026-08-10T20:10:21Z" → Date(10.08.2026 12:00 UTC).
 * Время отбрасываем. День определяем в MSK: UTC+3.
 */
function isoDateTimeToDate(s) {
  const str = String(s).trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/.exec(str);
  if (!m) return '';

  let year = +m[1];
  let month = +m[2];
  let day = +m[3];
  let hh = +m[4];
  let mi = +m[5];

  // Часовой сдвиг исходной записи
  let offsetMin = 0;
  const tz = m[8];
  if (tz && tz !== 'Z') {
    const tm = /^([+-])(\d{2}):?(\d{2})$/.exec(tz);
    if (tm) {
      const sign = tm[1] === '-' ? -1 : 1;
      offsetMin = sign * (+tm[2] * 60 + +tm[3]);
    }
  }

  // UTC → MSK (+3ч), учитываем переход через полночь
  let totalMin = hh * 60 + mi - offsetMin + MSK_OFFSET_HOURS * 60;
  let dayShift = Math.floor(totalMin / 1440);
  totalMin = ((totalMin % 1440) + 1440) % 1440;

  if (dayShift !== 0) {
    const d = new Date(Date.UTC(year, month - 1, day));
    d.setUTCDate(d.getUTCDate() + dayShift);
    year = d.getUTCFullYear();
    month = d.getUTCMonth() + 1;
    day = d.getUTCDate();
  }
  return new Date(Date.UTC(year, month - 1, day, 12, 0, 0, 0));
}

/* ===================== ЯЧЕЙКИ ДЛЯ WEB APP ===================== */

// Заголовок-«не дата»: пусто или только прочерки (-, –, —) — такие колонки скрываем.
function isDashHeader_(h) {
  return /^[\s\-\u2010-\u2015\u2212]*$/.test(String(h === null || h === undefined ? '' : h));
}

// Date → "dd.MM.yyyy" строкой (для показа в Web App); число/строку не трогает.
// Дата форматируется в часовом поясе ТАБЛИЦЫ (не скрипта): иначе при разных
// поясах «1 августа» превращалось в «31 июля».
function fmtCell(v) {
  if (v === '' || v === null || v === undefined) return '';
  if (v instanceof Date) {
    return Utilities.formatDate(v, SpreadsheetApp.getActive().getSpreadsheetTimeZone(), 'dd.MM.yyyy');
  }
  return v; // числа остаются числами --- фронтенд сам их форматирует
}

// Ячейка-дата (Date или "dd.MM.yyyy") → "yyyy-MM-dd" ('' если не дата).
function cellDateKey_(v) {
  if (v instanceof Date) {
    return Utilities.formatDate(v, SpreadsheetApp.getActive().getSpreadsheetTimeZone(), 'yyyy-MM-dd');
  }
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(v).trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : '';
}

/**********************************************************************
 * ЧИСЛА, КЛЮЧИ ДАТ, КЭШ
 **********************************************************************/

// Как SUMIFS: суммируются только настоящие числа, текст игнорируется.
function Util_num_(v) {
  return (typeof v === 'number' && isFinite(v)) ? v : 0;
}

function Util_r2_(v) {
  return Math.round(v * 100) / 100;
}

function Util_colIndex_(letter) {
  let n = 0;
  for (const ch of String(letter).toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function Util_keyToUtc_(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  return Date.UTC(+m[1], +m[2] - 1, +m[3]);
}

function Util_daysBetween_(fromKey, toKey) {
  return Math.round((Util_keyToUtc_(toKey) - Util_keyToUtc_(fromKey)) / 86400000);
}

function Util_addDaysKey_(key, n) {
  return Utilities.formatDate(new Date(Util_keyToUtc_(key) + n * 86400000 + 12 * 3600000), 'UTC', 'yyyy-MM-dd');
}

function Util_keyToRu_(key) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : key;
}

/**********************************************************************
 * НУМЕРАЦИЯ СТРОК (колонка A): 1, 1.1, 2, 2.1, 2.1.1 …
 * По нумерации строится иерархия: родитель строки «2.1.1» — «2.1», а если
 * её нет — «2». Строка с детьми сворачивается в Web App, вместе с ней
 * сворачиваются все её потомки. Строки без номера (например, «Параметры»)
 * в иерархии не участвуют.
 **********************************************************************/

/**
 * Номер строки из ячейки колонки A. raw — значение, display — как показано
 * в таблице. Таблица иногда превращает «1.1» в дату (1 янв) или число 1,1 —
 * возвращаем номер обратно в вид «1.1». Совет: колонку A лучше держать в
 * формате «Обычный текст», тогда «1.10» не превращается в «1.1».
 */
function Util_numFromCell_(raw, display, tz) {
  if (raw instanceof Date) return Utilities.formatDate(raw, tz, 'd.M');
  let s = (display !== undefined && display !== null && String(display).trim() !== '')
    ? String(display).trim()
    : String(raw === null || raw === undefined ? '' : raw).trim();
  if (typeof raw === 'number') s = s.replace(',', '.');   // «2,1» (число 2.1 в RU-локали) → «2.1»
  return s.replace(/\.+$/, '');
}

/** Проставляет каждой строке level (1, 2, 3…; 0 — без номера), parent (индекс или -1), hasChildren. */
function Util_hierAnnotate_(rows) {
  const idxByKey = {};
  rows.forEach((r, i) => {
    const num = String(r.num === null || r.num === undefined ? '' : r.num);
    const p = /^\d+(\.\d+)*$/.test(num) ? num.split('.').map(Number) : null;
    r.level = p ? p.length : 0;
    r.parent = -1;
    r.hasChildren = false;
    if (!p) return;
    for (let q = p.slice(0, -1); q.length; q = q.slice(0, -1)) {
      const k = q.join('.');
      if (idxByKey[k] !== undefined) { r.parent = idxByKey[k]; break; }
    }
    idxByKey[p.join('.')] = i;
  });
  rows.forEach(r => { if (r.parent >= 0) rows[r.parent].hasChildren = true; });
  return rows;
}

/**********************************************************************
 * ВЫПАДАЮЩИЕ СПИСКИ (проверка данных ячейки)
 **********************************************************************/

/**
 * Варианты выпадающего списка ячейки: правило «значение из диапазона» или
 * «значение из списка». Возвращает { kind: 'list', options: [...] } (подписи
 * как в таблице), { kind: 'other', options: [] } для прочих правил, null —
 * если правила нет.
 */
function Util_validOptions_(rule) {
  if (!rule) return null;
  const C = SpreadsheetApp.DataValidationCriteria;
  const type = rule.getCriteriaType();
  const vals = rule.getCriteriaValues();
  let opts = null;
  if (type === C.VALUE_IN_RANGE && vals[0]) {
    opts = [].concat.apply([], vals[0].getDisplayValues());
  } else if (type === C.VALUE_IN_LIST && vals[0]) {
    opts = vals[0];
  }
  if (!opts) return { kind: 'other', options: [] };
  const seen = {}, out = [];
  opts.forEach(o => {
    const s = String(o === null || o === undefined ? '' : o).trim();
    if (s !== '' && !seen[s]) { seen[s] = 1; out.push(s); }
  });
  return { kind: 'list', options: out };
}

/**********************************************************************
 * КЭШ (CacheService хранит до 100 КБ на ключ — режем JSON на куски)
 **********************************************************************/

// CacheService хранит до 100 КБ на ключ — режем JSON на куски.
function Util_cachePutJson_(prefix, sig, obj) {
  try {
    const cache = CacheService.getScriptCache();
    const json = JSON.stringify(obj);
    const size = 90000;
    const parts = {};
    let count = 0;
    for (let i = 0; i < json.length; i += size) parts[prefix + 'p' + (count++)] = json.slice(i, i + size);
    if (count > 50) return; // слишком большой объём — не кэшируем
    parts[prefix + 'meta'] = JSON.stringify({ sig: sig, count: count });
    cache.putAll(parts, 6 * 60 * 60);
  } catch (e) {
    Logger.log('Кэш не сохранён: ' + e.message);
  }
}

function Util_cacheGetJson_(prefix, sig) {
  try {
    const cache = CacheService.getScriptCache();
    const meta = cache.get(prefix + 'meta');
    if (!meta) return null;
    const m = JSON.parse(meta);
    if (m.sig !== sig) return null;
    const keys = [];
    for (let i = 0; i < m.count; i++) keys.push(prefix + 'p' + i);
    const got = cache.getAll(keys);
    let json = '';
    for (const k of keys) {
      if (got[k] === undefined) return null;
      json += got[k];
    }
    return JSON.parse(json);
  } catch (e) {
    return null;
  }
}
