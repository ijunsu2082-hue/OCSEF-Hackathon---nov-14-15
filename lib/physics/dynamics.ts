/**
 * Frequency dynamics: the swing equation, governor droop, fast frequency
 * response, under-frequency load shedding and inertia adequacy.
 *
 * The model is a single aggregated control area, which is the right screening
 * granularity for a municipality or a buildout study. It answers three
 * questions the regional energy model cannot:
 *
 *   1. If the largest infeed trips, how fast does frequency fall (ROCOF)?
 *   2. How low does it go before governors and batteries catch it (nadir)?
 *   3. Does under-frequency load shedding have to fire, and how much load?
 *
 * It is not a modal or electromagnetic transient study. Inter-area
 * oscillations and inverter control interactions need a positive-sequence
 * dynamic model with actual controller data.
 */

import { F_NOMINAL_HZ, clamp, roundTo } from "./units";

export type GeneratorType =
  | "gas_cc"
  | "gas_steam"
  | "hydro"
  | "nuclear"
  | "wind"
  | "solar"
  | "battery"
  | "other";

/**
 * Typical inertia constants H (MW·s/MVA). Inverter-based resources are zero
 * unless they provide synthetic inertia; that is a control choice, not a
 * property of the fuel.
 */
export const DEFAULT_INERTIA_H: Record<GeneratorType, number> = {
  gas_cc: 6.0,
  gas_steam: 5.0,
  hydro: 3.0,
  nuclear: 6.0,
  wind: 0,
  solar: 0,
  battery: 0,
  other: 4.0,
};

export interface InertiaSource {
  id: string;
  type: GeneratorType;
  /** Online rated MVA. */
  mva: number;
  /** Override H, MW·s/MVA. */
  inertia_constant_s?: number;
  online?: boolean;
}

export interface SystemInertia {
  online_mva: number;
  inertia_mws: number;
  h_sys_s: number;
  synchronous_mva: number;
  inverter_mva: number;
  synchronous_share_pct: number;
}

export function systemInertia(sources: readonly InertiaSource[]): SystemInertia {
  let onlineMva = 0;
  let inertiaMws = 0;
  let synchronousMva = 0;
  let inverterMva = 0;
  for (const source of sources) {
    if (source.online === false) continue;
    const mva = Math.max(0, source.mva);
    onlineMva += mva;
    const h = source.inertia_constant_s ?? DEFAULT_INERTIA_H[source.type] ?? 4;
    inertiaMws += h * mva;
    if (source.type === "wind" || source.type === "solar" || source.type === "battery") {
      inverterMva += mva;
    } else {
      synchronousMva += mva;
    }
  }
  return {
    online_mva: roundTo(onlineMva, 2),
    inertia_mws: roundTo(inertiaMws, 2),
    h_sys_s: onlineMva > 0 ? roundTo(inertiaMws / onlineMva, 3) : 0,
    synchronous_mva: roundTo(synchronousMva, 2),
    inverter_mva: roundTo(inverterMva, 2),
    synchronous_share_pct:
      onlineMva > 0 ? roundTo((synchronousMva / onlineMva) * 100, 1) : 0,
  };
}

/**
 * Initial rate of change of frequency after a loss of infeed:
 *
 *   ROCOF = −ΔP / (2 · E_inertia) · f₀
 *
 * with ΔP in MW and E_inertia in MW·s. The system MVA base cancels, which is
 * why the answer depends on stored kinetic energy rather than on nameplate.
 */
export function rocofFromLoss(lossMw: number, inertiaMws: number): number {
  if (inertiaMws <= 0) return -Infinity;
  return (-lossMw / (2 * inertiaMws)) * F_NOMINAL_HZ;
}

export interface UflsStage {
  frequency_hz: number;
  shed_mw: number;
  label?: string;
}

/** Typical three-stage UFLS ladder. Percentages are of the served load. */
export function defaultUflsStages(servedLoadMw: number): UflsStage[] {
  return [
    { frequency_hz: 59.3, shed_mw: servedLoadMw * 0.1, label: "UFLS 1" },
    { frequency_hz: 58.9, shed_mw: servedLoadMw * 0.1, label: "UFLS 2" },
    { frequency_hz: 58.5, shed_mw: servedLoadMw * 0.1, label: "UFLS 3" },
  ];
}

export interface FrequencyEventInput {
  /** Online system MVA, the swing-equation base. */
  system_mva: number;
  /** Total stored kinetic energy, MW·s. */
  inertia_mws: number;
  /** Lost infeed, MW. Positive. */
  loss_mw: number;
  /** Load damping D, pu power per pu frequency. Typical 1–2. */
  load_damping_pu?: number;
  /** Governor droop, percent. Typical 5 %. */
  governor_droop_pct?: number;
  /** Governor lag, seconds. Typical 2–5 s for thermal, <1 s for hydro. */
  governor_time_constant_s?: number;
  /** Governor reserve available, MW. Defaults to 10 % of system MVA. */
  governor_reserve_mw?: number;
  /** Fast frequency response from batteries, MW. */
  bess_mw?: number;
  /** Battery droop, MW per Hz. Defaults to full output at 0.5 Hz. */
  bess_gain_mw_per_hz?: number;
  /** Battery response lag, seconds. Default 0.2 s. */
  bess_time_constant_s?: number;
  ufls?: UflsStage[];
  duration_s?: number;
  dt_s?: number;
  record_every_s?: number;
}

export interface FrequencySample {
  t_s: number;
  frequency_hz: number;
  p_gov_mw: number;
  p_bess_mw: number;
  p_shed_mw: number;
}

export interface FrequencyEventResult {
  loss_mw: number;
  inertia_constant_s: number;
  rocof_hz_s: number;
  nadir_hz: number;
  time_to_nadir_s: number;
  final_hz: number;
  settling_hz: number;
  steady_state_hz: number;
  ufls_shed_mw: number;
  governor_response_mw: number;
  bess_response_mw: number;
  samples: FrequencySample[];
}

/**
 * Integrate the aggregated swing equation:
 *
 *   2H · dΔf/dt = −ΔP + P_gov + P_ffr + P_shed − D·Δf
 *
 * Governor and battery responses are first-order lags toward their droop
 * targets. UFLS stages latch when frequency crosses them. `dt_s` defaults to
 * 0.01 s; the returned samples are thinned to `record_every_s`.
 */
export function frequencyEvent(input: FrequencyEventInput): FrequencyEventResult {
  const systemMva = Math.max(1e-6, input.system_mva);
  const inertiaMws = Math.max(0, input.inertia_mws);
  const hSys = inertiaMws / systemMva;
  const lossMw = Math.max(0, input.loss_mw);
  const lossPu = lossMw / systemMva;
  const D = Math.max(0, input.load_damping_pu ?? 1);
  const droop = clamp((input.governor_droop_pct ?? 5) / 100, 0.01, 0.2);
  const tauGov = Math.max(0.01, input.governor_time_constant_s ?? 2.5);
  const governorReserve = Math.max(
    0,
    input.governor_reserve_mw ?? systemMva * 0.1,
  );
  const bessMw = Math.max(0, input.bess_mw ?? 0);
  const bessGain =
    input.bess_gain_mw_per_hz ?? (bessMw > 0 ? bessMw / 0.5 : 0);
  const tauBess = Math.max(0.01, input.bess_time_constant_s ?? 0.2);
  const ufls = [...(input.ufls ?? [])].sort((a, b) => b.frequency_hz - a.frequency_hz);
  const duration = clamp(input.duration_s ?? 60, 1, 600);
  const dt = clamp(input.dt_s ?? 0.01, 0.001, 0.1);
  const recordEvery = Math.max(dt, input.record_every_s ?? 0.5);

  const rocof = rocofFromLoss(lossMw, inertiaMws);
  if (lossMw === 0 || inertiaMws <= 0) {
    return {
      loss_mw: lossMw,
      inertia_constant_s: roundTo(hSys, 4),
      rocof_hz_s: Number.isFinite(rocof) ? roundTo(rocof, 4) : rocof,
      nadir_hz: F_NOMINAL_HZ,
      time_to_nadir_s: 0,
      final_hz: F_NOMINAL_HZ,
      settling_hz: F_NOMINAL_HZ,
      steady_state_hz: F_NOMINAL_HZ,
      ufls_shed_mw: 0,
      governor_response_mw: 0,
      bess_response_mw: 0,
      samples: [{ t_s: 0, frequency_hz: F_NOMINAL_HZ, p_gov_mw: 0, p_bess_mw: 0, p_shed_mw: 0 }],
    };
  }

  let df = 0; // per-unit frequency deviation
  let pGov = 0; // per-unit on system base, positive generation
  let pBess = 0;
  let pShed = 0;
  let t = 0;
  let nadir = F_NOMINAL_HZ;
  let timeToNadir = 0;
  let uflsShedMw = 0;
  const triggered = new Set<number>();
  const samples: FrequencySample[] = [
    { t_s: 0, frequency_hz: F_NOMINAL_HZ, p_gov_mw: 0, p_bess_mw: 0, p_shed_mw: 0 },
  ];
  let nextRecord = recordEvery;

  const maxSteps = Math.ceil(duration / dt) + 1;
  for (let step = 0; step < maxSteps; step += 1) {
    // First-order governor and FFR responses toward their droop targets.
    const govTargetPu = clamp(-df / droop, 0, governorReserve / systemMva);
    const bessTargetPu =
      bessGain > 0
        ? clamp((bessGain * -df * F_NOMINAL_HZ) / systemMva, 0, bessMw / systemMva)
        : 0;
    const alphaGov = 1 - Math.exp(-dt / tauGov);
    const alphaBess = 1 - Math.exp(-dt / tauBess);
    pGov += (govTargetPu - pGov) * alphaGov;
    pBess += (bessTargetPu - pBess) * alphaBess;

    // Swing equation. Damping is positive for a frequency drop, so it helps.
    const dDf = (-lossPu + pGov + pBess + pShed - D * df) / (2 * Math.max(1e-4, hSys));
    df += dDf * dt;
    t += dt;

    const frequency = F_NOMINAL_HZ * (1 + df);
    if (frequency < nadir) {
      nadir = frequency;
      timeToNadir = t;
    }

    // Latch UFLS stages in descending frequency order.
    for (let i = 0; i < ufls.length; i += 1) {
      const stage = ufls[i];
      if (!triggered.has(i) && frequency <= stage.frequency_hz) {
        triggered.add(i);
        pShed += stage.shed_mw / systemMva;
        uflsShedMw += stage.shed_mw;
      }
    }

    if (t >= nextRecord - 1e-9) {
      samples.push({
        t_s: roundTo(t, 2),
        frequency_hz: roundTo(frequency, 4),
        p_gov_mw: roundTo(pGov * systemMva, 2),
        p_bess_mw: roundTo(pBess * systemMva, 2),
        p_shed_mw: roundTo(pShed * systemMva, 2),
      });
      nextRecord += recordEvery;
    }
  }

  const finalHz = F_NOMINAL_HZ * (1 + df);
  const steadyDf = -lossPu / (D + Math.min(1 / droop, governorReserve / systemMva));
  const steadyHz = F_NOMINAL_HZ * (1 + clamp(steadyDf, -0.5, 0.1));

  return {
    loss_mw: roundTo(lossMw, 2),
    inertia_constant_s: roundTo(hSys, 4),
    rocof_hz_s: roundTo(rocof, 4),
    nadir_hz: roundTo(nadir, 4),
    time_to_nadir_s: roundTo(timeToNadir, 2),
    final_hz: roundTo(finalHz, 4),
    settling_hz: roundTo(finalHz, 4),
    steady_state_hz: roundTo(steadyHz, 4),
    ufls_shed_mw: roundTo(uflsShedMw, 2),
    governor_response_mw: roundTo(pGov * systemMva, 2),
    bess_response_mw: roundTo(pBess * systemMva, 2),
    samples,
  };
}

/** Long-run frequency after a step loss, with governor reserve and damping. */
export function steadyStateFrequency(
  lossMw: number,
  systemMva: number,
  options: { load_damping_pu?: number; governor_droop_pct?: number; governor_reserve_mw?: number } = {},
): number {
  const D = Math.max(0, options.load_damping_pu ?? 1);
  const droop = clamp((options.governor_droop_pct ?? 5) / 100, 0.01, 0.2);
  const reserve = Math.max(0, options.governor_reserve_mw ?? systemMva * 0.1);
  const response = Math.min(1 / droop, reserve / Math.max(1e-6, systemMva));
  const df = -(lossMw / Math.max(1e-6, systemMva)) / Math.max(1e-6, D + response);
  return F_NOMINAL_HZ * (1 + df);
}

export type StressBand = "ok" | "watch" | "high" | "critical";

export function rocofBand(rocofHzPerS: number): StressBand {
  const magnitude = Math.abs(rocofHzPerS);
  if (magnitude >= 1.5) return "critical";
  if (magnitude >= 1.0) return "high";
  if (magnitude >= 0.5) return "watch";
  return "ok";
}

export function nadirBand(nadirHz: number): StressBand {
  if (nadirHz < 57.0) return "critical";
  if (nadirHz < 58.0) return "high";
  if (nadirHz < 59.0) return "watch";
  return "ok";
}

export function inertiaBand(hSys: number): StressBand {
  if (hSys < 1.5) return "critical";
  if (hSys < 2.5) return "high";
  if (hSys < 4.0) return "watch";
  return "ok";
}

export function stiffnessBand(scr: number): StressBand {
  if (scr < 2) return "critical";
  if (scr < 3) return "high";
  if (scr < 5) return "watch";
  return "ok";
}

/** Combined stability verdict from the four independent screens. */
export function stabilityScore(summary: {
  rocof_hz_s: number;
  nadir_hz: number;
  h_sys_s: number;
  scr: number;
}): { score: number; band: StressBand; binding: string } {
  const bands: [string, StressBand, number][] = [
    ["ROCOF", rocofBand(summary.rocof_hz_s), 0.3],
    ["Nadir", nadirBand(summary.nadir_hz), 0.3],
    ["Inertia", inertiaBand(summary.h_sys_s), 0.2],
    ["Stiffness", stiffnessBand(summary.scr), 0.2],
  ];
  const rank: Record<StressBand, number> = { ok: 0, watch: 1, high: 2, critical: 3 };
  let score = 0;
  let worst: StressBand = "ok";
  let binding = "none";
  for (const [name, band, weight] of bands) {
    score += rank[band] * weight;
    if (rank[band] > rank[worst]) {
      worst = band;
      binding = name;
    }
  }
  return {
    score: Math.round((score / 3) * 1000) / 10,
    band: worst,
    binding,
  };
}
