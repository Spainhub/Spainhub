import { FormEvent, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { ApiError } from "../api/client";
import { Button, Field, Notice } from "../components/ui";

export default function LoginPage() {
  const { me, ready, login } = useAuth();
  const nav = useNavigate();
  const loc = useLocation() as { state?: { from?: string } };
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (ready && me) return <Navigate to={loc.state?.from ?? "/"} replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await login(email.trim(), password);
      nav(loc.state?.from ?? "/", { replace: true });
    } catch (err) {
      setError(err instanceof ApiError ? (err.status === 429 ? "Слишком много попыток. Попробуйте позже" : err.message) : "Не удалось войти");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="center-screen">
      <form className="card login" onSubmit={submit} aria-label="Вход">
        <div className="brand brand-lg">WIN<span>SCOMS</span></div>
        <p className="muted">Управленческий P&amp;L для маркетплейсов</p>
        {error && <Notice kind="error">{error}</Notice>}
        <Field label="Email"><input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></Field>
        <Field label="Пароль"><input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
        <Button type="submit" variant="primary" disabled={busy}>{busy ? "Входим…" : "Войти"}</Button>
        <p className="muted small">Доступ выдаёт администратор.</p>
      </form>
    </div>
  );
}
