import type { ReconcileStatus } from "@/research/etl/reconcile";

/** Reconciliation outcome a citation can display next to its chip. */
export interface ReconciliationMark {
  status: ReconcileStatus;
  /** Policy id the outcome comes from. */
  policy?: string;
  /** Why the pair is incomparable, conflicting or within tolerance. */
  reason?: string | null;
}

const LABEL: Record<ReconcileStatus, string> = {
  agreement: "agreement",
  within_tolerance: "within tolerance",
  conflict: "conflict",
  incomparable: "incomparable",
};

const COLOR: Record<ReconcileStatus, string> = {
  agreement: "var(--ok)",
  within_tolerance: "var(--accent-2)",
  conflict: "var(--critical)",
  incomparable: "var(--muted)",
};

const SYMBOL: Record<ReconcileStatus, string> = {
  agreement: "=",
  within_tolerance: "≈",
  conflict: "≠",
  incomparable: "⊘",
};

const VISUALLY_HIDDEN = {
  position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap",
} as const;

/**
 * Provider reconciliation status. The text label carries the meaning; colour
 * only reinforces it.
 */
export function ReconciliationBadge({ status, policy, reason }: ReconciliationMark) {
  const label = LABEL[status];
  const description = `Provider reconciliation: ${label}${policy ? ` (${policy})` : ""}${reason ? `. ${reason}` : ""}`;
  return (
    <span
      className={`reconciliation-badge reconciliation-${status}`}
      data-status={status}
      title={description}
      style={{
        display: "inline-block",
        marginInlineStart: "0.35em",
        padding: "0 0.45em",
        border: `1px solid ${COLOR[status]}`,
        borderRadius: "var(--radius-sm)",
        color: COLOR[status],
        font: "inherit",
        fontSize: "0.75em",
        lineHeight: 1.6,
        whiteSpace: "nowrap",
      }}
    >
      <span aria-hidden="true">{SYMBOL[status]} </span>
      <span style={VISUALLY_HIDDEN}>Provider reconciliation: </span>
      {label}
    </span>
  );
}
