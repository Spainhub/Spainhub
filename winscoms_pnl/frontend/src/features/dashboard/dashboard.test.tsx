import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { cell, jsonError, me, mockFetch, ORG, report } from "../../test/fixtures";
import { renderApp } from "../../test/render";
import { Kpi } from "./Dashboard";

const REPORT = `GET /api/v1/orgs/${ORG}/reports/pnl`;

describe("дашборд", () => {
  it("не показывает ноль вместо нерассчитанных показателей и объясняет причину", async () => {
    mockFetch({ "GET /api/v1/auth/me": me(), [REPORT]: report({ granularity: "total" }) });
    renderApp("/");
    const cogs = await screen.findByTestId("kpi-Себестоимость");
    expect(within(cogs).getByText("—")).toBeInTheDocument();
    expect(cogs).toHaveTextContent("Нет себестоимости для 2 из 87 шт.");
    expect(cogs).toHaveTextContent("Предварительно: 1 000 ₽");
    const gp = screen.getByTestId("kpi-Валовая прибыль");
    expect(gp).not.toHaveTextContent(/^Валовая прибыль0/);
    expect(screen.getByText(/Часть показателей не рассчитана/)).toBeInTheDocument();
    expect(screen.getByTestId("kpi-Чистая выручка")).toHaveTextContent("171 774");
  });

  it("пустое состояние без данных", async () => {
    mockFetch({ "GET /api/v1/auth/me": me(), [REPORT]: report({ coverage: { days_in_range: 30, days_with_data: 0, missing_days: [], missing_days_count: 30 } }) });
    renderApp("/");
    expect(await screen.findByText("За выбранный период нет данных")).toBeInTheDocument();
  });

  it("ошибка загрузки", async () => {
    mockFetch({ "GET /api/v1/auth/me": me(), [REPORT]: () => jsonError(500, "x") });
    renderApp("/");
    expect(await screen.findByRole("alert")).toHaveTextContent("Ошибка сервера");
  });

  it("KPI: рост расходов выделяется как плохой, неполные данные помечены", () => {
    const { rerender } = render(<Kpi title="Затраты" now={cell("120.00")} before={cell("100.00")} costLike />);
    expect(screen.getByText(/\+20,00 % к предыдущему периоду/)).toHaveClass("bad");
    rerender(<Kpi title="Прибыль" now={cell("120.00", "incomplete")} before={cell("100.00")} />);
    expect(screen.getByText("Данные неполные")).toBeInTheDocument();
    expect(screen.getByText(/\+20,00 % к предыдущему периоду/)).toHaveClass("good");
  });
});


describe("мастер первой настройки", () => {
  const steps = (over: Record<string, unknown> = {}) => ({
    "GET /api/v1/auth/me": me(),
    [REPORT]: report({ granularity: "total" }),
    [`GET /api/v1/orgs/${ORG}/settings`]: null,
    [`GET /api/v1/orgs/${ORG}/seller-accounts`]: [],
    [`GET /api/v1/orgs/${ORG}/costs`]: [],
    [`GET /api/v1/orgs/${ORG}/manual-entries`]: [],
    ...over,
  });

  it("показывает шаги, подсвечивает следующий и ведёт к нужному разделу", async () => {
    mockFetch(steps());
    renderApp("/");
    const box = await screen.findByRole("region", { name: "Начало работы" });
    expect(box).toHaveTextContent("Выполнено 0 из 5");
    expect(within(box).getByRole("link", { name: "Открыть настройки" })).toHaveAttribute("href", "/settings");
    expect(within(box).getByRole("link", { name: "Загрузить себестоимость" })).toHaveAttribute("href", "/expenses?tab=costs");
    expect(within(box).getByRole("progressbar")).toHaveAttribute("aria-valuenow", "0");
  });

  it("отмечает выполненные шаги и скрывается, когда всё готово", async () => {
    mockFetch(steps({ [`GET /api/v1/orgs/${ORG}/settings`]: { tax_regime: "usn_income" }, [`GET /api/v1/orgs/${ORG}/seller-accounts`]: [{ id: "a", last_sync_at: "2026-07-11T10:00:00Z" }] }));
    renderApp("/");
    expect(await screen.findByText("Выполнено 3 из 5")).toBeInTheDocument();
  });

  it("не показывается, когда настроено всё", async () => {
    mockFetch(steps({ [`GET /api/v1/orgs/${ORG}/settings`]: { tax_regime: "osno" }, [`GET /api/v1/orgs/${ORG}/seller-accounts`]: [{ id: "a", last_sync_at: "x" }], [`GET /api/v1/orgs/${ORG}/costs`]: [{ id: 1 }], [`GET /api/v1/orgs/${ORG}/manual-entries`]: [{ id: 1 }] }));
    renderApp("/");
    await screen.findByTestId("kpi-Чистая выручка");
    expect(screen.queryByRole("region", { name: "Начало работы" })).toBeNull();
  });
});
