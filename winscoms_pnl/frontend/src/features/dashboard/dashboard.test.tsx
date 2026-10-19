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
    expect(await screen.findByText("За период нет данных")).toBeInTheDocument();
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
