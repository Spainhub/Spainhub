import { Navigate, useLocation } from "react-router-dom";
import { ReactNode } from "react";
import { useAuth } from "../auth/AuthContext";
import NoOrganization from "./NoOrganization";
import { EmptyState, Spinner } from "./ui";

export function RequireAuth({ children }: { children: ReactNode }) {
  const { me, ready } = useAuth();
  const loc = useLocation();
  if (!ready) return <div className="center-screen"><Spinner /></div>;
  if (!me) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  return <>{children}</>;
}

/** Страницы данных организации: нужна хотя бы одна организация. */
export function RequireOrg({ children }: { children: ReactNode }) {
  const { orgId } = useAuth();
  if (!orgId) return <NoOrganization />;
  return <>{children}</>;
}

export function RequirePlatformAdmin({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  if (!me?.user.is_platform_admin) return <EmptyState title="Нет доступа" hint="Раздел доступен только администратору платформы." />;
  return <>{children}</>;
}
