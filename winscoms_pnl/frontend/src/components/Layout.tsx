import { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { Button } from "./ui";

const NAV = [
  { to: "/", label: "Дашборд", end: true },
  { to: "/pnl", label: "P&L отчёт" },
  { to: "/connections", label: "Подключения" },
  { to: "/expenses", label: "Расходы и корректировки" },
  { to: "/settings", label: "Настройки" },
];

export default function Layout() {
  const { me, membership, setOrgId, logout } = useAuth();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  if (!me) return null;
  const items = me.user.is_platform_admin ? [...NAV, { to: "/admin", label: "Администрирование" }] : NAV;
  return (
    <div className="shell">
      <header className="topbar">
        <button className="icon-btn menu-btn" aria-label="Меню" aria-expanded={open} onClick={() => setOpen(!open)}>☰</button>
        <div className="brand">WIN<span>SCOMS</span></div>
        <div className="topbar-right">
          {me.memberships.length > 1 && (
            <select aria-label="Организация" value={membership?.organization_id ?? ""} onChange={(e) => setOrgId(e.target.value)}>
              {me.memberships.map((m) => <option key={m.organization_id} value={m.organization_id}>{m.organization_name}</option>)}
            </select>
          )}
          {me.memberships.length === 1 && <span className="org-name">{membership?.organization_name}</span>}
          <span className="user-email" title={me.user.email}>{me.user.email}</span>
          <Button variant="ghost" onClick={async () => { await logout(); nav("/login"); }}>Выйти</Button>
        </div>
      </header>
      <nav className={`sidenav ${open ? "open" : ""}`} aria-label="Основная навигация">
        {items.map((i) => (
          <NavLink key={i.to} to={i.to} end={i.end} onClick={() => setOpen(false)} className={({ isActive }) => (isActive ? "active" : "")}>{i.label}</NavLink>
        ))}
      </nav>
      <main className="content"><Outlet /></main>
    </div>
  );
}
