"use client";

import { useEffect, useRef, useState } from "react";
import {
  BASEMAPS,
  basemapById,
  type BasemapId,
} from "@/lib/basemaps";
import {
  LAYER_OPTIONS,
  type LayerVisibility,
} from "@/lib/gridLayers";
import { RISK_COLORS, type RiskBucket } from "@/lib/risk";

interface Props {
  basemap: BasemapId;
  onBasemap: (id: BasemapId) => void;
  layers: LayerVisibility;
  onLayers: (next: LayerVisibility) => void;
}

const RAMP: RiskBucket[] = ["LOW", "WATCH", "HIGH", "CRITICAL"];

/**
 * Google-style layers control: a thumbnail tile that opens basemap choices and
 * map details. Replaces the flat row of layer chips so the map keeps its
 * corners clear. Dark-token styling to match the shell.
 */
export default function LayerPicker({ basemap, onBasemap, layers, onLayers }: Props) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const preview = basemapById(basemap === "dark" ? "satellite" : basemap);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={rootRef} className="layer-picker">
      {open ? (
        <div role="dialog" aria-label="Map layers" className="layer-picker-pop">
          <p className="layer-pop-title">Map type</p>
          <div className="layer-basemaps">
            {BASEMAPS.map((option) => {
              const selected = option.id === basemap;
              return (
                <button
                  key={option.id}
                  type="button"
                  className="layer-basemap"
                  data-active={selected}
                  aria-pressed={selected}
                  onClick={() => onBasemap(option.id)}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={option.thumb} alt="" width={54} height={54} />
                  <span>{option.label}</span>
                </button>
              );
            })}
          </div>

          <p className="layer-pop-title layer-pop-divider">Map details</p>
          <div className="layer-checks">
            {LAYER_OPTIONS.map((option) => (
              <label key={option.id}>
                <input
                  type="checkbox"
                  checked={layers[option.id]}
                  onChange={() => onLayers({ ...layers, [option.id]: !layers[option.id] })}
                />
                {option.label}
              </label>
            ))}
          </div>

          <p className="layer-pop-title layer-pop-divider">Risk score</p>
          <div className="layer-ramp">
            {RAMP.map((bucket) => (
              <span key={bucket}>
                <i style={{ background: RISK_COLORS[bucket] }} aria-hidden />
                {bucket}
              </span>
            ))}
          </div>

          <p className="layer-note">
            <span className="layer-note-ring" aria-hidden />
            Dashed ring marks the scanned area
          </p>
          <p className="layer-note">
            <span className="layer-note-dash" aria-hidden />
            Dashed ties between load centers are modeled (illustrative), not published
            circuits
          </p>
        </div>
      ) : null}

      <button
        type="button"
        className="layer-trigger"
        aria-expanded={open}
        aria-label="Layers"
        onClick={() => setOpen((value) => !value)}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={preview.thumb} alt="" width={64} height={64} />
        <span>Layers</span>
      </button>
    </div>
  );
}
