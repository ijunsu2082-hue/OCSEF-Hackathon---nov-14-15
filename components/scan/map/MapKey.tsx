"use client";

import { useState, type ReactNode } from "react";
import { CATEGORY_COLORS, CATEGORY_KEYS, CATEGORY_LABELS } from "@/lib/scan/colors";

const SHADOW = "0 1px 3px rgba(16,24,40,.08)";

function Row({ swatch, children }: { swatch: ReactNode; children: ReactNode }) {
  return (
    <li className="flex items-center gap-2">
      <span className="flex h-3.5 w-4 shrink-0 items-center justify-center">{swatch}</span>
      {children}
    </li>
  );
}

const dot = (color: string, size = 10) => (
  <span
    className="block shrink-0 rounded-full border border-white"
    style={{ width: size, height: size, background: color, boxShadow: "0 0 0 1px #e6e9ee" }}
  />
);

const line = (color: string, height: number) => (
  <span className="block w-4 shrink-0 rounded-full" style={{ height, background: color }} />
);

/** Always-visible key for what each dot and line on the map means. */
export function MapKey() {
  const [open, setOpen] = useState(true);

  if (!open) {
    return (
      <button
        type="button"
        aria-expanded={false}
        onClick={() => setOpen(true)}
        className="absolute bottom-7 right-3 rounded-[6px] border border-[#e6e9ee] bg-white px-2.5 py-1 text-[13px] font-medium text-[#1d2733]"
        style={{ zIndex: 20, boxShadow: SHADOW }}
      >
        Key
      </button>
    );
  }

  return (
    <section
      aria-label="Map key"
      className="absolute bottom-7 right-3 w-[208px] rounded-[6px] border border-[#e6e9ee] bg-white p-3 text-[12px] text-[#556070]"
      style={{ zIndex: 20, boxShadow: SHADOW }}
    >
      <div className="flex items-center justify-between">
        <p className="text-[13px] font-semibold text-[#1d2733]">Key</p>
        <button
          type="button"
          aria-expanded
          onClick={() => setOpen(false)}
          className="text-[12px] font-medium text-[#0369a1] hover:underline"
        >
          Hide key
        </button>
      </div>

      <p className="mt-2 font-medium text-[#1d2733]">
        Power plants <span className="font-normal text-[#556070]">(bigger dot = more MW)</span>
      </p>
      <ul className="mt-1 grid grid-cols-2 gap-x-3 gap-y-1">
        {CATEGORY_KEYS.map((k) => (
          <Row key={k} swatch={dot(CATEGORY_COLORS[k])}>
            {CATEGORY_LABELS[k]}
          </Row>
        ))}
      </ul>

      <ul className="mt-2 space-y-1 border-t border-[#e6e9ee] pt-2">
        <Row swatch={<span className="block h-[5px] w-[5px] rounded-full bg-[#0284c7]" />}>Substation</Row>
        <Row swatch={line("#94a3b8", 2)}>Power line</Row>
        <Row swatch={line("#0ea5e9", 3)}>Power line in scan area</Row>
        <Row
          swatch={<span className="box-border block h-2.5 w-2.5 rounded-full border-2 border-[#0284c7] bg-white" />}
        >
          Westminster HS
        </Row>
        <Row swatch={<span className="box-border block h-3.5 w-3.5 rounded-full border-2 border-[#0ea5e9] bg-[#e0f2fe]" />}>
          Scan area
        </Row>
        <Row swatch={<span className="box-border block h-3.5 w-3.5 rounded-full border-2 border-[#0284c7]" />}>
          100-mile study area
        </Row>
      </ul>

      <p className="mt-2 border-t border-[#e6e9ee] pt-2 text-[#6b7583]">Hover a dot or line for details. Click to scan there.</p>
    </section>
  );
}
