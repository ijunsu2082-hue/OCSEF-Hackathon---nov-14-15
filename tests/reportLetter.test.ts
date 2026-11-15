import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGridData } from "../lib/scan/data";
import { scanArea } from "../lib/scan/scan";
import {
  buildDraft,
  fileQuickReport,
  loadReports,
  mailtoHref,
  quickReportLetter,
  quickRouting,
  resolveUtility,
} from "../lib/scan/compliance";
import type { ReportTarget } from "../lib/scan/target";
import { stubFetchFromPublic } from "./helpers";

stubFetchFromPublic();

async function anaheimPlant() {
  const data = await loadGridData();
  const plant = data.plants.find((p) => /AT&T Anaheim/i.test(p.plant_name));
  assert.ok(plant, "AT&T Anaheim plant in the dataset");
  const result = scanArea(data, { lat: plant.lat, lon: plant.lon, radius_mi: 5 });
  const target = { kind: "plant", plant } as ReportTarget;
  return { result, target, draft: buildDraft(target, result, null, false) };
}

test("Anaheim report is addressed to Anaheim Public Utilities by email", async () => {
  const { result, target, draft } = await anaheimPlant();
  const routing = quickRouting(["tree", "old_broken"], resolveUtility(target, result, null));
  assert.equal(routing.utility?.key, "anaheim");
  assert.equal(routing.email, "CustomerService@anaheim.net");

  const letter = quickReportLetter(draft, ["tree", "old_broken"], "The wire is broken.", routing, { name: "Jordan Lee", contact: "jordan@example.com" });
  assert.equal(letter.to, "CustomerService@anaheim.net");
  assert.match(letter.subject, /^Safety report: Tree touching a power line and damaged equipment near AT&T Anaheim$/);
  assert.match(letter.body, /^Dear Anaheim Public Utilities Customer Service Team,/);
  assert.match(letter.body, /What I observed\n- A tree or branch appears to be touching a power line\./);
  assert.match(letter.body, /- Additional details: The wire is broken\./);
  assert.match(letter.body, /General Order 95/);
  assert.match(letter.body, /Reply with a reference number/);
  assert.match(letter.body, /Sincerely,\nJordan Lee\njordan@example\.com$/);
  // Instructions for the person and app branding stay out of the letter.
  assert.doesNotMatch(letter.body, /911|Mapergy|student-built|Where to send it/);

  const href = mailtoHref(letter.subject, letter.body, letter.to);
  assert.ok(href.startsWith("mailto:CustomerService@anaheim.net?subject="), href.slice(0, 60));
});

test("utilities without a published email leave the recipient empty and the signature as placeholders", async () => {
  const { result, target, draft } = await anaheimPlant();
  const routing = quickRouting(["outage"], resolveUtility(target, result, "sce"));
  assert.equal(routing.email, null);
  const letter = quickReportLetter(draft, ["outage"], "", routing);
  assert.equal(letter.to, null);
  assert.match(letter.subject, /^Service request: Power outage near /);
  assert.match(letter.body, /^Dear Southern California Edison \(SCE\) Customer Service Team,/);
  assert.match(letter.body, /\[Your name\]\n\[Your phone number or email\]$/);
  assert.ok(mailtoHref(letter.subject, letter.body, letter.to).startsWith("mailto:?subject="));
  assert.ok(mailtoHref("s", "b", "not an email").startsWith("mailto:?subject="), "rejects a malformed recipient");
});

test("filed reports keep the letter through save and load", async () => {
  const { result, target, draft } = await anaheimPlant();
  const routing = quickRouting(["tree"], resolveUtility(target, result, null));
  const r = fileQuickReport(draft, ["tree"], "", routing, new Date("2026-11-15T19:00:00Z"), { name: "A", contact: "B" });
  assert.equal(r.email?.to, "CustomerService@anaheim.net");
  const store = new Map<string, string>([["gs-reports-v1", JSON.stringify([r])]]);
  const g = globalThis as { window?: unknown };
  const had = "window" in g;
  const prev = g.window;
  g.window = { localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) } };
  try {
    const [back] = loadReports();
    assert.deepEqual(back.email, r.email);
  } finally {
    if (had) g.window = prev;
    else delete g.window;
  }
});
