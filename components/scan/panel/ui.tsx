"use client";

import { useId, useState, type ReactNode } from "react";
import { SOURCES, type SourceId, type SourceInfo } from "@/lib/scan/sources";

/*
 * Plain building blocks for the scan panel. Colors are the shared light palette
 * (lib/scan/colors.ts UI): text #1d2733, secondary #556070, tertiary #6b7583,
 * dividers #e6e9ee. No cards, chips, shadows or monospace.
 */

/** Flat section: 1px top divider + 24px padding. */
export function Section({
  title,
  subtitle,
  sources,
  children,
}: {
  title: string;
  subtitle?: string;
  sources?: SourceId[];
  children: ReactNode;
}) {
  return (
    <section className="border-t border-[#e6e9ee] px-6 py-6">
      <SourcedTitle
        sources={sources}
        heading={<h3 className="min-w-0 text-[15px] font-semibold leading-snug text-[#1d2733]">{title}</h3>}
        below={subtitle && <p className="text-[12px] leading-snug text-[#6b7583]">{subtitle}</p>}
      />
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
export function Group({
  title,
  wide,
  sources,
  children,
}: {
  title: string;
  wide?: boolean;
  sources?: SourceId[];
  children: ReactNode;
}) {
  return (
    <div className={`flex min-w-0 flex-col gap-0.5 ${wide ? "col-span-2" : ""}`}>
      <div className="mb-1">
        <SourcedTitle
          sources={sources}
          heading={<h4 className="min-w-0 text-[14px] font-semibold leading-snug text-[#1d2733]">{title}</h4>}
        />
      </div>
      {children}
    </div>
  );
}

/* ---------------------------------------------------------------- Sources */

/** Small text button that toggles the source note. */
export function SourcesButton({
  open,
  onToggle,
  controls,
}: {
  open: boolean;
  onToggle: () => void;
  controls: string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={controls}
      className="shrink-0 text-[13px] leading-snug text-[#0369a1] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0ea5e9]"
    >
      Sources
    </button>
  );
}

/** Inline box listing where a section's data comes from. */
export function SourceNote({ sources, id }: { sources: SourceId[]; id?: string }) {
  return (
    <div
      id={id}
      className="mt-2 flex flex-col gap-3 rounded-[6px] border border-[#e6e9ee] bg-[#f6f8fa] px-3 py-2.5 text-[13px] font-normal leading-snug text-[#556070]"
    >
      {sources.map((sid) => {
        const s: SourceInfo = SOURCES[sid];
        return (
          <div key={sid} className="flex flex-col gap-0.5">
            <p>
              <span className="font-semibold text-[#1d2733]">{s.name}</span> · {s.publisher}
            </p>
            <p className="text-[#6b7583]">Data as of {s.asOf}</p>
            <p>{s.what}</p>
            {s.method && <p>{s.method}</p>}
            {s.note && <p>{s.note}</p>}
            {s.url && (
              <a href={s.url} target="_blank" rel="noopener noreferrer" className="text-[#0369a1] hover:underline">
                View source
              </a>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Title row with an optional "Sources" button at the right and its note below. */
export function SourcedTitle({
  heading,
  below,
  sources,
}: {
  heading: ReactNode;
  below?: ReactNode;
  sources?: SourceId[];
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const has = !!sources && sources.length > 0;
  return (
    <>
      <div className="flex items-baseline justify-between gap-3">
        {heading}
        {has && <SourcesButton open={open} onToggle={() => setOpen((o) => !o)} controls={id} />}
      </div>
      {below}
      {has && open && <SourceNote sources={sources} id={id} />}
    </>
  );
}
