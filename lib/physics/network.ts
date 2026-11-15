/**
 * AC network primitives: conductor impedance, radial power flow, exact
 * two-bus voltage drop, voltage-stability margin, short-circuit strength and
 * DER hosting capacity.
 *
 * Conventions
 * -----------
 *  - `s_mva` is always three-phase apparent power.
 *  - `v_kv` is always line-to-line RMS.
 *  - A radial network is a tree. Branches may be declared in either direction;
 *    the solver orients them away from the slack bus.
 *  - Loads are positive consumption, DER is positive injection.
 *
 * This is a quasi-static positive-sequence model. It deliberately does not
 * model unbalanced phases, harmonics or electromagnetic transients. Those are
 * valid next steps, not hidden assumptions: every result that depends on the
 * balanced assumption says so in docs/GRID-MODEL.md.
 */

import {
  SQRT3,
  cAbs,
  cAdd,
  cConj,
  cDiv,
  cMul,
  cScale,
  cSub,
  cx,
  clamp,
  powerFactor,
  roundTo,
  type Complex,
  type PerUnitBase,
} from "./units";

// ---- Conductors -------------------------------------------------------------

export interface ConductorSpec {
  id: string;
  label: string;
  /** DC resistance at 25 °C, ohms per mile. */
  resistance_ohm_per_mi_25c: number;
  /** Geometric mean radius, feet. */
  gmr_ft: number;
  diameter_in: number;
  /** Screening ampacity at 75 °C conductor, 40 °C ambient, 0.61 m/s wind. */
  ampacity_a: number;
  max_temp_c: number;
  /** Resistance temperature coefficient, 1/°C (aluminium unless noted). */
  alpha_per_c: number;
}

/**
 * Screening conductor library. These are published-class values, not a
 * substitute for the utility's as-built conductor schedule. `x` is derived
 * from geometry in `branchImpedanceOhms`, not stored, so changing phase
 * spacing changes reactance honestly.
 */
export const CONDUCTORS: Record<string, ConductorSpec> = {
  "acsr-4-0-penguin": {
    id: "acsr-4-0-penguin",
    label: "4/0 ACSR Penguin",
    resistance_ohm_per_mi_25c: 0.445,
    gmr_ft: 0.0085,
    diameter_in: 0.563,
    ampacity_a: 340,
    max_temp_c: 100,
    alpha_per_c: 0.00403,
  },
  "acsr-336-linnet": {
    id: "acsr-336-linnet",
    label: "336.4 kcmil ACSR Linnet",
    resistance_ohm_per_mi_25c: 0.306,
    gmr_ft: 0.0244,
    diameter_in: 0.721,
    ampacity_a: 530,
    max_temp_c: 100,
    alpha_per_c: 0.00403,
  },
  "acsr-477-hawk": {
    id: "acsr-477-hawk",
    label: "477 kcmil ACSR Hawk",
    resistance_ohm_per_mi_25c: 0.216,
    gmr_ft: 0.0287,
    diameter_in: 0.858,
    ampacity_a: 660,
    max_temp_c: 100,
    alpha_per_c: 0.00403,
  },
  "acsr-795-drake": {
    id: "acsr-795-drake",
    label: "795 kcmil ACSR Drake",
    resistance_ohm_per_mi_25c: 0.128,
    gmr_ft: 0.0375,
    diameter_in: 1.108,
    ampacity_a: 900,
    max_temp_c: 100,
    alpha_per_c: 0.00403,
  },
  "acsr-1590-falcon": {
    id: "acsr-1590-falcon",
    label: "1590 kcmil ACSR Falcon",
    resistance_ohm_per_mi_25c: 0.0645,
    gmr_ft: 0.0522,
    diameter_in: 1.545,
    ampacity_a: 1200,
    max_temp_c: 100,
    alpha_per_c: 0.00403,
  },
  "aaac-500": {
    id: "aaac-500",
    label: "500 kcmil AAAC",
    resistance_ohm_per_mi_25c: 0.214,
    gmr_ft: 0.0308,
    diameter_in: 0.858,
    ampacity_a: 640,
    max_temp_c: 90,
    alpha_per_c: 0.00403,
  },
};

export function getConductor(id: string): ConductorSpec {
  const conductor = CONDUCTORS[id];
  if (!conductor) {
    throw new Error(
      `Unknown conductor "${id}". Known: ${Object.keys(CONDUCTORS).join(", ")}`,
    );
  }
  return conductor;
}

export type ConductorId = keyof typeof CONDUCTORS;

export function defaultPhaseSpacingFt(voltageKv: number): number {
  if (voltageKv < 35) return 6;
  if (voltageKv < 100) return 12;
  if (voltageKv < 200) return 20;
  if (voltageKv < 300) return 25;
  return 35;
}

export function defaultConductorForVoltage(voltageKv: number): string {
  if (voltageKv < 35) return "acsr-336-linnet";
  if (voltageKv < 100) return "acsr-477-hawk";
  if (voltageKv < 200) return "acsr-795-drake";
  return "acsr-1590-falcon";
}

export interface BranchSpec {
  id: string;
  from_bus: string;
  to_bus: string;
  voltage_kv: number;
  length_mi: number;
  /** Conductor id, defaults from voltage class. */
  conductor?: string;
  circuits?: number;
  bundle_count?: number;
  /** Bundle spacing in inches; default 18. */
  bundle_spacing_in?: number;
  phase_spacing_ft?: number;
  arrangement?: "equilateral" | "flat";
  /** Explicit thermal rating. Overrides the conductor ampacity calculation. */
  rating_mva?: number;
}

export interface BranchImpedance {
  branch_id: string;
  conductor: ConductorSpec;
  r_ohm: number;
  x_ohm: number;
  z_ohm: number;
  x_over_r: number;
  /** Series impedance referred to the branch's voltage base. */
  z_pu: number;
  rating_mva: number;
}

/**
 * Series impedance of a three-phase line.
 *
 *   R = R25 / (circuits · bundle)
 *   X = 0.2794 · log10(GMD / GMR_bundle) / circuits   Ω/mi at 60 Hz
 *   GMR_bundle = (GMR · d^(n-1))^(1/n)
 *
 * GMD is phase spacing for an equilateral arrangement, 1.26·D for a flat
 * arrangement. The 0.2794 constant is 2πf·(unit conversion) at 60 Hz.
 */
export function branchImpedanceOhms(
  branch: BranchSpec,
  base: PerUnitBase,
  options: { ambient_c?: number } = {},
): BranchImpedance {
  const conductor = getConductor(
    branch.conductor ?? defaultConductorForVoltage(branch.voltage_kv),
  );
  const circuits = Math.max(1, branch.circuits ?? 1);
  const bundle = Math.max(1, branch.bundle_count ?? 1);
  const bundleSpacingFt = Math.max(0.1, (branch.bundle_spacing_in ?? 18) / 12);
  const phaseSpacingFt = Math.max(
    0.1,
    branch.phase_spacing_ft ?? defaultPhaseSpacingFt(branch.voltage_kv),
  );
  const arrangement = branch.arrangement ?? "equilateral";
  const gmdFt = arrangement === "flat" ? phaseSpacingFt * 1.26 : phaseSpacingFt;

  const gmrBundleFt =
    bundle === 1
      ? conductor.gmr_ft
      : Math.pow(conductor.gmr_ft * Math.pow(bundleSpacingFt, bundle - 1), 1 / bundle);

  const resistancePerMi =
    conductor.resistance_ohm_per_mi_25c / (circuits * bundle);
  const reactancePerMi =
    (0.2794 * Math.log10(gmdFt / gmrBundleFt)) / circuits;

  const ambientCorrection =
    options.ambient_c === undefined
      ? 1
      : Math.sqrt(
          clamp(
            (conductor.max_temp_c - options.ambient_c) /
              Math.max(1, conductor.max_temp_c - 40),
            0.25,
            1.25,
          ),
        );

  const ratingFromAmpacity =
    (SQRT3 * branch.voltage_kv * conductor.ampacity_a * circuits * bundle) /
    1000; // MVA

  return {
    branch_id: branch.id,
    conductor,
    r_ohm: resistancePerMi * branch.length_mi,
    x_ohm: reactancePerMi * branch.length_mi,
    z_ohm: Math.hypot(resistancePerMi * branch.length_mi, reactancePerMi * branch.length_mi),
    x_over_r:
      resistancePerMi === 0 ? Infinity : reactancePerMi / resistancePerMi,
    z_pu:
      Math.hypot(resistancePerMi * branch.length_mi, reactancePerMi * branch.length_mi) /
      (base.v_kv * base.v_kv / base.s_mva),
    rating_mva: branch.rating_mva ?? ratingFromAmpacity * ambientCorrection,
  };
}

/** Complex series impedance in per-unit on the supplied base. */
export function branchZPu(branch: BranchSpec, base: PerUnitBase): Complex {
  const z = branchImpedanceOhms(branch, base);
  const zBase = (base.v_kv * base.v_kv) / base.s_mva;
  return cx(z.r_ohm / zBase, z.x_ohm / zBase);
}

/** Total thermal rating of a branch, MVA. */
export function branchRatingMva(
  branch: BranchSpec,
  options: { ambient_c?: number } = {},
): number {
  const base: PerUnitBase = { s_mva: 1, v_kv: branch.voltage_kv };
  return branchImpedanceOhms(branch, base, options).rating_mva;
}

// ---- Radial power flow ------------------------------------------------------

export interface BusSpec {
  id: string;
  /** Nominal line-to-line kV. Every bus in one radial network must match. */
  base_kv: number;
  load_mw: number;
  load_mvar: number;
  /** DER injection at unity power factor unless der_mvar is supplied. */
  der_mw?: number;
  der_mvar?: number;
  /** Fraction of load that is constant power / current / impedance. */
  zip?: { constant_power: number; constant_current: number; constant_impedance: number };
}

export interface RadialNetwork {
  id: string;
  slack_bus_id: string;
  buses: BusSpec[];
  branches: BranchSpec[];
  /** Optional source impedance behind the slack, per-unit on `s_base_mva`. */
  source_impedance_pu?: Complex;
}

export interface RadialPowerFlowOptions {
  s_base_mva?: number;
  max_iterations?: number;
  tolerance_pu?: number;
  /** Under-relaxation factor, 1 = plain backward-forward sweep. */
  damping?: number;
}

export interface BusResult {
  id: string;
  voltage_pu: number;
  voltage_kv: number;
  angle_deg: number;
  load_mw: number;
  load_mvar: number;
  der_mw: number;
  der_mvar: number;
  net_mw: number;
}

export interface BranchResult {
  id: string;
  from_bus: string;
  to_bus: string;
  current_a: number;
  flow_mva: number;
  flow_mw: number;
  flow_mvar: number;
  loading_pct: number;
  loss_mw: number;
  loss_mvar: number;
  drop_pct: number;
  voltage_from_pu: number;
  voltage_to_pu: number;
}

export interface RadialPowerFlowResult {
  network_id: string;
  converged: boolean;
  iterations: number;
  s_base_mva: number;
  buses: BusResult[];
  branches: BranchResult[];
  slack_bus_id: string;
  slack_mw: number;
  slack_mvar: number;
  total_load_mw: number;
  total_load_mvar: number;
  total_der_mw: number;
  total_loss_mw: number;
  total_loss_mvar: number;
  min_voltage_pu: number;
  max_voltage_pu: number;
}

interface Topology {
  order: string[];
  parentBranch: Map<string, string>;
  childrenBranches: Map<string, string[]>;
  branchEnds: Map<string, { from: string; to: string }>;
}

function buildTopology(network: RadialNetwork): Topology {
  const busIds = new Set(network.buses.map((b) => b.id));
  if (!busIds.has(network.slack_bus_id)) {
    throw new Error(`Slack bus "${network.slack_bus_id}" is not in the network`);
  }
  const branchIds = new Set<string>();
  const adjacency = new Map<string, { branch: string; other: string }[]>();
  for (const bus of network.buses) adjacency.set(bus.id, []);

  for (const branch of network.branches) {
    if (!busIds.has(branch.from_bus) || !busIds.has(branch.to_bus)) {
      throw new Error(`Branch "${branch.id}" references a bus that is not in the network`);
    }
    if (branchIds.has(branch.id)) throw new Error(`Duplicate branch id "${branch.id}"`);
    branchIds.add(branch.id);
    adjacency.get(branch.from_bus)!.push({ branch: branch.id, other: branch.to_bus });
    adjacency.get(branch.to_bus)!.push({ branch: branch.id, other: branch.from_bus });
  }

  const order: string[] = [];
  const parentBranch = new Map<string, string>();
  const childrenBranches = new Map<string, string[]>();
  const branchEnds = new Map<string, { from: string; to: string }>();
  const visited = new Set<string>();

  const queue = [network.slack_bus_id];
  visited.add(network.slack_bus_id);
  while (queue.length > 0) {
    const bus = queue.shift()!;
    order.push(bus);
    childrenBranches.set(bus, []);
    for (const edge of adjacency.get(bus) ?? []) {
      if (visited.has(edge.other)) {
        if (parentBranch.get(bus) !== edge.branch) {
          // A back-edge means the network is meshed. The radial model is not
          // valid there; fail loudly instead of returning a plausible number.
          throw new Error(
            `Network "${network.id}" is not radial: branch "${edge.branch}" closes a loop at bus "${bus}"`,
          );
        }
        continue;
      }
      visited.add(edge.other);
      parentBranch.set(edge.other, edge.branch);
      childrenBranches.get(bus)!.push(edge.branch);
      branchEnds.set(edge.branch, { from: bus, to: edge.other });
      queue.push(edge.other);
    }
  }

  if (visited.size !== network.buses.length) {
    const missing = network.buses.filter((b) => !visited.has(b.id)).map((b) => b.id);
    throw new Error(`Network "${network.id}" is not connected: ${missing.join(", ")}`);
  }

  return { order, parentBranch, childrenBranches, branchEnds };
}

function zipFactor(
  bus: BusSpec,
  voltagePu: number,
): number {
  const zip = bus.zip ?? { constant_power: 1, constant_current: 0, constant_impedance: 0 };
  const sum = zip.constant_power + zip.constant_current + zip.constant_impedance;
  const normal = sum > 0 ? sum : 1;
  return (
    (zip.constant_power / normal) +
    (zip.constant_current / normal) * voltagePu +
    (zip.constant_impedance / normal) * voltagePu * voltagePu
  );
}

/**
 * Backward-forward sweep for a balanced radial network.
 *
 * The sweep is exact for a tree with constant-power loads once it converges.
 * ZIP loads are updated each iteration, so a voltage-dependent feeder is a
 * fixed-point of the same equations. If a heavily loaded feeder fails to
 * converge, `converged` is false and the last iterate is returned — callers
 * must treat that as a voltage-collapse warning, not a valid operating point.
 */
export function radialPowerFlow(
  network: RadialNetwork,
  options: RadialPowerFlowOptions = {},
): RadialPowerFlowResult {
  const busesById = new Map(network.buses.map((b) => [b.id, b]));
  const voltageKv = busesById.get(network.slack_bus_id)?.base_kv ?? 12.47;
  for (const bus of network.buses) {
    if (Math.abs(bus.base_kv - voltageKv) > 1e-9) {
      throw new Error(
        `Network "${network.id}" mixes voltage bases (${voltageKv} kV and ${bus.base_kv} kV). Model each voltage level as its own radial network.`,
      );
    }
  }

  const topology = buildTopology(network);
  const branchesById = new Map(network.branches.map((b) => [b.id, b]));
  const totalLoad = network.buses.reduce((sum, b) => sum + Math.max(0, b.load_mw), 0);
  const sBase =
    options.s_base_mva ??
    Math.max(1, totalLoad > 0 ? totalLoad * 1.5 : 1);
  const base: PerUnitBase = { s_mva: sBase, v_kv: voltageKv };
  const zPu = new Map<string, Complex>();
  const ratings = new Map<string, number>();
  for (const branch of network.branches) {
    const z = branchImpedanceOhms(branch, base);
    zPu.set(branch.id, cx(z.r_ohm / ((voltageKv * voltageKv) / sBase), z.x_ohm / ((voltageKv * voltageKv) / sBase)));
    ratings.set(branch.id, z.rating_mva);
  }

  const slackZ = network.source_impedance_pu ?? cx(0, 0);
  const voltages = new Map<string, Complex>();
  for (const bus of network.buses) voltages.set(bus.id, cx(1, 0));

  const maxIterations = options.max_iterations ?? 100;
  const tolerance = options.tolerance_pu ?? 1e-9;
  const damping = clamp(options.damping ?? 1, 0.1, 1);
  let converged = false;
  let iterations = 0;

  // Branch currents from the latest sweep are also needed after convergence to
  // report flows, losses and the slack contribution, so they live outside the
  // iteration loop and are refreshed each pass.
  const branchCurrents = new Map<string, Complex>();

  for (let iter = 0; iter < maxIterations; iter += 1) {
    iterations = iter + 1;
    branchCurrents.clear();
    const injections = new Map<string, Complex>();
    for (const bus of network.buses) {
      const v = voltages.get(bus.id)!;
      const vm = Math.max(0.05, cAbs(v));
      const loadScale = zipFactor(bus, vm);
      const loadP = (bus.load_mw * loadScale) / sBase;
      const loadQ = (bus.load_mvar * loadScale) / sBase;
      const derP = (bus.der_mw ?? 0) / sBase;
      const derQ = (bus.der_mvar ?? 0) / sBase;
      const net = cx(loadP - derP, loadQ - derQ);
      injections.set(bus.id, cConj(cDiv(net, v)));
    }

    for (let i = topology.order.length - 1; i >= 1; i -= 1) {
      const busId = topology.order[i];
      let current = injections.get(busId) ?? cx(0, 0);
      for (const childBranch of topology.childrenBranches.get(busId) ?? []) {
        current = cAdd(current, branchCurrents.get(childBranch) ?? cx(0, 0));
      }
      branchCurrents.set(topology.parentBranch.get(busId)!, current);
    }

    const updated = new Map<string, Complex>();
    updated.set(network.slack_bus_id, cx(1, 0));
    let maxDelta = 0;
    for (let i = 1; i < topology.order.length; i += 1) {
      const busId = topology.order[i];
      const branchId = topology.parentBranch.get(busId)!;
      const ends = topology.branchEnds.get(branchId)!;
      const previous = voltages.get(busId)!;
      const parentV = updated.get(ends.from)!;
      const z = zPu.get(branchId)!;
      const drop = cMul(z, branchCurrents.get(branchId) ?? cx(0, 0));
      const computed = cSub(parentV, drop);
      const next = cAdd(previous, cScale(cSub(computed, previous), damping));
      maxDelta = Math.max(maxDelta, cAbs(cSub(next, previous)));
      updated.set(busId, next);
    }
    for (const [busId, v] of updated) voltages.set(busId, v);
    if (maxDelta < tolerance) {
      converged = true;
      break;
    }
  }

  const busResults: BusResult[] = network.buses.map((bus) => {
    const v = voltages.get(bus.id)!;
    return {
      id: bus.id,
      voltage_pu: roundTo(cAbs(v), 5),
      voltage_kv: roundTo(cAbs(v) * bus.base_kv, 3),
      angle_deg: roundTo((Math.atan2(v.im, v.re) * 180) / Math.PI, 3),
      load_mw: bus.load_mw,
      load_mvar: bus.load_mvar,
      der_mw: bus.der_mw ?? 0,
      der_mvar: bus.der_mvar ?? 0,
      net_mw: roundTo(bus.load_mw - (bus.der_mw ?? 0), 3),
    };
  });

  let totalLossMw = 0;
  let totalLossMvar = 0;
  const branchResults: BranchResult[] = network.branches.map((branch) => {
    const ends = topology.branchEnds.get(branch.id)!;
    const current = branchCurrents.get(branch.id) ?? cx(0, 0);
    const vFrom = voltages.get(ends.from)!;
    const vTo = voltages.get(ends.to)!;
    const z = zPu.get(branch.id)!;
    const flowPu = cScale(cMul(vFrom, cConj(current)), sBase); // MVA
    const lossPu = cMul(cScale(cMul(current, cConj(current)), 1), z);
    const lossMw = lossPu.re * sBase;
    const lossMvar = lossPu.im * sBase;
    totalLossMw += lossMw;
    totalLossMvar += lossMvar;
    const iBase = sBase / (SQRT3 * branch.voltage_kv);
    const currentKa = cAbs(current) * iBase;
    const rating = ratings.get(branch.id) ?? 0;
    const flowMva = cAbs(flowPu);
    return {
      id: branch.id,
      from_bus: ends.from,
      to_bus: ends.to,
      current_a: roundTo(currentKa * 1000, 1),
      flow_mva: roundTo(flowMva, 3),
      flow_mw: roundTo(flowPu.re, 3),
      flow_mvar: roundTo(flowPu.im, 3),
      loading_pct: rating > 0 ? roundTo((flowMva / rating) * 100, 2) : 0,
      loss_mw: roundTo(lossMw, 4),
      loss_mvar: roundTo(lossMvar, 4),
      drop_pct: roundTo(((cAbs(vFrom) - cAbs(vTo)) / Math.max(1e-9, cAbs(vFrom))) * 100, 3),
      voltage_from_pu: roundTo(cAbs(vFrom), 5),
      voltage_to_pu: roundTo(cAbs(vTo), 5),
    };
  });

  const slackBus = busesById.get(network.slack_bus_id)!;
  const slackLoad = cx(
    (slackBus.load_mw * zipFactor(slackBus, 1)) / sBase,
    (slackBus.load_mvar * zipFactor(slackBus, 1)) / sBase,
  );
  let slackCurrent = cConj(cDiv(slackLoad, cx(1, 0)));
  for (const childBranch of topology.childrenBranches.get(network.slack_bus_id) ?? []) {
    slackCurrent = cAdd(slackCurrent, branchCurrents.get(childBranch) ?? cx(0, 0));
  }
  // Source impedance is only used for short-circuit strength; adding it here
  // would double-count the slack voltage drop in the sweep. Keep 1.0 pu slack.
  void slackZ;
  const slackPower = cScale(cMul(cx(1, 0), cConj(slackCurrent)), sBase);

  const voltagesPu = busResults.map((b) => b.voltage_pu);
  return {
    network_id: network.id,
    converged,
    iterations,
    s_base_mva: roundTo(sBase, 3),
    buses: busResults,
    branches: branchResults,
    slack_bus_id: network.slack_bus_id,
    slack_mw: roundTo(slackPower.re, 3),
    slack_mvar: roundTo(slackPower.im, 3),
    total_load_mw: roundTo(
      network.buses.reduce((sum, b) => sum + b.load_mw, 0),
      3,
    ),
    total_load_mvar: roundTo(
      network.buses.reduce((sum, b) => sum + b.load_mvar, 0),
      3,
    ),
    total_der_mw: roundTo(
      network.buses.reduce((sum, b) => sum + (b.der_mw ?? 0), 0),
      3,
    ),
    total_loss_mw: roundTo(totalLossMw, 4),
    total_loss_mvar: roundTo(totalLossMvar, 4),
    min_voltage_pu: roundTo(Math.min(...voltagesPu), 5),
    max_voltage_pu: roundTo(Math.max(...voltagesPu), 5),
  };
}

// ---- Exact two-bus solution -------------------------------------------------

export interface TwoBusInput {
  sending_kv: number;
  p_mw: number;
  q_mvar: number;
  r_ohm: number;
  x_ohm: number;
  /** Optional thermal rating for the receiving-end flow, MVA. */
  rating_mva?: number;
}

export interface TwoBusResult {
  feasible: boolean;
  sending_kv: number;
  receiving_kv: number;
  receiving_pu: number;
  drop_pct: number;
  current_a: number;
  loss_mw: number;
  loss_mvar: number;
  sending_mva: number;
  receiving_mva: number;
  loading_pct: number;
  /** Voltage at the nose of the P-V curve for this load power factor, pu. */
  critical_voltage_pu: number | null;
}

function twoBusRoots(
  pPu: number,
  qPu: number,
  rPu: number,
  xPu: number,
): { v: number | null; criticalV: number | null } {
  // V_s = V_r + Z·I*, with I = S*/V_r* and V_r taken as the angle reference.
  const a = rPu * pPu + xPu * qPu;
  const b = xPu * pPu - rPu * qPu;
  const vs2 = 1; // sending end is 1.0 pu by definition
  const B = 2 * a - vs2;
  const C = a * a + b * b;
  const discriminant = B * B - 4 * C;
  if (discriminant < 0) return { v: null, criticalV: null };
  const u = (-B + Math.sqrt(discriminant)) / 2; // larger root = stable branch
  const v = Math.sqrt(Math.max(0, u));
  return { v, criticalV: null };
}

/**
 * Exact receiving-end voltage for a constant-power load behind a series
 * impedance (the standard two-bus quadratic). No small-angle approximation:
 * the result is valid up to the nose of the P-V curve, where it returns
 * `feasible: false`.
 */
export function solveTwoBus(input: TwoBusInput): TwoBusResult {
  const sBase = Math.max(1, Math.hypot(input.p_mw, input.q_mvar));
  const vBase = input.sending_kv;
  const zBase = (vBase * vBase) / sBase;
  const pPu = input.p_mw / sBase;
  const qPu = input.q_mvar / sBase;
  const rPu = input.r_ohm / zBase;
  const xPu = input.x_ohm / zBase;
  const root = twoBusRoots(pPu, qPu, rPu, xPu);

  if (root.v === null) {
    return {
      feasible: false,
      sending_kv: input.sending_kv,
      receiving_kv: 0,
      receiving_pu: 0,
      drop_pct: 100,
      current_a: 0,
      loss_mw: 0,
      loss_mvar: 0,
      sending_mva: Math.hypot(input.p_mw, input.q_mvar),
      receiving_mva: Math.hypot(input.p_mw, input.q_mvar),
      loading_pct: input.rating_mva ? (Math.hypot(input.p_mw, input.q_mvar) / input.rating_mva) * 100 : 0,
      critical_voltage_pu: null,
    };
  }

  const v = root.v;
  const iPu = Math.hypot(input.p_mw, input.q_mvar) / sBase / Math.max(1e-9, v);
  const lossMw = iPu * iPu * rPu * sBase;
  const lossMvar = iPu * iPu * xPu * sBase;
  const currentKa = (Math.hypot(input.p_mw, input.q_mvar) / (SQRT3 * v * vBase));
  const receivingMva = Math.hypot(input.p_mw, input.q_mvar);

  // Nose voltage for this fixed power factor: discriminant = 0.
  let aNose = 0;
  const bx = xPu * pPu - rPu * qPu;
  // a = Vs²/4 - b²/Vs² at the nose
  aNose = 1 / 4 - (bx * bx) / 1;
  const vCritical = Math.sqrt(Math.max(0, (1 - 2 * aNose) / 2));

  return {
    feasible: true,
    sending_kv: roundTo(input.sending_kv, 3),
    receiving_kv: roundTo(v * vBase, 3),
    receiving_pu: roundTo(v, 5),
    drop_pct: roundTo((1 - v) * 100, 2),
    current_a: roundTo(currentKa * 1000, 1),
    loss_mw: roundTo(lossMw, 4),
    loss_mvar: roundTo(lossMvar, 4),
    sending_mva: roundTo(receivingMva + lossMw, 3),
    receiving_mva: roundTo(receivingMva, 3),
    loading_pct: input.rating_mva
      ? roundTo((receivingMva / input.rating_mva) * 100, 2)
      : 0,
    critical_voltage_pu: roundTo(vCritical, 4),
  };
}

export interface VoltageCollapseResult {
  lambda_max: number;
  p_max_mw: number;
  q_max_mvar: number;
  critical_voltage_pu: number;
  margin_pct: number;
  feasible_at_operating_point: boolean;
}

/**
 * Voltage-stability margin for a two-bus corridor: scale the operating load by
 * λ, find the largest λ with a real high-voltage solution, and report the
 * remaining active-power margin. This is the P-V nose of the classic
 * Thevenin equivalent, not a rule of thumb.
 */
export function voltageCollapseMargin(
  input: TwoBusInput,
  options: { max_lambda?: number; tolerance?: number } = {},
): VoltageCollapseResult {
  const maxLambda = options.max_lambda ?? 20;
  const tolerance = options.tolerance ?? 1e-7;
  const feasible = (lambda: number): boolean =>
    solveTwoBus({
      ...input,
      p_mw: input.p_mw * lambda,
      q_mvar: input.q_mvar * lambda,
    }).feasible;

  if (!feasible(0)) {
    return {
      lambda_max: 0,
      p_max_mw: 0,
      q_max_mvar: 0,
      critical_voltage_pu: 0,
      margin_pct: 0,
      feasible_at_operating_point: false,
    };
  }

  let lo = 0;
  let hi = 0.1;
  while (hi < maxLambda && feasible(hi)) {
    lo = hi;
    hi = Math.min(maxLambda, hi * 1.6);
  }
  if (hi >= maxLambda && feasible(maxLambda)) {
    // No nose inside the scan window; the corridor is very strong or lightly
    // loaded. Report the window limit rather than inventing a bound.
    const atLimit = solveTwoBus({
      ...input,
      p_mw: input.p_mw * maxLambda,
      q_mvar: input.q_mvar * maxLambda,
    });
    return {
      lambda_max: maxLambda,
      p_max_mw: input.p_mw * maxLambda,
      q_max_mvar: input.q_mvar * maxLambda,
      critical_voltage_pu: atLimit.receiving_pu,
      margin_pct: 100 * (1 - 1 / maxLambda),
      feasible_at_operating_point: true,
    };
  }

  for (let i = 0; i < 80; i += 1) {
    const mid = (lo + hi) / 2;
    if (feasible(mid)) lo = mid;
    else hi = mid;
    if (hi - lo < tolerance) break;
  }

  const lambdaMax = lo;
  const pMax = input.p_mw * lambdaMax;
  const qMax = input.q_mvar * lambdaMax;
  const bx = (input.x_ohm * (pMax / Math.max(1e-9, Math.hypot(pMax, qMax)))) -
    (input.r_ohm * (qMax / Math.max(1e-9, Math.hypot(pMax, qMax))));
  // Convert the normalized nose relation back to the per-unit base used above.
  const sBase = Math.max(1, Math.hypot(pMax, qMax));
  const vBase = input.sending_kv;
  const zBase = (vBase * vBase) / sBase;
  const pPu = pMax / sBase;
  const qPu = qMax / sBase;
  const rPu = input.r_ohm / zBase;
  const xPu = input.x_ohm / zBase;
  const bPu = xPu * pPu - rPu * qPu;
  const aNose = 1 / 4 - bPu * bPu;
  const vCritical = Math.sqrt(Math.max(0, (1 - 2 * aNose) / 2));
  void bx;

  return {
    lambda_max: roundTo(lambdaMax, 4),
    p_max_mw: roundTo(pMax, 3),
    q_max_mvar: roundTo(qMax, 3),
    critical_voltage_pu: roundTo(vCritical, 4),
    margin_pct: roundTo(100 * (1 - 1 / lambdaMax), 2),
    feasible_at_operating_point: true,
  };
}

// ---- Short circuit ----------------------------------------------------------

export interface ShortCircuitResult {
  bus_id: string;
  fault_current_ka: number;
  fault_mva: number;
  source_scr: number;
  x_over_r: number;
  voltage_kv: number;
}

/**
 * Three-phase bolted-fault current at a bus, from the cumulative series
 * impedance to the slack plus an optional source impedance. The result is a
 * planning screen: utility protection studies need sequence networks,
 * transformer connections and breaker duty, none of which live here.
 */
export function shortCircuitAtBus(
  network: RadialNetwork,
  busId: string,
  options: { source_impedance_pu?: Complex; s_base_mva?: number } = {},
): ShortCircuitResult {
  const topology = buildTopology(network);
  const bus = network.buses.find((b) => b.id === busId);
  if (!bus) throw new Error(`Unknown bus "${busId}"`);
  const totalLoad = network.buses.reduce((sum, b) => sum + Math.max(0, b.load_mw), 0);
  const sBase = options.s_base_mva ?? Math.max(1, totalLoad * 1.5);
  const base: PerUnitBase = { s_mva: sBase, v_kv: bus.base_kv };

  let zCum = options.source_impedance_pu ?? network.source_impedance_pu ?? cx(0, 0);
  if (busId !== network.slack_bus_id) {
    let cursor = busId;
    while (cursor !== network.slack_bus_id) {
      const branchId = topology.parentBranch.get(cursor);
      if (!branchId) throw new Error(`Bus "${busId}" is not reachable from the slack`);
      const branch = network.branches.find((b) => b.id === branchId)!;
      const z = branchZPu(branch, base);
      zCum = cAdd(zCum, z);
      cursor = topology.branchEnds.get(branchId)!.from;
    }
  }
  const zMag = Math.max(1e-9, cAbs(zCum));
  const iPu = 1 / zMag;
  const iBase = sBase / (SQRT3 * bus.base_kv);
  const faultKa = iPu * iBase;
  const faultMva = SQRT3 * bus.base_kv * faultKa;
  const xr = Math.abs(zCum.re) < 1e-9 ? Infinity : Math.abs(zCum.im / zCum.re);
  return {
    bus_id: busId,
    fault_current_ka: roundTo(faultKa, 3),
    fault_mva: roundTo(faultMva, 3),
    source_scr: roundTo(faultMva / Math.max(0.1, bus.load_mw), 2),
    x_over_r: roundTo(xr, 2),
    voltage_kv: bus.base_kv,
  };
}

export function sourceImpedanceFromScr(scr: number, xOverR = 10): Complex {
  const z = 1 / Math.max(0.1, scr);
  const r = z / Math.sqrt(1 + xOverR * xOverR);
  const x = r * xOverR;
  return cx(r, x);
}

// ---- DER hosting capacity ---------------------------------------------------

export interface HostingCapacityOptions {
  voltage_min_pu?: number;
  voltage_max_pu?: number;
  max_branch_loading_pct?: number;
  max_der_mw?: number;
  tolerance_mw?: number;
}

export interface HostingCapacityResult {
  bus_id: string;
  hosting_capacity_mw: number;
  binding_constraint: "none" | "voltage_high" | "voltage_low" | "thermal" | "reverse_power";
  min_voltage_pu: number;
  max_voltage_pu: number;
  max_branch_loading_pct: number;
}

/**
 * Largest single-bus DER injection that keeps the feeder inside voltage and
 * thermal limits. Binary search on a converged power flow — no linearisation,
 * no assumed hosting-capacity curve proportion.
 */
export function hostingCapacity(
  network: RadialNetwork,
  busId: string,
  options: HostingCapacityOptions = {},
): HostingCapacityResult {
  const vMin = options.voltage_min_pu ?? 0.95;
  const vMax = options.voltage_max_pu ?? 1.05;
  const maxLoading = options.max_branch_loading_pct ?? 100;
  const maxDer = options.max_der_mw ?? 100;
  const tolerance = options.tolerance_mw ?? 0.01;

  const evaluate = (derMw: number): HostingCapacityResult => {
    const test: RadialNetwork = {
      ...network,
      buses: network.buses.map((bus) =>
        bus.id === busId ? { ...bus, der_mw: (bus.der_mw ?? 0) + derMw } : bus,
      ),
    };
    const result = radialPowerFlow(test);
    let constraint: HostingCapacityResult["binding_constraint"] = "none";
    if (result.max_voltage_pu > vMax) constraint = "voltage_high";
    else if (result.min_voltage_pu < vMin) constraint = "voltage_low";
    else if (Math.max(0, ...result.branches.map((b) => b.loading_pct)) > maxLoading) {
      constraint = "thermal";
    } else if (result.slack_mw < 0) constraint = "reverse_power";
    return {
      bus_id: busId,
      hosting_capacity_mw: derMw,
      binding_constraint: constraint,
      min_voltage_pu: result.min_voltage_pu,
      max_voltage_pu: result.max_voltage_pu,
      max_branch_loading_pct: roundTo(
        Math.max(0, ...result.branches.map((b) => b.loading_pct)),
        2,
      ),
    };
  };

  const feasible = (derMw: number): boolean => evaluate(derMw).binding_constraint === "none";
  if (!feasible(0)) return evaluate(0);

  let lo = 0;
  let hi = Math.min(maxDer, 0.5);
  while (hi < maxDer && feasible(hi)) {
    lo = hi;
    hi = Math.min(maxDer, hi * 1.8);
  }
  if (hi >= maxDer && feasible(maxDer)) {
    return { ...evaluate(maxDer), hosting_capacity_mw: maxDer };
  }
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if (feasible(mid)) lo = mid;
    else hi = mid;
    if (hi - lo < tolerance) break;
  }
  const result = evaluate(lo);
  return { ...result, hosting_capacity_mw: roundTo(lo, 2) };
}

// ---- Convenience ------------------------------------------------------------

/** Aggregate feeder summary used by the municipality engine and the UI. */
export function feederSummary(result: RadialPowerFlowResult): {
  peak_loading_pct: number;
  min_voltage_pu: number;
  max_voltage_pu: number;
  loss_pct: number;
  worst_branch: BranchResult | null;
} {
  const worst = result.branches.reduce<BranchResult | null>(
    (acc, b) => (acc === null || b.loading_pct > acc.loading_pct ? b : acc),
    null,
  );
  const delivered = Math.max(1e-9, result.total_load_mw);
  return {
    peak_loading_pct: worst?.loading_pct ?? 0,
    min_voltage_pu: result.min_voltage_pu,
    max_voltage_pu: result.max_voltage_pu,
    loss_pct: (result.total_loss_mw / delivered) * 100,
    worst_branch: worst,
  };
}

/** Power factor implied by a load bus. */
export function busPowerFactor(bus: BusSpec): number {
  return powerFactor(bus.load_mw, bus.load_mvar);
}
