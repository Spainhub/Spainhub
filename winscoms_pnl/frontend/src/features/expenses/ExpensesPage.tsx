import { FormEvent, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { api, ApiError, download } from "../../api/client";
import type { Cost, ManualEntry, SellerAccount } from "../../api/types";
import { useAuth } from "../../auth/AuthContext";
import { PageHeader } from "../../components/PageHeader";
import { Button, Card, EmptyState, ErrorState, Field, Modal, Notice, Spinner } from "../../components/ui";
import { useAsync } from "../../hooks";
import { formatDate, formatMoney, isoDate } from "../../utils/format";

interface Category { category: string; name: string }

function ManualTab({ org, canWrite, adding, setAdding }: { org: string; canWrite: boolean; adding: boolean; setAdding: (v: boolean) => void }) {
  const cats = useAsync(() => api.get<Category[]>(`/orgs/${org}/manual-categories`), [org]);
  const accounts = useAsync(() => api.get<SellerAccount[]>(`/orgs/${org}/seller-accounts`), [org]);
  const list = useAsync(() => api.get<ManualEntry[]>(`/orgs/${org}/manual-entries`, { limit: 200 }), [org]);
  const empty = { entry_date: isoDate(new Date()), category: "opex_other", amount: "", description: "", seller_account_id: "" };
  const [form, setForm] = useState(empty);
  const [editId, setEditId] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const name = (c: string) => cats.data?.find((x) => x.category === c)?.name ?? c;
  const open = adding || editId !== null;
  const close = () => { setAdding(false); setEditId(null); setForm(empty); setErr(null); };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setErr(null);
    const body = { ...form, amount: form.amount.replace(",", "."), description: form.description || null, seller_account_id: form.seller_account_id || null };
    try {
      if (editId) await api.put(`/orgs/${org}/manual-entries/${editId}`, body); else await api.post(`/orgs/${org}/manual-entries`, body);
      close(); list.reload();
    } catch (x) { setErr(x instanceof ApiError ? x.message : "Не удалось сохранить"); } finally { setBusy(false); }
  }

  return (
    <>
      <Notice kind="info">Сумма <b>0</b> подтверждает, что расходов по статье нет. Группы «Реклама и маркетинг» и «Операционные расходы» нужно подтвердить хотя бы одной записью — иначе операционная и чистая прибыль не считаются. При режиме ОСНО вводите суммы без НДС.</Notice>
      {open && canWrite && (
        <Modal title={editId ? "Изменить запись" : "Новая запись"} onClose={close}>
          <form className="form-grid" onSubmit={submit} aria-label="Запись о расходе">
            <Field label="Статья"><select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>{(cats.data ?? []).map((c) => <option key={c.category} value={c.category}>{c.name}</option>)}</select></Field>
            <div className="form-two">
              <Field label="Дата"><input type="date" value={form.entry_date} onChange={(e) => setForm({ ...form, entry_date: e.target.value })} required /></Field>
              <Field label="Сумма, ₽"><input inputMode="decimal" pattern="[0-9]+([.,][0-9]{1,6})?" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} required placeholder="0" /></Field>
            </div>
            <Field label="Аккаунт" hint="Необязательно — по умолчанию запись относится ко всей организации"><select value={form.seller_account_id} onChange={(e) => setForm({ ...form, seller_account_id: e.target.value })}><option value="">Вся организация</option>{(accounts.data ?? []).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
            <Field label="Описание"><input value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} maxLength={1000} /></Field>
            {err && <Notice kind="error">{err}</Notice>}
            <div className="form-actions"><Button type="button" onClick={close}>Отмена</Button><Button type="submit" variant="primary" disabled={busy}>Сохранить</Button></div>
          </form>
        </Modal>
      )}
      {list.loading && !list.data && <Spinner />}
      {list.error && <ErrorState message={list.error} onRetry={list.reload} />}
      {list.data && list.data.length === 0 && <EmptyState title="Записей пока нет" hint="Добавьте зарплаты, подписки, внешнюю рекламу и прочие расходы.">{canWrite && <Button variant="primary" onClick={() => setAdding(true)}>+ Добавить запись</Button>}</EmptyState>}
      {list.data && list.data.length > 0 && (
        <div className="table-wrap"><table className="plain">
          <thead><tr><th>Дата</th><th>Статья</th><th>Описание</th><th className="num">Сумма</th>{canWrite && <th />}</tr></thead>
          <tbody>{list.data.map((m) => (
            <tr key={m.id}><td>{formatDate(m.entry_date)}</td><td>{name(m.category)}</td><td>{m.description}</td><td className="num">{formatMoney(m.amount)} {m.currency}</td>
              {canWrite && <td className="row-actions">
                <Button variant="ghost" onClick={() => { setEditId(m.id); setForm({ entry_date: m.entry_date, category: m.category, amount: String(Number(m.amount)), description: m.description ?? "", seller_account_id: m.seller_account_id ?? "" }); }}>Изменить</Button>
                <Button variant="ghost" className="danger-text" onClick={async () => { if (window.confirm("Удалить запись?")) { await api.del(`/orgs/${org}/manual-entries/${m.id}`); list.reload(); } }}>Удалить</Button>
              </td>}
            </tr>))}</tbody>
        </table></div>
      )}
    </>
  );
}

function CostsTab({ org, canWrite }: { org: string; canWrite: boolean }) {
  const list = useAsync(() => api.get<Cost[]>(`/orgs/${org}/costs`, { limit: 500 }), [org]);
  const file = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ kind: "ok" | "error"; text: string; errors?: { row: number; field: string; error: string }[] } | null>(null);

  async function upload() {
    const f = file.current?.files?.[0];
    if (!f) return;
    setBusy(true); setResult(null);
    const form = new FormData();
    form.append("file", f);
    try {
      const r = await api.upload<{ imported: number; skipped_blank: number }>(`/orgs/${org}/costs/import`, form);
      setResult({ kind: "ok", text: `Загружено строк: ${r.imported}. Пропущено без цены: ${r.skipped_blank}.` });
      list.reload();
    } catch (x) {
      const d = x instanceof ApiError ? (x.detail as { errors?: { row: number; field: string; error: string }[] } | undefined) : undefined;
      setResult({ kind: "error", text: x instanceof ApiError ? x.message : "Не удалось загрузить", errors: d?.errors });
    } finally { setBusy(false); if (file.current) file.current.value = ""; }
  }

  return (
    <>
      <Card title="Загрузка себестоимости через Excel">
        <ol className="steps">
          <li>Скачайте шаблон — в нём уже перечислены ваши товары.</li>
          <li>Заполните колонку <b>costPerUnit</b> — себестоимость одной единицы (при ОСНО — без НДС). Колонка <b>validFrom</b> — дата, с которой цена действует (необязательно).</li>
          <li>Загрузите файл. При любой ошибке не загрузится ничего — вы увидите, какие строки исправить.</li>
        </ol>
        <div className="actions">
          <Button onClick={() => download(`/orgs/${org}/costs/template`, "cost_template.xlsx").catch(() => setResult({ kind: "error", text: "Не удалось скачать шаблон" }))}>Скачать шаблон</Button>
          {canWrite && <>
            <input ref={file} type="file" accept=".xlsx" aria-label="Файл с себестоимостью" />
            <Button variant="primary" onClick={upload} disabled={busy}>Загрузить файл</Button>
          </>}
        </div>
        {result && <Notice kind={result.kind}>{result.text}</Notice>}
        {result?.errors && <ul className="errors">{result.errors.map((e, i) => <li key={i}>Строка {e.row}, {e.field}: {e.error}</li>)}</ul>}
      </Card>
      {list.loading && !list.data && <Spinner />}
      {list.error && <ErrorState message={list.error} onRetry={list.reload} />}
      {list.data && list.data.length === 0 && <EmptyState title="Себестоимость не задана" hint="Пока её нет, валовая, операционная и чистая прибыль не считаются." />}
      {list.data && list.data.length > 0 && (
        <div className="table-wrap"><table className="plain">
          <thead><tr><th>nmId</th><th>Артикул</th><th>Действует с</th><th className="num">Себестоимость ед.</th></tr></thead>
          <tbody>{list.data.map((c) => <tr key={c.id}><td>{c.nm_id}</td><td>{c.vendor_code}</td><td>{c.valid_from === "1970-01-01" ? "с начала" : formatDate(c.valid_from)}</td><td className="num">{formatMoney(c.cost_per_unit)} {c.currency}</td></tr>)}</tbody>
        </table></div>
      )}
    </>
  );
}

export default function ExpensesPage() {
  const { orgId, canWrite } = useAuth();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "costs" ? "costs" : "manual";
  const [adding, setAdding] = useState(false);
  const go = (t: "manual" | "costs") => setParams(t === "costs" ? { tab: "costs" } : {});
  return (
    <>
      <PageHeader title="Расходы и корректировки" subtitle="Данные, которых нет в отчётах маркетплейса: себестоимость, зарплаты, подписки, внешняя реклама"
        actions={tab === "manual" && canWrite ? <Button variant="primary" onClick={() => setAdding(true)}>+ Добавить запись</Button> : undefined} />
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "manual"} className={tab === "manual" ? "active" : ""} onClick={() => go("manual")}>Расходы и корректировки</button>
        <button role="tab" aria-selected={tab === "costs"} className={tab === "costs" ? "active" : ""} onClick={() => go("costs")}>Себестоимость товаров</button>
      </div>
      {tab === "manual" ? <ManualTab org={orgId!} canWrite={canWrite} adding={adding} setAdding={setAdding} /> : <CostsTab org={orgId!} canWrite={canWrite} />}
    </>
  );
}
