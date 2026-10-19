import type { CellValue, LineStatus, Me, PnlLine, PnlReport } from "../api/types";

export const ORG = "11111111-1111-1111-1111-111111111111";

export const me = (role: "admin" | "member" | "viewer" = "admin", platform = false): Me => ({
  user: { id: "u1", email: "owner@example.com", full_name: null, is_active: true, is_platform_admin: platform },
  memberships: [{ organization_id: ORG, organization_name: "ООО Ромашка", role }],
  csrf_token: "csrf-1",
});

export const cell = (value: string | null, status: LineStatus = "ok", extra: Partial<CellValue> = {}): CellValue => ({
  value, preliminary: null, status, notes: [], contributions: [], ...extra,
});

const line = (id: string, name: string, parent: string | null, level: number, kind: string, values: Record<string, CellValue>, memo = false): PnlLine =>
  ({ id, name, parent, level, kind, memo, note: null, values });

export function report(over: Partial<PnlReport> = {}): PnlReport {
  const P = ["2026-07", "total"];
  const both = (c: CellValue) => Object.fromEntries(P.map((p) => [p, c]));
  return {
    date_from: "2026-07-01", date_to: "2026-07-31", granularity: "month", currency: "RUB", account_id: null,
    settings: { tax_regime: "usn_income", usn_rate: "6", profit_tax_rate: "20", vat_sales_rate: "22", vat_services_rate: "22" },
    quality: { transactions_by_status: { ok: 30, review: 2 }, excluded_pending_amounts: { rebill_logistics_cost: "1006.610000" }, import_issues: 0 },
    coverage: { days_in_range: 31, days_with_data: 11, missing_days: ["2026-07-12"], missing_days_count: 20 },
    periods: P,
    lines: [
      line("revenue", "Выручка", null, 0, "header", {}),
      line("sales_gross", "Продажи (по цене продажи)", "revenue", 1, "imported", both(cell("171774.00"))),
      line("net_revenue", "Чистая выручка", null, 0, "formula", both(cell("171774.00"))),
      line("marketplace_costs", "Затраты маркетплейса", null, 0, "group", both(cell("77000.50"))),
      line("commission", "Комиссия маркетплейса", "marketplace_costs", 1, "imported", both(cell("58880.62", "incomplete", { notes: ["В импорте 3 строк с ошибками"] }))),
      line("acquiring", "Эквайринг", "marketplace_costs", 1, "imported", both(cell("4157.21"))),
      line("cogs", "Себестоимость (COGS)", null, 0, "group", both(cell(null, "blocked", { notes: ["Нет себестоимости для 2 из 87 шт."], preliminary: "1000.00" }))),
      line("gross_profit", "Валовая прибыль", null, 0, "formula", both(cell(null, "blocked", { preliminary: "94000.00", notes: ["Нет данных для расчёта: cogs"] }))),
      line("opex_other", "Прочие операционные расходы", "opex", 1, "manual", both(cell(null, "missing", { notes: ["Нет записей"] }))),
      line("net_profit", "Чистая прибыль", null, 0, "formula", both(cell("-1500.50"))),
    ],
    ...over,
  };
}

/** Простой роутер для подмены fetch: ключ "METHOD /path" → ответ либо функция. */
type Handler = unknown | ((url: URL, init?: RequestInit) => unknown);
export function mockFetch(routes: Record<string, Handler>) {
  const calls: { method: string; url: URL; init?: RequestInit }[] = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    calls.push({ method, url, init });
    const key = Object.keys(routes).find((k) => k === `${method} ${url.pathname}`) ?? Object.keys(routes).find((k) => `${method} ${url.pathname}`.startsWith(k));
    if (!key) return new Response(JSON.stringify({ detail: `нет мока: ${method} ${url.pathname}` }), { status: 404, headers: { "content-type": "application/json" } });
    let h = routes[key] as Handler;
    if (typeof h === "function") h = (h as (u: URL, i?: RequestInit) => unknown)(url, init);
    h = await h;
    if (h instanceof Response) return h;
    if (h === undefined) return new Response(null, { status: 204 });
    return new Response(JSON.stringify(h), { status: 200, headers: { "content-type": "application/json" } });
  });
  vi.stubGlobal("fetch", fn);
  return { fn, calls };
}

export const jsonError = (status: number, detail: unknown) =>
  new Response(JSON.stringify({ detail }), { status, headers: { "content-type": "application/json" } });
