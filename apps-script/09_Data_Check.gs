/**********************************************************************
 * 09_Data_Check.gs
 * КОНТРОЛЬ ПОЛНОТЫ ДАННЫХ DATA_WB (пропуски автоматической загрузки)
 *
 * Что проверяется (окно = с 1-го числа месяца 3 месяца назад по вчера,
 * т.е. ровно то, что нужно колонкам K:M и E:J листа P&L ОТЧЕТ):
 *  1. Пропущенные дни — в DATA_WB нет ни одной строки за дату rrDate.
 *  2. «Провалы» — строк за день < GAP_LOW_RATIO от медианы соседних
 *     дней (признак недогруженного дня: таймаут, 5xx, WB дописал позже).
 *  3. Актуальность — дата последней строки и время последней успешной
 *     загрузки (журнал LOG).
 *  4. Структура — колонки, на которые ссылаются формулы P&L ОТЧЕТ
 *     (V, Z, AB, AH, AR, BI, BL, BM), не «уехали» после миграции
 *     заголовков; AB = rrDate.
 *  5. Типы операций (колонка Z) — какие значения реально приходят и
 *     какие из них не попадают в формулы (например, «Возврат» вместо
 *     «Возвраты»).
 *  6. Дубликаты rrdId, строки без даты, строки старше окна хранения
 *     (не отработала очистка), наличие ежедневного триггера, «зависшая»
 *     очередь загрузки.
 *
 * Результат: лист "DATA_CHECK" и статус для Web App (плашка в шапке).
 * Пропуски дозагружаются автоматически в dailyUpdate()
 * (не более GAP_MAX_ATTEMPTS попыток на день) или вручную из меню.
 *
 * ВАЖНО: все имена в этом файле имеют префикс GAP_ / Gap_.
 **********************************************************************/

const GAP_LOW_RATIO = 0.3;        // день < 30% медианы соседей — «провал»
const GAP_GRACE_DAYS = 1;         // вчера может быть ещё не опубликовано WB
const GAP_MAX_ATTEMPTS = 3;       // попыток дозагрузки одного дня
const GAP_MAX_HEAL_RANGES = 6;    // диапазонов дозагрузки за один запуск
const GAP_STALE_HOURS = 36;       // нет успешной загрузки дольше — тревога

const GAP_PROP_ATTEMPTS = 'GAP_HEAL_ATTEMPTS';
const GAP_PROP_BASELINE = 'GAP_HEADER_BASELINE';
const GAP_PROP_STATUS = 'GAP_STATUS';

// Колонки, на которые ссылаются формулы P&L ОТЧЕТ (кроме Z и AB — у них
// своя проверка): должны быть числовыми полями API.
const GAP_MONEY_LETTERS = ['V', 'AH', 'AR', 'BI', 'BL', 'BM'];

/* =================== МЕНЮ =================== */

function Gap_checkMenu() {
  const res = Gap_runCheck();
  const ss = SpreadsheetApp.getActive();
  ss.setActiveSheet(ss.getSheetByName(SHEET_DATA_CHECK));
  SpreadsheetApp.getUi().alert(
    'Контроль данных: ' + Gap_statusLabel_(res.status),
    res.issues.length ? res.issues.map(i => '• ' + i.text).join('\n') : 'Пропусков и ошибок не найдено.',
    SpreadsheetApp.getUi().ButtonSet.OK
  );
}

function Gap_healMenu() {
  const ranges = Gap_findHealRanges_(null, true);
  if (!ranges.length) {
    SpreadsheetApp.getUi().alert('Дозагружать нечего — пропущенных дней нет.');
    return;
  }
  ranges.forEach(r => enqueueLoad_(r.from, r.to, 'дозагрузка пропусков'));
  SpreadsheetApp.getActive().toast(
    'Дозагрузка: ' + ranges.map(r => formatRu(r.from) + '–' + formatRu(r.to)).join(', '),
    'Контроль данных', 10
  );
  processLoadQueue_();
}

/** Вызывать из редактора, если структуру DATA_WB изменили осознанно. */
function Gap_resetHeaderBaseline() {
  PropertiesService.getScriptProperties().deleteProperty(GAP_PROP_BASELINE);
  Logger.log('Эталон заголовков сброшен — будет записан при следующей проверке.');
}

/** Для Web App: короткий статус (плашка в шапке отчёта). */
function Gap_getStatus() {
  const s = PropertiesService.getScriptProperties().getProperty(GAP_PROP_STATUS);
  return s ? JSON.parse(s) : null;
}

/* =================== ПРОВЕРКА =================== */

function Gap_runCheck(opts) {
  opts = opts || {};
  const res = Gap_analyze_();
  Gap_writeSheet_(res);

  const props = PropertiesService.getScriptProperties();
  props.setProperty(GAP_PROP_STATUS, JSON.stringify({
    status: res.status,
    text: Gap_shortText_(res),
    lastDate: res.lastKey ? Util_keyToRu_(res.lastKey) : '',
    checkedAt: formatRu(new Date()) + ' ' + formatTime(new Date()),
    missing: res.missing.length,
    low: res.low.length
  }));

  return res;
}

function Gap_analyze_() {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName(SHEET_DATA);
  const issues = [];
  const add = (level, text) => issues.push({ level: level, text: text });

  const todayKey = dayKey_(mskToday_());
  const startKey = dayKey_(retentionStart_());
  const endKey = dayKey_(dayAdd_(mskToday_(), -1));
  const graceFromKey = dayKey_(dayAdd_(mskToday_(), -GAP_GRACE_DAYS));

  const res = {
    windowFrom: startKey, windowTo: endKey,
    days: [], missing: [], low: [], pending: [], confirmedEmpty: [],
    operTypes: [], issues: issues, lastKey: '', firstKey: '',
    totalRows: 0, duplicates: 0, noDate: 0, stale: 0, status: 'ok'
  };

  if (!sh || sh.getLastRow() < 2) {
    add('error', 'Лист DATA_WB пуст — выполните «Первый запуск».');
    res.status = 'error';
    return res;
  }

  const n = sh.getLastRow() - 1;
  const lastCol = sh.getLastColumn();
  const headers = sh.getRange(1, 1, 1, lastCol).getValues()[0];
  res.totalRows = n;

  /* ---- 4. Структура колонок ---- */
  const at = letter => {
    const i = Util_colIndex_(letter);
    return i <= lastCol ? String(headers[i - 1]) : '';
  };
  if (at(DATA_COLS.date) !== 'rrDate') {
    add('error', `Колонка ${DATA_COLS.date} = «${at(DATA_COLS.date)}», ожидается rrDate — формулы P&L ОТЧЕТ фильтруют не по той дате.`);
  }
  GAP_MONEY_LETTERS.forEach(l => {
    const h = at(l);
    if (!NUMERIC_FIELDS.has(h)) {
      add('error', `Колонка ${l} = «${h || 'пусто'}» — не числовое поле API, формулы P&L ОТЧЕТ считают не то.`);
    }
  });
  const props = PropertiesService.getScriptProperties();
  const watched = GAP_MONEY_LETTERS.concat([DATA_COLS.oper, DATA_COLS.date]);
  const current = {};
  watched.forEach(l => { current[l] = at(l); });
  const baseRaw = props.getProperty(GAP_PROP_BASELINE);
  if (!baseRaw) {
    props.setProperty(GAP_PROP_BASELINE, JSON.stringify(current));
  } else {
    const base = JSON.parse(baseRaw);
    const changed = watched.filter(l => base[l] !== current[l])
      .map(l => `${l}: «${base[l]}» → «${current[l]}»`);
    if (changed.length) {
      add('error', 'Изменились колонки, на которые ссылаются формулы: ' + changed.join('; ') +
        '. Если это ожидаемо — Gap_resetHeaderBaseline().');
    }
  }

  /* ---- Чтение нужных колонок ---- */
  const dateIdx = headers.indexOf('rrDate');
  if (dateIdx < 0) {
    add('error', 'В DATA_WB нет колонки rrDate — проверить пропуски невозможно.');
    res.status = 'error';
    return res;
  }
  const col = i => sh.getRange(2, i, n, 1).getValues().map(r => r[0]);
  const dates = col(dateIdx + 1);
  const rrdIdx = headers.indexOf('rrdId');
  const rrd = rrdIdx >= 0 ? col(rrdIdx + 1) : null;
  const operCol = Util_colIndex_(DATA_COLS.oper);
  const amtCol = Util_colIndex_(DATA_COLS.amount);
  const oper = operCol <= lastCol ? col(operCol) : new Array(n).fill('');
  const amt = amtCol <= lastCol ? col(amtCol) : new Array(n).fill(0);

  /* ---- Агрегация по дням ---- */
  const perDay = {};
  const opers = {};
  const seen = new Set();
  const keyCache = {};
  for (let i = 0; i < n; i++) {
    if (rrd) {
      const id = String(rrd[i]);
      if (id !== '') {
        if (seen.has(id)) res.duplicates++; else seen.add(id);
      }
    }
    const v = dates[i];
    if (!(v instanceof Date)) { res.noDate++; continue; }
    const t = v.getTime();
    let k = keyCache[t];
    if (k === undefined) k = keyCache[t] = dayKey_(v);
    if (!res.lastKey || k > res.lastKey) res.lastKey = k;
    if (!res.firstKey || k < res.firstKey) res.firstKey = k;
    if (k < startKey) { res.stale++; continue; }

    const d = perDay[k] || (perDay[k] = { rows: 0, sales: 0 });
    d.rows++;
    const op = String(oper[i] || '').trim();
    if (op === OPER_SALE) d.sales += Util_num_(amt[i]);
    const o = opers[op] || (opers[op] = { rows: 0, amount: 0 });
    o.rows++;
    o.amount += Util_num_(amt[i]);
  }

  /* ---- 1–2. Пропуски и провалы ---- */
  const attempts = Gap_getAttempts_();
  const keys = [];
  for (let k = startKey; k <= endKey; k = Util_addDaysKey_(k, 1)) keys.push(k);
  const counts = keys.map(k => (perDay[k] ? perDay[k].rows : 0));

  keys.forEach((k, i) => {
    const rows = counts[i];
    let status = 'ok';
    if (rows === 0) {
      if (k >= graceFromKey) status = 'pending';
      else if ((attempts[k] || 0) >= GAP_MAX_ATTEMPTS) status = 'empty';
      else status = 'missing';
    } else {
      const neigh = [];
      for (let j = Math.max(0, i - 7); j <= Math.min(counts.length - 1, i + 7); j++) {
        if (j !== i && counts[j] > 0) neigh.push(counts[j]);
      }
      const med = Gap_median_(neigh);
      if (med && rows < med * GAP_LOW_RATIO) status = 'low';
    }
    res.days.push({ key: k, rows: rows, sales: perDay[k] ? perDay[k].sales : 0, status: status });
    if (status === 'missing') res.missing.push(k);
    if (status === 'low') res.low.push(k);
    if (status === 'pending') res.pending.push(k);
    if (status === 'empty') res.confirmedEmpty.push(k);
  });

  if (res.missing.length) {
    add('error', `Пропущено дней: ${res.missing.length} (${Gap_rangesText_(res.missing)}). Меню «Контроль данных» → «Дозагрузить пропуски».`);
  }
  if (res.low.length) {
    add('warn', `Подозрительно мало строк: ${res.low.length} дн. (${Gap_rangesText_(res.low)}) — возможно, день загружен не полностью.`);
  }
  if (res.pending.length) {
    add('info', `Ещё не опубликовано WB: ${Gap_rangesText_(res.pending)} — загрузится при следующем обновлении.`);
  }
  if (res.confirmedEmpty.length) {
    add('warn', `WB не вернул данных после ${GAP_MAX_ATTEMPTS} попыток: ${Gap_rangesText_(res.confirmedEmpty)}.`);
  }

  /* ---- 3. Актуальность ---- */
  if (res.lastKey && res.lastKey < dayKey_(dayAdd_(mskToday_(), -(GAP_GRACE_DAYS + 1)))) {
    add('error', `Последние данные — за ${Util_keyToRu_(res.lastKey)}. Ежедневная загрузка отстаёт.`);
  }
  const lastOk = Gap_lastSuccessfulLoad_();
  if (!lastOk) {
    add('warn', 'В журнале LOG нет успешных загрузок.');
  } else if ((Date.now() - lastOk.getTime()) / 3600000 > GAP_STALE_HOURS) {
    add('error', `Последняя успешная загрузка: ${formatRu(lastOk)} ${formatTime(lastOk)} — больше ${GAP_STALE_HOURS} ч назад.`);
  }
  const errs = Gap_recentLoadErrors_(7);
  if (errs.length) {
    add('warn', `Ошибки загрузки за 7 дней: ${errs.length}. Последняя: ${errs[errs.length - 1]}`);
  }

  /* ---- 5. Типы операций ---- */
  const covered = [OPER_SALE, OPER_RETURN, OPER_LOGISTICS];
  res.operTypes = Object.keys(opers).sort((a, b) => opers[b].rows - opers[a].rows)
    .map(k => ({ name: k || '(пусто)', rows: opers[k].rows, amount: opers[k].amount, covered: covered.includes(k) }));
  if (!opers[OPER_RETURN]) {
    const similar = Object.keys(opers).filter(k => /^возврат/i.test(k));
    if (similar.length) {
      add('warn', `Формулы ищут тип «${OPER_RETURN}», а в данных есть только: ${similar.map(s => '«' + s + '»').join(', ')} — возвраты не вычитаются из выручки.`);
    }
  }
  if (!opers[OPER_SALE]) {
    add('error', `В колонке ${DATA_COLS.oper} нет значения «${OPER_SALE}» — выручка в P&L ОТЧЕТ будет 0.`);
  }

  /* ---- 6. Прочее ---- */
  if (res.duplicates) add('warn', `Дубликаты rrdId: ${res.duplicates} — суммы завышены.`);
  if (res.noDate) add('warn', `Строк без даты rrDate: ${res.noDate} — не попадают ни в один период.`);
  if (res.stale) add('info', `Строк старше окна хранения: ${res.stale} — будут удалены очисткой.`);
  if (!Gap_hasDailyTrigger_()) {
    add('warn', 'Ежедневный триггер не найден (для текущего пользователя). Меню «Контроль данных» → «Установить ежедневный триггер».');
  }
  const q = getLoadQueue_();
  if (q.length && q[0].updatedAt && Date.now() - q[0].updatedAt > 2 * 3600000) {
    add('error', `Очередь загрузки не двигается больше 2 ч (${q[0].label}, с ${q[0].cur}). Запустите «Ежедневное обновление».`);
  }

  res.status = issues.some(i => i.level === 'error') ? 'error'
    : (issues.some(i => i.level === 'warn') ? 'warn' : 'ok');
  return res;
}

/* =================== ДОЗАГРУЗКА =================== */

/**
 * Диапазоны дат для дозагрузки: пропущенные и «провальные» дни
 * (у каждого < GAP_MAX_ATTEMPTS попыток). beforeKey — брать только дни
 * раньше этой даты (более поздние и так перезагружаются перекрытием).
 * Соседние дни с разрывом ≤ 2 дней склеиваются, чтобы экономить запросы
 * (лимит WB — 1 запрос в минуту). Попытки засчитываются сразу.
 */
function Gap_findHealRanges_(beforeKey, includeLow) {
  const res = Gap_analyze_();
  const attempts = Gap_getAttempts_();
  let keys = res.missing.concat(includeLow === false ? [] : res.low)
    .filter(k => (attempts[k] || 0) < GAP_MAX_ATTEMPTS)
    .sort();
  if (beforeKey) keys = keys.filter(k => k < beforeKey);
  if (!keys.length) return [];

  const ranges = [];
  keys.forEach(k => {
    const last = ranges[ranges.length - 1];
    if (last && Util_daysBetween_(last.to, k) <= 3) last.to = k;
    else ranges.push({ from: k, to: k });
  });
  const picked = ranges.slice(0, GAP_MAX_HEAL_RANGES);

  picked.forEach(r => {
    for (let k = r.from; k <= r.to; k = Util_addDaysKey_(k, 1)) {
      if (keys.includes(k)) attempts[k] = (attempts[k] || 0) + 1;
    }
  });
  Gap_saveAttempts_(attempts);

  return picked.map(r => ({ from: isoDateToDate(r.from), to: isoDateToDate(r.to) }));
}

function Gap_getAttempts_() {
  const raw = PropertiesService.getScriptProperties().getProperty(GAP_PROP_ATTEMPTS);
  return raw ? JSON.parse(raw) : {};
}

function Gap_saveAttempts_(obj) {
  const startKey = dayKey_(retentionStart_());
  Object.keys(obj).forEach(k => { if (k < startKey) delete obj[k]; });
  PropertiesService.getScriptProperties().setProperty(GAP_PROP_ATTEMPTS, JSON.stringify(obj));
}

/* =================== ЖУРНАЛ / ТРИГГЕРЫ =================== */

function Gap_lastSuccessfulLoad_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_LOG);
  if (!sh || sh.getLastRow() < 2) return null;
  const vals = sh.getRange(2, 1, sh.getLastRow() - 1, 6).getValues();
  for (let i = vals.length - 1; i >= 0; i--) {
    if (vals[i][5] === 'OK' && vals[i][0] instanceof Date) return vals[i][0];
  }
  return null;
}

function Gap_recentLoadErrors_(days) {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_LOG);
  if (!sh || sh.getLastRow() < 2) return [];
  const since = Date.now() - days * 86400000;
  return sh.getRange(2, 1, sh.getLastRow() - 1, 7).getValues()
    .filter(r => r[0] instanceof Date && r[0].getTime() >= since && !['OK', 'ПРОДОЛЖЕНИЕ', 'ИНФО'].includes(r[5]))
    .map(r => `${formatRu(r[0])} ${formatTime(r[0])} — ${r[5]}: ${r[6]}`);
}

function Gap_hasDailyTrigger_() {
  try {
    return ScriptApp.getProjectTriggers().some(t =>
      ['dailyUpdate', 'loadYesterday'].includes(t.getHandlerFunction()) &&
      t.getEventType() === ScriptApp.EventType.CLOCK);
  } catch (e) {
    return true; // нет прав на чтение триггеров — не шумим
  }
}

/* =================== ВЫВОД =================== */

function Gap_writeSheet_(res) {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName(SHEET_DATA_CHECK);
  if (!sh) sh = ss.insertSheet(SHEET_DATA_CHECK);
  sh.clear();

  const now = new Date();
  let row = 1;
  sh.getRange(row, 1).setValue('Контроль полноты данных DATA_WB').setFontSize(14).setFontWeight('bold');
  row += 2;

  const summary = [
    ['Статус', Gap_statusLabel_(res.status)],
    ['Проверено', formatRu(now) + ' ' + formatTime(now)],
    ['Окно проверки', `${Util_keyToRu_(res.windowFrom)} — ${Util_keyToRu_(res.windowTo)}`],
    ['Строк в DATA_WB', res.totalRows],
    ['Данные с / по', res.firstKey ? `${Util_keyToRu_(res.firstKey)} — ${Util_keyToRu_(res.lastKey)}` : '—'],
    ['Пропущено дней', res.missing.length],
    ['Дней с провалом', res.low.length],
    ['Дубликаты rrdId', res.duplicates]
  ];
  sh.getRange(row, 1, summary.length, 2).setValues(summary);
  sh.getRange(row, 1, summary.length, 1).setFontWeight('bold');
  const color = { ok: '#e6f4ea', warn: '#fff4d6', error: '#fde8e1' }[res.status];
  sh.getRange(row, 2).setBackground(color).setFontWeight('bold');
  row += summary.length + 1;

  sh.getRange(row, 1).setValue('Замечания').setFontWeight('bold').setBackground('#f3f3f3');
  sh.getRange(row, 2, 1, 4).setBackground('#f3f3f3');
  row++;
  const issueRows = res.issues.length
    ? res.issues.map(i => [{ error: 'Ошибка', warn: 'Внимание', info: 'Инфо' }[i.level], i.text])
    : [['—', 'Замечаний нет']];
  sh.getRange(row, 1, issueRows.length, 2).setValues(issueRows);
  sh.getRange(row, 2, issueRows.length, 1).setWrap(true);
  row += issueRows.length + 1;

  if (res.operTypes.length) {
    sh.getRange(row, 1, 1, 4).setValues([['Тип операции (колонка ' + DATA_COLS.oper + ')', 'Строк', 'Сумма (' + DATA_COLS.amount + ')', 'Учитывается в формулах']])
      .setFontWeight('bold').setBackground('#f3f3f3');
    row++;
    const ot = res.operTypes.map(o => [o.name, o.rows, o.amount, o.covered ? 'да' : 'нет']);
    sh.getRange(row, 1, ot.length, 4).setValues(ot);
    sh.getRange(row, 3, ot.length, 1).setNumberFormat('#,##0.00');
    row += ot.length + 1;
  }

  sh.getRange(row, 1, 1, 5).setValues([['Дата', 'День недели', 'Строк', 'Продажи (' + DATA_COLS.amount + ')', 'Статус']])
    .setFontWeight('bold').setBackground('#f3f3f3');
  sh.setFrozenRows(0);
  row++;
  const WD = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
  const ST = { ok: 'OK', missing: 'ПРОПУСК', low: 'Мало строк', pending: 'Ожидается', empty: 'Нет данных в API' };
  const STC = { ok: null, missing: '#fde8e1', low: '#fff4d6', pending: '#eef3fb', empty: '#fff4d6' };
  const days = res.days.slice().reverse(); // свежие сверху
  if (days.length) {
    sh.getRange(row, 1, days.length, 5).setValues(days.map(d => [
      Util_keyToRu_(d.key), WD[new Date(Util_keyToUtc_(d.key)).getUTCDay()], d.rows, d.sales, ST[d.status]
    ]));
    sh.getRange(row, 4, days.length, 1).setNumberFormat('#,##0.00');
    sh.getRange(row, 5, days.length, 1).setBackgrounds(days.map(d => [STC[d.status]]));
  }

  sh.setColumnWidth(1, 230);
  sh.setColumnWidth(2, 520);
  sh.setColumnWidth(3, 110);
  sh.setColumnWidth(4, 160);
  sh.setColumnWidth(5, 150);
}

/* =================== УТИЛИТЫ =================== */

function Gap_statusLabel_(s) {
  return { ok: 'OK', warn: 'есть замечания', error: 'есть пропуски/ошибки' }[s] || s;
}

function Gap_shortText_(res) {
  if (res.status === 'ok') return 'Данные полные';
  const parts = [];
  if (res.missing.length) parts.push(`пропущено дней: ${res.missing.length}`);
  if (res.low.length) parts.push(`неполных дней: ${res.low.length}`);
  if (!parts.length) parts.push(res.issues.filter(i => i.level !== 'info').length + ' замеч.');
  return parts.join(', ');
}

function Gap_median_(arr) {
  if (!arr.length) return 0;
  const s = arr.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** ['2026-07-01','2026-07-02','2026-07-05'] → "01.07–02.07, 05.07" */
function Gap_rangesText_(keys) {
  const out = [];
  let a = null, b = null;
  const flush = () => {
    if (!a) return;
    const f = k => Util_keyToRu_(k).slice(0, 5);
    out.push(a === b ? f(a) : f(a) + '–' + f(b));
  };
  keys.slice().sort().forEach(k => {
    if (b && Util_daysBetween_(b, k) === 1) { b = k; return; }
    flush();
    a = b = k;
  });
  flush();
  return out.length > 8 ? out.slice(0, 8).join(', ') + ' …' : out.join(', ');
}
