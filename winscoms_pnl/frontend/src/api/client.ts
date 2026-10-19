const BASE = "/api/v1";

let csrfToken = "";
export function setCsrfToken(t: string) { csrfToken = t; }

export class ApiError extends Error {
  constructor(public status: number, message: string, public detail?: unknown) { super(message); }
}

type Listener = () => void;
const unauthListeners = new Set<Listener>();
export function onUnauthorized(fn: Listener) { unauthListeners.add(fn); return () => { unauthListeners.delete(fn); }; }

function messageFrom(status: number, body: unknown): string {
  if (status >= 500) {   // внутренние детали пользователю не показываем, только код для поиска в логах
    const rid = (body as { request_id?: unknown } | null)?.request_id;
    return `Ошибка сервера. Попробуйте позже${typeof rid === "string" ? ` (код ${rid})` : ""}`;
  }
  const d = (body as { detail?: unknown } | null)?.detail;
  if (typeof d === "string") return d;
  if (d && typeof d === "object" && "message" in (d as object)) return String((d as { message: unknown }).message);
  if (Array.isArray(d)) return "Проверьте введённые данные";
  if (status === 401) return "Требуется вход";
  if (status === 403) return "Недостаточно прав";
  if (status === 404) return "Не найдено";
  if (status >= 500) return "Ошибка сервера. Попробуйте позже";
  return "Не удалось выполнить запрос";
}

export async function request<T>(method: string, path: string, opts: { body?: unknown; form?: FormData; query?: Record<string, string | number | undefined | null> } = {}): Promise<T> {
  const url = new URL(BASE + path, window.location.origin);
  for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined && v !== null && v !== "") url.searchParams.set(k, String(v));
  const headers: Record<string, string> = {};
  if (method !== "GET") headers["X-CSRF-Token"] = csrfToken;
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) { headers["Content-Type"] = "application/json"; body = JSON.stringify(opts.body); }
  let res: Response;
  try {
    res = await fetch(url.pathname + url.search, { method, headers, body, credentials: "same-origin" });
  } catch {
    throw new ApiError(0, "Нет связи с сервером. Проверьте подключение");
  }
  if (res.status === 204) return undefined as T;
  const ctype = res.headers.get("content-type") ?? "";
  const data = ctype.includes("json") ? await res.json().catch(() => null) : null;
  if (!res.ok) {
    if (res.status === 401 && path !== "/auth/login") unauthListeners.forEach((f) => f());
    throw new ApiError(res.status, messageFrom(res.status, data), (data as { detail?: unknown } | null)?.detail);
  }
  return data as T;
}

export async function download(path: string, filename: string, query?: Record<string, string>): Promise<void> {
  const url = new URL(BASE + path, window.location.origin);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url.pathname + url.search, { credentials: "same-origin" });
  if (!res.ok) throw new ApiError(res.status, messageFrom(res.status, null));
  const blob = await res.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

export const api = {
  get: <T,>(path: string, query?: Record<string, string | number | undefined | null>) => request<T>("GET", path, { query }),
  post: <T,>(path: string, body?: unknown, query?: Record<string, string | number | undefined | null>) => request<T>("POST", path, { body, query }),
  put: <T,>(path: string, body?: unknown) => request<T>("PUT", path, { body }),
  patch: <T,>(path: string, body?: unknown) => request<T>("PATCH", path, { body }),
  del: <T,>(path: string) => request<T>("DELETE", path),
  upload: <T,>(path: string, form: FormData, query?: Record<string, string>) => request<T>("POST", path, { form, query }),
};
