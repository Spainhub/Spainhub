import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, ApiError, onUnauthorized, setCsrfToken } from "../api/client";
import type { Me, Membership, Role } from "../api/types";

interface AuthValue {
  me: Me | null;
  ready: boolean;
  orgId: string | null;
  membership: Membership | null;
  role: Role | null;
  canWrite: boolean;
  isOrgAdmin: boolean;
  setOrgId: (id: string) => void;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
}

const Ctx = createContext<AuthValue | null>(null);
const ORG_KEY = "winscoms.org";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const [orgId, setOrg] = useState<string | null>(() => { try { return localStorage.getItem(ORG_KEY); } catch { return null; } });

  const apply = useCallback((m: Me | null) => {
    setMe(m);
    setCsrfToken(m?.csrf_token ?? "");
  }, []);

  useEffect(() => {
    api.get<Me>("/auth/me").then(apply, (e) => { if (!(e instanceof ApiError) || e.status !== 401) console.error(e); apply(null); }).finally(() => setReady(true));
  }, [apply]);

  useEffect(() => onUnauthorized(() => apply(null)), [apply]);

  const login = useCallback(async (email: string, password: string) => { apply(await api.post<Me>("/auth/login", { email, password })); }, [apply]);
  const logout = useCallback(async () => { try { await api.post("/auth/logout"); } finally { apply(null); } }, [apply]);
  const setOrgId = useCallback((id: string) => { setOrg(id); try { localStorage.setItem(ORG_KEY, id); } catch { /* приватный режим */ } }, []);

  const value = useMemo<AuthValue>(() => {
    const ms = me?.memberships ?? [];
    const membership = ms.find((m) => m.organization_id === orgId) ?? ms[0] ?? null;
    const role = membership?.role ?? null;
    return {
      me, ready, orgId: membership?.organization_id ?? null, membership, role,
      canWrite: role === "admin" || role === "member", isOrgAdmin: role === "admin",
      setOrgId, login, logout,
    };
  }, [me, ready, orgId, setOrgId, login, logout]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthValue {
  const v = useContext(Ctx);
  if (!v) throw new Error("useAuth вне AuthProvider");
  return v;
}
