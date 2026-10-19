import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { jsonError, me, mockFetch, ORG, report } from "./test/fixtures";
import { renderApp } from "./test/render";

const dash = { [`GET /api/v1/orgs/${ORG}/reports/pnl`]: report({ granularity: "total" }) };

describe("вход и защита маршрутов", () => {
  it("неавторизованного отправляет на вход, защищённые данные не запрашиваются", async () => {
    const { calls } = mockFetch({ "GET /api/v1/auth/me": () => jsonError(401, "Требуется вход") });
    renderApp("/pnl");
    expect(await screen.findByRole("form", { name: "Вход" })).toBeInTheDocument();
    expect(calls.some((c) => c.url.pathname.includes("/reports/"))).toBe(false);
  });

  it("успешный вход ведёт на запрошенную страницу и показывает меню", async () => {
    mockFetch({
      "GET /api/v1/auth/me": () => jsonError(401, "Требуется вход"),
      "POST /api/v1/auth/login": me(),
      [`GET /api/v1/orgs/${ORG}/seller-accounts`]: [],
      [`GET /api/v1/orgs/${ORG}/reports/pnl`]: report(),
    });
    renderApp("/pnl");
    await userEvent.type(await screen.findByLabelText("Email"), "owner@example.com");
    await userEvent.type(screen.getByLabelText("Пароль"), "correct-horse-battery");
    await userEvent.click(screen.getByRole("button", { name: "Войти" }));
    expect(await screen.findByRole("heading", { name: "P&L отчёт" })).toBeInTheDocument();
    const nav = screen.getByRole("navigation", { name: "Основная навигация" });
    for (const t of ["Дашборд", "P&L отчёт", "Подключения", "Расходы и корректировки", "Настройки"]) expect(nav).toHaveTextContent(t);
    expect(nav).not.toHaveTextContent("Администрирование");
  });

  it("неверный пароль — понятное сообщение, без перехода", async () => {
    mockFetch({ "GET /api/v1/auth/me": () => jsonError(401, "x"), "POST /api/v1/auth/login": () => jsonError(401, "Неверный email или пароль") });
    renderApp("/login");
    await userEvent.type(await screen.findByLabelText("Email"), "a@b.co");
    await userEvent.type(screen.getByLabelText("Пароль"), "wrong");
    await userEvent.click(screen.getByRole("button", { name: "Войти" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Неверный email или пароль");
    expect(screen.getByRole("form", { name: "Вход" })).toBeInTheDocument();
  });

  it("пункт «Администрирование» виден только администратору платформы", async () => {
    mockFetch({ "GET /api/v1/auth/me": me("admin", true), ...dash, [`GET /api/v1/orgs/${ORG}/reports/pnl`]: report({ granularity: "total" }) });
    renderApp("/");
    expect(await screen.findByRole("link", { name: "Администрирование" })).toBeInTheDocument();
  });

  it("обычный пользователь не видит админку даже по прямой ссылке", async () => {
    mockFetch({ "GET /api/v1/auth/me": me("admin", false) });
    renderApp("/admin");
    expect(await screen.findByText("Нет доступа")).toBeInTheDocument();
  });

  it("выход возвращает на экран входа", async () => {
    mockFetch({ "GET /api/v1/auth/me": me(), "POST /api/v1/auth/logout": undefined, ...dash });
    renderApp("/");
    await userEvent.click(await screen.findByRole("button", { name: "Выйти" }));
    await waitFor(() => expect(screen.getByRole("form", { name: "Вход" })).toBeInTheDocument());
  });
});
