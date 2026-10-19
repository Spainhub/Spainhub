import { useState } from "react";
import { api } from "../../api/client";
import type { DrilldownResponse, PnlLine } from "../../api/types";
import { Button, EmptyState, ErrorState, Modal, Spinner } from "../../components/ui";
import { useAsync } from "../../hooks";
import { formatDate, formatMoney } from "../../utils/format";

const PAGE = 100;
type Row = Record<string, unknown>;
const s = (v: unknown) => (v === null || v === undefined ? "" : String(v));

export default function Drilldown({ orgId, line, from, to, accountId, currency, onClose }: {
  orgId: string; line: PnlLine; from: string; to: string; accountId: string; currency: string; onClose: () => void;
}) {
  const [offset, setOffset] = useState(0);
  const [items, setItems] = useState<Row[]>([]);
  const q = useAsync(async () => {
    const r = await api.get<DrilldownResponse>(`/orgs/${orgId}/reports/pnl/drilldown`, {
      line: line.id, date_from: from, date_to: to, account_id: accountId || undefined, currency, limit: PAGE, offset,
    });
    setItems((prev) => (offset === 0 ? r.items : [...prev, ...r.items]));
    return r;
  }, [orgId, line.id, from, to, accountId, currency, offset]);

  const kind = q.data?.kind;
  return (
    <Modal title={`Состав строки: ${line.name}`} onClose={onClose} wide>
      <p className="muted small">Период {formatDate(from)} — {formatDate(to)}. Каждая сумма в отчёте складывается из этих записей.</p>
      {q.error && <ErrorState message={q.error} onRetry={q.reload} />}
      {q.loading && items.length === 0 && <Spinner />}
      {!q.loading && !q.error && items.length === 0 && <EmptyState title="За период нет записей" />}
      {items.length > 0 && (
        <div className="table-wrap">
          <table className="plain">
            <thead>
              {kind === "import" && <tr><th>Дата</th><th>rrdId</th><th>Операция</th><th>Детали</th><th>Артикул</th><th className="num">Сумма</th></tr>}
              {kind === "manual" && <tr><th>Дата</th><th>Описание</th><th className="num">Сумма</th></tr>}
              {kind === "cogs" && <tr><th>Дата</th><th>rrdId</th><th>nmId</th><th>Артикул</th><th className="num">Шт.</th><th className="num">Цена ед.</th><th className="num">Итого</th></tr>}
            </thead>
            <tbody>
              {items.map((r, i) => (
                <tr key={i}>
                  {kind === "import" && <><td>{formatDate(s(r.entry_date))}</td><td>{s(r.source_id)}</td><td>{s(r.source_operation)}</td><td>{s(r.bonus_type) || s(r.line_type)}</td><td>{s(r.vendor_code)}</td><td className="num">{formatMoney(s(r.amount))}</td></>}
                  {kind === "manual" && <><td>{formatDate(s(r.entry_date))}</td><td>{s(r.description)}</td><td className="num">{formatMoney(s(r.amount))}</td></>}
                  {kind === "cogs" && <>
                    <td>{formatDate(s(r.entry_date))}</td><td>{s(r.source_id)}</td><td>{s(r.nm_id)}</td><td>{s(r.vendor_code)}</td><td className="num">{s(r.quantity)}</td>
                    <td className="num">{r.cost_per_unit ? formatMoney(s(r.cost_per_unit)) : <span className="cell-missing">нет цены</span>}</td>
                    <td className="num">{r.cogs ? formatMoney(s(r.cogs)) : "—"}</td>
                  </>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(q.data?.items.length ?? 0) === PAGE && <div className="center"><Button onClick={() => setOffset(offset + PAGE)} disabled={q.loading}>Показать ещё</Button></div>}
    </Modal>
  );
}
