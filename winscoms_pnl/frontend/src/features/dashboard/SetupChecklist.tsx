import { Link } from "react-router-dom";
import { api } from "../../api/client";
import type { Cost, ManualEntry, OrgSettings, SellerAccount } from "../../api/types";
import { useAuth } from "../../auth/AuthContext";
import { useAsync } from "../../hooks";

export interface Step { id: string; title: string; hint: string; to: string; cta: string; done: boolean }

export function useSetupSteps(org: string) {
  return useAsync(async (): Promise<Step[]> => {
    const [settings, accounts, costs, manual] = await Promise.allSettled([
      api.get<OrgSettings | null>(`/orgs/${org}/settings`),
      api.get<SellerAccount[]>(`/orgs/${org}/seller-accounts`),
      api.get<Cost[]>(`/orgs/${org}/costs`, { limit: 1 }),
      api.get<ManualEntry[]>(`/orgs/${org}/manual-entries`, { limit: 1 }),
    ]);
    const ok = <T,>(r: PromiseSettledResult<T>): T | null => (r.status === "fulfilled" ? r.value : null);
    const acc = ok(accounts) ?? [];
    return [
      { id: "tax", title: "Выберите налоговый режим", hint: "УСН «доходы» или ОСНО — от этого зависят налоги и НДС в отчёте.", to: "/settings", cta: "Открыть настройки", done: !!ok(settings) },
      { id: "wb", title: "Подключите Wildberries", hint: "Добавьте API-токен с доступом к категории «Финансы» и проверьте подключение.", to: "/connections", cta: "Подключить", done: acc.length > 0 },
      { id: "sync", title: "Загрузите данные за 3 месяца", hint: "Загрузка идёт в фоне: лимит Wildberries — 1 запрос в минуту.", to: "/connections", cta: "Запустить загрузку", done: acc.some((a) => !!a.last_sync_at) },
      { id: "costs", title: "Добавьте себестоимость товаров", hint: "Скачайте Excel-шаблон, заполните цены и загрузите — без этого прибыль не считается.", to: "/expenses?tab=costs", cta: "Загрузить себестоимость", done: (ok(costs)?.length ?? 0) > 0 },
      { id: "opex", title: "Подтвердите расходы", hint: "Добавьте зарплаты, подписки, внешнюю рекламу — или запись с суммой 0, если расходов нет.", to: "/expenses", cta: "Добавить расходы", done: (ok(manual)?.length ?? 0) > 0 },
    ];
  }, [org]);
}

export default function SetupChecklist({ org }: { org: string }) {
  const { canWrite } = useAuth();
  const q = useSetupSteps(org);
  const steps = q.data;
  if (!steps || steps.every((s) => s.done)) return null;
  const done = steps.filter((s) => s.done).length;
  const next = steps.find((s) => !s.done)!;
  return (
    <section className="setup card" aria-label="Начало работы">
      <header className="card-head">
        <h2>Начало работы</h2>
        <span className="muted small">Выполнено {done} из {steps.length}</span>
      </header>
      <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={steps.length} aria-valuenow={done}><span style={{ width: `${(done / steps.length) * 100}%` }} /></div>
      <ol className="setup-steps">
        {steps.map((s) => (
          <li key={s.id} className={`${s.done ? "done" : ""} ${s.id === next.id ? "current" : ""}`}>
            <span className="check-mark" aria-hidden>{s.done ? "✓" : ""}</span>
            <div className="step-body"><div className="step-title">{s.title}</div>{!s.done && <div className="muted small">{s.hint}</div>}</div>
            {!s.done && canWrite && <Link className={`btn ${s.id === next.id ? "btn-primary" : "btn-secondary"}`} to={s.to}>{s.cta}</Link>}
          </li>
        ))}
      </ol>
    </section>
  );
}
