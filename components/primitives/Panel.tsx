import type { ReactNode } from "react";
import { cx } from "./cx";

export interface PanelProps {
  /** Small uppercase label above the title. */
  eyebrow?: string;
  title?: ReactNode;
  /** Right-aligned controls (toggles, links). */
  actions?: ReactNode;
  children?: ReactNode;
  /** Remove inner padding when the child is a chart or a table. */
  flush?: boolean;
  className?: string;
}

/**
 * The only card surface in the app. Everything else nests inside a Panel.
 * Stub-complete: safe to import before Dev 1's globals.css exists.
 */
export function Panel({ eyebrow, title, actions, children, flush = false, className }: PanelProps) {
  const hasHeader = Boolean(eyebrow || title || actions);

  return (
    <section
      className={cx("relative overflow-hidden rounded-[var(--radius-md)] border", className)}
      style={{ background: "var(--panel)", borderColor: "var(--border)", boxShadow: "var(--shadow-panel)" }}
    >
      {hasHeader && (
        <header
          className="flex items-start justify-between gap-3 border-b px-3 py-2"
          style={{ borderColor: "var(--border)" }}
        >
          <div className="min-w-0">
            {eyebrow && (
              <p
                className="font-mono text-[10px] uppercase tracking-[0.14em]"
                style={{ color: "var(--muted)" }}
              >
                {eyebrow}
              </p>
            )}
            {title && (
              <h2 className="truncate text-[13px] font-semibold" style={{ color: "var(--text)" }}>
                {title}
              </h2>
            )}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={flush ? "" : "px-3 py-3"}>{children}</div>
    </section>
  );
}
