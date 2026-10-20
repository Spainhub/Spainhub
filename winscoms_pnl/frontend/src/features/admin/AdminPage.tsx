import { FormEvent, useState } from "react";
import { api, ApiError } from "../../api/client";
import type { AdminUser, Organization, Role, SyncJob } from "../../api/types";
import { PageHeader } from "../../components/PageHeader";
import { Badge, Button, Card, ErrorState, Field, Notice, Spinner } from "../../components/ui";
import { useAsync } from "../../hooks";
import { formatDateTime } from "../../utils/format";

function Orgs() {
  const q = useAsync(() => api.get<Organization[]>("/admin/organizations"), []);
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  async function add(e: FormEvent) {
    e.preventDefault(); setErr(null);
    try { await api.post("/admin/organizations", { name: name.trim() }); setName(""); q.reload(); } catch (x) { setErr(x instanceof ApiError ? x.message : "Ошибка"); }
  }
  return (
    <Card title="Организации">
      <form className="form-grid cols" onSubmit={add}><Field label="Название"><input value={name} onChange={(e) => setName(e.target.value)} required /></Field><Button type="submit" variant="primary">Создать</Button></form>
      {err && <Notice kind="error">{err}</Notice>}
      {q.loading && <Spinner />}{q.error && <ErrorState message={q.error} onRetry={q.reload} />}
      <ul className="plain-list">{q.data?.map((o) => <li key={o.id}><b>{o.name}</b> <span className="muted small">{o.id}</span></li>)}</ul>
    </Card>
  );
}

function Users() {
  const users = useAsync(() => api.get<AdminUser[]>("/admin/users"), []);
  const orgs = useAsync(() => api.get<Organization[]>("/admin/organizations"), []);
  const [f, setF] = useState({ email: "", password: "", full_name: "", organization_id: "", role: "member" as Role });
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  async function add(e: FormEvent) {
    e.preventDefault(); setMsg(null);
    try {
      await api.post("/admin/users", { ...f, full_name: f.full_name || null, organization_id: f.organization_id || null });
      setF({ ...f, email: "", password: "", full_name: "" }); setMsg({ kind: "ok", text: "Пользователь создан" }); users.reload();
    } catch (x) { setMsg({ kind: "error", text: x instanceof ApiError ? x.message : "Ошибка" }); }
  }
  return (
    <Card title="Пользователи">
      <form className="form-grid cols" onSubmit={add} aria-label="Новый пользователь">
        <Field label="Email"><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required /></Field>
        <Field label="Пароль" hint="Не короче 12 символов"><input type="password" autoComplete="new-password" minLength={12} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} required /></Field>
        <Field label="Имя"><input value={f.full_name} onChange={(e) => setF({ ...f, full_name: e.target.value })} /></Field>
        <Field label="Организация"><select value={f.organization_id} onChange={(e) => setF({ ...f, organization_id: e.target.value })}><option value="">—</option>{orgs.data?.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></Field>
        <Field label="Роль"><select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as Role })}><option value="admin">Администратор организации</option><option value="member">Участник</option><option value="viewer">Только чтение</option></select></Field>
        <Button type="submit" variant="primary">Создать</Button>
      </form>
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      {users.loading && <Spinner />}{users.error && <ErrorState message={users.error} onRetry={users.reload} />}
      {users.data && <div className="table-wrap"><table className="plain"><thead><tr><th>Email</th><th>Имя</th><th>Статус</th><th /></tr></thead><tbody>
        {users.data.map((u) => <tr key={u.id}><td>{u.email} {u.is_platform_admin && <Badge tone="accent">платформа</Badge>}</td><td>{u.full_name}</td><td>{u.is_active ? <Badge tone="ok">активен</Badge> : <Badge>отключён</Badge>}</td>
          <td><Button variant="ghost" onClick={async () => { try { await api.patch(`/admin/users/${u.id}`, { is_active: !u.is_active }); users.reload(); } catch (x) { setMsg({ kind: "error", text: x instanceof ApiError ? x.message : "Ошибка" }); } }}>{u.is_active ? "Отключить" : "Включить"}</Button></td></tr>)}
      </tbody></table></div>}
    </Card>
  );
}

function Jobs() {
  const q = useAsync(() => api.get<SyncJob[]>("/admin/sync-jobs", { limit: 50 }), []);
  return (
    <Card title="Последние загрузки" actions={<Button onClick={q.reload}>Обновить</Button>}>
      {q.loading && <Spinner />}{q.error && <ErrorState message={q.error} onRetry={q.reload} />}
      {q.data && <div className="table-wrap"><table className="plain"><thead><tr><th>Создано</th><th>Период</th><th>Статус</th><th className="num">Записей</th><th>Сообщение</th></tr></thead><tbody>
        {q.data.map((j) => <tr key={j.id}><td>{formatDateTime(j.created_at)}</td><td>{j.period_from} — {j.period_to}</td><td>{j.status}</td><td className="num">{j.records_saved}</td><td className="small">{j.error_message}</td></tr>)}
      </tbody></table></div>}
    </Card>
  );
}

export default function AdminPage() {
  return (<><PageHeader title="Администрирование" subtitle="Организации, пользователи и состояние загрузок" /><Orgs /><Users /><Jobs /></>);
}
