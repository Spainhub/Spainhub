/**********************************************************************
 * 14_Web_Pnl.gs — ЛИСТ P&L ОТЧЕТ → вкладка 2 Web App
 *
 * Лист ведётся вручную (ваши формулы); скрипт его НЕ пишет, а читает
 * «как есть». Раскладка:
 *   строки 1–4  — шапка (A1 название, A2 подзаголовок, A3 продавец,
 *                 E2/G2 — фильтр периода, E4/G4 — рабочий период);
 *   строка 6    — заголовки: № | Наименование показателя | Сумма | Доля, % | периоды E…
 *   строка 7    — «Параметры» (у месяца — дата конца месяца, у дня — день недели);
 *   дальше      — показатели; нумерация в колонке A: 1, 1.1, 2, 2.1, 2.1.1 …
 *
 * СВОРАЧИВАНИЕ строк следует нумерации колонки A (Util_hierAnnotate_):
 * строка с подстроками сворачивается вместе со всеми потомками.
 * Колонка периода, у которой вместо даты пусто или «-», не показывается.
 *
 * ГРАФИКИ при наведении:
 *  - у строк, чьё название подходит под PNL_SERIES_RULES (00_Config.gs), —
 *    дневной ряд за весь период из DATA_WB (Pnl_getDailySeries);
 *  - у остальных итоговых строк (с подстроками) и у строк с ≥ 14 дневными
 *    значениями — по дневным колонкам самого листа (строит браузер).
 *
 * ВАЖНО: все имена в этом файле имеют префикс Pnl_.
 **********************************************************************/

const PNL_CACHE_PREFIX = 'PNL_CHART_V2_';

/** Шапка страницы Web App (из P&L ОТЧЕТ; валюта — B5), общая для вкладок; UNIT и СПРАВКА дополняют её своими значениями. */
function Pnl_header_() {
  const sh = SpreadsheetApp.getActive().getSheetByName(SHEET_PNL);
  if (!sh) {
    return { title: 'P&L Report', subtitle: '', seller: '', periodFrom: '', periodTo: '', defaultFrom: '', defaultTo: '', currency: '', generated: '' };
  }
  const b = sh.getRange(1, 1, 5, 7).getValues();
  const s = v => String(v === null || v === undefined ? '' : v);
  return {
    title: s(b[0][0]),
    subtitle: s(b[1][0]),
    seller: s(b[2][0]),
    periodFrom: fmtCell(b[1][4]) || fmtCell(b[3][4]),   // E2 или E4
    periodTo: fmtCell(b[1][6]) || fmtCell(b[3][6]),     // G2 или G4
    defaultFrom: fmtCell(b[3][4]),
    defaultTo: fmtCell(b[3][6]),
    currency: s(b[4][1]).trim(),   // B5 — валюта отчёта (BYN, RUS …)
    generated: ''
  };
}

/** Период отчёта из P&L ОТЧЕТ: [min(E4,G4); max(E4,G4)] как "yyyy-MM-dd". */
function Pnl_period_() {
  const ss = SpreadsheetApp.getActive();
  const calc = ss.getSheetByName(SHEET_PNL);
  if (!calc) throw new Error(`Лист ${SHEET_PNL} не найден.`);
  const tz = ss.getSpreadsheetTimeZone();
  const toKey = v => (v instanceof Date) ? Utilities.formatDate(v, tz, 'yyyy-MM-dd') : '';
  let a = toKey(calc.getRange(PERIOD_FROM_USED).getValue());
  let b = toKey(calc.getRange(PERIOD_TO_USED).getValue());
  const today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  if (!a) a = today;
  if (!b) b = a;
  return a <= b ? { fromKey: a, toKey: b } : { fromKey: b, toKey: a };
}

/** Какой ряд DATA_WB подходит строке по названию (id из PNL_SERIES_RULES) или ''. */
function Pnl_seriesIdFor_(name) {
  const n = String(name || '').trim();
  for (let i = 0; i < PNL_SERIES_RULES.length; i++) {
    if (PNL_SERIES_RULES[i].re.test(n)) return PNL_SERIES_RULES[i].id;
  }
  return '';
}

/** Данные вкладки «P&L ОТЧЕТ». Каждый вызов читает лист заново. */
function Pnl_getReportData() {
  const sh = Web_sheet_(SHEET_PNL);
  const tz = SpreadsheetApp.getActive().getSpreadsheetTimeZone();
  const lastCol = Math.max(sh.getLastColumn(), PNL_FIRST_PERIOD_COL);
  const lastRow = sh.getLastRow();
  const headers = sh.getRange(PNL_HEADER_ROW, 1, 1, lastCol).getValues()[0];

  // Колонки периодов: пустой заголовок или прочерк «-» вместо даты — колонку не показываем.
  const keepIdx = [];
  headers.forEach((h, i) => { if (i >= PNL_FIRST_PERIOD_COL - 1 && !isDashHeader_(h)) keepIdx.push(i); });
  const periods = keepIdx.map(i => fmtCell(headers[i]));

  // Тип колонки-периода — по строке «Параметры»: у месяцев там дата конца месяца,
  // у дней — день недели (текст). Не зависит от числа дневных колонок.
  const params = sh.getRange(PNL_PARAMS_ROW, 1, 1, lastCol).getValues()[0];
  const periodMeta = keepIdx.map(i => {
    const p = params[i];
    const isMonth = p instanceof Date || /^\d{2}\.\d{2}\.\d{4}$/.test(String(p).trim());
    const key = cellDateKey_(headers[i]);
    return { type: isMonth ? 'month' : 'day', key: key, ym: key.slice(0, 7) };
  });

  const rows = [];
  const cnt = lastRow - PNL_HEADER_ROW;
  if (cnt > 0) {
    const block = sh.getRange(PNL_HEADER_ROW + 1, 1, cnt, lastCol);
    const values = block.getValues();
    const formulas = block.getFormulas();
    const dispA = sh.getRange(PNL_HEADER_ROW + 1, 1, cnt, 1).getDisplayValues();
    values.forEach((r, k) => {
      const name = String(r[1] === null ? '' : r[1]).trim();
      if (name === '') return;
      const isParams = name.toLowerCase() === 'параметры';
      const isPercent = /%/.test(name);
      // Строка ручного ввода: в колонках периодов нет ни одной формулы, а «Сумма» заполнена
      const noFormulas = keepIdx.length > 0 && keepIdx.every(i => !formulas[k][i]);
      const hasSum = r[2] !== '' && r[2] !== null;
      rows.push({
        num: Util_numFromCell_(r[0], dispA[k][0], tz),
        name: name,
        sum: fmtCell(r[2]),
        share: fmtCell(r[3]),
        isPercent: isPercent,
        isParams: isParams,
        isManual: !isParams && !isPercent && noFormulas && hasSum,
        seriesId: isParams ? '' : Pnl_seriesIdFor_(name),
        values: keepIdx.map(i => fmtCell(r[i]))
      });
    });
    Util_hierAnnotate_(rows);
  }

  return {
    header: Pnl_header_(),
    periods: periods,
    periodMeta: periodMeta,
    rows: rows
  };
}

/** Серверный вызов для Web App: дневные ряды из DATA_WB за период отчёта. */
function Pnl_getDailySeries() {
  const p = Pnl_period_();
  const ver = PropertiesService.getScriptProperties().getProperty(PROP_DATA_VERSION) || '0';
  const sheet = SpreadsheetApp.getActive().getSheetByName(SHEET_DATA);
  const sig = [p.fromKey, p.toKey, sheet ? sheet.getLastRow() : 0, ver].join('#');

  const cached = Util_cacheGetJson_(PNL_CACHE_PREFIX, sig);
  if (cached) return cached;

  const res = Pnl_computeSeries_(p);
  Util_cachePutJson_(PNL_CACHE_PREFIX, sig, res);
  return res;
}

function Pnl_computeSeries_(p) {
  const days = Util_daysBetween_(p.fromKey, p.toKey) + 1;
  const keys = [];
  for (let i = 0; i < days; i++) keys.push(Util_addDaysKey_(p.fromKey, i));

  const z = () => new Array(days).fill(0);
  const S = z(), R = z(), F = z(), L = z(), ST = z(), P = z();

  const data = Wb_readColumns_();
  if (data) {
    const idx = {};
    keys.forEach((k, i) => { idx[k] = i; });
    for (let i = 0; i < data.n; i++) {
      const d = idx[data.dayKey(i)];
      if (d === undefined) continue;
      const op = String(data.oper[i] || '').trim();
      if (op === OPER_SALE) {
        S[d] += Util_num_(data.amount[i]);
        F[d] += Util_num_(data.forPay[i]);
      } else if (op === OPER_RETURN) {
        R[d] += Util_num_(data.amount[i]);
      } else if (op === OPER_LOGISTICS) {
        L[d] += Util_num_(data.logistics[i]);
      }
      ST[d] += Util_num_(data.storage[i]);
      P[d] += Util_num_(data.penalty[i]) + Util_num_(data.deduction[i]);
    }
  }

  const r2 = Util_r2_;
  const net = S.map((s, i) => s - R[i]);                               // чистая выручка
  const extra = F.map((f, i) => Math.max(0, f - net[i]));              // внереализационный доход (СПП)
  const income = net.map((v, i) => v + extra[i]);                      // доходы
  const comm = net.map((v, i) => v - F[i]);                            // комиссия WB, нетто
  const mp = comm.map((v, i) => v + L[i] + ST[i] + P[i]);              // расходы маркетплейса

  const money = arr => ({ values: arr.map(r2) });
  // Процентные строки: числитель и знаменатель — клиент считает долю за любой
  // отрезок как сумма/сумма, а не как среднее.
  const pct = (num, den) => ({
    isPercent: true,
    num: num.map(r2),
    den: den.map(r2),
    values: num.map((v, i) => den[i] ? v / den[i] : 0)
  });

  return {
    from: Util_keyToRu_(p.fromKey),
    to: Util_keyToRu_(p.toKey),
    dates: keys.map(Util_keyToRu_),
    series: {
      income: money(income), revenue: money(net), returns: money(R), forPay: money(F),
      spp: money(extra), mpExpenses: money(mp), commission: money(comm), commissionPct: pct(comm, net),
      logistics: money(L), logisticsPct: pct(L, net), storage: money(ST), penalties: money(P)
    }
  };
}
