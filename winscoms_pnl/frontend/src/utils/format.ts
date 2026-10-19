// Деньги приходят строками (Decimal). Форматируем без перевода в float, чтобы не терять точность.
const NBSP = " ";
const MINUS = "−";

export function formatMoney(value: string | null | undefined, opts: { decimals?: number } = {}): string {
  if (value === null || value === undefined || value === "") return "—";
  const decimals = opts.decimals ?? 2;
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!m) return "—";
  const [, sign, intPart, frac = ""] = m;
  let int = intPart;
  let fr = frac.padEnd(decimals, "0").slice(0, decimals);
  // округление half-up по первому отброшенному знаку
  if (frac.length > decimals && frac[decimals] >= "5") {
    const n = BigInt(int + fr) + 1n;
    const s = n.toString().padStart(decimals + 1, "0");
    int = s.slice(0, s.length - decimals);
    fr = s.slice(s.length - decimals);
  }
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
  const isZero = /^0*$/.test(int + fr);
  const body = decimals > 0 ? `${grouped},${fr}` : grouped;
  return `${sign && !isZero ? MINUS : ""}${body}`;
}

export function formatPercent(value: string | null | undefined): string {
  const v = formatMoney(value);
  return v === "—" ? v : `${v}${NBSP}%`;
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}.${m}.${y}`;
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString("ru-RU", { timeZone: "Europe/Moscow", dateStyle: "short", timeStyle: "short" });
}

export function isoDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}

/** Предыдущий период той же длины, заканчивающийся накануне начала текущего. */
export function previousPeriod(from: string, to: string): { from: string; to: string } {
  const len = daysBetween(from, to) + 1;
  return { from: addDays(from, -len), to: addDays(from, -1) };
}

export function periodLabel(key: string): string {
  if (key === "total") return "Итого";
  if (/^\d{4}-\d{2}$/.test(key)) {
    const [y, m] = key.split("-");
    const names = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
    return `${names[Number(m) - 1]} ${y}`;
  }
  return formatDate(key).slice(0, 5);
}
