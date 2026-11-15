/**
 * Region build — profile + snapshots + claims → one verifiable evidence bundle.
 *
 * No network by default. Every input is either a committed fixture or an in-repo
 * artifact, so two machines (and CI) build byte-identical claims. `--refresh`
 * is the only code path that fetches.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  computeBundleId,
  computeRegistryDigest,
} from "../lib/evidence/canonical";
import { facilitySubject, regionSubject } from "../lib/evidence/citation";
import { verifyBundle } from "../lib/evidence/verify";
import type {
  Claim,
  Disclosure,
  EvidenceBundle,
  SourceSnapshot,
  UnresolvedItem,
} from "../lib/evidence/schema";
import { EVIDENCE_SCHEMA } from "../lib/evidence/schema";
import {
  dedupeClaims,
  derivedClaim,
  findClaim,
  modeledClaim,
  observedClaim,
  orderedInputs,
} from "./claims";
import { SOURCE_REGISTRY, getSourceDefinition } from "./registry";
import { REPO_ROOT, fromRepoPath, loadArtifact, loadFixture } from "./snapshot";
import { resolvePointer } from "./parsers";
import { resolveConflicts } from "./resolve";

interface SeedFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: {
    id: string;
    name: string;
    type: string;
    provider: { utility_name: string; contact_email: string };
    infrastructure: {
      year_built: number;
      age_years: number;
      motor_efficiency_rating: number;
      nameplate_draw_mw: number;
      utilization_pct: number;
    };
    energy_profile: {
      baseline_draw_mw: number;
      peak_draw_mw: number;
      grid_zone: string;
      carbon_intensity_gco2_kwh: number;
      source_mix: {
        natural_gas: number;
        solar: number;
        hydro: number;
        wind: number;
        other: number;
      };
    };
    upgrade_potential: {
      recommended_intervention: string;
      solar_capacity_add_mw: number;
      efficiency_gain_pct: number;
      capex_estimate_usd: number;
      annual_savings_usd: number;
      solar_capex_per_mw_usd: number;
      solar_savings_per_mw_usd: number;
      vfd_capex_usd: number;
      vfd_savings_usd: number;
    };
  };
}

interface RegionProfile {
  schema: string;
  id: string;
  name: string;
  state: string;
  center: [number, number];
  radius_miles: number;
  bounds: [[number, number], [number, number]];
  grid_zone: string;
  as_of_year: number;
  captured_at: string;
  output: string;
  seed: {
    source_id: string;
    path: string;
    parser: string;
    model_basis: Record<string, string>;
  };
  fixtures: {
    source_id: string;
    path: string;
    parser: string;
    claims: { predicate: string; locator: string }[];
    notes: string[];
  }[];
  layers: {
    source_id: string;
    path: string;
    parser: string;
    claim: string;
    notes: string[];
  }[];
  disclosures: Disclosure[];
}

export interface BuildOptions {
  profile: string;
  out?: string;
  now?: Date;
}

function isScalar(value: unknown): value is string | number | boolean {
  return (
    typeof value === "string" || typeof value === "number" || typeof value === "boolean"
  );
}

function scalarAt(data: unknown, locator: string, context: string): string | number | boolean {
  const value = resolvePointer(data, locator);
  if (!isScalar(value)) {
    throw new Error(`${context}: ${locator} resolved to ${typeof value}, expected a scalar`);
  }
  return value;
}

function assertFinite(value: number, context: string): number {
  if (!Number.isFinite(value)) throw new Error(`${context}: not a finite number`);
  return value;
}

export async function loadProfile(profileArg: string): Promise<{ profile: RegionProfile; path: string }> {
  const path = profileArg.endsWith(".json")
    ? resolve(REPO_ROOT, profileArg)
    : resolve(REPO_ROOT, "research/profiles", `${profileArg}.json`);
  const profile = JSON.parse(await readFile(path, "utf8")) as RegionProfile;
  if (profile.schema !== "gridsentinel.region-profile/1") {
    throw new Error(`${path}: unsupported profile schema ${profile.schema}`);
  }
  return { profile, path };
}

export async function buildRegion(options: BuildOptions): Promise<EvidenceBundle> {
  const { profile } = await loadProfile(options.profile);
  const sources = SOURCE_REGISTRY;
  const sourceById = new Map(sources.map((source) => [source.id, source]));
  const snapshots: SourceSnapshot[] = [];
  const claims: Claim[] = [];
  const unresolved: UnresolvedItem[] = [];

  const addSnapshot = (snapshot: SourceSnapshot) => {
    if (!snapshots.some((candidate) => candidate.id === snapshot.id)) snapshots.push(snapshot);
  };

  const requireSource = (id: string) => {
    const source = sourceById.get(id);
    if (!source) throw new Error(`profile references unregistered source ${id}`);
    return source;
  };

  // ---- region identity from the Census fixture ------------------------------
  const region = regionSubject(profile.id);
  for (const fixture of profile.fixtures) {
    const source = requireSource(fixture.source_id);
    const loaded = await loadFixture(
      fixture.source_id,
      fixture.path,
      fixture.parser,
      fixture.notes,
    );
    addSnapshot(loaded.snapshot);
    for (const binding of fixture.claims) {
      claims.push(
        observedClaim({
          subject: region,
          predicate: binding.predicate,
          value: scalarAt(loaded.data, binding.locator, fixture.path),
          sourceId: source.id,
          snapshot: loaded.snapshot,
          locator: binding.locator,
          authority: source.authority,
          caveats: source.caveats,
        }),
      );
    }
  }

  // ---- radius/anchor are profile configuration, not measurements -----------
  claims.push(
    modeledClaim({
      subject: region,
      predicate: "region.radius_miles",
      value: profile.radius_miles,
      basis: `Analysis scope fixed by research/profiles/${profile.id}.json. Not a measurement of any facility.`,
    }),
  );
  claims.push(
    modeledClaim({
      subject: region,
      predicate: "region.home_latitude",
      value: profile.center[0],
      basis: `Anchor point fixed by research/profiles/${profile.id}.json (Westminster High School, Westminster CA).`,
    }),
  );
  claims.push(
    modeledClaim({
      subject: region,
      predicate: "region.home_longitude",
      value: profile.center[1],
      basis: `Anchor point fixed by research/profiles/${profile.id}.json (Westminster High School, Westminster CA).`,
    }),
  );

  // ---- layer counts ---------------------------------------------------------
  for (const layer of profile.layers) {
    const source = requireSource(layer.source_id);
    const loaded = await loadArtifact(layer.source_id, layer.path, layer.parser, {
      capturedAt: profile.captured_at,
      notes: layer.notes,
    });
    addSnapshot(loaded.snapshot);
    const claim = derivedClaim({
      subject: region,
      predicate: layer.claim,
      formulaId: "artifact.count",
      inputs: [],
      snapshot: loaded.snapshot,
      caveats: source.caveats,
    });
    claims.push(claim);
  }

  // ---- seed load centers ----------------------------------------------------
  const seedSource = requireSource(profile.seed.source_id);
  const seed = await loadArtifact(profile.seed.source_id, profile.seed.path, profile.seed.parser, {
    capturedAt: profile.captured_at,
    notes: [
      "Exact in-repo seed dataset. Every facility claim uses a JSON Pointer into this snapshot.",
    ],
  });
  addSnapshot(seed.snapshot);
  const dataset = seed.data as { features?: SeedFeature[] };
  const features = dataset.features ?? [];
  if (features.length === 0) throw new Error(`${profile.seed.path}: no features`);

  claims.push(
    derivedClaim({
      subject: region,
      predicate: "region.facility_count",
      formulaId: "artifact.count",
      inputs: [],
      snapshot: seed.snapshot,
      caveats: seedSource.caveats,
    }),
  );

  const facilityIds: string[] = [];
  const facilityClaims: Record<string, Record<string, Claim>> = {};

  for (let index = 0; index < features.length; index += 1) {
    const feature = features[index];
    const properties = feature.properties;
    const id = properties.id;
    if (!id) throw new Error(`feature ${index} has no id`);
    if (facilityIds.includes(id)) throw new Error(`duplicate facility id ${id}`);
    facilityIds.push(id);
    const subject = facilitySubject(id);
    const base = `/features/${index}`;
    const pointer = (suffix: string) => `${base}/${suffix}`;
    const basis = profile.seed.model_basis;
    const addModeled = (
      predicate: string,
      locator: string,
      value: string | number | boolean,
      basisKey: keyof typeof basis,
    ) => {
      const claim = modeledClaim({
        subject,
        predicate,
        value,
        basis: basis[basisKey],
        sourceId: seedSource.id,
        snapshot: seed.snapshot,
        locator,
        caveats: seedSource.caveats,
      });
      claims.push(claim);
      (facilityClaims[id] ??= {})[predicate] = claim;
      return claim;
    };

    addModeled("facility.name", pointer("properties/name"), properties.name, "identity");
    addModeled("facility.type", pointer("properties/type"), properties.type, "identity");
    addModeled(
      "facility.operator",
      pointer("properties/provider/utility_name"),
      properties.provider.utility_name,
      "identity",
    );
    addModeled(
      "facility.latitude",
      pointer("geometry/coordinates/1"),
      assertFinite(feature.geometry.coordinates[1], `${id} latitude`),
      "identity",
    );
    addModeled(
      "facility.longitude",
      pointer("geometry/coordinates/0"),
      assertFinite(feature.geometry.coordinates[0], `${id} longitude`),
      "identity",
    );
    addModeled(
      "facility.year_built",
      pointer("properties/infrastructure/year_built"),
      properties.infrastructure.year_built,
      "identity",
    );
    addModeled(
      "facility.nameplate_draw_mw",
      pointer("properties/infrastructure/nameplate_draw_mw"),
      properties.infrastructure.nameplate_draw_mw,
      "electrical",
    );
    addModeled(
      "facility.utilization_pct",
      pointer("properties/infrastructure/utilization_pct"),
      properties.infrastructure.utilization_pct,
      "electrical",
    );
    addModeled(
      "facility.motor_efficiency_rating",
      pointer("properties/infrastructure/motor_efficiency_rating"),
      properties.infrastructure.motor_efficiency_rating,
      "electrical",
    );
    addModeled(
      "facility.peak_draw_mw",
      pointer("properties/energy_profile/peak_draw_mw"),
      properties.energy_profile.peak_draw_mw,
      "electrical",
    );
    addModeled(
      "facility.grid_zone",
      pointer("properties/energy_profile/grid_zone"),
      properties.energy_profile.grid_zone,
      "carbon",
    );
    addModeled(
      "facility.carbon_intensity_gco2_kwh",
      pointer("properties/energy_profile/carbon_intensity_gco2_kwh"),
      properties.energy_profile.carbon_intensity_gco2_kwh,
      "carbon",
    );
    for (const key of ["natural_gas", "solar", "hydro", "wind", "other"] as const) {
      addModeled(
        `facility.source_mix.${key}`,
        pointer(`properties/energy_profile/source_mix/${key}`),
        properties.energy_profile.source_mix[key],
        "carbon",
      );
    }
    addModeled(
      "facility.upgrade.recommended_intervention",
      pointer("properties/upgrade_potential/recommended_intervention"),
      properties.upgrade_potential.recommended_intervention,
      "upgrade",
    );
    addModeled(
      "facility.upgrade.solar_capacity_add_mw",
      pointer("properties/upgrade_potential/solar_capacity_add_mw"),
      properties.upgrade_potential.solar_capacity_add_mw,
      "upgrade",
    );
    addModeled(
      "facility.upgrade.efficiency_gain_pct",
      pointer("properties/upgrade_potential/efficiency_gain_pct"),
      properties.upgrade_potential.efficiency_gain_pct,
      "upgrade",
    );
    addModeled(
      "facility.upgrade.solar_capex_per_mw_usd",
      pointer("properties/upgrade_potential/solar_capex_per_mw_usd"),
      properties.upgrade_potential.solar_capex_per_mw_usd,
      "economics",
    );
    addModeled(
      "facility.upgrade.solar_savings_per_mw_usd",
      pointer("properties/upgrade_potential/solar_savings_per_mw_usd"),
      properties.upgrade_potential.solar_savings_per_mw_usd,
      "economics",
    );
    addModeled(
      "facility.upgrade.vfd_capex_usd",
      pointer("properties/upgrade_potential/vfd_capex_usd"),
      properties.upgrade_potential.vfd_capex_usd,
      "economics",
    );
    addModeled(
      "facility.upgrade.vfd_savings_usd",
      pointer("properties/upgrade_potential/vfd_savings_usd"),
      properties.upgrade_potential.vfd_savings_usd,
      "economics",
    );
  }

  // ---- facility derivations -------------------------------------------------
  for (const id of facilityIds) {
    const subject = facilitySubject(id);
    const map = facilityClaims[id];
    const yearBuilt = map["facility.year_built"];
    const nameplate = map["facility.nameplate_draw_mw"];
    const utilization = map["facility.utilization_pct"];
    const carbonIntensity = map["facility.carbon_intensity_gco2_kwh"];

    const age = derivedClaim({
      subject,
      predicate: "facility.age_years",
      formulaId: "energy.age_years",
      inputs: orderedInputs("energy.age_years", { year_built: yearBuilt }),
      params: { as_of_year: profile.as_of_year },
      caveats: ["Derived from the in-service year and the profile as-of year."],
    });
    const baseline = derivedClaim({
      subject,
      predicate: "facility.baseline_draw_mw",
      formulaId: "energy.baseline_draw_mw",
      inputs: orderedInputs("energy.baseline_draw_mw", {
        nameplate_mw: nameplate,
        utilization_pct: utilization,
      }),
    });
    const annualMwh = derivedClaim({
      subject,
      predicate: "facility.annual_mwh",
      formulaId: "energy.annual_mwh",
      inputs: orderedInputs("energy.annual_mwh", { draw_mw: baseline }),
    });
    const annualCo2 = derivedClaim({
      subject,
      predicate: "facility.annual_co2_tons",
      formulaId: "energy.annual_co2_tons",
      inputs: orderedInputs("energy.annual_co2_tons", {
        annual_mwh: annualMwh,
        carbon_intensity_gco2_kwh: carbonIntensity,
      }),
    });
    const homes = derivedClaim({
      subject,
      predicate: "facility.homes_equivalent",
      formulaId: "energy.homes_equivalent",
      inputs: orderedInputs("energy.homes_equivalent", { annual_mwh: annualMwh }),
    });
    const risk = derivedClaim({
      subject,
      predicate: "facility.risk_score",
      formulaId: "energy.risk_score",
      inputs: orderedInputs("energy.risk_score", {
        year_built: yearBuilt,
        age_years: age,
        motor_efficiency_rating: map["facility.motor_efficiency_rating"],
        nameplate_draw_mw: nameplate,
        utilization_pct: utilization,
        baseline_draw_mw: baseline,
        peak_draw_mw: map["facility.peak_draw_mw"],
        carbon_intensity_gco2_kwh: carbonIntensity,
        mix_natural_gas: map["facility.source_mix.natural_gas"],
        mix_solar: map["facility.source_mix.solar"],
        mix_hydro: map["facility.source_mix.hydro"],
        mix_wind: map["facility.source_mix.wind"],
        mix_other: map["facility.source_mix.other"],
      }),
      caveats: ["Uses lib/risk.ts, the same function the UI renders."],
    });

    const capex = derivedClaim({
      subject,
      predicate: "facility.upgrade.capex_usd",
      formulaId: "upgrade.capex_usd",
      inputs: orderedInputs("upgrade.capex_usd", {
        solar_mw: map["facility.upgrade.solar_capacity_add_mw"],
        solar_capex_per_mw_usd: map["facility.upgrade.solar_capex_per_mw_usd"],
        vfd_capex_usd: map["facility.upgrade.vfd_capex_usd"],
      }),
      params: { vfd: true },
    });
    const savings = derivedClaim({
      subject,
      predicate: "facility.upgrade.annual_savings_usd",
      formulaId: "upgrade.savings_usd",
      inputs: orderedInputs("upgrade.savings_usd", {
        solar_mw: map["facility.upgrade.solar_capacity_add_mw"],
        solar_savings_per_mw_usd: map["facility.upgrade.solar_savings_per_mw_usd"],
        vfd_savings_usd: map["facility.upgrade.vfd_savings_usd"],
      }),
      params: { vfd: true },
    });
    const payback = derivedClaim({
      subject,
      predicate: "facility.upgrade.payback_years",
      formulaId: "upgrade.payback_years",
      inputs: orderedInputs("upgrade.payback_years", {
        capex_usd: capex,
        annual_savings_usd: savings,
      }),
    });

    claims.push(age, baseline, annualMwh, annualCo2, homes, risk, capex, savings, payback);

    // The seed carries a pre-computed bundle total. It must equal the derived
    // figure; if not, the bundle carries an unresolved conflict instead of
    // quietly preferring one of the two.
    const seedCapex = propertiesOf(features, id).upgrade_potential.capex_estimate_usd;
    const seedSavings = propertiesOf(features, id).upgrade_potential.annual_savings_usd;
    if (Math.abs(Number(capex.value) - seedCapex) > 0.5) {
      unresolved.push({
        subject,
        predicate: "facility.upgrade.capex_usd",
        reason: "conflict",
        detail: `Derived capex ${String(capex.value)} != seed capex ${seedCapex}`,
        candidate_claim_ids: [capex.id],
        escalated: false,
      });
    }
    if (Math.abs(Number(savings.value) - seedSavings) > 0.5) {
      unresolved.push({
        subject,
        predicate: "facility.upgrade.annual_savings_usd",
        reason: "conflict",
        detail: `Derived savings ${String(savings.value)} != seed savings ${seedSavings}`,
        candidate_claim_ids: [savings.id],
        escalated: false,
      });
    }

    map["facility.age_years"] = age;
    map["facility.baseline_draw_mw"] = baseline;
    map["facility.annual_mwh"] = annualMwh;
    map["facility.annual_co2_tons"] = annualCo2;
    map["facility.homes_equivalent"] = homes;
    map["facility.risk_score"] = risk;
    map["facility.upgrade.capex_usd"] = capex;
    map["facility.upgrade.annual_savings_usd"] = savings;
    map["facility.upgrade.payback_years"] = payback;
  }

  // ---- region rollups -------------------------------------------------------
  const ordered = [...facilityIds].sort();
  const claimList = (predicate: string) =>
    ordered.map((id) => findClaim(claims, facilitySubject(id), predicate));

  const sumDecimals: [string, number][] = [
    ["region.kpi_total_nameplate_mw", 1],
    ["region.kpi_total_draw_mw", 2],
    ["region.kpi_total_annual_mwh", 0],
    ["region.kpi_total_annual_co2_tons", 0],
  ];
  const predicateForSum: Record<string, string> = {
    "region.kpi_total_nameplate_mw": "facility.nameplate_draw_mw",
    "region.kpi_total_draw_mw": "facility.baseline_draw_mw",
    "region.kpi_total_annual_mwh": "facility.annual_mwh",
    "region.kpi_total_annual_co2_tons": "facility.annual_co2_tons",
  };
  for (const [regionPredicate, decimals] of sumDecimals) {
    claims.push(
      derivedClaim({
        subject: region,
        predicate: regionPredicate,
        formulaId: "region.sum",
        inputs: claimList(predicateForSum[regionPredicate]),
        params: { decimals },
      }),
    );
  }

  const ciClaims = claimList("facility.carbon_intensity_gco2_kwh");
  const drawClaims = claimList("facility.baseline_draw_mw");
  const pairs: Claim[] = [];
  for (let i = 0; i < ordered.length; i += 1) {
    pairs.push(ciClaims[i], drawClaims[i]);
  }
  claims.push(
    derivedClaim({
      subject: region,
      predicate: "region.kpi_carbon_intensity_gco2_kwh",
      formulaId: "region.weighted_mean",
      inputs: pairs,
      params: { decimals: 1 },
      caveats: ["Draw-weighted mean of the modelled facility carbon intensities."],
    }),
  );

  // ---- assemble -------------------------------------------------------------
  const deduped = dedupeClaims(claims).sort(
    (a, b) => a.subject.localeCompare(b.subject) || a.predicate.localeCompare(b.predicate) || a.id.localeCompare(b.id),
  );
  const resolutions = resolveConflicts(deduped, sources);
  const uniqueSnapshots = [...snapshots].sort((a, b) => a.id.localeCompare(b.id));

  const bundle: EvidenceBundle = {
    schema: EVIDENCE_SCHEMA,
    bundle_id: "",
    region: {
      id: profile.id,
      name: profile.name,
      state: profile.state,
      center: profile.center,
      radius_miles: profile.radius_miles,
      bounds: profile.bounds,
    },
    generated_at: (options.now ?? new Date()).toISOString(),
    registry_digest: computeRegistryDigest(sources),
    sources,
    snapshots: uniqueSnapshots,
    claims: deduped,
    resolutions,
    unresolved,
    disclosures: profile.disclosures,
    verification: {
      ok: false,
      verified_at: "",
      bundle_id: "",
      errors: [],
      warnings: [],
      checks: [],
    },
    stats: {
      claims: deduped.length,
      observed: deduped.filter((claim) => claim.method === "observed").length,
      derived: deduped.filter((claim) => claim.method === "derived").length,
      modeled: deduped.filter((claim) => claim.method === "modeled").length,
      inferred: deduped.filter((claim) => claim.method === "inferred").length,
      sources: sources.length,
      snapshots: uniqueSnapshots.length,
      unresolved: unresolved.length,
    },
  };

  bundle.bundle_id = computeBundleId(bundle);
  const { report } = verifyBundle(bundle, {
    strict: false,
    enforceFreshness: true,
    now: options.now ?? new Date(),
  });
  bundle.verification = report;
  if (!report.ok) {
    const details = report.errors
      .slice(0, 12)
      .map((entry) => `  ${entry.code}: ${entry.detail}`)
      .join("\n");
    throw new Error(
      `evidence bundle failed verification with ${report.errors.length} error(s):\n${details}`,
    );
  }

  const outPath = options.out ?? profile.output;
  const absoluteOut = resolve(REPO_ROOT, outPath);
  await mkdir(dirname(absoluteOut), { recursive: true });
  await writeFile(absoluteOut, `${JSON.stringify(bundle, null, 2)}\n`);
  return bundle;
}

function propertiesOf(features: SeedFeature[], id: string): SeedFeature["properties"] {
  const feature = features.find((candidate) => candidate.properties.id === id);
  if (!feature) throw new Error(`missing seed feature ${id}`);
  return feature.properties;
}
