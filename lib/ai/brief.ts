import { GoogleGenAI } from "@google/genai";
import { compactUSD, fmtNumber, fmtYears, fmtPercent } from "../format";
import { gridChain } from "../grid";
import { assetsForSite, assetsForSiteFromSource } from "../gridAssets.server";
import { listFacilities } from "../region";
import { layerSourceLabel } from "../scan/sourceLabel";
import type { BriefResponse, FacilityProperties, SimResult } from "../types";

const DEFAULT_MODEL = "gemini-2.5-flash";

/**
 * Physical context for the memo: the six-phase chain this load center sits on.
 * Built from the same region data the UI reads, so the memo cannot disagree
 * with the screen.
 */
function pointFor(properties: FacilityProperties): [number, number] | null {
  for (const facility of listFacilities()) {
    if (facility.properties.id === properties.id) {
      const [lon, lat] = facility.geometry.coordinates;
      return [lon, lat];
    }
  }
  return null;
}

function chainFor(properties: FacilityProperties, sim: SimResult) {
  const point = pointFor(properties);
  // The memo reads the same EIA-860 / OSM layers the screen does; if they are
  // unreadable the chain reports the gap rather than a modelled stand-in.
  return gridChain(properties, sim, { assets: point ? assetsForSite(point) : null });
}

interface ChainContext {
  chain: ReturnType<typeof gridChain>;
  /** Grid-layer provenance; null when the bundled default is in use (env unset). */
  layerSource: string | null;
}

/**
 * With GRIDSENTINEL_ASSETS_LOCATION set the chain reads that location's loaded
 * ETL assets (falling back to bundled, with the reason) and the memo labels
 * which it used. Unset, this is exactly chainFor().
 */
async function chainContext(properties: FacilityProperties, sim: SimResult): Promise<ChainContext> {
  if (!process.env.GRIDSENTINEL_ASSETS_LOCATION) return { chain: chainFor(properties, sim), layerSource: null };
  const point = pointFor(properties);
  if (!point) {
    return {
      chain: gridChain(properties, sim, { assets: null }),
      layerSource: layerSourceLabel({ source: "bundled", fallbackReasons: ["load center has no map point"] }),
    };
  }
  const sourced = await assetsForSiteFromSource(point);
  return {
    chain: gridChain(properties, sim, { assets: sourced.assets }),
    layerSource: layerSourceLabel({
      source: sourced.source, revision: sourced.etl?.revision ?? null, fallbackReasons: sourced.fallback_reasons,
    }),
  };
}

function economics(properties: FacilityProperties, sim: SimResult) {
  if (sim.upgraded) {
    return {
      capex: sim.upgraded.capex_usd,
      savings: sim.upgraded.annual_savings_usd,
      payback: sim.upgraded.payback_years,
      avoided: sim.upgraded.co2_avoided_tons,
    };
  }
  const u = properties.upgrade_potential;
  return {
    capex: u.capex_estimate_usd,
    savings: u.annual_savings_usd,
    payback: u.annual_savings_usd > 0 ? u.capex_estimate_usd / u.annual_savings_usd : null,
    avoided: Math.max(0, sim.annual_co2_tons * 0.2),
  };
}

/**
 * Deterministic memo. Emits the exact same five labels as the model output so
 * the UI never needs a second renderer.
 */
export function fallbackBrief(
  properties: FacilityProperties,
  sim: SimResult,
  tone: "technical" | "executive" = "technical",
  context?: ChainContext,
): string {
  const u = properties.upgrade_potential;
  const e = economics(properties, sim);
  const age = properties.infrastructure.age_years;
  const chain = context?.chain ?? chainFor(properties, sim);
  const layerNote = context?.layerSource ? ` Grid layers: ${context.layerSource}.` : "";
  const binding =
    chain.find((phase) => phase.severity === "critical") ??
    chain.find((phase) => phase.severity === "high") ??
    chain[chain.length - 1];
  const bindingSignal =
    binding.diagnostics.find((diag) => diag.severity === binding.severity) ??
    binding.diagnostics[0];
  const motorEff = properties.infrastructure.motor_efficiency_rating;

  return [
    `To: ${properties.provider.utility_name} — Energy & Sustainability`,
    `From: GridSentinel Audit Desk`,
    `Re: ${properties.name} (${properties.type}, ${age} yr) — grid-risk and decarbonization screen`,
    ``,
    `RECOMMENDATION  ${u.recommended_intervention}. The bundle adds ${fmtNumber(
      u.solar_capacity_add_mw,
      1,
    )} MW of on-site solar and cuts drive-side electricity use by ${fmtPercent(
      u.efficiency_gain_pct,
    )}.`,
    `FINDINGS        ${fmtNumber(
      sim.effective_draw_mw,
      1,
    )} MW live demand at ${fmtPercent(sim.utilization_pct, 1)} of ${fmtNumber(
      sim.nameplate_mw,
      1,
    )} MW nameplate; ${fmtNumber(
      sim.carbon_intensity,
      0,
    )} gCO2/kWh grid intensity; motor efficiency ${fmtPercent(
      motorEff * 100,
    )} against an 0.85 benchmark. Grid chain: ${binding.name} binds first — ${bindingSignal.label.toLowerCase()}.${layerNote}`,
    `ECONOMICS       ${compactUSD(e.capex)} screening capex, ${compactUSD(
      e.savings,
    )} annual savings, ${fmtYears(e.payback)} simple payback, ${fmtNumber(
      e.avoided,
      0,
    )} tCO2 avoided per year. Screening estimates, not bids.`,
    `RISK            ${
      sim.heatwave_active
        ? `At 105F the asset draws ${fmtNumber(
            sim.effective_draw_mw,
            1,
          )} MW against ${fmtNumber(sim.nameplate_mw, 1)} MW nameplate (${
            sim.overload ? "overload" : "no overload"
          }), with carbon intensity up 25 percent.`
        : `${fmtNumber(sim.effective_draw_mw, 1)} MW against ${fmtNumber(
            sim.nameplate_mw,
            1,
          )} MW nameplate. Pre-stress baseline; run the heatwave scenario for exposure.`
    }`,
    `NEXT STEP       Request 15-minute interval data for the drive bank and a joint site verification, then route the bundle into the next capital cycle. ${tone === "executive" ? "Decision needed: approve the site audit." : "Owner: energy manager, within 30 days."}`,
  ].join("\n");
}

export async function generateBrief(
  properties: FacilityProperties,
  sim: SimResult,
  tone: "technical" | "executive" = "technical",
): Promise<BriefResponse> {
  const context = await chainContext(properties, sim);
  const fallback = (): BriefResponse => ({
    node_id: properties.id,
    brief: fallbackBrief(properties, sim, tone, context),
    source: "fallback",
    model: null,
    generated_at: new Date().toISOString(),
  });

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return fallback();

  const model = process.env.GEMINI_MODEL || DEFAULT_MODEL;
  const { chain, layerSource } = context;

  const payload = {
    load_center: {
      name: properties.name,
      type: properties.type,
      operator: properties.provider.utility_name,
      year_built: properties.infrastructure.year_built,
      nameplate_mw: properties.infrastructure.nameplate_draw_mw,
      utilization_pct: properties.infrastructure.utilization_pct,
      motor_efficiency_rating: properties.infrastructure.motor_efficiency_rating,
      grid_zone: properties.energy_profile.grid_zone,
      carbon_intensity_gco2_kwh: properties.energy_profile.carbon_intensity_gco2_kwh,
      source_mix: properties.energy_profile.source_mix,
      recommended_intervention: properties.upgrade_potential.recommended_intervention,
      solar_capacity_add_mw: properties.upgrade_potential.solar_capacity_add_mw,
      efficiency_gain_pct: properties.upgrade_potential.efficiency_gain_pct,
    },
    simulation: sim,
    grid_chain: chain.map((phase) => ({
      phase: `${phase.phase}. ${phase.name}`,
      severity: phase.severity,
      signals: phase.diagnostics.map((diag) => `${diag.label} (${diag.severity}): ${diag.detail}`),
      primary_pathway: phase.pathways[0]?.label ?? null,
    })),
    ...(layerSource ? { grid_layers_source: layerSource } : {}),
    tone,
  };

  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model,
      contents: `Electrical load-center telemetry and simulation JSON:\n${JSON.stringify(payload)}`,
      config: {
        systemInstruction:
          "You are a utility energy-audit analyst writing about electrical load centers. Write a ~200 word decision memo in plain text with exactly these five labelled sections, in this order: RECOMMENDATION, FINDINGS, ECONOMICS, RISK, NEXT STEP. Use the numbers provided (MW, MWh, tCO2, dollars, percent), name units, mark economics as screening estimates, and stay decision-oriented. Never describe a process throughput, a resource or a supply chain. No markdown tables, no headings beyond those labels. Treat the supplied grid_chain as the physical context: when it explains the exposure, name the binding phase and its primary pathway.",
        temperature: 0.4,
        maxOutputTokens: 400,
      },
    });

    const text = response.text?.trim();
    if (!text) return fallback();

    return {
      node_id: properties.id,
      brief: text,
      source: "gemini",
      model,
      generated_at: new Date().toISOString(),
    };
  } catch (err) {
    console.error(
      "[generate-brief]",
      err instanceof Error ? err.message : "unknown error",
    );
    return fallback();
  }
}
