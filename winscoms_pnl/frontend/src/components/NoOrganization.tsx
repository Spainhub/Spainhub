import { FormEvent, useState } from "react";
import { api, ApiError } from "../api/client";
import type { Organization } from "../api/types";
import { useAuth } from "../auth/AuthContext";
import { useAsync } from "../hooks";
import { Button, Card, EmptyState, Field, Notice } from "./ui";

/** Экран первого входа: у пользователя нет организации. Администратор платформы может создать её и стать администратором. */
export default function NoOrganization() {
  const { me, refresh } = useAuth();
  const isPlatform = !!me?.user.is_platform_admin;
  const orgs = useAsync(() => api.get<Organization[]>("/admin/organizations"), [], isPlatform);
  const [name, setName] = useState("");
  const [existing, setExisting] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!isPlatform) {
    return <EmptyState title="Вы пока не состоите ни в одной организации" hint="Попросите администратора платформы добавить вас в организацию." />;
  }

  async function join(orgId: string) {
    await api.post(`/admin/organizations/${orgId}/members`, { user_id: me!.user.id, role: "admin" });
    await refresh();
  }
  async function create(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try { const o = await api.post<Organization>("/admin/organizations", { name: name.trim() }); await join(o.id); }
    catch (x) { setErr(x instanceof ApiError ? x.message : "Не удалось создать организацию"); } finally { setBusy(false); }
  }
  async function useExisting(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try { await join(existing); } catch (x) { setErr(x instanceof ApiError ? x.message : "Не удалось добавить"); } finally { setBusy(false); }
  }

  return (
    <div className="narrow">
      <h1>Добро пожаловать в WINSCOMS</h1>
      <p className="muted">Вы вошли как администратор платформы. Чтобы увидеть P&amp;L и подключить Wildberries, нужна организация, в которой вы — администратор.</p>
      {err && <Notice kind="error">{err}</Notice>}
      <Card title="1. Создайте организацию">
        <form className="form-grid" onSubmit={create} aria-label="Новая организация">
          <Field label="Название компании"><input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} placeholder="ООО «Ромашка»" /></Field>
          <div className="form-actions"><Button type="submit" variant="primary" disabled={busy}>Создать и войти в организацию</Button></div>
        </form>
      </Card>
      {(orgs.data?.length ?? 0) > 0 && (
        <Card title="Или войдите в существующую">
          <form className="form-grid" onSubmit={useExisting} aria-label="Существующая организация">
            <Field label="Организация"><select value={existing} onChange={(e) => setExisting(e.target.value)} required><option value="">Выберите…</option>{orgs.data!.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></Field>
            <div className="form-actions"><Button type="submit" disabled={busy || !existing}>Стать администратором</Button></div>
          </form>
        </Card>
      )}
      <p className="muted small">Сотрудников и других пользователей создаёт раздел «Администрирование».</p>
    </div>
  );
}
