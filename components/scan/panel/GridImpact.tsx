"use client";

import type { LineRatingNow, ScanResult } from "@/lib/scan";
import {
  CURTAILED_LOCAL_2025,
  CURTAILED_TOTAL_2025,
  bulkLineMiles,
  co2RangeTonnes,
  homesForYear,
  localSharePct,
  temperatureRatio,
} from "@/lib/scan/impact";
import type { SourceId } from "@/lib/scan/sources";
import { fmtNum, fmtRatio, isNum } from "./format";
import { Caption, Section } from "./ui";

const SOURCES: SourceId[] = [
  "caiso_curtailment_2025",
  "caiso_curtailment_defs",
  "egrid2023_camx",
  "eia_ca_home_use",
  "doe_dlr_2019",
  "ferc881",
];

/** 3,765,628 -> "3.77 million"; 610,957 -> "0.61 million". */
function millions(n: number): string {
  return `${fmtNum(n / 1_000_000, 2)} million`;
}

/** Round to the nearest 10,000 for a plain "about" figure. */
function roughThousands(n: number): string {
  return fmtNum(Math.round(n / 10_000) * 10_000, 0);
}

function KeyNumber({ value, label }: { value: string; label: string }) {
  return (
    <div className="grid grid-cols-[minmax(0,6rem)_minmax(0,1fr)] items-baseline gap-x-3">
      <dt className="order-2 text-[13px] leading-snug text-[#556070]">{label}</dt>
      <dd className="order-1 text-[20px] font-semibold leading-tight tabular-nums text-[#1d2733]">{value}</dd>
    </div>
  );
}

function AreaLine({ result, live }: { result: ScanResult; live: LineRatingNow | null }) {
  const miles = bulkLineMiles(result);
  const ratio = temperatureRatio(live);
  const src = live?.weather?.source;
  const when =
    src === "heatwave-scenario"
      ? "In the 105 °F heatwave scenario"
      : src === "fallback-2025"
        ? "With 2025 weather (live data unavailable)"
        : "Right now";

  const milesText =
    miles > 0
      ? `This circle has ${fmtNum(miles, miles < 10 ? 1 : 0)} miles of power lines rated 200 kV and up (the biggest lines), the kind that carry power from solar and wind farms toward cities.`
      : "This circle has no power lines of 200 kV and up in our map data.";

  let ratioText: string;
  if (!isNum(ratio)) {
    ratioText = "Live weather is not available right now, so we can't show today's temperature-adjusted rating here.";
  } else if (ratio < 1) {
    ratioText = `${when} it is hot enough that a typical line here should carry less than its fixed rating: ${fmtRatio(ratio)} (temperature-adjusted rating, modeled).`;
  } else {
    ratioText = `${when}, air temperature alone lets a typical line here carry up to ${fmtRatio(ratio)} a fixed 40 °C worst-case rating (ambient-adjusted rating, modeled; less against the utility's seasonal ratings, and no gain where equipment or grid stability sets the limit). A federal rule (FERC Order 881) requires FERC-regulated grid operators to switch to this kind of rating. Wind can add more, but it changes hour to hour.`;
  }

  return (
    <div className="flex flex-col gap-2">
      <h4 className="text-[14px] font-semibold leading-snug text-[#1d2733]">In this area</h4>
      <p className="text-[14px] leading-snug text-[#1d2733]">{milesText}</p>
      <p className="text-[14px] leading-snug text-[#1d2733]">{ratioText}</p>
      <p className="text-[14px] leading-snug text-[#556070]">
        We can&apos;t yet tell which line in this circle is congested; CAISO doesn&apos;t publish that per line in a
        simple public form.
      </p>
    </div>
  );
}

export function GridImpact({ result, live }: { result: ScanResult; live: LineRatingNow | null }) {
  const total = CURTAILED_TOTAL_2025.value;
  const local = CURTAILED_LOCAL_2025.value;
  const share = localSharePct();
  const co2 = co2RangeTonnes(local);
  const homes = homesForYear(local);

  return (
    <Section title="Why this matters" sources={SOURCES}>
      <div className="flex flex-col gap-5 print:break-inside-avoid">
        <div className="flex flex-col gap-2">
          <p className="text-[14px] leading-snug text-[#1d2733]">
            In {CURTAILED_TOTAL_2025.year}, California&apos;s main grid (CAISO) threw away {millions(total)} MWh of
            solar and wind power (curtailment). About {fmtNum(share, 0)}% of that happened because local power lines
            were full (congestion), not because there was too much power overall.
          </p>
          <p className="text-[14px] leading-snug text-[#1d2733]">
            That congestion part alone could have powered about {roughThousands(homes)} California homes for a year.
            Letting lines carry more when the weather allows (dynamic line rating) is a low-cost option compared with
            building new lines, according to the U.S. Department of Energy.
          </p>
        </div>

        <dl className="flex flex-col gap-3">
          <KeyNumber value={fmtNum(total / 1_000_000, 2)} label={`Million MWh of solar and wind thrown away in ${CURTAILED_TOTAL_2025.year}`} />
          <KeyNumber value={`${fmtNum(share, 0)}%`} label="Of that, cut because local lines were full" />
          <KeyNumber
            value={`${fmtNum(co2.low / 1_000_000, 1)}–${fmtNum(co2.high / 1_000_000, 1)}`}
            label="Million tonnes CO2 if every congestion-curtailed MWh had displaced average (low) or gas-heavy non-baseload (high) CA power; true avoided emissions are likely lower."
          />
        </dl>

        <AreaLine result={result} live={live} />

        <Caption>
          Source: CAISO 2025 curtailment data (CAISO grid only), EPA eGRID2023, EIA 2024. True CO2 savings are likely
          lower: not all of this power could have reached customers or replaced gas.
        </Caption>
      </div>
    </Section>
  );
}

export default GridImpact;
