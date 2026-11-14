import type { ReactNode } from "react";

/*
 * Plain building blocks for the scan panel. Colors are the shared light palette
 * (lib/scan/colors.ts UI): text #1d2733, secondary #556070, tertiary #6b7583,
 * dividers #e6e9ee. No cards, chips, shadows or monospace.
 */

/** Flat section: 1px top divider + 24px padding. */
export function Section({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <section className="border-t border-[#e6e9ee] px-6 py-6">
      <h3 className="text-[15px] font-semibold leading-snug text-[#1d2733]">{title}</h3>
      {subtitle && <p className="text-[12px] leading-snug text-[#6b7583]">{subtitle}</p>}
      <div className="mt-4">{children}</div>
    </section>
  );
}

/** One small caption per section (source / method). */
export function Caption({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={`text-[12px] leading-snug text-[#6b7583] ${className ?? ""}`}>{children}</p>;
}

/** Label / value row. */
export function Row({ label, value }: { label: ReactNode; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span className="min-w-0 text-[13px] leading-snug text-[#556070]">{label}</span>
      <span className="shrink-0 text-right text-[14px] font-semibold tabular-nums text-[#1d2733]">{value}</span>
    </div>
  );
}

/** A small titled group of rows inside "What's here". */
export function Group({ title, wide, children }: { title: string; wide?: boolean; children: ReactNode }) {
  return (
    <div className={`flex min-w-0 flex-col gap-0.5 ${wide ? "col-span-2" : ""}`}>
      <h4 className="mb-1 text-[14px] font-semibold leading-snug text-[#1d2733]">{title}</h4>
      {children}
    </div>
  );
}
