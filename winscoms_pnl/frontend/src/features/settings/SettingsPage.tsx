import { FormEvent, useEffect, useState } from "react";
import { api, ApiError } from "../../api/client";
import type { OrgSettings } from "../../api/types";
import { useAuth } from "../../auth/AuthContext";
import { Button, Card, ErrorState, Field, Notice, Spinner } from "../../components/ui";
import { useAsync } from "../../hooks";

const DEFAULTS: OrgSettings = { tax_regime: "usn_income", usn_rate: "6", profit_tax_rate: "20", vat_sales_rate: "22", vat_services_rate: "22" };

export default function SettingsPage() {
  const { orgId, isOrgAdmin, membership } = useAuth();
  const org = orgId!;
  const q = useAsync(() => api.get<OrgSettings | null>(`/orgs/${org}/settings`), [org]);
  const [form, setForm] = useState<OrgSettings>(DEFAULTS);
  const [msg, setMsg] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (q.data) setForm({ ...DEFAULTS, ...q.data }); }, [q.data]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setMsg(null);
    try { await api.put(`/orgs/${org}/settings`, form); setMsg({ kind: "ok", text: "Сохранено" }); q.reload(); }
    catch (x) { setMsg({ kind: "error", text: x instanceof ApiError ? x.message : "Не удалось сохранить" }); } finally { setBusy(false); }
  }
  const set = (k: keyof OrgSettings) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value } as OrgSettings);
  const osno = form.tax_regime === "osno";

  return (
    <>
      <h1>Настройки</h1>
      <p className="muted">Организация: {membership?.organization_name}</p>
      {q.loading && <Spinner />}
      {q.error && <ErrorState message={q.error} onRetry={q.reload} />}
      {!q.loading && !q.error && (
        <Card title="Учётная политика">
          {q.data === null && <Notice kind="warn">Налоговый режим не выбран — P&L отчёт не будет рассчитан, пока вы его не сохраните.</Notice>}
          <form onSubmit={save} className="stack" aria-label="Учётная политика">
            <fieldset disabled={!isOrgAdmin}>
              <legend>Налоговый режим</legend>
              <label className="radio"><input type="radio" name="regime" checked={form.tax_regime === "usn_income"} onChange={() => setForm({ ...form, tax_regime: "usn_income" })} /> УСН «доходы» — налог = ставка × продажи, НДС не выделяется</label>
              <label className="radio"><input type="radio" name="regime" checked={osno} onChange={() => setForm({ ...form, tax_regime: "osno" })} /> ОСНО — налог на прибыль и НДС отдельной строкой</label>
              <div className="form-row">
                {!osno && <Field label="Ставка УСН, %"><input inputMode="decimal" value={form.usn_rate} onChange={set("usn_rate")} /></Field>}
                {osno && <>
                  <Field label="Налог на прибыль, %"><input inputMode="decimal" value={form.profit_tax_rate} onChange={set("profit_tax_rate")} /></Field>
                  <Field label="НДС в цене продажи, %"><input inputMode="decimal" value={form.vat_sales_rate} onChange={set("vat_sales_rate")} /></Field>
                  <Field label="НДС в услугах маркетплейса, %" hint="По отчётам WB 2026 — 22%"><input inputMode="decimal" value={form.vat_services_rate} onChange={set("vat_services_rate")} /></Field>
                </>}
              </div>
            </fieldset>
            {osno && <p className="muted small">При ОСНО суммы услуг маркетплейса и ручные расходы считаются без НДС, себестоимость единицы вводите без НДС. Допущение: все услуги маркетплейса облагаются НДС по одной ставке.</p>}
            {msg && <Notice kind={msg.kind}>{msg.text}</Notice>}
            {isOrgAdmin ? <Button type="submit" variant="primary" disabled={busy}>Сохранить</Button> : <p className="muted small">Менять учётную политику может администратор организации.</p>}
          </form>
        </Card>
      )}
    </>
  );
}
