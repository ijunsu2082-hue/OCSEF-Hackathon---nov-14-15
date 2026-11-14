import { cx } from "./cx";

export type RiskLevel = "LOW" | "WATCH" | "HIGH" | "CRITICAL";

const LEVEL_CLASS: Record<RiskLevel, string> = {
  LOW: "pill-low",
  WATCH: "pill-watch",
  HIGH: "pill-high",
  CRITICAL: "pill-critical",
};

export interface RiskPillProps {
  level: RiskLevel;
  /** 0–100 risk score; rendered after the label when provided. */
  score?: number;
  className?: string;
}

/**
 * Risk is always text + dot + color, never color alone.
 * The level is passed in — this component does not compute scores (that is lib/risk.ts).
 */
export function RiskPill({ level, score, className }: RiskPillProps) {
  return (
    <span className={cx("pill", LEVEL_CLASS[level], className)} title={`Energy risk: ${level}`}>
      {level}
      {typeof score === "number" && <span className="num opacity-70">{Math.round(score)}</span>}
    </span>
  );
}
