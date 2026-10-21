/**********************************************************************
 * 05_Wb_Load.gs — ЗАГРУЗКА WILDBERRIES: точки входа, очередь, API, журнал
 *
 * Шаг 1: данные WB API → лист DATA_WB (запись — 06_Wb_Sheet.gs)
 * Шаг 2: отчёты (P&L ОТЧЕТ, ТОВАРЫ, UNIT) считаются ваши формулами по DATA_WB
 * Шаг 3: Web App (04_Menu.gs → doGet, Index.html)
 *
 * НАДЁЖНАЯ АВТОЗАГРУЗКА (защита от пропусков):
 * - Первый запуск грузит окно целиком: с 1-го числа месяца 3 месяца
 *   назад по сегодня.
 * - dailyUpdate (ежедневный триггер) перезапрашивает последние
 *   DAILY_OVERLAP_DAYS дней (WB дописывает строки задним числом),
 *   догоняет, если триггер несколько дней не работал, и дозагружает
 *   пропуски, найденные проверкой (09_Data_Check.gs). Дубликаты
 *   отсекаются по rrdId.
 * - Загрузка идёт через очередь (ScriptProperties): при нехватке
 *   времени (лимит 6 мин) прогресс сохраняется и скрипт сам
 *   продолжает через минуту. Данные пишутся после каждой страницы.
 * - 429/5xx/сетевые ошибки повторяются; каждый запуск пишется в лист
 *   LOG. После загрузки: очистка окна и проверка пропусков (DATA_CHECK).
 *
 * Названия функций firstRun, dailyUpdate, loadYesterday, continueLoadQueue
 * НЕ МЕНЯТЬ: на них могут быть созданы триггеры.
 * Токен WB берётся из единого хранилища — см. 03_Auth.gs → Auth_getWbToken().
 * Все даты загрузчика — «день» в МСК, хранится как Date UTC-полдень.
 **********************************************************************/

function firstRun() {
  // Первый запуск — «с чистого листа»: старые данные DATA_WB удаляются.
  if (!confirmClear_('DATA_WB', Data_wbRowCount_())) return;
  clearDataSheet_();
  const from = retentionStart_();
  const to = mskToday_();
  Info_build();
  enqueueLoad_(from, to, `первый запуск (${MAX_MONTHS_BACK} мес.)`);
  processLoadQueue_();
}

/** Число строк данных в DATA_WB (без шапки). */
function Data_wbRowCount_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_DATA);
  return sh ? Math.max(0, sh.getLastRow() - 1) : 0;
}

/** Спрашивает подтверждение, если на листе уже есть данные. true — можно продолжать. */
function confirmClear_(sheetName, rows) {
  if (!rows) return true;
  const ui = SpreadsheetApp.getUi();
  const res = ui.alert('Первый запуск',
    `Лист ${sheetName} содержит ${rows} строк данных. При первом запуске они будут удалены ` +
    'и загружены заново. Продолжить?', ui.ButtonSet.YES_NO);
  return res === ui.Button.YES;
}

/** Очищает данные DATA_WB (шапка остаётся) и сбрасывает очередь загрузки. */
function clearDataSheet_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_DATA);
  if (sh && sh.getLastRow() > 1) {
    sh.getRange(2, 1, sh.getLastRow() - 1, Math.max(sh.getLastColumn(), 1)).clearContent();
  }
  withQueue_(() => []);
  deleteContinuationTriggers_();
  bumpDataVersion_();
  SpreadsheetApp.flush();
}

/**
 * ЕЖЕДНЕВНОЕ ОБНОВЛЕНИЕ — на него ставится триггер (installDailyTrigger).
 * 1) перезапрашивает последние DAILY_OVERLAP_DAYS дней;
 * 2) если последние данные старше — догоняет с даты последних данных;
 * 3) дозагружает пропуски раньше этого окна (DATA_CHECK.gs);
 * 4) после загрузки: очистка и проверка (DATA_CHECK).
 */
function dailyUpdate() {
  const today = mskToday_();
  const start = retentionStart_();
  let from = dayAdd_(today, -DAILY_OVERLAP_DAYS);

  const last = dataWbLastDate_();
  if (!last) from = start;                               // данных нет — всё окно
  else if (last < from) from = dayAdd_(last, -1);        // триггер «пропускал» дни
  if (from < start) from = start;

  enqueueLoad_(from, today, 'ежедневное обновление');

  if (typeof Gap_findHealRanges_ === 'function') {
    try {
      Gap_findHealRanges_(dayKey_(from), true)
        .forEach(r => enqueueLoad_(r.from, r.to, 'дозагрузка пропусков'));
    } catch (e) {
      logLoad_('проверка пропусков', '', '', 0, 'ОШИБКА', e.message);
    }
  }
  processLoadQueue_();
}

/** Совместимость: старый пункт меню / старый триггер. */
function loadYesterday() {
  dailyUpdate();
}

function loadCustomPeriod() {
  const ui = SpreadsheetApp.getUi();
  const r1 = ui.prompt('Дата начала (ГГГГ-ММ-ДД):', ui.ButtonSet.OK_CANCEL);
  if (r1.getSelectedButton() !== ui.Button.OK) return;
  const r2 = ui.prompt('Дата окончания (ГГГГ-ММ-ДД):', ui.ButtonSet.OK_CANCEL);
  if (r2.getSelectedButton() !== ui.Button.OK) return;

  const from = parseDate(r1.getResponseText().trim());
  const to = parseDate(r2.getResponseText().trim());
  if (!from || !to) { ui.alert('Неверный формат даты'); return; }
  if (from > to) { ui.alert('Дата начала больше даты окончания'); return; }

  const cutoff = retentionStart_();
  const realFrom = from < cutoff ? cutoff : from;
  if (realFrom > to) {
    ui.alert(`Период вне допустимого окна (${MAX_MONTHS_BACK} месяца, с ${formatRu(cutoff)}).`);
    return;
  }
  enqueueLoad_(realFrom, to, 'ручной период');
  processLoadQueue_();
}

/** Ставит ежедневный триггер dailyUpdate (старые триггеры загрузки удаляет). */
function installDailyTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (['dailyUpdate', 'loadYesterday', 'cleanupOldRows', 'runReport'].includes(t.getHandlerFunction())) {
      ScriptApp.deleteTrigger(t);
    }
  });
  ScriptApp.newTrigger('dailyUpdate')
    .timeBased()
    .everyDays(1)
    .atHour(DAILY_TRIGGER_HOUR)
    .inTimezone(TZ_MSK)
    .create();
  const msg = `Триггер установлен: dailyUpdate ежедневно в ~${DAILY_TRIGGER_HOUR}:00 МСК ` +
    '(от имени текущего пользователя — используется ЕГО токен WB).';
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { Logger.log(msg); }
}

/**********************************************************************
 * ОЧЕРЕДЬ ЗАГРУЗКИ
 * Задание: { from, to, label, cur, rrdId, rows, errors, updatedAt }
 * (даты — "yyyy-MM-dd"). cur/rrdId — курсор: откуда продолжать после
 * таймаута. Очередь хранится в ScriptProperties и переживает перезапуски.
 **********************************************************************/

function enqueueLoad_(from, to, label) {
  const f = dayKey_(from);
  const t = dayKey_(to);
  withQueue_(q => {
    // Уже есть задание, покрывающее этот период — не дублируем
    if (q.some(j => j.from <= f && j.to >= t && j.cur <= f)) return q;
    q.push({
      id: Date.now() + '_' + Math.floor(Math.random() * 1e6),
      from: f, to: t, label: label, cur: f, rrdId: 0, rows: 0, errors: 0, updatedAt: Date.now()
    });
    return q;
  });
}

function getLoadQueue_() {
  const raw = PropertiesService.getScriptProperties().getProperty(PROP_LOAD_QUEUE);
  return raw ? JSON.parse(raw) : [];
}

/**
 * Изменение очереди под короткой блокировкой документа. Обработчик
 * держит ScriptLock всё время загрузки, поэтому для очереди нужна
 * отдельная блокировка — иначе задание, добавленное во время загрузки
 * (например, ручной «Загрузить за период»), затёрлось бы.
 */
function withQueue_(fn) {
  const lock = LockService.getDocumentLock();
  lock.waitLock(20000);
  try {
    const q = fn(getLoadQueue_());
    const props = PropertiesService.getScriptProperties();
    if (q.length) props.setProperty(PROP_LOAD_QUEUE, JSON.stringify(q));
    else props.deleteProperty(PROP_LOAD_QUEUE);
  } finally {
    lock.releaseLock();
  }
}

function updateJob_(job) {
  withQueue_(q => q.map(j => (j.id === job.id ? job : j)));
}

function removeJob_(job) {
  withQueue_(q => q.filter(j => j.id !== job.id));
}

/** Точка входа одноразового триггера-продолжения. */
function continueLoadQueue() {
  processLoadQueue_();
}

function processLoadQueue_() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    notify_('Загрузка уже выполняется — задание поставлено в очередь.');
    return;
  }
  const startTime = Date.now();
  const props = PropertiesService.getScriptProperties();
  try {
    deleteContinuationTriggers_();
    let token = null;

    while (true) {
      const job = getLoadQueue_()[0];
      if (!job) break;
      let state;
      try {
        token = token || Auth_getWbToken();
        state = runJob_(token, job, startTime, () => updateJob_(job));
      } catch (e) {
        job.errors = (job.errors || 0) + 1;
        job.updatedAt = Date.now();
        const fatal = /^(401|402|403)|не задан/.test(e.message);
        if (fatal || job.errors >= LOAD_MAX_JOB_ERRORS) {
          logLoad_(job.label, job.from, job.to, job.rows, 'ПРОПУЩЕНО',
            `${e.message} (попыток: ${job.errors}). Пропуск будет найден проверкой.`);
          removeJob_(job);
          props.setProperty(PROP_AFTERLOAD, '1');
          continue;
        }
        updateJob_(job);
        logLoad_(job.label, job.from, job.to, job.rows, 'ОШИБКА',
          `${e.message}. Повтор через ${LOAD_RETRY_DELAY_MS / 60000} мин (попытка ${job.errors}).`);
        scheduleContinuation_(LOAD_RETRY_DELAY_MS);
        return;
      }

      if (state === 'timeout') {
        updateJob_(job);
        logLoad_(job.label, job.from, job.to, job.rows, 'ПРОДОЛЖЕНИЕ',
          `Лимит времени: продолжу с ${job.cur} через 1 мин.`);
        scheduleContinuation_(60 * 1000);
        notify_(`Загружено ${job.rows} строк, продолжение через минуту (автоматически).`);
        return;
      }

      logLoad_(job.label, job.from, job.to, job.rows, 'OK', '');
      removeJob_(job);
      props.setProperty(PROP_AFTERLOAD, '1');
    }

    // Очередь пуста — пост-обработка (если осталось время, иначе в продолжении)
    if (props.getProperty(PROP_AFTERLOAD)) {
      if (Date.now() - startTime > MAX_RUNTIME_MS - 2 * 60 * 1000) {
        scheduleContinuation_(60 * 1000);
        return;
      }
      props.deleteProperty(PROP_AFTERLOAD);
      afterLoad_();
    }
  } finally {
    lock.releaseLock();
  }
}

/**
 * Выполняет одно задание. Пишет данные после КАЖДОЙ страницы и сохраняет
 * курсор — при таймауте/ошибке уже загруженное не теряется.
 * Возвращает 'done' | 'timeout'.
 */
function runJob_(token, job, startTime, persist) {
  const to = isoDateToDate(job.to);
  let cur = isoDateToDate(job.cur);

  while (cur <= to) {
    let end = dayAdd_(cur, CHUNK_DAYS - 1);
    if (end > to) end = to;

    while (true) {
      if (!hasTimeForRequest_(startTime)) return 'timeout';
      const page = fetchPage_(token, cur, end, job.rrdId);
      if (!page.length) break;

      appendToDataSheet(page);
      job.rows += page.length;
      job.rrdId = page[page.length - 1].rrdId;
      job.updatedAt = Date.now();
      persist();
      if (page.length < PAGE_LIMIT) break;
    }

    cur = dayAdd_(end, 1);
    job.cur = dayKey_(cur);
    job.rrdId = 0;
    job.errors = 0;
    job.updatedAt = Date.now();
    persist();
  }
  return 'done';
}

/** Хватит ли времени на паузу лимита + ещё один запрос с записью. */
function hasTimeForRequest_(startTime) {
  const wait = rateLimitWaitMs_();
  return Date.now() - startTime + wait + REQUEST_BUDGET_MS < MAX_RUNTIME_MS;
}

function rateLimitWaitMs_() {
  const last = +(PropertiesService.getScriptProperties().getProperty(PROP_LAST_REQUEST) || 0);
  return Math.max(0, last + REQUEST_PAUSE_MS - Date.now());
}

function scheduleContinuation_(ms) {
  deleteContinuationTriggers_();
  ScriptApp.newTrigger('continueLoadQueue').timeBased().after(ms).create();
}

function deleteContinuationTriggers_() {
  ScriptApp.getProjectTriggers().forEach(t => {
    if (t.getHandlerFunction() === 'continueLoadQueue') ScriptApp.deleteTrigger(t);
  });
}

/** После загрузки: очистка окна, P&L по SKU, контроль пропусков. */
function afterLoad_() {
  const steps = [
    ['очистка', () => cleanupOldRows_(false)],
    ['контроль данных', () => { if (typeof Gap_runCheck === 'function') Gap_runCheck(); }]
  ];
  steps.forEach(([name, fn]) => {
    try { fn(); } catch (e) { logLoad_(name, '', '', 0, 'ОШИБКА', e.message); }
  });
}

/* ===================== ЖУРНАЛ ЗАГРУЗОК (лист LOG) ===================== */

function logLoad_(label, from, to, rows, status, message) {
  try {
    const ss = SpreadsheetApp.getActive();
    let sh = ss.getSheetByName(SHEET_LOG);
    if (!sh) {
      sh = ss.insertSheet(SHEET_LOG);
      sh.getRange(1, 1, 1, 7).setValues([['Время', 'Операция', 'Период с', 'Период по', 'Строк', 'Статус', 'Сообщение']])
        .setFontWeight('bold').setBackground('#efefef');
      sh.setFrozenRows(1);
      sh.setColumnWidth(1, 140);
      sh.setColumnWidth(2, 190);
      sh.setColumnWidth(7, 520);
      sh.getRange('A:A').setNumberFormat('dd.MM.yyyy HH:mm');
    }
    sh.appendRow([new Date(), label, from, to, rows, status, message || '']);
    const color = { OK: '#e6f4ea', 'ПРОДОЛЖЕНИЕ': '#eef3fb', 'ОШИБКА': '#fde8e1', 'ПРОПУЩЕНО': '#fde8e1' }[status];
    if (color) sh.getRange(sh.getLastRow(), 6).setBackground(color);
    if (sh.getLastRow() > LOAD_LOG_MAX_ROWS + 1) {
      sh.deleteRows(2, sh.getLastRow() - LOAD_LOG_MAX_ROWS - 1);
    }
  } catch (e) {
    Logger.log('LOG: ' + e.message);
  }
  Logger.log(`[${status}] ${label} ${from}–${to}: ${rows} строк. ${message || ''}`);
}

/** Toast работает только при ручном запуске; в триггере — просто лог. */
function notify_(msg) {
  Logger.log(msg);
  try { SpreadsheetApp.getActive().toast(msg, 'WB', 8); } catch (e) { /* триггер */ }
}

/* ===================== API WILDBERRIES ===================== */

/** Одна страница отчёта (с учётом лимита 1 запрос/мин). */
function fetchPage_(token, dateFrom, dateTo, rrdId) {
  const payload = {
    dateFrom: dayKey_(dateFrom),
    dateTo: dayKey_(dateTo),
    limit: PAGE_LIMIT,
    rrdId: rrdId || 0,
    period: 'daily'
  };
  const resp = fetchWithRetry(token, payload);
  const code = resp.getResponseCode();
  if (code === 204) return [];
  if (code !== 200) {
    throw new Error(`WB API ${code}: ${resp.getContentText().slice(0, 300)}`);
  }
  const data = JSON.parse(resp.getContentText());
  return Array.isArray(data) ? data : [];
}

/**
 * Запрос с повторами: 429 (ждём X-Ratelimit-Retry или паузу), 5xx и
 * сетевые исключения (до 5 попыток). 401/402/403 — сразу ошибка.
 */
function fetchWithRetry(token, payload) {
  const options = {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: token },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };
  const props = PropertiesService.getScriptProperties();
  let lastErr = '';

  for (let attempt = 1; attempt <= 5; attempt++) {
    const wait = rateLimitWaitMs_();
    if (wait > 0) Utilities.sleep(wait);
    props.setProperty(PROP_LAST_REQUEST, String(Date.now()));

    let resp;
    try {
      resp = UrlFetchApp.fetch(API_URL, options);
    } catch (e) {
      lastErr = 'сеть: ' + e.message;
      continue; // следующая попытка — после паузы лимита
    }
    const code = resp.getResponseCode();

    if (code === 429) {
      const h = resp.getHeaders() || {};
      const retry = +(h['X-Ratelimit-Retry'] || h['x-ratelimit-retry'] || 0);
      if (retry > 0) Utilities.sleep(Math.min(retry, 120) * 1000);
      lastErr = '429: превышен лимит запросов';
      continue;
    }
    if (code >= 500) {
      lastErr = `${code}: ошибка сервера WB`;
      continue;
    }
    if (code === 401) throw new Error('401: неверный или просроченный токен');
    if (code === 403) throw new Error('403: у токена нет категории «Финансы»');
    if (code === 402) throw new Error('402: недостаточно средств на балансе');
    return resp;
  }
  throw new Error(`Попытки исчерпаны (${lastErr})`);
}
