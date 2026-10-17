import { useEffect, useState } from "react";

type Status = "loading" | "ok" | "down";

export function App() {
  const [status, setStatus] = useState<Status>("loading");

  useEffect(() => {
    fetch("/api/v1/health/ready")
      .then((r) => setStatus(r.ok ? "ok" : "down"))
      .catch(() => setStatus("down"));
  }, []);

  const label = { loading: "Проверка…", ok: "Сервер работает", down: "Сервер недоступен" }[status];

  return (
    <main className="page">
      <h1>WIN<span className="accent">SCOMS</span></h1>
      <p>Управленческий P&amp;L для маркетплейсов</p>
      <p className={`status status-${status}`}>{label}</p>
    </main>
  );
}
