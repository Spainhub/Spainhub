import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { Me } from "../api/types";
import { jsonError, me, mockFetch, ORG } from "../test/fixtures";
import { renderApp } from "../test/render";

const noOrg = (platform: boolean): Me => ({ ...me("admin", platform), memberships: [] });

describe("пользователь без организации", () => {
  it("обычному пользователю — понятное объяснение", async () => {
    mockFetch({ "GET /api/v1/auth/me": noOrg(false) });
    renderApp("/pnl");
    expect(await screen.findByText("Вы пока не состоите ни в одной организации")).toBeInTheDocument();
  });

  it("администратор платформы создаёт организацию и сразу становится её администратором", async () => {
    let created = false;
    const { calls } = mockFetch({
      "GET /api/v1/auth/me": () => (created ? me("admin", true) : noOrg(true)),
      "GET /api/v1/admin/organizations": [],
      "POST /api/v1/admin/organizations": () => ({ id: ORG, name: "ООО Ромашка", is_active: true }),
      [`POST /api/v1/admin/organizations/${ORG}/members`]: () => { created = true; return { status: "ok" }; },
      [`GET /api/v1/orgs/${ORG}/seller-accounts`]: [],
    });
    renderApp("/connections");
    await userEvent.type(await screen.findByLabelText("Название компании"), "ООО Ромашка");
    await userEvent.click(screen.getByRole("button", { name: "Создать и войти в организацию" }));
    expect(await screen.findByText("Подключите Wildberries")).toBeInTheDocument();         // после создания — сразу к подключению
    const join = calls.find((c) => c.url.pathname.endsWith("/members"))!;
    expect(JSON.parse(String(join.init?.body))).toMatchObject({ user_id: "u1", role: "admin" });
  });

  it("можно войти в существующую организацию", async () => {
    mockFetch({
      "GET /api/v1/auth/me": noOrg(true),
      "GET /api/v1/admin/organizations": [{ id: ORG, name: "Существующая", is_active: true }],
      [`POST /api/v1/admin/organizations/${ORG}/members`]: () => jsonError(409, "Пользователь уже состоит в организации"),
    });
    renderApp("/");
    await userEvent.selectOptions(await screen.findByLabelText("Организация"), ORG);
    await userEvent.click(screen.getByRole("button", { name: "Стать администратором" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("уже состоит");
  });
});
