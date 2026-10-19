import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { jsonError, me, mockFetch, ORG } from "../../test/fixtures";
import { renderApp } from "../../test/render";

const B = `/api/v1/orgs/${ORG}`;
const cats = [{ category: "opex_other", name: "Прочие операционные расходы" }, { category: "opex_salaries", name: "Зарплаты и подрядчики" }];
const base = (role: "admin" | "viewer" = "admin", extra = {}) => ({
  "GET /api/v1/auth/me": me(role),
  [`GET ${B}/manual-categories`]: cats,
  [`GET ${B}/seller-accounts`]: [],
  [`GET ${B}/manual-entries`]: [],
  [`GET ${B}/costs`]: [],
  ...extra,
});

describe("расходы и корректировки", () => {
  it("пустое состояние и подсказка про подтверждение нулём", async () => {
    mockFetch(base());
    renderApp("/expenses");
    expect(await screen.findByText("Записей пока нет")).toBeInTheDocument();
    expect(screen.getByText(/подтверждает, что расходов по статье нет/)).toBeInTheDocument();
  });

  it("добавление записи: запятая в сумме превращается в точку, ошибки сервера видны", async () => {
    let fail = true;
    const { calls } = mockFetch(base("admin", { [`POST ${B}/manual-entries`]: () => (fail ? jsonError(422, "Неизвестная категория: x") : { id: 1 }) }));
    renderApp("/expenses");
    await screen.findByRole("option", { name: "Зарплаты и подрядчики" });
    await userEvent.selectOptions(screen.getByLabelText("Статья"), "opex_salaries");
    await userEvent.type(screen.getByLabelText("Сумма, ₽"), "1500,5");
    await userEvent.click(screen.getByRole("button", { name: "Добавить" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Неизвестная категория");
    fail = false;
    await userEvent.click(screen.getByRole("button", { name: "Добавить" }));
    await waitFor(() => expect(calls.filter((c) => c.method === "POST")).toHaveLength(2));
    expect(JSON.parse(String(calls.filter((c) => c.method === "POST")[1].init?.body))).toMatchObject({ category: "opex_salaries", amount: "1500.5" });
  });

  it("читатель видит список, но не форму", async () => {
    mockFetch(base("viewer", { [`GET ${B}/manual-entries`]: [{ id: 1, entry_date: "2026-07-03", category: "opex_salaries", amount: "1500.500000", currency: "RUB", description: "ФОТ", seller_account_id: null, marketplace: null, created_at: "2026-07-03T00:00:00Z" }] }));
    renderApp("/expenses");
    expect(await screen.findByText("ФОТ")).toBeInTheDocument();
    expect(screen.getByText("1 500,50 RUB")).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Запись о расходе" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Удалить" })).toBeNull();
  });

  it("себестоимость: ошибки файла показываются построчно", async () => {
    mockFetch(base("admin", { [`POST ${B}/costs/import`]: () => jsonError(422, { message: "Файл не загружен: исправьте ошибки", errors: [{ row: 3, field: "nmId", error: "Нужен числовой nmId" }, { row: 4, field: "costPerUnit", error: "Нужно число от 0" }] }) }));
    renderApp("/expenses");
    await userEvent.click(await screen.findByRole("tab", { name: "Себестоимость товаров" }));
    expect(await screen.findByText("Себестоимость не задана")).toBeInTheDocument();
    const file = new File(["x"], "c.xlsx", { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    await userEvent.upload(screen.getByLabelText("Файл с себестоимостью"), file);
    await userEvent.click(screen.getByRole("button", { name: "Загрузить файл" }));
    expect(await screen.findByText("Файл не загружен: исправьте ошибки")).toBeInTheDocument();
    expect(screen.getByText("Строка 3, nmId: Нужен числовой nmId")).toBeInTheDocument();
    expect(screen.getByText("Строка 4, costPerUnit: Нужно число от 0")).toBeInTheDocument();
  });

  it("успешная загрузка себестоимости", async () => {
    mockFetch(base("admin", { [`POST ${B}/costs/import`]: { imported: 32, skipped_blank: 1 } }));
    renderApp("/expenses");
    await userEvent.click(await screen.findByRole("tab", { name: "Себестоимость товаров" }));
    await userEvent.upload(await screen.findByLabelText("Файл с себестоимостью"), new File(["x"], "c.xlsx"));
    await userEvent.click(screen.getByRole("button", { name: "Загрузить файл" }));
    expect(await screen.findByText("Загружено строк: 32. Пропущено без цены: 1.")).toBeInTheDocument();
  });
});
