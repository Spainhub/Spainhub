import { describe, expect, it, vi } from "vitest";
import { api, ApiError, onUnauthorized, setCsrfToken } from "./client";
import { jsonError, mockFetch } from "../test/fixtures";

describe("api client", () => {
  it("GET не шлёт CSRF, изменяющие запросы шлют", async () => {
    const { calls } = mockFetch({ "GET /api/v1/a": { ok: 1 }, "POST /api/v1/b": { ok: 2 } });
    setCsrfToken("tok-123");
    await api.get("/a");
    await api.post("/b", { x: 1 });
    expect((calls[0].init?.headers as Record<string, string>)["X-CSRF-Token"]).toBeUndefined();
    expect((calls[1].init?.headers as Record<string, string>)["X-CSRF-Token"]).toBe("tok-123");
    expect(calls[1].init?.credentials).toBe("same-origin");
  });

  it("ошибки превращаются в понятные сообщения, 401 оповещает приложение", async () => {
    mockFetch({ "GET /api/v1/x": () => jsonError(401, "Требуется вход"), "GET /api/v1/y": () => jsonError(500, "boom"), "GET /api/v1/z": () => jsonError(409, "Не задана учётная политика") });
    const fn = vi.fn();
    const off = onUnauthorized(fn);
    await expect(api.get("/x")).rejects.toMatchObject({ status: 401 });
    expect(fn).toHaveBeenCalledTimes(1);
    off();
    await expect(api.get("/z")).rejects.toThrow("Не задана учётная политика");
    await expect(api.get("/y")).rejects.toBeInstanceOf(ApiError);
  });

  it("сетевая ошибка — сообщение пользователю", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    await expect(api.get("/x")).rejects.toThrow("Нет связи с сервером");
  });

  it("422 с массивом ошибок не показывает сырой JSON", async () => {
    mockFetch({ "POST /api/v1/f": () => jsonError(422, [{ loc: ["body", "x"], msg: "bad" }]) });
    await expect(api.post("/f", {})).rejects.toThrow("Проверьте введённые данные");
  });
});
