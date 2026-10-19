import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError } from "./api/client";

export interface AsyncState<T> { data: T | null; error: string | null; errorStatus: number | null; loading: boolean; reload: () => void }

/** Загрузка данных с состояниями loading/error. Устаревшие ответы (гонка запросов) игнорируются. */
export function useAsync<T>(fn: () => Promise<T>, deps: unknown[], enabled = true): AsyncState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [loading, setLoading] = useState(enabled);
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const run = useCallback(fn, deps);

  useEffect(() => {
    if (!enabled) { setLoading(false); return; }
    const id = ++seq.current;
    setLoading(true);
    setError(null);
    setErrorStatus(null);
    run().then(
      (d) => { if (id === seq.current) { setData(d); setLoading(false); } },
      (e) => { if (id === seq.current) { setError(e instanceof ApiError ? e.message : "Неожиданная ошибка"); setErrorStatus(e instanceof ApiError ? e.status : null); setData(null); setLoading(false); } },
    );
  }, [run, tick, enabled]);

  return { data, error, errorStatus, loading, reload: () => setTick((t) => t + 1) };
}
