/**********************************************************************
 * Charts.gs
 * Данные для графиков «при наведении» во вкладке «P&L по периодам».
 *
 * Для строк, которые считаются автоматически из Data_wb, отдаём ДНЕВНОЙ
 * ряд за весь период отчёта (Calculation!E4 … G4) — по тем же формулам,
 * что и calcFormula() в Code.gs (колонки берутся из SKUCALC_COLS).
 *
 * Строки, зависящие от ручного ввода (COGS, OPEX, Валовая и Чистая
 * прибыль и т.п.), по дням посчитать нельзя — для них Web App строит
 * график по колонкам отчёта (3 месяца + 6 дней).
 *
 * ВАЖНО: все имена в этом файле имеют префикс PNLCHART_ / PnlChart_.
 **********************************************************************/

const PNLCHART_CACHE_PREFIX = 'PNLCHART_V1_';

/** Серверный вызов для Web App. */
function PnlChart_getDailySeries() {
  const p = SkuCalc_period_();
  const ver = PropertiesService.getScriptProperties().getProperty('WB_DATA_VERSION') || '0';
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_DATA);
  const sig = [p.fromKey, p.toKey, sheet ? sheet.getLastRow() : 0, ver].join('#');

  const cached = SkuCalc_cacheGetJson_(PNLCHART_CACHE_PREFIX, sig);
  if (cached) return cached;

  const res = PnlChart_compute_(p);
  SkuCalc_cachePutJson_(PNLCHART_CACHE_PREFIX, sig, res);
  return res;
}

function PnlChart_compute_(p) {
  const days = SkuCalc_daysBetween_(p.fromKey, p.toKey) + 1;
  const keys = [];
  for (let i = 0; i < days; i++) keys.push(SkuCalc_addDaysKey_(p.fromKey, i));

  const z = () => new Array(days).fill(0);
  const S = z(), R = z(), F = z(), L = z(), ST = z(), P = z();

  const data = SkuCalc_readData_();
  if (data) {
    const idx = {};
    keys.forEach((k, i) => { idx[k] = i; });
    for (let i = 0; i < data.n; i++) {
      const d = idx[data.dayKey(i)];
      if (d === undefined) continue;
      const op = String(data.oper[i] || '').trim();
      if (op === SKUCALC_OPER_SALE) {
        S[d] += SkuCalc_num_(data.amount[i]);
        F[d] += SkuCalc_num_(data.forPay[i]);
      } else if (op === SKUCALC_OPER_RETURN) {
        R[d] += SkuCalc_num_(data.amount[i]);
      } else if (op === SKUCALC_OPER_LOGISTICS) {
        L[d] += SkuCalc_num_(data.logistics[i]);
      }
      ST[d] += SkuCalc_num_(data.storage[i]);
      P[d] += SkuCalc_num_(data.penalty[i]) + SkuCalc_num_(data.deduction[i]);
    }
  }

  const r2 = SkuCalc_r2_;
  const net = S.map((s, i) => s - R[i]);                               // 9
  const extra = F.map((f, i) => Math.max(0, f - net[i]));              // 12
  const income = net.map((v, i) => v + extra[i]);                      // 8
  const comm = net.map((v, i) => v - F[i]);                            // 16
  const mp = comm.map((v, i) => v + L[i] + ST[i] + P[i]);              // 15

  const name = row => (CALC_ROWS.find(r => r.row === row) || {}).name;
  const money = arr => ({ values: arr.map(r2) });
  // Процентные строки: отдаём числитель и знаменатель, чтобы клиент мог
  // корректно посчитать долю за любой отрезок (сумма/сумма, а не среднее).
  const pct = (num, den) => ({
    isPercent: true,
    num: num.map(r2),
    den: den.map(r2),
    values: num.map((v, i) => den[i] ? v / den[i] : 0)
  });

  const series = {};
  series[name(8)] = money(income);
  series[name(9)] = money(net);
  series[name(10)] = money(R);
  series[name(11)] = money(F);
  series[name(12)] = money(extra);
  series[name(15)] = money(mp);
  series[name(16)] = money(comm);
  series[name(17)] = pct(comm, net);
  series[name(18)] = money(L);
  series[name(19)] = pct(L, net);
  series[name(20)] = money(ST);
  series[name(21)] = money(P);

  return {
    from: SkuCalc_keyToRu_(p.fromKey),
    to: SkuCalc_keyToRu_(p.toKey),
    dates: keys.map(SkuCalc_keyToRu_),
    series: series
  };
}
