/**
 * Municipality + buildout time-series engine.
 *
 * One call builds the physical model from a scenario, runs a design day or a
 * weather year through the radial power flow, accumulates the stats the UI
 * needs, and screens the peak condition for frequency and voltage stability.
 *
 * The engine is intentionally deterministic: no random Monte Carlo, no wall
 * clock. The same scenario and year always produce the same numbers.
 */

import {
  branchImpedanceOhms,
  defaultConductorForVoltage,
  getConductor,
  hostingCapacity,
  radialPowerFlow,
  voltageCollapseMargin,
  type BranchSpec,
  type BusSpec,
  type RadialNetwork,
  type RadialPowerFlowResult,
} from "./network";
import {
  conductorHeatBalance,
  initTransformerState,
  stepTransformer,
  transformerLossOfLifePct,
  transformerRemainingLifeYears,
  type TransformerSpec,
  type TransformerState,
} from "./thermal";
import {
  annualLoadMwh,
  bessStep,
  initBess,
  loadAt,
  solarAt,
  syntheticWeatherDay,
  syntheticWeatherYear,
  windPower,
  SECTOR_HVAC_SHARE,
  type BessSpec,
  type BessState,
  type LoadSpec,
  type SolarSpec,
  type WeatherPoint,
  type WeatherScenario,
  type WindSpec,
} from "./load";
import {
  defaultUflsStages,
  frequencyEvent,
  stabilityScore,
  systemInertia,
  type InertiaSource,
} from "./dynamics";
import {
  DEFAULT_ECONOMICS,
  lossSavingsUsd,
  municipalLcoe,
  unservedEnergyCost,
  type EconomicAssumptions,
} from "./economics";
import { clamp, roundTo } from "./units";
import {
  BUILDOUT_LABELS,
  DEFAULT_RELIABILITY,
  type BessDispatchSpec,
  type BuildoutProject,
  type BuildoutStats,
  type BuiltFeeder,
  type BuiltMunicipality,
  type CapacityStats,
  type DemandStats,
  type EconomicStats,
  type EmissionStats,
  type FeederStats,
  type HourlyPoint,
  type LossStats,
  type MunicipalityResult,
  type MunicipalityScenario,
  type MunicipalityStats,
  type PeakSnapshot,
  type ReliabilityStats,
  type SimulationOptions,
  type StabilityStats,
  type ThermalStats,
  type VoltageStats,
} from "./municipalityTypes";

// ---- Build the physical topology -------------------------------------------

function buildoutLoadSpec(project: BuildoutProject): LoadSpec {
  const hvac = project.hvac_share ?? SECTOR_HVAC_SHARE[project.sector];
  return {
    id: `buildout-${project.id}`,
    sector: project.sector,
    peak_mw: Math.max(0, project.peak_mw),
    power_factor: clamp(project.power_factor, 0.5, 1),
    hvac_share: clamp(hvac, 0, 0.9),
    cooling_balance_c: project.cooling_balance_c,
    cooling_design_c: project.cooling_design_c,
    heating_balance_c: project.heating_balance_c,
    heating_design_c: project.heating_design_c,
    shape: project.shape,
  };
}

function computePathMiles(
  busIds: readonly string[],
  branches: readonly BranchSpec[],
  slackId: string,
): Record<string, number> {
  const adjacency = new Map<string, { to: string; miles: number }[]>();
  for (const id of busIds) adjacency.set(id, []);
  for (const branch of branches) {
    adjacency.get(branch.from_bus)?.push({ to: branch.to_bus, miles: branch.length_mi });
    adjacency.get(branch.to_bus)?.push({ to: branch.from_bus, miles: branch.length_mi });
  }
  const result: Record<string, number> = { [slackId]: 0 };
  const queue = [slackId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const base = result[current] ?? 0;
    for (const edge of adjacency.get(current) ?? []) {
      if (edge.to in result) continue;
      result[edge.to] = base + edge.miles;
      queue.push(edge.to);
    }
  }
  return result;
}

/**
 * Build the physical topology for a year. Buildout projects are added only
 * when they are energized, so a 2026 study and a 2032 study have different
 * feeder trees, not just different load numbers.
 */
export function buildMunicipality(
  scenario: MunicipalityScenario,
  year = scenario.base_year,
  includeBuildouts = true,
): BuiltMunicipality {
  const activeBuildouts = includeBuildouts
    ? scenario.buildouts.filter((p) => p.energize_year <= year)
    : [];
  const buildoutBus: Record<string, string> = {};
  const feeders: BuiltFeeder[] = [];

  for (const feeder of scenario.feeders) {
    const busIds: string[] = [feeder.slack_bus.id, ...feeder.buses.map((b) => b.id)];
    const branches: BranchSpec[] = [...feeder.branches];
    const loadsByBus: Record<string, LoadSpec[]> = {};
    const solarByBus: Record<string, SolarSpec[]> = {};
    const windByBus: Record<string, WindSpec[]> = {};
    const bessByBus: Record<string, BessSpec[]> = {};
    const customersByBus: Record<string, number> = {};
    const busKv: Record<string, number> = {
      [feeder.slack_bus.id]: feeder.voltage_kv,
    };

    loadsByBus[feeder.slack_bus.id] = [];
    solarByBus[feeder.slack_bus.id] = [];
    windByBus[feeder.slack_bus.id] = [];
    bessByBus[feeder.slack_bus.id] = [];
    customersByBus[feeder.slack_bus.id] = feeder.slack_bus.customers ?? 0;

    for (const bus of feeder.buses) {
      busKv[bus.id] = bus.base_kv;
      loadsByBus[bus.id] = [...bus.loads];
      solarByBus[bus.id] = [...(bus.solar ?? [])];
      windByBus[bus.id] = [...(bus.wind ?? [])];
      bessByBus[bus.id] = [...(bus.bess ?? [])];
      customersByBus[bus.id] = Math.max(0, bus.customers);
    }

    for (const project of activeBuildouts.filter((p) => p.feeder_id === feeder.id)) {
      let target = project.bus_id;
      if (!(target in loadsByBus)) {
        throw new Error(
          `Buildout "${project.id}" attaches to unknown bus "${project.bus_id}" on feeder "${feeder.id}"`,
        );
      }

      if (project.new_bus) {
        const newBus = project.new_bus;
        if (newBus.id in loadsByBus) {
          throw new Error(`Buildout "${project.id}" creates duplicate bus "${newBus.id}"`);
        }
        if (!(newBus.connection_length_mi > 0)) {
          throw new Error(`Buildout "${project.id}" needs a positive connection length`);
        }
        busIds.push(newBus.id);
        busKv[newBus.id] = feeder.voltage_kv;
        loadsByBus[newBus.id] = [];
        solarByBus[newBus.id] = [];
        windByBus[newBus.id] = [];
        bessByBus[newBus.id] = [];
        customersByBus[newBus.id] = Math.max(0, newBus.customers);
        branches.push({
          id: `bo-${project.id}`,
          from_bus: target,
          to_bus: newBus.id,
          voltage_kv: feeder.voltage_kv,
          length_mi: newBus.connection_length_mi,
          conductor: newBus.conductor,
          circuits: newBus.circuits ?? 1,
          phase_spacing_ft: newBus.phase_spacing_ft,
        });
        target = newBus.id;
      }

      loadsByBus[target].push(buildoutLoadSpec(project));
      if (project.solar) solarByBus[target].push(project.solar);
      if (project.wind) windByBus[target].push(project.wind);
      if (project.bess) bessByBus[target].push(project.bess);
      buildoutBus[project.id] = target;
    }

    const totalPeak = Object.values(loadsByBus)
      .flat()
      .reduce((sum, load) => sum + Math.max(0, load.peak_mw), 0);
    const sBase = Math.max(1, totalPeak * 1.5);
    const pathMiles = computePathMiles(busIds, branches, feeder.slack_bus.id);

    feeders.push({
      scenario: feeder,
      s_base_mva: roundTo(sBase, 3),
      network: {
        id: feeder.id,
        slack_bus_id: feeder.slack_bus.id,
        buses: busIds.map((id) => ({
          id,
          base_kv: busKv[id] ?? feeder.voltage_kv,
          load_mw: 0,
          load_mvar: 0,
          der_mw: 0,
          der_mvar: 0,
        })),
        branches,
      },
      loadsByBus,
      solarByBus,
      windByBus,
      bessByBus,
      customersByBus,
      pathMilesByBus: pathMiles,
      targetBuses: busIds,
    });
  }

  return {
    scenario,
    year,
    include_buildouts: includeBuildouts,
    feeders,
    activeBuildouts,
    buildoutBus,
  };
}

// ---- Weather ---------------------------------------------------------------

interface WeatherRun {
  points: WeatherPoint[];
  day_of_year: number[];
  hour_of_day: number[];
}

export function buildWeather(
  scenario: WeatherScenario,
  options: SimulationOptions = {},
): WeatherRun {
  const requested = clamp(Math.floor(options.hours ?? 8760), 1, 8784);
  const start = Math.max(0, Math.floor(options.start_hour ?? 0));
  const supplied = scenario.hourly;

  if (supplied && supplied.length > 0) {
    const points = supplied.slice(start, start + requested);
    if (points.length < requested) {
      throw new Error(
        `Weather series has ${supplied.length} hours but ${requested} were requested from offset ${start}`,
      );
    }
    return {
      points,
      day_of_year: points.map((_, i) => Math.floor((start + i) / 24) + 1),
      hour_of_day: points.map((_, i) => (start + i) % 24),
    };
  }

  if (requested <= 24) {
    const high =
      scenario.design_high_c ??
      scenario.annual_mean_c + scenario.annual_amplitude_c + scenario.diurnal_amplitude_c;
    const low =
      scenario.design_low_c ??
      scenario.annual_mean_c - scenario.annual_amplitude_c - scenario.diurnal_amplitude_c;
    const points = syntheticWeatherDay(
      {
        latitude_deg: scenario.latitude_deg,
        annual_mean_c: scenario.annual_mean_c,
        diurnal_amplitude_c: scenario.diurnal_amplitude_c,
        high_c: high,
        low_c: low,
        wind_mean_mps: scenario.wind_mean_mps,
        clearness: scenario.clearness,
        day_of_year: 230,
      },
      230,
    ).slice(0, requested);
    return {
      points,
      day_of_year: points.map(() => 230),
      hour_of_day: points.map((_, i) => i % 24),
    };
  }

  const full = syntheticWeatherYear(scenario);
  const points = full.slice(start, Math.min(full.length, start + requested));
  return {
    points,
    day_of_year: points.map((_, i) => Math.floor((start + i) / 24) + 1),
    hour_of_day: points.map((_, i) => (start + i) % 24),
  };
}

// ---- Run model -------------------------------------------------------------

interface FeederAccumulator {
  id: string;
  name: string;
  annual_mwh: number;
  losses_mwh: number;
  peak_load_mw: number;
  min_voltage_pu: number;
  max_voltage_pu: number;
  max_branch_loading_pct: number;
  violation_hours: number;
  infeasible_hours: number;
  overload_branch_hours: number;
  bus_voltage_min: Record<string, number>;
  bus_annual_mwh: Record<string, number>;
  worst_bus: string | null;
  hosting_capacity_mw: number;
}

interface PeakModel {
  index: number;
  ambient_c: number;
  weather: WeatherPoint;
  load_mw: number;
  min_voltage_pu: number;
  max_voltage_pu: number;
  max_branch_loading_pct: number;
  transformer_loading_pct: number;
  feeder_voltages: Record<string, { min_pu: number; max_pu: number }>;
  bus_voltages: Record<string, number>;
  bus_load_mw: Record<string, number>;
  networks: Map<string, RadialNetwork>;
  worst_bus_by_feeder: Record<string, string>;
  branch_currents: Record<string, number>;
}

interface RunModel {
  demand: { peak_mw: number; min_mw: number; sum_mwh: number; grid_mwh: number };
  voltage: {
    min_pu: number;
    max_pu: number;
    max_drop_pct: number;
    violation_hours: number;
    infeasible_hours: number;
  };
  losses: { sum_mwh: number; peak_mw: number };
  thermal: {
    state: TransformerState;
    peak_loading_pct: number;
    hotspot_max_c: number;
    top_oil_max_c: number;
  };
  feeders: Map<string, FeederAccumulator>;
  peak: PeakModel;
  hourly: HourlyPoint[];
  line_overload_hours: number;
}

function bessRequest(
  spec: BessSpec,
  hour: number,
  dispatch?: BessDispatchSpec,
): number {
  const discharge = dispatch?.discharge_hours ?? [17, 18, 19, 20, 21];
  const charge = dispatch?.charge_hours ?? [9, 10, 11, 12, 13, 14, 15];
  if (discharge.includes(hour)) return spec.power_mw;
  if (charge.includes(hour)) return -spec.power_mw;
  return 0;
}

function calibrationMap(
  built: BuiltMunicipality,
  points: readonly WeatherPoint[],
): Map<string, number> {
  const map = new Map<string, number>();
  if (points.length < 8000) return map; // only calibrate against a full year
  for (const feeder of built.feeders) {
    for (const [busId, loads] of Object.entries(feeder.loadsByBus)) {
      void busId;
      for (const load of loads) {
        if (!load.annual_mwh || load.annual_mwh <= 0) continue;
        const simulated = annualLoadMwh(load, points);
        if (simulated > 0) {
          map.set(`${feeder.scenario.id}:${load.id}`, load.annual_mwh / simulated);
        }
      }
    }
  }
  return map;
}

function emptyPeak(): PeakModel {
  return {
    index: -1,
    ambient_c: 20,
    weather: { ambient_c: 20, wind_mps: 0, solar_w_m2: 0 },
    load_mw: 0,
    min_voltage_pu: 1,
    max_voltage_pu: 1,
    max_branch_loading_pct: 0,
    transformer_loading_pct: 0,
    feeder_voltages: {},
    bus_voltages: {},
    bus_load_mw: {},
    networks: new Map(),
    worst_bus_by_feeder: {},
    branch_currents: {},
  };
}

function runModel(
  built: BuiltMunicipality,
  weather: WeatherRun,
  options: SimulationOptions,
): RunModel {
  const scenario = built.scenario;
  const transformer = scenario.substation.transformer;
  const vMin = options.voltage_min_pu ?? 0.95;
  const vMax = options.voltage_max_pu ?? 1.05;
  const hours = weather.points.length;
  const calibration = calibrationMap(built, weather.points);

  const feeders = new Map<string, FeederAccumulator>();
  for (const feeder of built.feeders) {
    feeders.set(feeder.scenario.id, {
      id: feeder.scenario.id,
      name: feeder.scenario.name,
      annual_mwh: 0,
      losses_mwh: 0,
      peak_load_mw: 0,
      min_voltage_pu: 1,
      max_voltage_pu: 1,
      max_branch_loading_pct: 0,
      violation_hours: 0,
      infeasible_hours: 0,
      overload_branch_hours: 0,
      bus_voltage_min: {},
      bus_annual_mwh: {},
      worst_bus: null,
      hosting_capacity_mw: 0,
    });
  }

  let thermalState = initTransformerState(weather.points[0]?.ambient_c ?? 20);
  const bessStates = new Map<string, BessState>();
  const model: RunModel = {
    demand: { peak_mw: 0, min_mw: Number.POSITIVE_INFINITY, sum_mwh: 0, grid_mwh: 0 },
    voltage: {
      min_pu: 1,
      max_pu: 1,
      max_drop_pct: 0,
      violation_hours: 0,
      infeasible_hours: 0,
    },
    losses: { sum_mwh: 0, peak_mw: 0 },
    thermal: {
      state: thermalState,
      peak_loading_pct: 0,
      hotspot_max_c: 0,
      top_oil_max_c: 0,
    },
    feeders,
    peak: emptyPeak(),
    hourly: [],
    line_overload_hours: 0,
  };

  for (let i = 0; i < hours; i += 1) {
    const weatherPoint = weather.points[i];
    const ambient = weatherPoint.ambient_c;
    const hour = weather.hour_of_day[i];
    const day = weather.day_of_year[i];

    let totalLoad = 0;
    let totalSolar = 0;
    let totalWind = 0;
    let totalBattery = 0;
    let totalLoss = 0;
    let overloadBranchCount = 0;
    let substationMw = 0;
    let substationMvar = 0;
    let minV = 1;
    let maxV = 1;
    let maxLoading = 0;
    let anyViolation = false;
    let anyInfeasible = false;

    const currentFeederVoltages: PeakModel["feeder_voltages"] = {};
    const currentBusVoltages: Record<string, number> = {};
    const currentBusLoads: Record<string, number> = {};
    const currentNetworks = new Map<string, RadialNetwork>();
    const currentWorst: Record<string, string> = {};
    const currentBranchCurrents: Record<string, number> = {};

    for (const feeder of built.feeders) {
      const builtHour = builtBusSpecs(built, feeder, {
        hour,
        day,
        ambient,
        weatherPoint,
        calibration,
        bessStates,
      });
      const busSpecs: BusSpec[] = builtHour.buses;
      const network: RadialNetwork = { ...feeder.network, buses: busSpecs };
      const result: RadialPowerFlowResult = radialPowerFlow(network, {
        s_base_mva: feeder.s_base_mva,
      });

      const feederLoad = busSpecs.reduce((sum, bus) => sum + bus.load_mw, 0);
      const feederLoss = result.total_loss_mw;
      const feederMaxLoading = Math.max(0, ...result.branches.map((b) => b.loading_pct));
      const feederMinV = result.min_voltage_pu;
      const feederMaxV = result.max_voltage_pu;
      const violation =
        !result.converged ||
        feederMinV < vMin ||
        feederMaxV > vMax ||
        feederMaxLoading > 100;

      const acc = feeders.get(feeder.scenario.id)!;
      acc.annual_mwh += feederLoad;
      acc.losses_mwh += feederLoss;
      acc.peak_load_mw = Math.max(acc.peak_load_mw, feederLoad);
      acc.min_voltage_pu = Math.min(acc.min_voltage_pu, feederMinV);
      acc.max_voltage_pu = Math.max(acc.max_voltage_pu, feederMaxV);
      acc.max_branch_loading_pct = Math.max(acc.max_branch_loading_pct, feederMaxLoading);
      acc.violation_hours += violation ? 1 : 0;
      acc.infeasible_hours += result.converged ? 0 : 1;
      const feederOverloads = result.branches.filter((b) => b.loading_pct > 100).length;
      acc.overload_branch_hours += feederOverloads;
      overloadBranchCount += feederOverloads;

      let worstBus = feeder.scenario.slack_bus.id;
      let worstV = Number.POSITIVE_INFINITY;
      for (const bus of result.buses) {
        acc.bus_voltage_min[bus.id] = Math.min(
          acc.bus_voltage_min[bus.id] ?? 1,
          bus.voltage_pu,
        );
        const load = busSpecs.find((b) => b.id === bus.id)?.load_mw ?? 0;
        acc.bus_annual_mwh[bus.id] = (acc.bus_annual_mwh[bus.id] ?? 0) + load;
        currentBusVoltages[bus.id] = bus.voltage_pu;
        currentBusLoads[bus.id] = load;
        if (bus.voltage_pu < worstV) {
          worstV = bus.voltage_pu;
          worstBus = bus.id;
        }
      }
      acc.worst_bus = worstBus;
      currentWorst[feeder.scenario.id] = worstBus;
      currentFeederVoltages[feeder.scenario.id] = {
        min_pu: feederMinV,
        max_pu: feederMaxV,
      };
      for (const branch of result.branches) {
        currentBranchCurrents[`${feeder.scenario.id}:${branch.id}`] = branch.current_a;
      }
      currentNetworks.set(feeder.scenario.id, network);

      totalLoad += feederLoad;
      totalSolar += builtHour.solar_mw;
      totalWind += builtHour.wind_mw;
      totalBattery += builtHour.battery_mw;
      totalLoss += feederLoss;
      substationMw += result.slack_mw;
      substationMvar += result.slack_mvar;
      minV = Math.min(minV, feederMinV);
      maxV = Math.max(maxV, feederMaxV);
      maxLoading = Math.max(maxLoading, feederMaxLoading);
      anyViolation = anyViolation || violation;
      anyInfeasible = anyInfeasible || !result.converged;
    }

    const transformerApparent = Math.hypot(substationMw, substationMvar);
    thermalState = stepTransformer(
      transformer,
      thermalState,
      Math.max(0, transformerApparent),
      ambient,
      1,
    );
    model.thermal.state = thermalState;
    model.thermal.peak_loading_pct = Math.max(
      model.thermal.peak_loading_pct,
      thermalState.loading_pct,
    );
    model.thermal.hotspot_max_c = Math.max(
      model.thermal.hotspot_max_c,
      thermalState.hotspot_c,
    );
    model.thermal.top_oil_max_c = Math.max(
      model.thermal.top_oil_max_c,
      thermalState.top_oil_c,
    );

    model.demand.sum_mwh += totalLoad;
    model.demand.grid_mwh += Math.max(0, substationMw);
    model.demand.peak_mw = Math.max(model.demand.peak_mw, totalLoad);
    model.demand.min_mw = Math.min(model.demand.min_mw, totalLoad);
    model.losses.sum_mwh += totalLoss;
    model.losses.peak_mw = Math.max(model.losses.peak_mw, totalLoss);
    model.voltage.min_pu = Math.min(model.voltage.min_pu, minV);
    model.voltage.max_pu = Math.max(model.voltage.max_pu, maxV);
    model.voltage.max_drop_pct = Math.max(model.voltage.max_drop_pct, (1 - minV) * 100);
    model.voltage.violation_hours += anyViolation ? 1 : 0;
    model.voltage.infeasible_hours += anyInfeasible ? 1 : 0;
    model.line_overload_hours += overloadBranchCount;

    if (model.peak.index < 0 || totalLoad > model.peak.load_mw) {
      model.peak = {
        index: i,
        ambient_c: ambient,
        weather: weatherPoint,
        load_mw: totalLoad,
        min_voltage_pu: minV,
        max_voltage_pu: maxV,
        max_branch_loading_pct: maxLoading,
        transformer_loading_pct: thermalState.loading_pct,
        feeder_voltages: currentFeederVoltages,
        bus_voltages: currentBusVoltages,
        bus_load_mw: currentBusLoads,
        networks: currentNetworks,
        worst_bus_by_feeder: currentWorst,
        branch_currents: currentBranchCurrents,
      };
    }

    if (options.record_hourly) {
      model.hourly.push({
        index: i,
        hour,
        ambient_c: roundTo(ambient, 2),
        load_mw: roundTo(totalLoad, 3),
        solar_mw: roundTo(totalSolar, 3),
        wind_mw: roundTo(totalWind, 3),
        bess_mw: roundTo(totalBattery, 3),
        losses_mw: roundTo(totalLoss, 4),
        min_voltage_pu: roundTo(minV, 5),
        max_branch_loading_pct: roundTo(maxLoading, 2),
        transformer_hotspot_c: roundTo(thermalState.hotspot_c, 2),
      });
    }
  }

  if (model.peak.index < 0) {
    model.peak.index = 0;
  }
  if (!Number.isFinite(model.demand.min_mw)) model.demand.min_mw = 0;

  if (options.compute_hosting !== false) {
    for (const [feederId, acc] of feeders) {
      const network = model.peak.networks.get(feederId);
      const worstBus = model.peak.worst_bus_by_feeder[feederId];
      if (!network || !worstBus) continue;
      const hosting = hostingCapacity(network, worstBus, {
        max_der_mw: Math.max(5, model.peak.load_mw * 2),
      });
      acc.hosting_capacity_mw = hosting.hosting_capacity_mw;
    }
  }

  return model;
}

interface BuiltBusContext {
  hour: number;
  day: number;
  ambient: number;
  weatherPoint: WeatherPoint;
  calibration: Map<string, number>;
  bessStates: Map<string, BessState>;
}

interface BuiltBusResult {
  buses: BusSpec[];
  solar_mw: number;
  wind_mw: number;
  battery_mw: number;
}

function builtBusSpecs(
  built: BuiltMunicipality,
  feeder: BuiltFeeder,
  ctx: BuiltBusContext,
): BuiltBusResult {
  let totalSolar = 0;
  let totalWind = 0;
  let totalBattery = 0;
  const buses = feeder.network.buses.map((bus) => {
    let p = 0;
    let q = 0;
    for (const load of feeder.loadsByBus[bus.id] ?? []) {
      const scale = ctx.calibration.get(`${feeder.scenario.id}:${load.id}`) ?? 1;
      const point = loadAt(
        { ...load, peak_mw: load.peak_mw * scale },
        ctx.hour,
        ctx.ambient,
      );
      p += point.p_mw;
      q += point.q_mvar;
    }

    let solar = 0;
    for (const spec of feeder.solarByBus[bus.id] ?? []) {
      solar += solarAt(
        spec,
        ctx.weatherPoint,
        built.scenario.latitude_deg,
        ctx.day,
        ctx.hour,
      ).ac_mw;
    }

    let wind = 0;
    for (const spec of feeder.windByBus[bus.id] ?? []) {
      wind += windPower(spec, ctx.weatherPoint.wind_mps);
    }

    let battery = 0;
    for (const spec of feeder.bessByBus[bus.id] ?? []) {
      const key = `${feeder.scenario.id}:${bus.id}:${spec.id}`;
      const state = ctx.bessStates.get(key) ?? initBess(spec);
      ctx.bessStates.set(key, state);
      const request = bessRequest(spec, ctx.hour, built.scenario.bess_dispatch);
      const step = bessStep(spec, state, request, 1);
      ctx.bessStates.set(key, step.state);
      battery += step.actual_mw;
    }

    totalSolar += solar;
    totalWind += wind;
    totalBattery += battery;

    return {
      id: bus.id,
      base_kv: bus.base_kv,
      load_mw: Math.max(0, p),
      load_mvar: Math.max(0, q),
      der_mw: solar + wind + battery,
      der_mvar: 0,
    };
  });
  return {
    buses,
    solar_mw: totalSolar,
    wind_mw: totalWind,
    battery_mw: totalBattery,
  };
}

// ---- Reliability -----------------------------------------------------------

function computeReliability(
  scenario: MunicipalityScenario,
  built: BuiltMunicipality,
  model: RunModel,
  hours: number,
): ReliabilityStats {
  const assumptions = { ...DEFAULT_RELIABILITY, ...scenario.reliability };
  let totalCustomers = 0;
  for (const feeder of built.feeders) {
    for (const customers of Object.values(feeder.customersByBus)) {
      totalCustomers += Math.max(0, customers);
    }
  }

  let customerMinutes = 0;
  let customerInterruptions = 0;
  let unservedMwh = 0;
  let customerHours = 0;
  let worstBus: string | null = null;
  let worstContribution = 0;

  for (const feeder of built.feeders) {
    const acc = model.feeders.get(feeder.scenario.id);
    if (!acc) continue;
    for (const [busId, customers] of Object.entries(feeder.customersByBus)) {
      if (customers <= 0) continue;
      const miles = feeder.pathMilesByBus[busId] ?? 0;
      const lambda =
        assumptions.failure_rate_per_mi_year *
        miles *
        assumptions.permanent_fault_fraction;
      const avgLoad = (acc.bus_annual_mwh[busId] ?? 0) / Math.max(1, hours);
      const contribution = lambda * assumptions.repair_hours * avgLoad;
      customerMinutes += lambda * assumptions.repair_hours * 60 * customers;
      customerInterruptions += lambda * customers;
      unservedMwh += contribution;
      customerHours += lambda * assumptions.repair_hours * customers;
      if (contribution > worstContribution) {
        worstContribution = contribution;
        worstBus = busId;
      }
    }
  }

  return {
    saidi_min:
      totalCustomers > 0 ? roundTo(customerMinutes / totalCustomers, 1) : 0,
    saifi:
      totalCustomers > 0 ? roundTo(customerInterruptions / totalCustomers, 3) : 0,
    unserved_mwh: roundTo(unservedMwh, 2),
    customer_hours: roundTo(customerHours, 1),
    worst_bus: worstBus,
  };
}

// ---- Stability -------------------------------------------------------------

function modeledGeneration(
  scenario: MunicipalityScenario,
  peakMw: number,
): { sources: InertiaSource[]; basis: "provided" | "modeled" } {
  if (scenario.generation && scenario.generation.length > 0) {
    return { sources: scenario.generation, basis: "provided" };
  }
  const mix = scenario.source_mix ?? {
    natural_gas: 55,
    solar: 20,
    hydro: 10,
    wind: 5,
    other: 10,
  };
  const installed = Math.max(1, peakMw / 0.85);
  return {
    basis: "modeled",
    sources: [
      { id: "modeled-gas", type: "gas_cc", mva: (installed * mix.natural_gas) / 100 },
      { id: "modeled-solar", type: "solar", mva: (installed * mix.solar) / 100 },
      { id: "modeled-hydro", type: "hydro", mva: (installed * mix.hydro) / 100 },
      { id: "modeled-wind", type: "wind", mva: (installed * mix.wind) / 100 },
      { id: "modeled-other", type: "other", mva: (installed * mix.other) / 100 },
    ],
  };
}

function pathImpedance(
  network: RadialNetwork,
  busId: string,
  sBaseMva: number,
): { r_ohm: number; x_ohm: number } {
  const adjacency = new Map<string, { branch: BranchSpec; other: string }[]>();
  for (const bus of network.buses) adjacency.set(bus.id, []);
  for (const branch of network.branches) {
    adjacency.get(branch.from_bus)?.push({ branch, other: branch.to_bus });
    adjacency.get(branch.to_bus)?.push({ branch, other: branch.from_bus });
  }
  const parent = new Map<string, { branch: BranchSpec; from: string }>();
  const queue = [network.slack_bus_id];
  const visited = new Set([network.slack_bus_id]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of adjacency.get(current) ?? []) {
      if (visited.has(edge.other)) continue;
      visited.add(edge.other);
      parent.set(edge.other, { branch: edge.branch, from: current });
      queue.push(edge.other);
    }
  }

  let r = 0;
  let x = 0;
  let cursor = busId;
  while (cursor !== network.slack_bus_id) {
    const entry = parent.get(cursor);
    if (!entry) break;
    const base = { s_mva: sBaseMva, v_kv: entry.branch.voltage_kv };
    const z = branchImpedanceOhms(entry.branch, base);
    r += z.r_ohm;
    x += z.x_ohm;
    cursor = entry.from;
  }
  return { r_ohm: r, x_ohm: x };
}

function computeStability(
  scenario: MunicipalityScenario,
  built: BuiltMunicipality,
  peak: PeakModel,
): StabilityStats {
  const generation = modeledGeneration(scenario, peak.load_mw);
  const inertia = systemInertia(generation.sources);
  const systemMva = Math.max(1, inertia.online_mva, peak.load_mw);
  const maxUnit = Math.max(
    0,
    ...generation.sources.filter((s) => s.online !== false).map((s) => s.mva),
  );
  const contingency = clamp(
    Math.max(1, peak.load_mw * 0.1, maxUnit * 0.8),
    1,
    Math.max(1, peak.load_mw * 0.8),
  );

  let ffrMw = scenario.ffr_mw ?? 0;
  if (scenario.ffr_mw === undefined) {
    for (const feeder of built.feeders) {
      for (const specs of Object.values(feeder.bessByBus)) {
        ffrMw += specs.reduce((sum, spec) => sum + spec.power_mw, 0);
      }
    }
  }

  const frequency = frequencyEvent({
    system_mva: systemMva,
    inertia_mws: inertia.inertia_mws,
    loss_mw: contingency,
    governor_reserve_mw: systemMva * 0.1,
    bess_mw: ffrMw,
    ufls: defaultUflsStages(peak.load_mw),
    duration_s: 60,
    dt_s: 0.02,
    record_every_s: 1,
  });

  const sourceSc =
    scenario.substation.source_sc_mva ??
    scenario.substation.transformer.rating_mva * 25;
  const zSource =
    scenario.substation.transformer.rating_mva / Math.max(1, sourceSc);
  const zTx = scenario.substation.transformer.impedance_pct / 100;
  const faultMva =
    scenario.substation.transformer.rating_mva / Math.max(1e-6, zSource + zTx);
  const scr = faultMva / Math.max(0.1, peak.load_mw);

  let pvMargin = 100;
  let criticalVoltage = 1;
  for (const feeder of built.feeders) {
    const network = peak.networks.get(feeder.scenario.id);
    const worstBus = peak.worst_bus_by_feeder[feeder.scenario.id];
    if (!network || !worstBus) continue;
    const bus = network.buses.find((b) => b.id === worstBus);
    if (!bus) continue;
    const p = Math.max(0.1, bus.load_mw - (bus.der_mw ?? 0));
    const q = Math.max(0, bus.load_mvar);
    const path = pathImpedance(network, worstBus, feeder.s_base_mva);
    const margin = voltageCollapseMargin({
      sending_kv: feeder.scenario.voltage_kv,
      p_mw: p,
      q_mvar: q,
      r_ohm: path.r_ohm,
      x_ohm: path.x_ohm,
    });
    if (margin.margin_pct < pvMargin) {
      pvMargin = margin.margin_pct;
      criticalVoltage = margin.critical_voltage_pu;
    }
  }

  const hSys = inertia.inertia_mws / systemMva;
  const verdict = stabilityScore({
    rocof_hz_s: frequency.rocof_hz_s,
    nadir_hz: frequency.nadir_hz,
    h_sys_s: hSys,
    scr,
  });

  return {
    basis: generation.basis,
    inertia_mws: roundTo(inertia.inertia_mws, 2),
    h_sys_s: roundTo(hSys, 3),
    synchronous_share_pct: inertia.synchronous_share_pct,
    scr: roundTo(scr, 3),
    fault_mva: roundTo(faultMva, 1),
    contingency_mw: roundTo(contingency, 2),
    rocof_hz_s: frequency.rocof_hz_s,
    nadir_hz: frequency.nadir_hz,
    steady_state_hz: frequency.steady_state_hz,
    ufls_shed_mw: frequency.ufls_shed_mw,
    pv_margin_pct: roundTo(pvMargin, 1),
    critical_voltage_pu: roundTo(criticalVoltage, 4),
    score: verdict.score,
    band: verdict.band,
    binding: verdict.binding,
  };
}

// ---- Line thermal / unbalance ---------------------------------------------

function peakLineTemperature(
  built: BuiltMunicipality,
  peak: PeakModel,
): number {
  let maxTemp = 0;
  for (const feeder of built.feeders) {
    const network = peak.networks.get(feeder.scenario.id);
    if (!network) continue;
    for (const branch of network.branches) {
      const current = peak.branch_currents[`${feeder.scenario.id}:${branch.id}`];
      if (current === undefined) continue;
      const conductor = getConductor(
        branch.conductor ?? defaultConductorForVoltage(branch.voltage_kv),
      );
      const thermal = conductorHeatBalance(conductor, current, {
        ambient_c: peak.ambient_c,
        wind_mps: peak.weather.wind_mps,
        solar_w_m2: peak.weather.solar_w_m2,
      });
      maxTemp = Math.max(maxTemp, thermal.temperature_c);
    }
  }
  return roundTo(maxTemp, 1);
}

function peakUnbalance(built: BuiltMunicipality, peak: PeakModel): number {
  // Only buses that declare an A/B/C split can be unbalanced. Every other bus
  // (including buildout-created buses) is balanced and contributes zero to the
  // weighted deviation but still counts in the load denominator.
  const phaseSplits = new Map<string, readonly [number, number, number]>();
  for (const feeder of built.feeders) {
    for (const bus of feeder.scenario.buses) {
      if (bus.phase_split) phaseSplits.set(bus.id, bus.phase_split);
    }
  }

  let weighted = 0;
  let totalLoad = 0;
  for (const [busId, load] of Object.entries(peak.bus_load_mw)) {
    if (load <= 0) continue;
    totalLoad += load;
    const split = phaseSplits.get(busId);
    if (!split) continue;
    const sum = split.reduce((a, b) => a + b, 0) || 1;
    const fractions = split.map((v) => v / sum);
    const deviation = Math.max(...fractions.map((f) => Math.abs(f - 1 / 3)));
    weighted += (deviation / (1 / 3)) * 100 * load;
  }
  return totalLoad > 0 ? roundTo(weighted / totalLoad, 1) : 0;
}

// ---- Buildout stats --------------------------------------------------------

function computeBuildoutStats(
  scenario: MunicipalityScenario,
  built: BuiltMunicipality,
  model: RunModel,
  baseline: RunModel | null,
  weather: WeatherRun,
): BuildoutStats[] {
  return scenario.buildouts
    .filter((p) => p.feeder_id && scenario.feeders.some((f) => f.id === p.feeder_id))
    .map((project) => {
      const active = built.activeBuildouts.some((p) => p.id === project.id);
      const targetBus = built.buildoutBus[project.id] ?? project.bus_id;
      const spec = buildoutLoadSpec(project);
      const annual = annualLoadMwh(spec, weather.points, weather.hour_of_day);
      const peak = Math.max(
        0,
        ...weather.points.map((wp, i) =>
          loadAt(spec, weather.hour_of_day[i], wp.ambient_c).p_mw,
        ),
      );
      const feederBefore = baseline?.feeders.get(project.feeder_id);
      const feederAfter = model.feeders.get(project.feeder_id);
      const voltageBefore = baseline?.peak.bus_voltages[targetBus];
      const voltageAfter = model.peak.bus_voltages[targetBus];
      return {
        id: project.id,
        name: project.name,
        kind: project.kind,
        feeder_id: project.feeder_id,
        bus_id: targetBus,
        status: active ? "active" : "planned",
        peak_mw: roundTo(active ? peak : project.peak_mw, 3),
        annual_mwh: roundTo(annual, 1),
        capex_usd: Math.round(project.capex_usd),
        annual_om_usd: Math.round(project.annual_om_usd ?? 0),
        cost_per_added_mw: roundTo(
          project.capex_usd / Math.max(0.1, project.peak_mw),
          0,
        ),
        connection_miles: project.new_bus?.connection_length_mi ?? 0,
        voltage_impact_pu:
          voltageBefore !== undefined && voltageAfter !== undefined
            ? roundTo(voltageAfter - voltageBefore, 5)
            : 0,
        feeder_loading_impact_pct:
          feederBefore && feederAfter
            ? roundTo(feederAfter.max_branch_loading_pct - feederBefore.max_branch_loading_pct, 2)
            : 0,
      };
    });
}

// ---- Public entry point ----------------------------------------------------

/**
 * Run a municipality study. `options.hours = 24` gives the real-time design
 * day; the default 8760 gives the annual stats. The baseline run is enabled by
 * default so buildout deltas are real, not estimated.
 */
export function runMunicipality(
  scenario: MunicipalityScenario,
  options: SimulationOptions = {},
): MunicipalityResult {
  const year = options.year ?? scenario.base_year;
  const includeBuildouts = options.include_buildouts ?? true;
  const weather = buildWeather(scenario.weather, options);
  const built = buildMunicipality(scenario, year, includeBuildouts);
  const model = runModel(built, weather, options);

  const baseline =
    includeBuildouts && (options.compare_baseline ?? true)
      ? buildMunicipality(scenario, year, false)
      : null;
  const baselineModel = baseline ? runModel(baseline, weather, options) : null;

  const hours = weather.points.length;
  const stats = composeStats(
    scenario,
    built,
    model,
    baselineModel,
    weather,
  );

  return {
    stats,
    hourly: options.record_hourly ? model.hourly : undefined,
    peak: toPeakSnapshot(model.peak),
  };
}

function toPeakSnapshot(peak: PeakModel): PeakSnapshot {
  return {
    index: peak.index,
    ambient_c: roundTo(peak.ambient_c, 2),
    load_mw: roundTo(peak.load_mw, 3),
    min_voltage_pu: peak.min_voltage_pu,
    max_voltage_pu: peak.max_voltage_pu,
    max_branch_loading_pct: peak.max_branch_loading_pct,
    transformer_loading_pct: peak.transformer_loading_pct,
    feeder_voltages: peak.feeder_voltages,
    bus_voltages: peak.bus_voltages,
    bus_load_mw: peak.bus_load_mw,
  };
}

function composeStats(
  scenario: MunicipalityScenario,
  built: BuiltMunicipality,
  model: RunModel,
  baselineModel: RunModel | null,
  weather: WeatherRun,
): MunicipalityStats {
  const hours = weather.points.length;
  const economics: EconomicAssumptions = {
    ...DEFAULT_ECONOMICS,
    ...scenario.economics,
  };
  const transformer: TransformerSpec = scenario.substation.transformer;
  const peak = model.demand.peak_mw;
  const baselinePeak = baselineModel?.demand.peak_mw ?? 0;
  const activeBuildoutPeak = built.activeBuildouts.reduce(
    (sum, p) => sum + Math.max(0, p.peak_mw),
    0,
  );
  const existingPeak = baselineModel
    ? baselinePeak
    : Math.max(0, peak - activeBuildoutPeak);
  const buildoutPeak = baselineModel
    ? Math.max(0, peak - baselinePeak)
    : Math.min(peak, activeBuildoutPeak);
  const annualMwh = model.demand.sum_mwh;
  const averageMw = hours > 0 ? annualMwh / hours : 0;
  const reliability = computeReliability(scenario, built, model, hours);
  const thermal: ThermalStats = {
    transformer_peak_loading_pct: roundTo(model.thermal.peak_loading_pct, 1),
    transformer_hotspot_max_c: roundTo(model.thermal.hotspot_max_c, 1),
    transformer_top_oil_max_c: roundTo(model.thermal.top_oil_max_c, 1),
    transformer_loss_of_life_pct: transformerLossOfLifePct(
      transformer,
      model.thermal.state.equivalent_aging_years,
    ),
    transformer_remaining_life_years: transformerRemainingLifeYears(
      transformer,
      model.thermal.state.equivalent_aging_years,
    ),
    line_peak_temp_c: peakLineTemperature(built, model.peak),
    line_overload_hours: model.line_overload_hours,
  };
  const stability = computeStability(scenario, built, model.peak);
  const co2Tons = (model.demand.grid_mwh * scenario.grid_carbon_intensity_gco2_kwh) / 1000;
  const emissions: EmissionStats = {
    co2_tons: roundTo(co2Tons, 1),
    intensity_gco2_kwh:
      annualMwh > 0 ? roundTo((co2Tons / annualMwh) * 1000, 1) : 0,
  };

  const buildoutCapex = built.activeBuildouts.reduce(
    (sum, p) => sum + Math.max(0, p.capex_usd),
    0,
  );
  const annualOm = built.activeBuildouts.reduce(
    (sum, p) => sum + Math.max(0, p.annual_om_usd ?? 0),
    0,
  );
  const energyPrice =
    scenario.grid_energy_price_usd_per_mwh ?? economics.energy_price_usd_per_mwh;
  const annualEnergyCost = model.demand.grid_mwh * energyPrice;
  const annualLossCost = lossSavingsUsd(
    model.losses.sum_mwh,
    economics.loss_value_usd_per_mwh,
  );
  const unservedCost = unservedEnergyCost(
    reliability.unserved_mwh,
    economics.voll_usd_per_mwh,
  );
  const demandStats: DemandStats = {
    peak_mw: roundTo(peak, 2),
    average_mw: roundTo(averageMw, 2),
    min_mw: roundTo(model.demand.min_mw, 2),
    load_factor: peak > 0 ? roundTo(averageMw / peak, 3) : 0,
    annual_mwh: roundTo(annualMwh, 0),
    existing_peak_mw: roundTo(existingPeak, 2),
    buildout_peak_mw: roundTo(buildoutPeak, 2),
    growth_pct:
      existingPeak > 0 ? roundTo(((peak - existingPeak) / existingPeak) * 100, 1) : 0,
  };
  const voltageStats: VoltageStats = {
    min_pu: model.voltage.min_pu,
    max_pu: model.voltage.max_pu,
    max_drop_pct: roundTo(model.voltage.max_drop_pct, 2),
    violation_hours: model.voltage.violation_hours,
    infeasible_hours: model.voltage.infeasible_hours,
    unbalance_pct: peakUnbalance(built, model.peak),
  };
  const lossStats: LossStats = {
    annual_mwh: roundTo(model.losses.sum_mwh, 1),
    pct: annualMwh > 0 ? roundTo((model.losses.sum_mwh / annualMwh) * 100, 2) : 0,
    peak_mw: roundTo(model.losses.peak_mw, 3),
    cost_usd: annualLossCost,
  };
  const economicStats: EconomicStats = {
    annual_energy_cost_usd: Math.round(annualEnergyCost),
    annual_loss_cost_usd: annualLossCost,
    lcoe_usd_mwh: municipalLcoe(
      annualEnergyCost + annualOm,
      buildoutCapex,
      annualMwh,
      economics,
    ),
    buildout_capex_usd: Math.round(buildoutCapex),
    annual_om_usd: Math.round(annualOm),
    cost_per_added_mw: roundTo(
      buildoutCapex / Math.max(0.1, peak - existingPeak),
      0,
    ),
    annual_unserved_cost_usd: unservedCost,
  };
  const hosting = [...model.feeders.values()].reduce(
    (sum, feeder) => sum + feeder.hosting_capacity_mw,
    0,
  );
  const capacity: CapacityStats = {
    substation_mva: transformer.rating_mva,
    peak_loading_pct: roundTo(model.thermal.peak_loading_pct, 1),
    headroom_mw: roundTo(
      Math.max(0, transformer.rating_mva * 0.95 - peak),
      2,
    ),
    hosting_capacity_mw: roundTo(hosting, 2),
  };
  const feederStats: FeederStats[] = [...model.feeders.values()].map((feeder) => ({
    id: feeder.id,
    name: feeder.name,
    peak_load_mw: roundTo(feeder.peak_load_mw, 2),
    annual_mwh: roundTo(feeder.annual_mwh, 0),
    losses_mwh: roundTo(feeder.losses_mwh, 1),
    loss_pct:
      feeder.annual_mwh > 0
        ? roundTo((feeder.losses_mwh / feeder.annual_mwh) * 100, 2)
        : 0,
    min_voltage_pu: feeder.min_voltage_pu,
    max_voltage_pu: feeder.max_voltage_pu,
    max_branch_loading_pct: feeder.max_branch_loading_pct,
    violation_hours: feeder.violation_hours,
    hosting_capacity_mw: feeder.hosting_capacity_mw,
    worst_bus: feeder.worst_bus,
  }));

  return {
    id: scenario.id,
    name: scenario.name,
    state: scenario.state,
    population: scenario.population,
    year: built.year,
    hours,
    demand: demandStats,
    voltage: voltageStats,
    losses: lossStats,
    reliability,
    thermal,
    stability,
    emissions,
    economics: economicStats,
    capacity,
    feeders: feederStats,
    buildouts: computeBuildoutStats(
      scenario,
      built,
      model,
      baselineModel,
      weather,
    ),
    baseline: baselineModel
      ? {
          peak_mw: roundTo(baselineModel.demand.peak_mw, 2),
          annual_mwh: roundTo(baselineModel.demand.sum_mwh, 0),
          losses_mwh: roundTo(baselineModel.losses.sum_mwh, 1),
          min_voltage_pu: baselineModel.voltage.min_pu,
          max_branch_loading_pct: Math.max(
            0,
            ...[...baselineModel.feeders.values()].map(
              (f) => f.max_branch_loading_pct,
            ),
          ),
        }
      : null,
  };
}

/** Re-export the label map so UI code can render buildout kinds without a second import. */
export { BUILDOUT_LABELS };
