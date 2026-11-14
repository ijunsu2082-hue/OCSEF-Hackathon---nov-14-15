import type { CSSProperties, ReactNode } from "react";
import { cx } from "@/components/primitives";

export type SrcKind = "EIA-860" | "OSM" | "MODELED" | "MEASURED" | "LIVE";

const SRC_STYLE: Record<SrcKind, { color: string; border: string }> = {
  "EIA-860": { color: "var(--text-dim)", border: "var(--border-strong)" },
  OSM: { color: "var(--text-dim)", border: "var(--border-strong)" },
  MEASURED: { color: "var(--ok)", border: "color-mix(in srgb, var(--ok) 40%, transparent)" },
  MODELED: { color: "var(--warn)", border: "color-mix(in srgb, var(--warn) 40%, transparent)" },
  LIVE: { color: "var(--accent)", border: "color-mix(in srgb, var(--accent) 45%, transparent)" },
};

/** Tiny provenance tag that rides next to every number. */
export function SrcTag({ kind, className }: { kind: SrcKind; className?: string }) {
  const s = SRC_STYLE[kind];
  return (
    <span
      className={cx(
        "inline-flex shrink-0 items-center rounded-[3px] border px-1 font-mono text-[8.5px] font-semibold uppercase leading-[14px] tracking-[0.1em]",
        className,
      )}
      style={{ color: s.color, borderColor: s.border }}
    >
      {kind}
    </span>
  );
}

/** Numbered section heading inside the drawer. */
export function SectionHead({ index, title, aside }: { index: string; title: string; aside?: ReactNode }) {
  return (
    <div className="mb-2 flex items-baseline justify-between gap-3">
      <h3 className="flex items-baseline gap-2 font-mono text-[10.5px] font-semibold uppercase tracking-[0.16em] text-ink-dim">
        <span className="text-accent">{index}</span>
        {title}
      </h3>
      {aside && <div className="shrink-0 text-[10px] text-muted">{aside}</div>}
    </div>
  );
}

/** Card used by the six "What's here" tiles. */
export function Tile({
  title,
  tag,
  wide,
  children,
}: {
  title: string;
  tag?: ReactNode;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      className={cx(
        "flex min-w-0 flex-col gap-2 rounded-[var(--radius-sm)] border border-line bg-panel-raised p-3",
        wide && "sm:col-span-2",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <h4 className="text-[12px] font-semibold leading-tight text-ink">{title}</h4>
        {tag}
      </div>
      {children}
    </div>
  );
}

/** Label / value row with a provenance tag. */
export function Metric({
  label,
  value,
  unit,
  src,
  tone,
}: {
  label: string;
  value: ReactNode;
  unit?: string;
  src?: SrcKind;
  tone?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-2 text-[11.5px]">
      <span className="min-w-0 leading-tight text-ink-dim">{label}</span>
      <span className="flex shrink-0 items-baseline gap-1.5">
        <span className="num font-semibold" style={{ color: tone ?? "var(--text)" }}>
          {value}
        </span>
        {unit && <span className="num text-[10px] text-muted">{unit}</span>}
        {src && <SrcTag kind={src} />}
      </span>
    </div>
  );
}

/** Static shimmer block (opacity pulse only; no glow). */
export function Shimmer({ className, style }: { className?: string; style?: CSSProperties }) {
  return <div className={cx("animate-pulse rounded-[var(--radius-sm)] bg-panel-raised", className)} style={style} aria-hidden />;
}
