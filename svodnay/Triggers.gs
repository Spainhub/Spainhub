/**
 * Triggers.gs — триггеры: автообновление (раз в сутки / раз в час) и продолжение прерванного запуска.
 * Триггеры работают от имени пользователя, который их создал.
 */

/** Точка входа для триггера автообновления: не падает, если предыдущий запуск ещё идёт. */
function ozonScheduledRun() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return; // предыдущий запуск ещё работает — пропускаем
  lock.releaseLock();
  runOzonFull();
}

/** Включить автообновление. mode: 'daily' | 'hourly'. Старое расписание заменяется. */
function ozonEnableAutoUpdate_(mode) {
  ozonDisableAutoUpdate_();
  const builder = ScriptApp.newTrigger(OZON_CONFIG.scheduledHandler).timeBased();
  if (mode === 'hourly') {
    builder.everyHours(1).create();
  } else {
    builder.everyDays(1).atHour(OZON_CONFIG.dailyTriggerHour).create();
  }
  // Режим запоминаем сами: у готового триггера интервал прочитать нельзя
  PropertiesService.getScriptProperties().setProperty(OZON_CONFIG.autoModeProperty, mode === 'hourly' ? 'hourly' : 'daily');
}

function ozonDisableAutoUpdate_() {
  ScriptApp.getProjectTriggers().forEach((trigger) => {
    if (trigger.getHandlerFunction() === OZON_CONFIG.scheduledHandler) ScriptApp.deleteTrigger(trigger);
  });
  PropertiesService.getScriptProperties().deleteProperty(OZON_CONFIG.autoModeProperty);
}

/** 'daily' | 'hourly' | 'off' — по типу существующего триггера. */
function ozonGetAutoUpdateMode_() {
  const triggers = ScriptApp.getProjectTriggers().filter((t) => t.getHandlerFunction() === OZON_CONFIG.scheduledHandler);
  if (!triggers.length) return 'off';
  return PropertiesService.getScriptProperties().getProperty(OZON_CONFIG.autoModeProperty) || 'daily';
}

/** Продолжение прерванного запуска через одноразовый триггер. */
function ozonScheduleContinuation_(retryAfterSeconds) {
  ozonDeleteContinuationTriggers_();
  const delay = Math.max(OZON_CONFIG.continuationDelayMillis, Number(retryAfterSeconds || 60) * 1000);
  ScriptApp.newTrigger(OZON_CONFIG.continuationHandler).timeBased().after(delay).create();
}

function ozonDeleteContinuationTriggers_() {
  ScriptApp.getProjectTriggers().forEach((trigger) => {
    if (trigger.getHandlerFunction() === OZON_CONFIG.continuationHandler) ScriptApp.deleteTrigger(trigger);
  });
}

/** Сброс «зависшего» запуска: убираем продолжения и состояние. */
function ozonResetFailedRun() {
  ozonDeleteContinuationTriggers_();
  ozonClearState_();
}
