// Точная арифметика для сумм (строки Decimal) без float: масштаб 1e6.
const SCALE = 6;
export function toUnits(v: string | null | undefined): bigint | null {
  if (v === null || v === undefined) return null;
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(v.trim());
  if (!m) return null;
  const frac = (m[3] ?? "").padEnd(SCALE, "0").slice(0, SCALE);
  const n = BigInt(m[2] + frac);
  return m[1] ? -n : n;
}
export function fromUnits(n: bigint): string {
  const neg = n < 0n;
  const s = (neg ? -n : n).toString().padStart(SCALE + 1, "0");
  return `${neg ? "-" : ""}${s.slice(0, s.length - SCALE)}.${s.slice(s.length - SCALE)}`;
}
export function diff(a: string | null, b: string | null): string | null {
  const x = toUnits(a), y = toUnits(b);
  return x === null || y === null ? null : fromUnits(x - y);
}
/** Изменение a относительно b в процентах (строка) или null, если b = 0/нет данных. */
export function pctChange(a: string | null, b: string | null): string | null {
  const x = toUnits(a), y = toUnits(b);
  if (x === null || y === null || y === 0n) return null;
  const abs = y < 0n ? -y : y;
  const scaled = ((x - y) * 10000n) / abs;          // сотые доли процента
  return (Number(scaled) / 100).toFixed(2);
}
export function isNegative(v: string | null): boolean { return !!v && v.trim().startsWith("-") && toUnits(v) !== 0n; }
