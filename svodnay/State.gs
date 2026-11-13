/**
 * State.gs — состояние запуска. Хранится в Script Properties, чтобы пережить перезапуск между сессиями.
 */
function ozonInitialState_() {
  return {
    status: 'RUNNING',
    runId: Utilities.getUuid(),
    phase: OZON_CONFIG.phases[0],
    phaseState: {},
    retries: 0,
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastError: ''
  };
}

function ozonGetState_() {
  const raw = PropertiesService.getScriptProperties().getProperty(OZON_CONFIG.stateProperty);
  return raw ? JSON.parse(raw) : null;
}

function ozonSetState_(state) {
  state.updatedAt = new Date().toISOString();
  PropertiesService.getScriptProperties().setProperty(OZON_CONFIG.stateProperty, JSON.stringify(state));
  ozonLogRun_(state);
}

function ozonClearState_() {
  PropertiesService.getScriptProperties().deleteProperty(OZON_CONFIG.stateProperty);
}

function ozonAdvancePhase_(state) {
  state.phase = ozonNextPhase_(state.phase);
  state.phaseState = {};
  if (state.phase === 'DONE') state.status = 'DONE';
}

/** Жёсткая остановка: общее время запуска превысило maxRunMillis. */
function ozonEnsureDeadline_(startedAtMillis) {
  if (Date.now() - startedAtMillis > OZON_CONFIG.maxRunMillis) throw new OzonDeadlineError();
}

/** Новый шаг (HTTP-запрос) стартуем только если останется запас времени на сам запрос и запись. */
function ozonEnsureCanStartStep_(startedAtMillis) {
  const limit = OZON_CONFIG.maxRunMillis - OZON_CONFIG.requestSafetyMillis;
  if (Date.now() - startedAtMillis > limit) throw new OzonDeadlineError();
}
