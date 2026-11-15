"use client";

import type { CSSProperties, ReactNode } from "react";
import { RISK_COLORS, type RiskBucket } from "@/lib/risk";

export function Panel({
  title,
  hint,
  action,
  children,
  className,
}: {
  title?: string;
  hint?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`section ${className ?? ""}`}>
      {title ? (
        <div className="section-head">
          <h3 className="section-title">{title}</h3>
          {action ?? (hint ? <span className="section-hint">{hint}</span> : null)}
        </div>
      ) : null}
      {children}
    </section>
  );
}

export function Stat({
  label,
  value,
  unit,
  cite,
}: {
  label: string;
  value: string;
  unit?: string;
  cite?: ReactNode;
}) {
  return (
    <div className="kpi">
      <span className="kpi-label">
        {label}
        {cite ? <span className="kpi-cite">{cite}</span> : null}
      </span>
      <span className="kpi-value">
        {value}
        {unit ? <span className="kpi-unit">{unit}</span> : null}
      </span>
    </div>
  );
}

export function RiskPill({
  bucket,
  score,
  large,
}: {
  bucket: RiskBucket;
  score?: number;
  large?: boolean;
}) {
  return (
    <span
      className={`riskpill ${large ? "is-lg" : ""}`}
      style={{ "--c": RISK_COLORS[bucket] } as CSSProperties}
    >
      <i aria-hidden />
      {bucket}
      {typeof score === "number" ? <span className="score">{score.toFixed(1)}</span> : null}
    </span>
  );
}

export function Sparkline({
  values,
  color = "#38D6C4",
  height = 38,
}: {
  values: number[];
  color?: string;
  height?: number;
}) {
  if (values.length < 2) return null;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const pts = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * 100;
      const y = 94 - ((v - min) / range) * 84;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");

  return (
    <svg
      className="spark"
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      style={{ height }}
      role="img"
      aria-label="24 hour draw profile"
    >
      <polyline
        points={pts}
        fill="none"
        stroke={color}
        strokeWidth="1.6"
        strokeLinejoin="round"
        strokeLinecap="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  options: { id: T; label: string }[];
  value: T;
  onChange: (id: T) => void;
  label: string;
}) {
  return (
    <div className="segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          data-active={option.id === value}
          aria-pressed={option.id === value}
          onClick={() => onChange(option.id)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
