"use client";

import { haversineMi } from "@/lib/scan";
import type { NicheCase, ScanResult } from "@/lib/scan";
import { DASH, fmtNum, isNum } from "./format";
import { Caption, Section } from "./ui";

const RELATED_MAX = 5;
const NEAREST_OUTSIDE = 3;

export interface NewsItem {
  c: NicheCase;
  distanceMi: number;
}

export interface LocalNewsGroups {
  within: NewsItem[]; // inside the scan circle, nearest first
  related: NewsItem[]; // outside the circle, related by name or nearness, nearest first
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Place / plant / utility names that tie a story to this area. */
function areaTerms(result: ScanResult): string[] {
  const raw: string[] = [];
  for (const p of result.plants) raw.push(p.city, p.plant_name, p.utility_name);
  for (const part of (result.area_label || "").split("·")) raw.push(part.replace(/^\s*near\s+/i, ""));
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of raw) {
    const k = (t ?? "").trim().toLowerCase();
    if (k.length < 3 || seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

/** Split all stories into "within the scan circle" and "related" for the clicked point + radius. */
export function groupLocalNews(result: ScanResult, cases: NicheCase[]): LocalNewsGroups {
  const { lat, lon, radius_mi } = result.area;
  const all: NewsItem[] = [];
  for (const c of cases) {
    const l = c.location;
    if (!l || !Number.isFinite(l.lat) || !Number.isFinite(l.lon)) continue;
    all.push({ c, distanceMi: haversineMi(lat, lon, l.lat, l.lon) });
  }
  all.sort((a, b) => a.distanceMi - b.distanceMi);

  const within = all.filter((n) => n.distanceMi <= radius_mi);
  const outside = all.filter((n) => n.distanceMi > radius_mi);

  const terms = areaTerms(result).map((t) => new RegExp(`(^|[^a-z0-9])${escapeRe(t)}($|[^a-z0-9])`, "i"));
  const mentions = (c: NicheCase) => {
    const text = `${c.title} ${c.location?.name ?? ""}`;
    return terms.some((re) => re.test(text));
  };
  const nearest = new Set(outside.slice(0, NEAREST_OUTSIDE).map((n) => n.c.id));
  const related = outside.filter((n) => nearest.has(n.c.id) || mentions(n.c)).slice(0, RELATED_MAX);

  return { within, related };
}

function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

function NewsRow({ item, onShowOnMap }: { item: NewsItem; onShowOnMap: (c: NicheCase) => void }) {
  const { c, distanceMi } = item;
  const link = c.stats.map((s) => s.source.trim()).find(isUrl);
  const category = c.category ? c.category.charAt(0).toUpperCase() + c.category.slice(1) : "";
  return (
    <div className="py-3">
      <h4 className="text-[14px] font-semibold leading-snug text-[#1d2733]">{c.title}</h4>
      <p className="mt-0.5 text-[12px] tabular-nums text-[#6b7583]">
        {category}
        {category && " · "}
        {isNum(distanceMi) ? `${fmtNum(distanceMi, 1)} mi away` : DASH}
      </p>
      {c.shock_line && <p className="mt-1.5 text-[14px] leading-snug text-[#556070]">{c.shock_line}</p>}
      <div className="mt-1.5 flex items-baseline gap-4">
        <button
          type="button"
          onClick={() => onShowOnMap(c)}
          className="text-[13px] text-[#0284c7] hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#0ea5e9]"
        >
          Show on map
        </button>
        {link && (
          <a
            href={link}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[13px] text-[#0284c7] hover:underline"
          >
            Sources
          </a>
        )}
      </div>
    </div>
  );
}

export function LocalNews({
  result,
  groups,
  onShowOnMap,
}: {
  result: ScanResult;
  groups: LocalNewsGroups;
  onShowOnMap: (c: NicheCase) => void;
}) {
  const r = result.area.radius_mi;
  const rText = fmtNum(r, isNum(r) && r % 1 !== 0 ? 1 : 0);
  const label = result.area_label || "this spot";
  return (
    <>
      <Section title={`Within ${rText} mi of ${label}`} sources={["news"]}>
        {groups.within.length === 0 ? (
          <p className="text-[14px] text-[#556070]">No local news within {rText} mi. Try a bigger radius.</p>
        ) : (
          <div className="-my-3 flex flex-col">
            {groups.within.map((n) => (
              <NewsRow key={n.c.id} item={n} onShowOnMap={onShowOnMap} />
            ))}
          </div>
        )}
        <Caption className="mt-3">
          Real local stories from news and public records. They&apos;re kept off the map so the map shows only
          equipment.
        </Caption>
      </Section>
      {groups.related.length > 0 && (
        <Section title="Related" subtitle="Stories outside the scan circle that mention this area or sit nearest to it.">
          <div className="-my-3 flex flex-col">
            {groups.related.map((n) => (
              <NewsRow key={n.c.id} item={n} onShowOnMap={onShowOnMap} />
            ))}
          </div>
        </Section>
      )}
    </>
  );
}
