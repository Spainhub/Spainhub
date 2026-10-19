import { CSSProperties, useMemo, useState } from "react";
import type { CellValue, PnlLine, PnlReport } from "../../api/types";
import { Badge } from "../../components/ui";
import { diff, isNegative, pctChange } from "../../utils/decimal";
import { formatMoney, formatPercent, periodLabel } from "../../utils/format";

const SOURCE: Record<string, string> = { imported: "импорт", manual: "вручную", cogs: "расчёт", formula: "расчёт", group: "расчёт", tax: "расчёт", ratio: "расчёт" };
const DRILLABLE = new Set(["imported", "manual", "cogs"]);
const isRatio = (l: PnlLine) => l.kind === "ratio";

export function Cell({ cell, ratio }: { cell: CellValue | undefined; ratio?: boolean }) {
  if (!cell) return <span className="muted">—</span>;
  const fmt = ratio ? formatPercent : formatMoney;
  switch (cell.status) {
    case "header": return null;
    case "missing": return <span className="cell-missing" title={cell.notes.join("\n")}>нет данных</span>;
    case "blocked":
      return (
        <span className="cell-blocked" title={cell.notes.join("\n")}>
          —{cell.preliminary !== null && <small className="muted"> ≈ {fmt(cell.preliminary)} предв.</small>}
        </span>
      );
    case "not_applicable": return <span className="muted" title={cell.notes.join("\n")}>—</span>;
    default:
      return (
        <span className={isNegative(cell.value) ? "neg" : ""} title={cell.notes.join("\n") || undefined}>
          {fmt(cell.value)}
          {cell.status === "incomplete" && <Badge tone="warn" title={cell.notes.join("\n") || "Данные неполные"}>неполно</Badge>}
        </span>
      );
  }
}

interface Props {
  report: PnlReport;
  compare?: PnlReport | null;
  onDrill: (line: PnlLine, period: string) => void;
}

export default function PnlTable({ report, compare, onDrill }: Props) {
  const parents = useMemo(() => new Set(report.lines.map((l) => l.parent).filter(Boolean) as string[]), [report]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const byId = useMemo(() => new Map(report.lines.map((l) => [l.id, l])), [report]);

  const visible = report.lines.filter((l) => {
    let p = l.parent;
    while (p) {
      if (collapsed.has(p)) return false;
      p = byId.get(p)?.parent ?? null;
    }
    return true;
  });
  const toggle = (id: string) => setCollapsed((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const allIds = [...parents];

  return (
    <div className="table-wrap" role="region" aria-label="Таблица P&L" tabIndex={0}>
      <div className="table-tools">
        <button className="link-btn" onClick={() => setCollapsed(new Set())}>Развернуть всё</button>
        <button className="link-btn" onClick={() => setCollapsed(new Set(allIds))}>Свернуть всё</button>
      </div>
      <table className="pnl">
        <thead>
          <tr>
            <th className="sticky-col">Статья</th>
            <th className="col-source">Источник</th>
            {report.periods.map((p) => <th key={p} className="num">{periodLabel(p)}</th>)}
            {compare && <><th className="num">Пред. период</th><th className="num">Δ</th><th className="num">Δ, %</th></>}
          </tr>
        </thead>
        <tbody>
          {visible.map((l) => {
            const expandable = parents.has(l.id);
            const isOpen = !collapsed.has(l.id);
            const drill = DRILLABLE.has(l.kind);
            const subtotal = l.kind === "formula" || l.kind === "group";
            const header = l.kind === "header";
            const ratio = isRatio(l);
            const cmpCell = compare?.lines.find((x) => x.id === l.id)?.values["total"];
            const cur = l.values["total"];
            const d = diff(cur?.value ?? null, cmpCell?.value ?? null);
            const pc = pctChange(cur?.value ?? null, cmpCell?.value ?? null);
            return (
              <tr key={l.id} className={`${subtotal ? "row-subtotal" : ""} ${header ? "row-header" : ""} ${l.memo ? "row-memo" : ""} level-${Math.min(l.level, 3)}`} data-line={l.id}>
                <th scope="row" className="sticky-col" style={{ "--lvl": l.level } as CSSProperties}>
                  {expandable ? (
                    <button className="toggle" aria-expanded={isOpen} aria-label={`${isOpen ? "Свернуть" : "Развернуть"} ${l.name}`} onClick={() => toggle(l.id)}>{isOpen ? "▾" : "▸"}</button>
                  ) : <span className="toggle-spacer" />}
                  {drill ? <button className="link-btn name-btn" onClick={() => onDrill(l, "total")} title="Показать состав строки">{l.name}</button> : <span title={l.note ?? undefined}>{l.name}</span>}
                </th>
                <td className="col-source">{header ? "" : <span className="tag">{SOURCE[l.kind] ?? l.kind}</span>}</td>
                {report.periods.map((p) => (
                  <td key={p} className="num">{header ? null : <Cell cell={l.values[p]} ratio={ratio} />}</td>
                ))}
                {compare && (
                  <>
                    <td className="num">{header ? null : <Cell cell={cmpCell} ratio={ratio} />}</td>
                    <td className={`num ${isNegative(d) ? "neg" : ""}`}>{header || d === null ? "" : formatMoney(d)}</td>
                    <td className={`num ${isNegative(pc) ? "neg" : ""}`}>{header || pc === null ? "" : formatPercent(pc)}</td>
                  </>
                )}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
