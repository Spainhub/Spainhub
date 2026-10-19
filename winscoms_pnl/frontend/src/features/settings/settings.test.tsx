import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { me, mockFetch, ORG } from "../../test/fixtures";
import { renderApp } from "../../test/render";

const S = `/api/v1/orgs/${ORG}/settings`;

describe("настройки", () => {
  it("если политика не задана — предупреждение; сохранение УСН отправляет ставку", async () => {
    const { calls } = mockFetch({ "GET /api/v1/auth/me": me(), [`GET ${S}`]: null, [`PUT ${S}`]: { tax_regime: "usn_income" } });
    renderApp("/settings");
    expect(await screen.findByText(/Налоговый режим не выбран/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Сохранить" }));
    expect(await screen.findByText("Сохранено")).toBeInTheDocument();
    expect(JSON.parse(String(calls.find((c) => c.method === "PUT")!.init?.body))).toMatchObject({ tax_regime: "usn_income", usn_rate: "6" });
  });

  it("переключение на ОСНО показывает ставки налога и НДС", async () => {
    mockFetch({ "GET /api/v1/auth/me": me(), [`GET ${S}`]: { tax_regime: "usn_income", usn_rate: "6", profit_tax_rate: "20", vat_sales_rate: "22", vat_services_rate: "22" } });
    renderApp("/settings");
    await userEvent.click(await screen.findByLabelText(/ОСНО/));
    expect(screen.getByLabelText("Налог на прибыль, %")).toHaveValue("20");
    expect(screen.getByLabelText(/НДС в услугах маркетплейса/)).toHaveValue("22");
    expect(screen.queryByLabelText("Ставка УСН, %")).toBeNull();
  });

  it("не администратор не может менять политику", async () => {
    mockFetch({ "GET /api/v1/auth/me": me("member"), [`GET ${S}`]: { tax_regime: "osno", usn_rate: "6", profit_tax_rate: "20", vat_sales_rate: "22", vat_services_rate: "22" } });
    renderApp("/settings");
    expect(await screen.findByText(/Менять учётную политику может администратор/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Сохранить" })).toBeNull();
    await waitFor(() => expect(screen.getByLabelText(/ОСНО/)).toBeDisabled());
  });
});
