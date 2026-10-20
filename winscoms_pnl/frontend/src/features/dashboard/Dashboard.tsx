import { useState } from "react";
import { Link } from "react-router-dom";
import { api } from "../../api/client";
import type { CellValue, PnlReport } from "../../api/types";
import { useAuth } from "../../auth/AuthContext";
import { Card, EmptyState, ErrorState, Notice, Spinner } from "../../components/ui";
import { useAsync } from "../../hooks";
import { diff, isNegative, pctChange } from "../../utils/decimal";
import { addDays, daysBetween, formatMoney, formatPercent, isoDate, periodLabel, previousPeriod } from "../../utils/format";
import { PageHeader } from "../../components/PageHeader";
import { presets } from "../pnl/PnlPage";
import SetupChecklist from "./SetupChecklist";

const KPIS: { id: string; title: string; ratio?: boolean; costLike?: boolean }[] = [
  { id: "net_revenue", title: "Чистая выручка" },
  { id: "marketplace_costs", title: "Затраты маркетплейса", costLike: true },
  { id: "cogs", title: "Себестоимость", costLike: true },
  { id: "gross_profit", title: "Валовая прибыль" },
  { id: "operating_profit", title: "Операционная прибыль" },
  { id: "net_profit", title: "Чистая прибыль" },
  { id: "net_margin", title: "Чистая маржа", ratio: true },
];

const cell = (r: PnlReport | null, id: string): CellValue | undefined => r?.lines.find((l) => l.id === id)?.values["total"];

function reason(c: CellValue | undefined): string {
  if (!c) return "Нет данных";
  if (c.status === "missing") return "Нет данных за период";
  return c.notes[0] ?? "Недостаточно данных для расчёта";
}

export function Kpi({ title, now, before, ratio, costLike }: { title: string; now: CellValue | undefined; before: CellValue | undefined; ratio?: boolean; costLike?: boolean }) {
  const ok = now && now.value !== null && now.status !== "missing" && now.status !== "blocked";
  const d = ok && before?.value != null ? diff(now!.value, before.value) : null;
  const pc = ok && before?.value != null && !ratio ? pctChange(now!.value, before.value) : null;
  const good = d !== null && (costLike ? isNegative(d) : !isNegative(d));
  return (
    <div className="kpi" data-testid={`kpi-${title}`}>
      <div className="kpi-title">{title}</div>
      {ok ? (
        <>
          <div className={`kpi-value ${isNegative(now!.value) ? "neg" : ""}`}>{ratio ? formatPercent(now!.value) : formatMoney(now!.value, { decimals: 0 })}{!ratio && <small> ₽</small>}</div>
          {now!.status === "incomplete" && <div className="kpi-note warn-text">Данные неполные</div>}
          {pc !== null && d !== null && d !== "0.000000" && <div className={`kpi-delta ${good ? "good" : "bad"}`}>{isNegative(pc) ? "" : "+"}{formatPercent(pc)} к предыдущему периоду</div>}
          {ratio && d !== null && <div className="kpi-delta muted">{isNegative(d) ? "" : "+"}{formatMoney(d)} п.п. к предыдущему</div>}
        </>
      ) : (
        <>
          <div className="kpi-value muted">—</div>
          <div className="kpi-note">{reason(now)}</div>
          {now?.status === "blocked" && now.preliminary !== null && <div className="kpi-note muted">Предварительно: {formatMoney(now.preliminary, { decimals: 0 })} ₽</div>}
        </>
      )}
    </div>
  );
}

export function Bars({ report }: { report: PnlReport }) {
  const rev = report.lines.find((l) => l.id === "net_revenue");
  const prof = report.lines.find((l) => l.id === "gross_profit");
  const months = report.periods.filter((p) => p !== "total");
  const val = (l: typeof rev, p: string) => { const v = l?.values[p]; return v && v.value !== null ? Number(v.value) : null; };
  const max = Math.max(1, ...months.map((p) => Math.abs(val(rev, p) ?? 0)));
  return (
    <svg className="bars" viewBox={`0 0 ${months.length * 90} 150`} role="img" aria-label="Чистая выручка и валовая прибыль по месяцам" preserveAspectRatio="xMidYMid meet">
      {months.map((p, i) => {
        const r = val(rev, p), g = val(prof, p);
        const h = (v: number | null) => (v === null ? 0 : Math.max(2, (Math.abs(v) / max) * 100));
        return (
          <g key={p} transform={`translate(${i * 90 + 10},0)`}>
            <title>{`${periodLabel(p)}: выручка ${r === null ? "нет данных" : formatMoney(String(r), { decimals: 0 })}, валовая ${g === null ? "нет данных" : formatMoney(String(g), { decimals: 0 })}`}</title>
            {r !== null && <rect x="0" y={110 - h(r)} width="30" height={h(r)} className="bar-rev" />}
            {g !== null && <rect x="34" y={110 - h(g)} width="30" height={h(g)} className="bar-profit" />}
            {r === null && <text x="0" y="100" className="bar-na">нет данных</text>}
            <text x="32" y="130" textAnchor="middle" className="bar-label">{periodLabel(p)}</text>
          </g>
        );
      })}
    </svg>
  );
}

export default function Dashboard() {
  const { orgId } = useAuth();
  const org = orgId!;
  const ps = presets();
  const last30 = { id: "30", label: "Последние 30 дней", from: addDays(isoDate(new Date()), -29), to: isoDate(new Date()) };
  const options = [last30, ...ps];
  const [sel, setSel] = useState(last30.id);
  const cur = options.find((o) => o.id === sel)!;
  const prev = previousPeriod(cur.from, cur.to);
  const six = (() => { const t = new Date(); return { from: isoDate(new Date(t.getFullYear(), t.getMonth() - 5, 1)), to: isoDate(t) }; })();

  const a = useAsync(() => api.get<PnlReport>(`/orgs/${org}/reports/pnl`, { date_from: cur.from, date_to: cur.to, granularity: "total" }), [org, sel]);
  const b = useAsync(() => api.get<PnlReport>(`/orgs/${org}/reports/pnl`, { date_from: prev.from, date_to: prev.to, granularity: "total" }), [org, sel], !!a.data);
  const c = useAsync(() => api.get<PnlReport>(`/orgs/${org}/reports/pnl`, { date_from: six.from, date_to: six.to, granularity: "month" }), [org], !!a.data);

  const noSettings = a.errorStatus === 409;
  const anyBlocked = a.data && KPIS.some((k) => ["blocked", "missing"].includes(cell(a.data, k.id)?.status ?? ""));
  return (
    <>
      <PageHeader title="Дашборд" subtitle="Ключевые показатели за выбранный период в сравнении с предыдущим"
        actions={<select aria-label="Период" value={sel} onChange={(e) => setSel(e.target.value)}>{options.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}</select>} />
      <SetupChecklist org={org} />
      {a.loading && <Spinner />}
      {a.error && !noSettings && <ErrorState message={a.error} onRetry={a.reload} />}
      {a.data && a.data.coverage.days_with_data === 0 && (
        <EmptyState title="За выбранный период нет данных" hint="Выберите другой период или загрузите отчёты Wildberries."><Link className="btn btn-secondary" to="/connections">Перейти к подключениям</Link></EmptyState>
      )}
      {a.data && a.data.coverage.days_with_data > 0 && (
        <>
          {anyBlocked && <Notice kind="warn">Часть показателей не рассчитана: не хватает данных (себестоимость, расходы). Они показаны как «—» с причиной — подставлять нули мы не будем. <Link to="/expenses">Заполнить</Link></Notice>}
          <div className="kpis">{KPIS.map((k) => <Kpi key={k.id} title={k.title} now={cell(a.data, k.id)} before={cell(b.data, k.id)} ratio={k.ratio} costLike={k.costLike} />)}</div>
          <Card title="Динамика по месяцам" actions={<span className="legend"><i className="sw rev" /> выручка <i className="sw profit" /> валовая прибыль</span>}>
            {c.loading ? <Spinner /> : c.data ? <Bars report={c.data} /> : <p className="muted">{c.error}</p>}
          </Card>
          <p className="muted small">Период: {cur.from} — {cur.to} ({daysBetween(cur.from, cur.to) + 1} дн.), сравнение с {prev.from} — {prev.to}. Подробности — в <Link to="/pnl">P&L отчёте</Link>.</p>
        </>
      )}
    </>
  );
}
