import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { cell, jsonError, me, mockFetch, ORG, report } from "../../test/fixtures";
import { renderApp, renderPage } from "../../test/render";
import PnlTable from "./PnlTable";

const REPORT = `GET /api/v1/orgs/${ORG}/reports/pnl`;
const base = (extra: Record<string, unknown> = {}) => ({
  "GET /api/v1/auth/me": me(),
  [`GET /api/v1/orgs/${ORG}/seller-accounts`]: [{ id: "a1", marketplace: "wildberries", name: "Магазин", token_hint: "abcd", status: "active", last_validated_at: null, last_sync_at: null, created_at: "2026-07-01T00:00:00Z" }],
  ...extra,
});

describe("таблица P&L", () => {
  it("показывает значения, статусы и причины вместо выдуманных нулей", () => {
    renderPage(<PnlTable report={report()} onDrill={() => {}} />);
    const row = (id: string) => document.querySelector(`tr[data-line="${id}"]`) as HTMLElement;
    expect(within(row("sales_gross")).getAllByText("171 774,00").length).toBeGreaterThan(0);
    expect(within(row("commission")).getAllByText("неполно").length).toBeGreaterThan(0);      // неполные данные помечены
    expect(within(row("cogs")).getAllByText(/предв\./).length).toBeGreaterThan(0);             // blocked: тире + предварительная оценка
    expect(within(row("cogs")).queryByText("0,00")).toBeNull();
    expect(within(row("gross_profit")).getAllByText(/94 000,00 предв\./).length).toBeGreaterThan(0);
    expect(within(row("opex_other")).getAllByText("нет данных").length).toBeGreaterThan(0);
    expect(row("net_profit").querySelector(".neg")).not.toBeNull();                            // отрицательное выделено
    expect(within(row("sales_gross")).getByText("импорт")).toBeInTheDocument();
    expect(within(row("opex_other")).getByText("вручную")).toBeInTheDocument();
    expect(within(row("net_revenue")).getByText("расчёт")).toBeInTheDocument();
  });

  it("группы сворачиваются и разворачиваются", async () => {
    renderPage(<PnlTable report={report()} onDrill={() => {}} />);
    expect(screen.getByText("Эквайринг")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Свернуть Затраты маркетплейса" }));
    expect(screen.queryByText("Эквайринг")).toBeNull();
    expect(screen.getByRole("button", { name: "Развернуть Затраты маркетплейса" })).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(screen.getByRole("button", { name: "Развернуть всё" }));
    expect(screen.getByText("Эквайринг")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Свернуть всё" }));
    expect(screen.queryByText("Комиссия маркетплейса")).toBeNull();
  });

  it("клик по листовой строке открывает расшифровку, по формуле — нет", async () => {
    const calls: string[] = [];
    renderPage(<PnlTable report={report()} onDrill={(l) => calls.push(l.id)} />);
    await userEvent.click(screen.getByRole("button", { name: "Комиссия маркетплейса" }));
    expect(calls).toEqual(["commission"]);
    expect(screen.queryByRole("button", { name: "Чистая выручка" })).toBeNull();
  });

  it("сравнение с прошлым периодом добавляет колонки и точную разницу", () => {
    const prev = report({ granularity: "total", periods: ["total"] });
    prev.lines.find((l) => l.id === "sales_gross")!.values = { total: cell("100000.00") };
    renderPage(<PnlTable report={report()} compare={prev} onDrill={() => {}} />);
    expect(screen.getByText("Пред. период")).toBeInTheDocument();
    const row = document.querySelector('tr[data-line="sales_gross"]') as HTMLElement;
    expect(within(row).getByText("71 774,00")).toBeInTheDocument();           // 171774 − 100000
    expect(within(row).getByText("71,77 %")).toBeInTheDocument();
  });
});

describe("страница P&L", () => {
  it("состояние загрузки, затем отчёт и блок качества данных", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    mockFetch(base({ [REPORT]: async () => { await gate; return report(); } }));
    renderApp("/pnl");
    expect(await screen.findByText("Считаем отчёт…")).toBeInTheDocument();
    release();
    expect(await screen.findByRole("region", { name: "Таблица P&L" })).toBeInTheDocument();
    expect(screen.getByLabelText("Качество данных")).toHaveTextContent("11 из 31 дн.");
    expect(screen.getByLabelText("Качество данных")).toHaveTextContent("возмещение издержек по перевозке");
  });

  it("фильтр по датам и аккаунту отправляет параметры на сервер", async () => {
    const { calls } = mockFetch(base({ [REPORT]: report() }));
    renderApp("/pnl");
    await screen.findByRole("region", { name: "Таблица P&L" });
    const from = screen.getByLabelText("С"), to = screen.getByLabelText("По");
    await userEvent.clear(from); await userEvent.type(from, "2026-06-01");
    await userEvent.clear(to); await userEvent.type(to, "2026-06-30");
    await userEvent.selectOptions(screen.getByLabelText("Детализация"), "day");
    await userEvent.selectOptions(screen.getByLabelText("Маркетплейс / аккаунт"), "a1");
    await userEvent.click(screen.getByRole("button", { name: "Применить" }));
    await waitFor(() => {
      const last = calls.filter((c) => c.url.pathname.endsWith("/reports/pnl")).at(-1)!;
      expect(Object.fromEntries(last.url.searchParams)).toMatchObject({ date_from: "2026-06-01", date_to: "2026-06-30", granularity: "day", account_id: "a1" });
    });
  });

  it("неверный диапазон блокирует запрос", async () => {
    const { calls } = mockFetch(base({ [REPORT]: report() }));
    renderApp("/pnl");
    await screen.findByRole("region", { name: "Таблица P&L" });
    const n = calls.length;
    const from = screen.getByLabelText("С");
    await userEvent.clear(from); await userEvent.type(from, "2026-12-31");
    expect(screen.getByText("Дата «По» раньше даты «С»")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Применить" })).toBeDisabled();
    expect(calls.length).toBe(n);
  });

  it("пустое состояние, когда за период нет данных", async () => {
    mockFetch(base({ [REPORT]: report({ coverage: { days_in_range: 31, days_with_data: 0, missing_days: [], missing_days_count: 31 } }) }));
    renderApp("/pnl");
    expect(await screen.findByText("За выбранный период нет данных")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Перейти к подключениям" })).toBeInTheDocument();
  });

  it("ошибка сервера показывается с кнопкой «Повторить»", async () => {
    let n = 0;
    mockFetch(base({ [REPORT]: () => (n++ === 0 ? jsonError(500, "boom") : report()) }));
    renderApp("/pnl");
    expect(await screen.findByRole("alert")).toHaveTextContent("Ошибка сервера");
    await userEvent.click(screen.getByRole("button", { name: "Повторить" }));
    expect(await screen.findByRole("region", { name: "Таблица P&L" })).toBeInTheDocument();
  });

  it("если не задана учётная политика — ведёт в настройки", async () => {
    mockFetch(base({ [REPORT]: () => jsonError(409, "Не задана учётная политика организации (налоговый режим). Откройте «Настройки».") }));
    renderApp("/pnl");
    expect(await screen.findByRole("link", { name: "Открыть настройки" })).toHaveAttribute("href", "/settings");
  });

  it("расшифровка строки загружает записи из API", async () => {
    const { calls } = mockFetch(base({
      [REPORT]: report(),
      [`GET /api/v1/orgs/${ORG}/reports/pnl/drilldown`]: { line: "commission", kind: "import", items: [{ entry_date: "2026-07-03", source_id: 3128735759679, source_operation: "Продажа", bonus_type: null, line_type: "commission_gross", vendor_code: "ART-1", amount: "836.070000" }] },
    }));
    renderApp("/pnl");
    await userEvent.click(await screen.findByRole("button", { name: "Комиссия маркетплейса" }));
    const dlg = await screen.findByRole("dialog");
    expect(await within(dlg).findByText("836,07")).toBeInTheDocument();
    expect(within(dlg).getByText("3128735759679")).toBeInTheDocument();
    expect(calls.some((c) => c.url.pathname.endsWith("/drilldown") && c.url.searchParams.get("line") === "commission")).toBe(true);
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});
