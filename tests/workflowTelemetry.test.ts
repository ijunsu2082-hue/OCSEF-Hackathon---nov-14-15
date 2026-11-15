import test from "node:test";
import assert from "node:assert/strict";
import { parseCaisoLmpCsv } from "../lib/workflowTelemetry/providers";

const fetchedAt = new Date("2026-11-15T19:05:00.000Z");

test("CAISO parser keeps only total LMP for the selected named node and preserves revision metadata", () => {
  const csv = [
    "INTERVALSTARTTIME_GMT,INTERVALENDTIME_GMT,OPR_DT,OPR_HR,NODE_ID_XML,NODE_ID,NODE,MARKET_RUN_ID,LMP_TYPE,XML_DATA_ITEM,PNODE_RESMRID,GRP_TYPE,POS,VALUE,OPR_INTERVAL,GROUP",
    "2026-11-15T19:00:00-00:00,2026-11-15T19:15:00-00:00,2026-11-15,12,TH_SP15_GEN-APND,TH_SP15_GEN-APND,TH_SP15_GEN-APND,RTM,MCC,LMP_CONG_PRC,abc,,1,3.5,1,8",
    "2026-11-15T19:00:00-00:00,2026-11-15T19:15:00-00:00,2026-11-15,12,TH_SP15_GEN-APND,TH_SP15_GEN-APND,TH_SP15_GEN-APND,RTM,LMP,LMP_PRC,abc,,1,42.75,1,8",
    "2026-11-15T19:00:00-00:00,2026-11-15T19:15:00-00:00,2026-11-15,12,OTHER,OTHER,OTHER,RTM,LMP,LMP_PRC,xyz,,1,999,1,8",
  ].join("\n");
  const rows = parseCaisoLmpCsv(csv, "TH_SP15_GEN-APND", fetchedAt);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value, 42.75);
  assert.equal(rows[0].unit, "USD/MWh");
  assert.equal(rows[0].target, "TH_SP15_GEN-APND");
  assert.match(rows[0].sourceRevision ?? "", /^row-[a-f0-9]{24}$/);
  assert.equal(rows[0].observedAt, "2026-11-15T19:00:00.000Z");
  assert.equal(rows[0].fetchedAt, fetchedAt.toISOString());
  assert.equal(rows[0].qualifiers.marketRunId, "RTM");
  assert.equal(rows[0].qualifiers.sourceInterval, "2026-11-15T19:00:00-00:00");
  assert.equal(rows[0].qualifiers.sourceGroup, "8");
  assert.equal(rows[0].qualifiers.revisionKind, "content-hash");
});

test("CAISO parser rejects a malformed provider response instead of returning an empty success", () => {
  assert.throws(() => parseCaisoLmpCsv("ERROR: no data", "TH_SP15_GEN-APND", fetchedAt), /CSV header/);
});
