import type { ReactNode } from "react";
import { cx } from "./cx";

export type StatTone = "default" | "accent" | "warn" | "critical" | "ok";
export type StatSize = "sm" | "md" | "lg";

export interface StatProps {
  label: string;
  value: ReactNode;
  unit?: string;
  /** Secondary line: comparison, timestamp, or caveat. */
  hint?: ReactNode;
  tone?: StatTone;
  size?: StatSize;
  className?: string;
}

const TONE_VAR: Record<StatTone, string> = {
  default: "var(--text)",
  accent: "var(--accent)",
  warn: "var(--warn)",
  critical: "var(--critical)",
  ok: "var(--ok)",
};

const VALUE_SIZE: Record<StatSize, string> = {
  sm: "text-[17px]",
  md: "text-[22px]",
  lg: "text-[28px]",
};

/**
 * KPI block: label above, value dominant, unit muted, hint underneath.
 * Numbers use tabular figures so values don't jitter as they update.
 */
export function Stat({ label, value, unit, hint, tone = "default", size = "md", className }: StatProps) {
  return (
    <div className={cx("flex min-w-0 flex-col gap-0.5", className)}>
      <span
        className="font-mono text-[9.5px] uppercase leading-tight tracking-[0.14em]"
        style={{ color: "var(--muted)" }}
      >
        {label}
      </span>
      <span className="flex items-baseline gap-1">
        <span
          className={cx("num font-semibold leading-none tracking-tight", VALUE_SIZE[size])}
          style={{ color: TONE_VAR[tone] }}
        >
          {value}
        </span>
        {unit && (
          <span className="num text-[10px] font-medium" style={{ color: "var(--muted)" }}>
            {unit}
          </span>
        )}
      </span>
      {hint && (
        <span className="num truncate text-[10px] leading-tight" style={{ color: "var(--muted)" }}>
          {hint}
        </span>
      )}
    </div>
  );
}
