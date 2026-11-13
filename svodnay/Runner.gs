/**
 * Runner.gs — оркестрация: запуск, пауза по времени, продолжение триггером.
 */

/** Полный новый запуск: сбрасывает кэши и состояние, затем идёт по фазам. */
function runOzonFull() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) throw new Error('Обновление Ozon уже выполняется.');
  try {
    ozonDeleteContinuationTriggers_();
    ozonResetCache_();
    ozonSetState_(ozonInitialState_());
    ozonRunUntilPause_();
  } finally {
    lock.releaseLock();
  }
}

/** Продолжение прерванного запуска (вызывается одноразовым триггером). */
function continueOzonRun() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;
  try {
    ozonDeleteContinuationTriggers_();
    ozonRunUntilPause_();
  } finally {
    lock.releaseLock();
  }
}

function ozonRunUntilPause_() {
  const startedAtMillis = Date.now();
  const state = ozonGetState_();
  if (!state || state.status !== 'RUNNING') return; // нечего продолжать

  try {
    while (state.status === 'RUNNING') {
      ozonEnsureDeadline_(startedAtMillis);
      ozonEnsureCanStartStep_(startedAtMillis);
      const stepResult = ozonRunCurrentPhaseStep_(state);
      state.retries = 0; // шаг прошёл успешно — счётчик подряд идущих повторов сбрасываем
      if (stepResult && stepResult.done) {
        ozonAdvancePhase_(state);
      } else if (stepResult && stepResult.phaseState) {
        state.phaseState = stepResult.phaseState;
      }
      ozonSetState_(state);
    }

    // Успех: чистим состояние, триггеры продолжения и временные листы
    ozonClearState_();
    ozonDeleteContinuationTriggers_();
    ozonDeleteTemporarySheets_();
  } catch (error) {
    if (error instanceof OzonDeadlineError) {
      // Плановая пауза по времени — не ошибка
      ozonSetState_(state);
      ozonScheduleContinuation_(60);
      return;
    }
    if (error instanceof OzonRetryLaterError) {
      state.retries = (state.retries || 0) + 1;
      state.lastError = error.message;
      if (state.retries > OZON_CONFIG.maxConsecutiveRetries) {
        state.status = 'FAILED';
        ozonSetState_(state);
        throw new Error('Превышено число повторов: ' + error.message);
      }
      ozonSetState_(state);
      ozonScheduleContinuation_(error.retryAfterSeconds);
      return;
    }
    state.status = 'FAILED';
    state.lastError = error && error.stack ? error.stack : String(error);
    ozonSetState_(state);
    throw error;
  }
}

function ozonRunCurrentPhaseStep_(state) {
  const phaseState = state.phaseState || {};
  const sheets = OZON_CONFIG.cacheSheets;

  switch (state.phase) {
    case 'FETCH_PRODUCTS': return ozonFetchProductsStep_(phaseState);
    case 'FETCH_PRODUCT_INFO': return ozonFetchProductInfoStep_(phaseState);
    case 'FETCH_ATTRIBUTES': return ozonFetchAttributesStep_(phaseState);
    case 'FETCH_CATEGORY_TREE': ozonFetchCategoryTree_(); return { done: true };
    case 'FETCH_PRICES': return ozonFetchPricesStep_(phaseState);
    case 'FETCH_FBS_STOCKS': return ozonFetchStocksStep_(phaseState, 'fbs');
    case 'FETCH_FBO_STOCKS': return ozonFetchStocksStep_(phaseState, 'fbo');
    case 'FETCH_FINANCE': ozonFetchFinance_(); return { done: true };
    case 'FETCH_FBO_POSTINGS_180': return ozonFetchPostingsStep_(phaseState, 'fbo', 180, sheets.fboPostings180);
    case 'FETCH_FBS_POSTINGS_180': return ozonFetchPostingsStep_(phaseState, 'fbs', 180, sheets.fbsPostings180);
    case 'BUILD_ROWS': ozonBuildFinalRows_(); return { done: true };
    case 'WRITE_SHEET': ozonWriteFinalValues_(ozonReadFinalRowsCache_()); return { done: true };
    default: throw new Error('Неизвестная фаза: ' + state.phase);
  }
}
