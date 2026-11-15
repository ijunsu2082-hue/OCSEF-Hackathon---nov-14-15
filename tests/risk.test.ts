import { test } from "node:test";
import assert from "node:assert/strict";
import { hazardScore, riskLevel, riskRange, WEIGHTS } from "../lib/scan/risk";
import { loadGridData } from "../lib/scan/data";
import { scanArea } from "../lib/scan/scan";
import { QUICK_SPOTS } from "../lib/scan/index";
import { stubFetchFromPublic } from "./helpers";

stubFetchFromPublic();

test("weights sum to 1 and each has a reason", () => {
  const ws = Object.values(WEIGHTS);
  assert.ok(Math.abs(ws.reduce((s, w) => s + w.weight, 0) - 1) < 1e-9);
  for (const w of ws) assert.ok(w.reason.length > 10);
});

test("hazard factor is capped so one story cannot reach 100", () => {
  assert.deepEqual([0, 1, 2, 3, 4, 10].map(hazardScore), [0, 25, 45, 60, 70, 70]);
});

test("riskRange is deterministic and brackets simple cases", () => {
  const same = [{ score: 40, weight: 0.5 }, { score: 40, weight: 0.5 }];
  assert.deepEqual(riskRange(same), { min: 40, max: 40 });
  // Two factors 0 and 100, weights 0.5/0.5 varied by +-50%: extremes 0.25/1 and 0.75/1 -> 25..75.
  assert.deepEqual(riskRange([{ score: 0, weight: 0.5 }, { score: 100, weight: 0.5 }]), { min: 25, max: 75 });
  assert.deepEqual(riskRange({ factors: same }), riskRange(same));
});

test("riskRange min <= score <= max on real scans", async () => {
  const data = await loadGridData();
  for (const spot of QUICK_SPOTS) {
    for (const radius of [5, 30]) {
      for (const heatwave of [false, true]) {
        const r = scanArea(data, { lat: spot.lat, lon: spot.lon, radius_mi: radius }, { heatwave });
        const { min, max } = riskRange(r.risk);
        const label = `${spot.name} ${radius} mi${heatwave ? " heatwave" : ""}`;
        assert.ok(min <= r.risk.score && r.risk.score <= max, `${label}: ${min} <= ${r.risk.score} <= ${max}`);
        assert.ok(Math.abs(r.risk.factors.reduce((s, f) => s + f.weight, 0) - 1) < 1e-9, `${label}: weights`);
        assert.equal(r.risk.level, riskLevel(r.risk.score));
        for (const f of r.risk.factors) assert.ok(f.score >= 0 && f.score <= 100, `${label} ${f.key}=${f.score}`);
        const hz = r.risk.factors.find((f) => f.key === "hazard")!;
        assert.ok(hz.score <= 70, `${label}: hazard ${hz.score}`);
        if (spot.name === "Westminster HS" && !heatwave) console.log(`risk ${label}: ${r.risk.score} (range ${min}-${max})`);
      }
    }
  }
});
