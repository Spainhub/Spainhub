import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { SellerAccount, SyncJob } from "../../api/types";
import { jsonError, me, mockFetch, ORG } from "../../test/fixtures";
import { renderApp } from "../../test/render";

const B = `/api/v1/orgs/${ORG}/seller-accounts`;
const acc = (over: Partial<SellerAccount> = {}): SellerAccount => ({ id: "a1", marketplace: "wildberries", name: "Магазин 1", token_hint: "ab12", status: "active", last_validated_at: null, last_sync_at: "2026-07-11T10:00:00Z", created_at: "2026-07-01T00:00:00Z", ...over });
const job = (over: Partial<SyncJob> = {}): SyncJob => ({ id: "j1", seller_account_id: "a1", kind: "initial", period_from: "2026-07-01", period_to: "2026-07-31", status: "succeeded", pages_fetched: 2, records_fetched: 592, records_saved: 592, attempts: 0, error_code: null, error_message: null, scheduled_at: "2026-07-01T00:00:00Z", started_at: null, finished_at: null, created_at: "2026-07-01T10:00:00Z", ...over });
const summary = { raw_records: 592, normalized: 592, by_status: { ok: 590, review: 2 }, by_category: {}, needs_attention: 2 };

const routes = (role: "admin" | "viewer" = "admin", list: SellerAccount[] = [acc()], jobs: SyncJob[] = [job()]) => ({
  "GET /api/v1/auth/me": me(role),
  [`GET ${B}`]: list,
  [`GET ${B}/a1/sync-jobs`]: jobs,
  [`GET ${B}/a1/normalization`]: summary,
});

describe("подключения", () => {
  it("показывает аккаунт, статус, последнюю загрузку и маскированный токен", async () => {
    mockFetch(routes());
    renderApp("/connections");
    expect(await screen.findByText("Магазин 1")).toBeInTheDocument();
    expect(screen.getByText("Подключён")).toBeInTheDocument();
    expect(screen.getByText("•••• ab12")).toBeInTheDocument();
    expect(await screen.findByText("Готово")).toBeInTheDocument();
    expect(screen.getByText(/2 строк требуют внимания/)).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/eyJ|SECRET/);
  });

  it("добавление аккаунта отправляет токен один раз и очищает поле", async () => {
    let list: SellerAccount[] = [];
    const { calls } = mockFetch({ ...routes(), [`GET ${B}`]: () => list, [`POST ${B}`]: () => { list = [acc()]; return acc(); } });
    renderApp("/connections");
    expect(await screen.findByText("Аккаунтов пока нет")).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText("Название магазина"), "Магазин 1");
    const tokenInput = screen.getByLabelText(/API-токен Wildberries/);
    expect(tokenInput).toHaveAttribute("type", "password");
    await userEvent.type(tokenInput, "my-secret-token-0123456789");
    await userEvent.click(screen.getByRole("button", { name: "Добавить" }));
    expect(await screen.findByText("Магазин 1", { selector: "h2" })).toBeInTheDocument();
    const post = calls.find((c) => c.method === "POST")!;
    expect(JSON.parse(String(post.init?.body))).toMatchObject({ name: "Магазин 1", token: "my-secret-token-0123456789", marketplace: "wildberries" });
    expect(document.body.textContent).not.toContain("my-secret-token");
  });

  it("проверка подключения: успех и ошибка токена", async () => {
    let valid = true;
    mockFetch({ ...routes(), [`POST ${B}/a1/validate`]: () => (valid ? { valid: true, message: "Подключение работает" } : { valid: false, message: "Токен недействителен или просрочен (401)." }) });
    renderApp("/connections");
    await userEvent.click(await screen.findByRole("button", { name: "Проверить подключение" }));
    expect(await screen.findByText("Подключение работает")).toBeInTheDocument();
    valid = false;
    await userEvent.click(screen.getByRole("button", { name: "Проверить подключение" }));
    expect(await screen.findByText(/Токен недействителен/)).toBeInTheDocument();
  });

  it("лимит запросов WB при проверке показывается как понятное сообщение", async () => {
    mockFetch({ ...routes(), [`POST ${B}/a1/validate`]: () => jsonError(429, "Лимит запросов WB: повторите через 60 с") });
    renderApp("/connections");
    await userEvent.click(await screen.findByRole("button", { name: "Проверить подключение" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Лимит запросов WB");
  });

  it("запуск загрузки и повтор неудавшейся", async () => {
    const { calls } = mockFetch({
      ...routes("admin", [acc()], [job({ status: "failed", error_message: "Токен недействителен", records_saved: 0, records_fetched: 0 })]),
      [`POST ${B}/a1/sync`]: job({ id: "j2", status: "queued" }),
      [`POST ${B}/a1/sync-jobs/j1/retry`]: job({ status: "queued" }),
    });
    renderApp("/connections");
    expect(await screen.findByText("Токен недействителен")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await waitFor(() => expect(calls.some((c) => c.url.pathname.endsWith("/sync-jobs/j1/retry"))).toBe(true));
    await userEvent.click(screen.getByRole("button", { name: "Загрузить за 3 месяца" }));
    expect(await screen.findByText(/Загрузка запущена/)).toBeInTheDocument();
    expect(JSON.parse(String(calls.find((c) => c.url.pathname.endsWith("/a1/sync"))!.init?.body))).toEqual({ months: 3 });
  });

  it("отключение требует подтверждения", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    const { calls } = mockFetch({ ...routes(), [`DELETE ${B}/a1`]: undefined });
    renderApp("/connections");
    const btn = await screen.findByRole("button", { name: "Отключить" });
    await userEvent.click(btn);
    expect(calls.some((c) => c.method === "DELETE")).toBe(false);
    await userEvent.click(btn);
    await waitFor(() => expect(calls.some((c) => c.method === "DELETE")).toBe(true));
    expect(confirm).toHaveBeenCalledTimes(2);
  });

  it("аккаунт с недействительным токеном предлагает заменить его", async () => {
    mockFetch(routes("admin", [acc({ status: "auth_error" })]));
    renderApp("/connections");
    expect(await screen.findByText("Нужен новый токен")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Загрузить за 3 месяца" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Заменить токен" })).toBeEnabled();
  });

  it("читателю недоступны добавление и управление", async () => {
    mockFetch(routes("viewer"));
    renderApp("/connections");
    expect(await screen.findByText("Магазин 1")).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Добавить аккаунт Wildberries" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Проверить подключение" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Отключить" })).toBeNull();
  });

  it("ошибка загрузки списка", async () => {
    mockFetch({ "GET /api/v1/auth/me": me(), [`GET ${B}`]: () => jsonError(500, "x") });
    renderApp("/connections");
    expect(await screen.findByRole("alert")).toHaveTextContent("Ошибка сервера");
  });
});
