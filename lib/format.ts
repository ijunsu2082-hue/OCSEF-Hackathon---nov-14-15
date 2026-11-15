export function fmtNumber(value: number, digits = 0): string {
  if (!Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export function fmtMW(value: number, digits = 1): string {
  return fmtNumber(value, digits);
}

export function compact(value: number, digits = 1): string {
  if (!Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${fmtNumber(value / 1_000_000_000, digits)}B`;
  if (abs >= 1_000_000) return `${fmtNumber(value / 1_000_000, digits)}M`;
  if (abs >= 10_000) return `${fmtNumber(value / 1_000, 0)}k`;
  if (abs >= 1_000) return `${fmtNumber(value / 1_000, digits)}k`;
  return fmtNumber(value, 0);
}

export function compactUSD(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs >= 1_000_000) return `${sign}$${fmtNumber(abs / 1_000_000, 2)}M`;
  if (abs >= 1_000) return `${sign}$${fmtNumber(abs / 1_000, 0)}k`;
  return `${sign}$${fmtNumber(abs, 0)}`;
}

export function fmtYears(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "n/a";
  return `${fmtNumber(value, 1)} yr`;
}

export function fmtPercent(value: number, digits = 0): string {
  return `${fmtNumber(value, digits)}%`;
}

export function fmtDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
