import { FormEvent, useEffect, useState } from "react";
import { api, ApiError } from "../../api/client";
import type { NormalizationSummary, SellerAccount, SyncJob } from "../../api/types";
import { useAuth } from "../../auth/AuthContext";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Notice, Spinner } from "../../components/ui";
import { useAsync } from "../../hooks";
import { formatDateTime } from "../../utils/format";

const JOB_LABEL: Record<SyncJob["status"], [string, "neutral" | "ok" | "warn" | "error" | "accent"]> = {
  queued: ["В очереди", "neutral"], running: ["Выполняется", "accent"], succeeded: ["Готово", "ok"],
  failed: ["Ошибка", "error"], partial: ["Частично", "warn"], cancelled: ["Отменено", "neutral"],
};
const ACC_LABEL: Record<SellerAccount["status"], [string, "ok" | "error" | "neutral"]> = {
  active: ["Подключён", "ok"], auth_error: ["Нужен новый токен", "error"], disconnected: ["Отключён", "neutral"],
};

function AddAccount({ orgId, onDone }: { orgId: string; onDone: () => void }) {
  const [name, setName] = useState("");
  const [token, setToken] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      await api.post(`/orgs/${orgId}/seller-accounts`, { marketplace: "wildberries", name: name.trim(), token: token.trim() });
      setName(""); setToken(""); onDone();
    } catch (x) { setErr(x instanceof ApiError ? x.message : "Не удалось добавить"); } finally { setBusy(false); }
  }
  return (
    <form onSubmit={submit} className="form-row" aria-label="Добавить аккаунт Wildberries">
      <Field label="Название магазина"><input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} /></Field>
      <Field label="API-токен Wildberries" hint="Категория «Финансы». После сохранения токен не показывается."><input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} required minLength={10} /></Field>
      <Button type="submit" variant="primary" disabled={busy}>Добавить</Button>
      {err && <Notice kind="error">{err}</Notice>}
    </form>
  );
}

function Account({ orgId, acc, canManage, reload }: { orgId: string; acc: SellerAccount; canManage: boolean; reload: () => void }) {
  const base = `/orgs/${orgId}/seller-accounts/${acc.id}`;
  const jobs = useAsync(() => api.get<SyncJob[]>(`${base}/sync-jobs`), [base]);
  const summary = useAsync(() => api.get<NormalizationSummary>(`${base}/normalization`), [base]);
  const [msg, setMsg] = useState<{ kind: "ok" | "error" | "info"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [newToken, setNewToken] = useState<string | null>(null);
  const active = (jobs.data ?? []).some((j) => j.status === "queued" || j.status === "running");

  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => { jobs.reload(); summary.reload(); }, 10000);
    return () => clearInterval(t);
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(fn: () => Promise<void>) {
    setBusy(true); setMsg(null);
    try { await fn(); } catch (x) { setMsg({ kind: "error", text: x instanceof ApiError ? x.message : "Ошибка" }); } finally { setBusy(false); }
  }
  const [label, tone] = ACC_LABEL[acc.status];

  return (
    <Card title={<>{acc.name} <Badge tone={tone}>{label}</Badge></>} className="account">
      <dl className="meta">
        <div><dt>Маркетплейс</dt><dd>Wildberries</dd></div>
        <div><dt>Токен</dt><dd>•••• {acc.token_hint ?? ""}</dd></div>
        <div><dt>Проверен</dt><dd>{formatDateTime(acc.last_validated_at)}</dd></div>
        <div><dt>Последняя успешная загрузка</dt><dd>{formatDateTime(acc.last_sync_at)}</dd></div>
      </dl>
      {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
      {summary.data && summary.data.needs_attention > 0 && <Notice kind="warn">{summary.data.needs_attention} строк требуют внимания (неизвестный тип или неподтверждённый учёт) — они не входят в P&L.</Notice>}
      {canManage && (
        <div className="actions">
          <Button disabled={busy} onClick={() => act(async () => { const r = await api.post<{ valid: boolean; message: string }>(`${base}/validate`); setMsg({ kind: r.valid ? "ok" : "error", text: r.message }); reload(); })}>Проверить подключение</Button>
          <Button variant="primary" disabled={busy || acc.status !== "active" || active} onClick={() => act(async () => { await api.post(`${base}/sync`, { months: 3 }); setMsg({ kind: "info", text: "Загрузка запущена: последние 3 месяца. Лимит Wildberries — 1 запрос в минуту, это займёт время." }); jobs.reload(); })}>Загрузить за 3 месяца</Button>
          <Button disabled={busy} onClick={() => setNewToken("")}>Заменить токен</Button>
          <Button variant="danger" disabled={busy} onClick={() => { if (window.confirm(`Отключить «${acc.name}»? Токен будет удалён, загрузка остановлена. Уже загруженные данные сохранятся.`)) act(async () => { await api.del(base); reload(); }); }}>Отключить</Button>
        </div>
      )}
      {newToken !== null && (
        <form className="form-row" onSubmit={(e) => { e.preventDefault(); act(async () => { await api.put(`${base}/token`, { token: newToken.trim() }); setNewToken(null); setMsg({ kind: "ok", text: "Токен заменён. Проверьте подключение." }); reload(); }); }}>
          <Field label="Новый токен"><input type="password" autoComplete="off" value={newToken} onChange={(e) => setNewToken(e.target.value)} required minLength={10} /></Field>
          <Button type="submit" variant="primary" disabled={busy}>Сохранить</Button><Button type="button" onClick={() => setNewToken(null)}>Отмена</Button>
        </form>
      )}
      <h3>Загрузки</h3>
      {jobs.loading && !jobs.data && <Spinner />}
      {jobs.error && <ErrorState message={jobs.error} onRetry={jobs.reload} />}
      {jobs.data && jobs.data.length === 0 && <p className="muted">Загрузок ещё не было.</p>}
      {jobs.data && jobs.data.length > 0 && (
        <div className="table-wrap">
          <table className="plain">
            <thead><tr><th>Создано</th><th>Период</th><th>Статус</th><th className="num">Записей</th><th>Сообщение</th><th /></tr></thead>
            <tbody>
              {jobs.data.map((j) => {
                const [t, bt] = JOB_LABEL[j.status];
                return (
                  <tr key={j.id}>
                    <td>{formatDateTime(j.created_at)}</td><td>{j.period_from} — {j.period_to}</td>
                    <td><Badge tone={bt}>{t}</Badge></td>
                    <td className="num">{j.records_saved} / {j.records_fetched}</td>
                    <td className="small">{j.error_message ?? (j.status === "succeeded" ? "Все страницы получены" : "")}</td>
                    <td>{canManage && (j.status === "failed" || j.status === "partial") && <Button disabled={busy} onClick={() => act(async () => { await api.post(`${base}/sync-jobs/${j.id}/retry`); jobs.reload(); })}>Повторить</Button>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export default function ConnectionsPage() {
  const { orgId, isOrgAdmin } = useAuth();
  const org = orgId!;
  const list = useAsync(() => api.get<SellerAccount[]>(`/orgs/${org}/seller-accounts`), [org]);
  return (
    <>
      <h1>Подключения</h1>
      {isOrgAdmin && <Card title="Добавить аккаунт Wildberries"><AddAccount orgId={org} onDone={list.reload} /></Card>}
      {list.loading && !list.data && <Spinner />}
      {list.error && <ErrorState message={list.error} onRetry={list.reload} />}
      {list.data && list.data.length === 0 && <EmptyState title="Аккаунтов пока нет" hint={isOrgAdmin ? "Добавьте токен Wildberries выше, проверьте подключение и запустите загрузку." : "Аккаунты подключает администратор организации."} />}
      {list.data?.map((a) => <Account key={a.id} orgId={org} acc={a} canManage={isOrgAdmin} reload={list.reload} />)}
    </>
  );
}
