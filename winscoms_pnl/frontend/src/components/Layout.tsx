import { useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { Button } from "./ui";

const I = (d: string) => <svg className="nav-ico" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>;
const ICON = {
  home: I("M3 11l9-8 9 8M5 10v10h5v-6h4v6h5V10"),
  chart: I("M4 20V10M10 20V4M16 20v-7M22 20H2"),
  plug: I("M9 2v6M15 2v6M7 8h10v4a5 5 0 0 1-10 0V8zM12 17v5"),
  wallet: I("M3 7h16a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7zM3 7l3-3h11M16 14h2"),
  gear: I("M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19 12a7 7 0 0 0-.1-1l2-1.5-2-3.4-2.3 1a7 7 0 0 0-1.7-1L14.5 3h-4l-.4 3a7 7 0 0 0-1.7 1l-2.3-1-2 3.4 2 1.5a7 7 0 0 0 0 2l-2 1.5 2 3.4 2.3-1a7 7 0 0 0 1.7 1l.4 3h4l.4-3a7 7 0 0 0 1.7-1l2.3 1 2-3.4-2-1.5c.1-.3.1-.7.1-1z"),
  shield: I("M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z"),
};
const GROUPS = [
  { title: "Отчёты", items: [{ to: "/", label: "Дашборд", end: true, icon: ICON.home }, { to: "/pnl", label: "P&L отчёт", icon: ICON.chart }] },
  { title: "Данные", items: [{ to: "/connections", label: "Подключения", icon: ICON.plug }, { to: "/expenses", label: "Расходы и корректировки", icon: ICON.wallet }] },
  { title: "Управление", items: [{ to: "/settings", label: "Настройки", icon: ICON.gear }] },
];

export default function Layout() {
  const { me, membership, setOrgId, logout } = useAuth();
  const nav = useNavigate();
  const [open, setOpen] = useState(false);
  if (!me) return null;
  const groups = me.user.is_platform_admin
    ? [...GROUPS.slice(0, 2), { title: "Управление", items: [...GROUPS[2].items, { to: "/admin", label: "Администрирование", icon: ICON.shield }] }]
    : GROUPS;
  return (
    <div className="shell">
      <header className="topbar">
        <button className="icon-btn menu-btn" aria-label="Меню" aria-expanded={open} onClick={() => setOpen(!open)}>☰</button>
        <div className="brand">WIN<span>SCOMS</span></div>
        {open && <button className="nav-scrim" aria-label="Закрыть меню" onClick={() => setOpen(false)} />}
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
        {groups.map((g) => (
          <div key={g.title} className="nav-group">
            <div className="nav-title">{g.title}</div>
            {g.items.map((i) => (
              <NavLink key={i.to} to={i.to} end={"end" in i ? i.end : undefined} onClick={() => setOpen(false)} className={({ isActive }) => (isActive ? "active" : "")}>{i.icon}<span>{i.label}</span></NavLink>
            ))}
          </div>
        ))}
      </nav>
      <main className="content"><Outlet /></main>
    </div>
  );
}
