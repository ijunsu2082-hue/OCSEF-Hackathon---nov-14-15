"use client";

import { useEffect, useRef, useState } from "react";
import { BASEMAPS, basemapById, type BasemapId } from "./basemaps";

export interface LayerVisibility {
  plants: boolean;
  transmission: boolean;
  substations: boolean;
  events: boolean;
}

const TOGGLES: { key: keyof LayerVisibility; label: string }[] = [
  { key: "plants", label: "Power plants" },
  { key: "transmission", label: "Transmission lines" },
  { key: "substations", label: "Substations" },
  { key: "events", label: "Retired & proposed" },
];

const SHADOW = "0 1px 3px rgba(16,24,40,.08)";

/** Google-style layer picker: a thumbnail button that opens basemap choices and map details. */
export function LayerPicker({
  basemap,
  onBasemap,
  layers,
  onLayers,
}: {
  basemap: BasemapId;
  onBasemap: (id: BasemapId) => void;
  layers: LayerVisibility;
  onLayers: (next: LayerVisibility) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const preview = basemapById(basemap === "satellite" ? "map" : "satellite");

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="absolute bottom-16 left-3" style={{ zIndex: 20 }}>
      {open && (
        <div
          role="dialog"
          aria-label="Map layers"
          className="absolute bottom-[76px] left-0 w-[272px] rounded-[6px] border border-[#e6e9ee] bg-white p-3 text-[13px] text-[#1d2733]"
          style={{ boxShadow: SHADOW }}
        >
          <p className="font-semibold">Map type</p>
          <div className="mt-2 grid grid-cols-4 gap-2">
            {BASEMAPS.map((b) => {
              const selected = b.id === basemap;
              return (
                <button
                  key={b.id}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => onBasemap(b.id)}
                  className="flex flex-col items-center gap-1"
                >
                  <span
                    className="block h-12 w-12 overflow-hidden rounded-[6px] border-2"
                    style={{ borderColor: selected ? "#0ea5e9" : "#e6e9ee" }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img src={b.thumb} alt="" width={48} height={48} className="h-full w-full object-cover" />
                  </span>
                  <span className={selected ? "text-[12px] font-medium text-[#0284c7]" : "text-[12px] text-[#556070]"}>
                    {b.label}
                  </span>
                </button>
              );
            })}
          </div>

          <p className="mt-3 border-t border-[#e6e9ee] pt-3 font-semibold">Map details</p>
          <div className="mt-1.5 space-y-1">
            {TOGGLES.map((t) => (
              <label key={t.key} className="flex cursor-pointer items-center gap-2">
                <input
                  type="checkbox"
                  checked={layers[t.key]}
                  onChange={() => onLayers({ ...layers, [t.key]: !layers[t.key] })}
                  className="h-3.5 w-3.5 accent-[#0ea5e9]"
                />
                {t.label}
              </label>
            ))}
          </div>
        </div>
      )}

      <button
        type="button"
        aria-expanded={open}
        aria-label="Layers"
        onClick={() => setOpen((o) => !o)}
        className="relative block h-16 w-16 overflow-hidden rounded-[6px] border-2 bg-white"
        style={{ borderColor: open ? "#0ea5e9" : "#ffffff", boxShadow: SHADOW }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={preview.thumb} alt="" width={64} height={64} className="h-full w-full object-cover" />
        <span className="absolute inset-x-0 bottom-0 bg-white py-0.5 text-center text-[12px] font-medium text-[#1d2733]">
          Layers
        </span>
      </button>
    </div>
  );
}
