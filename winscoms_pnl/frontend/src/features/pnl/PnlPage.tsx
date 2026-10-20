import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import type { PnlLine, PnlReport, SellerAccount } from "../../api/types";
import { useAuth } from "../../auth/AuthContext";
import { Button, Card, EmptyState, ErrorState, Field, Notice, Spinner } from "../../components/ui";
import { useAsync } from "../../hooks";
import { formatDate, formatMoney, isoDate, previousPeriod } from "../../utils/format";
import { PageHeader } from "../../components/PageHeader";
import Drilldown from "./Drilldown";
import PnlTable from "./PnlTable";

type Gran = "total" | "month" | "day";

export function presets(today = new Date()) {
  const y = today.getFullYear(), m = today.getMonth();
  const first = (yy: number, mm: number) => isoDate(new Date(yy, mm, 1));
  const last = (yy: number, mm: number) => isoDate(new Date(yy, mm + 1, 0));
  return [
    { id: "this", label: "Этот месяц", from: first(y, m), to: isoDate(today) },
    { id: "last", label: "Прошлый месяц", from: first(y, m - 1), to: last(y, m - 1) },
    { id: "3m", label: "3 месяца", from: first(y, m - 2), to: isoDate(today) },
  ];
}

export default function PnlPage() {
  const { orgId } = useAuth();
  const org = orgId!;
  const p0 = presets()[0];
  const [draft, setDraft] = useState({ from: p0.from, to: p0.to, gran: "month" as Gran, account: "", compare: false });
  const [applied, setApplied] = useState(draft);
  const [drill, setDrill] = useState<PnlLine | null>(null);

  const accounts = useAsync(() => api.get<SellerAccount[]>(`/orgs/${org}/seller-accounts`), [org]);
  const report = useAsync(
    () => api.get<PnlReport>(`/orgs/${org}/reports/pnl`, { date_from: applied.from, date_to: applied.to, granularity: applied.gran, account_id: applied.account || undefined }),
    [org, applied],
  );
  const prev = previousPeriod(applied.from, applied.to);
  const cmp = useAsync(
    () => api.get<PnlReport>(`/orgs/${org}/reports/pnl`, { date_from: prev.from, date_to: prev.to, granularity: "total", account_id: applied.account || undefined }),
    [org, applied, prev.from, prev.to],
    applied.compare,
  );

  const invalid = draft.to < draft.from;
  const dayTooLong = draft.gran === "day" && (Date.parse(draft.to) - Date.parse(draft.from)) / 86400000 + 1 > 62;
  const r = report.data;

  return (
    <>
      <PageHeader title="P&L отчёт" subtitle="Управленческий отчёт о прибылях и убытках. Нажмите на название строки, чтобы увидеть, из чего она сложена" />
      <Card className="filter-card">
        <div className="presets" aria-label="Быстрый выбор периода">
          <span className="muted small">Период:</span>
          {presets().map((p) => <button key={p.id} type="button" className="chip" onClick={() => { const n = { ...draft, from: p.from, to: p.to }; setDraft(n); setApplied(n); }}>{p.label}</button>)}
        </div>
        <form className="filters" onSubmit={(e) => { e.preventDefault(); if (!invalid && !dayTooLong) setApplied(draft); }}>
          <Field label="С"><input type="date" value={draft.from} onChange={(e) => setDraft({ ...draft, from: e.target.value })} required /></Field>
          <Field label="По"><input type="date" value={draft.to} onChange={(e) => setDraft({ ...draft, to: e.target.value })} required /></Field>
          <Field label="Детализация">
            <select value={draft.gran} onChange={(e) => setDraft({ ...draft, gran: e.target.value as Gran })}>
              <option value="month">По месяцам</option><option value="day">По дням</option><option value="total">Итого</option>
            </select>
          </Field>
          <Field label="Маркетплейс / аккаунт">
            <select value={draft.account} onChange={(e) => setDraft({ ...draft, account: e.target.value })}>
              <option value="">Все аккаунты</option>
              {(accounts.data ?? []).map((a) => <option key={a.id} value={a.id}>Wildberries — {a.name}</option>)}
            </select>
          </Field>
          <label className="check"><input type="checkbox" checked={draft.compare} onChange={(e) => setDraft({ ...draft, compare: e.target.checked })} /> Сравнить с предыдущим периодом</label>
          <div className="filters-submit"><Button type="submit" variant="primary" disabled={invalid || dayTooLong}>Применить</Button></div>
        </form>
        {invalid && <Notice kind="error">Дата «По» раньше даты «С»</Notice>}
        {dayTooLong && <Notice kind="warn">Детализация по дням — не более 62 дней</Notice>}
      </Card>

      {report.loading && <Spinner label="Считаем отчёт…" />}
      {report.error && report.errorStatus === 409 && /учётная политика/i.test(report.error) ? (
        <Notice kind="warn">{report.error} <Link to="/settings">Открыть настройки</Link></Notice>
      ) : report.error && <ErrorState message={report.error} onRetry={report.reload} />}

      {r && !report.loading && (
        <>
          {r.coverage.days_with_data === 0 ? (
            <EmptyState title="За выбранный период нет данных" hint="Выберите другой период или подключите аккаунт Wildberries и запустите загрузку.">
              <Link className="btn btn-primary" to="/connections">Перейти к подключениям</Link>
            </EmptyState>
          ) : (
            <Card title={`${formatDate(r.date_from)} — ${formatDate(r.date_to)}, ${r.currency}`} actions={<span className="muted small">Налоговый режим: {r.settings.tax_regime === "usn_income" ? `УСН «доходы» ${trimRate(r.settings.usn_rate)}%` : `ОСНО, налог на прибыль ${trimRate(r.settings.profit_tax_rate)}%`}</span>}>
              {applied.compare && cmp.loading && <Spinner label="Загружаем предыдущий период…" />}
              {applied.compare && cmp.error && <Notice kind="warn">Предыдущий период недоступен: {cmp.error}</Notice>}
              <PnlTable report={r} compare={applied.compare ? cmp.data : null} onDrill={(l) => setDrill(l)} />
              <Quality report={r} />
            </Card>
          )}
        </>
      )}
      {drill && r && <Drilldown orgId={org} line={drill} from={applied.from} to={applied.to} accountId={applied.account} currency={r.currency} onClose={() => setDrill(null)} />}
    </>
  );
}

const PENDING_NAMES: Record<string, string> = {
  rebill_logistics_cost: "возмещение издержек по перевозке",
  rebill_commission_credit: "возмещение издержек (кредит по комиссии)",
  penalty: "штрафы", additional_payment: "доплаты",
};
const pendingName = (k: string) => PENDING_NAMES[k] ?? (k.startsWith("unmapped:") ? `неописанное поле ${k.slice(9)}` : k);
const trimRate = (v: string) => String(Number(v));

export function Quality({ report: r }: { report: PnlReport }) {
  const st = r.quality.transactions_by_status;
  const pending = Object.entries(r.quality.excluded_pending_amounts);
  const bad = (st.inconsistent ?? 0) + (st.unclassified ?? 0);
  const cov = r.coverage;
  return (
    <div className="quality" aria-label="Качество данных">
      <h3>Качество данных</h3>
      <ul>
        <li>Данные есть за {cov.days_with_data} из {cov.days_in_range} дн. периода{cov.missing_days_count > 0 && <> — нет данных за: {cov.missing_days.slice(0, 10).map(formatDate).join(", ")}{cov.missing_days_count > 10 ? "…" : ""}</>}.</li>
        {bad > 0 && <li className="warn-text">{bad} строк отчёта не удалось классифицировать или они не сошлись — итоги помечены «неполно».</li>}
        {(st.review ?? 0) > 0 && <li>{st.review} строк требуют решения по учёту (например, возмещение издержек) — в P&L не входят.</li>}
        {pending.length > 0 && <li>Не включено в P&L: {pending.map(([k, v]) => `${pendingName(k)}: ${formatMoney(v)}`).join("; ")}.</li>}
      </ul>
      <p className="muted small">Источники: «импорт» — отчёт маркетплейса, «вручную» — введено пользователем, «расчёт» — формула. Нажмите на название строки, чтобы увидеть записи.</p>
    </div>
  );
}
