/**
 * Project economics for municipal infrastructure and grid upgrades.
 *
 * All functions are deterministic and use nominal dollars. The screening
 * conventions match the rest of the repo: simple payback is capex / annual
 * savings, LCOE uses a capital recovery factor, and NPV/IRR use an explicit
 * discount rate. Nothing here hides a subsidy or a financing assumption.
 */

import { clamp, roundTo } from "./units";

export interface EconomicAssumptions {
  discount_rate: number;
  project_life_years: number;
  /** Retail or wholesale energy price, $/MWh. */
  energy_price_usd_per_mwh: number;
  /** Value of avoided losses, $/MWh. Usually the same as energy price. */
  loss_value_usd_per_mwh: number;
  /** Value of lost load, $/MWh. */
  voll_usd_per_mwh: number;
  /** Social cost of carbon, $/tonne. */
  carbon_price_usd_per_ton: number;
  /** Annual O&M escalation, fraction per year. */
  om_escalation: number;
  /** Energy price escalation, fraction per year. */
  energy_escalation: number;
}

export const DEFAULT_ECONOMICS: EconomicAssumptions = {
  discount_rate: 0.07,
  project_life_years: 25,
  energy_price_usd_per_mwh: 145,
  loss_value_usd_per_mwh: 145,
  voll_usd_per_mwh: 12_000,
  carbon_price_usd_per_ton: 51,
  om_escalation: 0.02,
  energy_escalation: 0.025,
};

/** CRF = r(1+r)^n / ((1+r)^n − 1), the annual payment per $1 of capex. */
export function capitalRecoveryFactor(rate: number, years: number): number {
  const r = Math.max(0, rate);
  const n = Math.max(1, years);
  if (r === 0) return 1 / n;
  const factor = Math.pow(1 + r, n);
  return (r * factor) / (factor - 1);
}

/**
 * Levelized cost of energy, $/MWh:
 *   LCOE = (CRF · capex + annual O&M) / annual MWh
 */
export function levelizedCost(
  capexUsd: number,
  annualOmUsd: number,
  annualMwh: number,
  rate = DEFAULT_ECONOMICS.discount_rate,
  years = DEFAULT_ECONOMICS.project_life_years,
): number {
  if (annualMwh <= 0) return 0;
  const crf = capitalRecoveryFactor(rate, years);
  return roundTo((crf * Math.max(0, capexUsd) + Math.max(0, annualOmUsd)) / annualMwh, 2);
}

/** Net present value of a cash-flow series, starting at t=0. */
export function npv(rate: number, cashflows: readonly number[]): number {
  const r = Math.max(-0.99, rate);
  return roundTo(
    cashflows.reduce((sum, cf, t) => sum + cf / Math.pow(1 + r, t), 0),
    2,
  );
}

/**
 * Internal rate of return by bisection. Returns null when the cash flows never
 * cross zero (for example, a project with no positive year).
 */
export function irr(
  cashflows: readonly number[],
  options: { low?: number; high?: number; tolerance?: number } = {},
): number | null {
  if (cashflows.length < 2) return null;
  let low = options.low ?? -0.9;
  let high = options.high ?? 1.0;
  const tolerance = options.tolerance ?? 1e-7;
  const f = (r: number): number =>
    cashflows.reduce((sum, cf, t) => sum + cf / Math.pow(1 + r, t), 0);
  let fLow = f(low);
  let fHigh = f(high);
  if (fLow * fHigh > 0) {
    // Expand once before giving up; infrastructure cash flows can be slow.
    high = 5;
    fHigh = f(high);
    if (fLow * fHigh > 0) return null;
  }
  for (let i = 0; i < 200; i += 1) {
    const mid = (low + high) / 2;
    const fMid = f(mid);
    if (Math.abs(fMid) < tolerance || high - low < tolerance) {
      return roundTo(mid, 6);
    }
    if (fLow * fMid <= 0) {
      high = mid;
      fHigh = fMid;
    } else {
      low = mid;
      fLow = fMid;
    }
  }
  return roundTo((low + high) / 2, 6);
}

/** Simple payback in years; null when the project never pays back. */
export function simplePayback(capexUsd: number, annualSavingsUsd: number): number | null {
  if (annualSavingsUsd <= 0) return null;
  return roundTo(Math.max(0, capexUsd) / annualSavingsUsd, 2);
}

/** Discounted payback: first year the cumulative NPV turns non-negative. */
export function discountedPayback(
  capexUsd: number,
  annualSavingsUsd: number,
  rate = DEFAULT_ECONOMICS.discount_rate,
  maxYears = 50,
): number | null {
  if (annualSavingsUsd <= 0) return null;
  let cumulative = -capexUsd;
  for (let year = 1; year <= maxYears; year += 1) {
    cumulative += annualSavingsUsd / Math.pow(1 + rate, year);
    if (cumulative >= 0) return year;
  }
  return null;
}

/** Annual cash-flow series for a simple capex → savings project. */
export function projectCashflows(
  capexUsd: number,
  annualSavingsUsd: number,
  years = DEFAULT_ECONOMICS.project_life_years,
  escalation = 0,
): number[] {
  const flows: number[] = [-Math.max(0, capexUsd)];
  for (let year = 1; year <= years; year += 1) {
    flows.push(annualSavingsUsd * Math.pow(1 + escalation, year - 1));
  }
  return flows;
}

/** Value of avoided energy losses, $/yr. */
export function lossSavingsUsd(
  lossMwh: number,
  pricePerMwh = DEFAULT_ECONOMICS.loss_value_usd_per_mwh,
): number {
  return roundTo(Math.max(0, lossMwh) * Math.max(0, pricePerMwh), 0);
}

/** Cost of unserved energy, $/yr. */
export function unservedEnergyCost(
  unservedMwh: number,
  vollPerMwh = DEFAULT_ECONOMICS.voll_usd_per_mwh,
): number {
  return roundTo(Math.max(0, unservedMwh) * Math.max(0, vollPerMwh), 0);
}

/** Social cost of carbon, $/yr. */
export function carbonCost(
  tonsPerYear: number,
  pricePerTon = DEFAULT_ECONOMICS.carbon_price_usd_per_ton,
): number {
  return roundTo(Math.max(0, tonsPerYear) * Math.max(0, pricePerTon), 0);
}

export interface UpgradeEconomics {
  capex_usd: number;
  annual_savings_usd: number;
  annual_mwh_saved: number;
  annual_co2_tons_avoided: number;
  simple_payback_years: number | null;
  discounted_payback_years: number | null;
  npv_usd: number;
  irr: number | null;
  lcoe_usd_per_mwh: number;
}

/** Bundle the standard screening metrics for a municipal upgrade. */
export function upgradeEconomics(
  input: {
    capex_usd: number;
    annual_savings_usd: number;
    annual_mwh_saved?: number;
    annual_co2_tons_avoided?: number;
    annual_om_usd?: number;
  },
  assumptions: EconomicAssumptions = DEFAULT_ECONOMICS,
): UpgradeEconomics {
  const years = assumptions.project_life_years;
  const flows = projectCashflows(
    input.capex_usd,
    input.annual_savings_usd,
    years,
    assumptions.energy_escalation,
  );
  return {
    capex_usd: Math.round(input.capex_usd),
    annual_savings_usd: Math.round(input.annual_savings_usd),
    annual_mwh_saved: roundTo(input.annual_mwh_saved ?? 0, 1),
    annual_co2_tons_avoided: roundTo(input.annual_co2_tons_avoided ?? 0, 1),
    simple_payback_years: simplePayback(input.capex_usd, input.annual_savings_usd),
    discounted_payback_years: discountedPayback(
      input.capex_usd,
      input.annual_savings_usd,
      assumptions.discount_rate,
      years,
    ),
    npv_usd: npv(assumptions.discount_rate, flows),
    irr: irr(flows),
    lcoe_usd_per_mwh: levelizedCost(
      input.capex_usd,
      input.annual_om_usd ?? 0,
      Math.max(1e-9, input.annual_mwh_saved ?? 0),
      assumptions.discount_rate,
      years,
    ),
  };
}

/**
 * Levelized cost of a municipal supply portfolio, including grid losses.
 * `deliveredMwh` is energy at the customer meter; losses are added upstream.
 */
export function municipalLcoe(
  annualCostUsd: number,
  gridCapexUsd: number,
  deliveredMwh: number,
  assumptions: EconomicAssumptions = DEFAULT_ECONOMICS,
): number {
  if (deliveredMwh <= 0) return 0;
  const crf = capitalRecoveryFactor(
    assumptions.discount_rate,
    assumptions.project_life_years,
  );
  return roundTo(
    (annualCostUsd + crf * Math.max(0, gridCapexUsd)) / deliveredMwh,
    2,
  );
}

/**
 * Cost per added peak MW, the headline number for a buildout interconnection.
 * It spreads interconnection and upstream capacity over the new peak.
 */
export function costPerAddedMw(
  interconnectionCapexUsd: number,
  addedPeakMw: number,
): number {
  if (addedPeakMw <= 0) return 0;
  return roundTo(interconnectionCapexUsd / addedPeakMw, 0);
}

/** Capacity value of a MW of firm reduction, $/yr. */
export function capacityValue(
  firmMw: number,
  valuePerMwYear = 120_000,
  reserveMargin = 0.15,
): number {
  const firm = Math.max(0, firmMw) * (1 + clamp(reserveMargin, 0, 1));
  return Math.round(firm * Math.max(0, valuePerMwYear));
}
