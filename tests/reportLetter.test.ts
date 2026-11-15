import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGridData } from "../lib/scan/data";
import { scanArea } from "../lib/scan/scan";
import {
  HAZARDS,
  MAIL_BODY_MAX,
  buildDraft,
  detectUtility,
  fileQuickReport,
  type HazardId,
  loadReports,
  mailtoHref,
  quickReportLetter,
  quickRouting,
  resolveUtility,
} from "../lib/scan/compliance";
import type { ReportTarget } from "../lib/scan/target";
import { UTILITIES, type UtilityInfo, type UtilityKey } from "../lib/scan/legal";
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
  assert.match(letter.body, /Reply with a reference number for this report/);
  assert.match(letter.body, /Sincerely,\nJordan Lee\njordan@example\.com$/);
  // Instructions for the person and app branding stay out of the letter.
  assert.doesNotMatch(letter.body, /911|Mapergy|student-built|Where to send it/);

  const href = mailtoHref(letter.subject, letter.body, letter.to);
  assert.ok(href.startsWith("mailto:CustomerService@anaheim.net?subject="), href.slice(0, 60));
});

test("utilities without a published email get their report page, never a blank email", async () => {
  const { result, target, draft } = await anaheimPlant();
  const routing = quickRouting(["outage"], resolveUtility(target, result, "sce"));
  assert.equal(routing.email, null);
  assert.equal(routing.delivery, "form");
  assert.equal(routing.formUrl, UTILITIES.sce.reportUrl);
  assert.match(routing.note ?? "", /SCE has no customer email address.*paste it into SCE's report page or call 1-800-611-1911/);
  const letter = quickReportLetter(draft, ["outage"], "", routing);
  assert.equal(letter.to, null);
  assert.equal(letter.formUrl, UTILITIES.sce.reportUrl);
  assert.equal(letter.recipient, "SCE");
  assert.match(letter.subject, /^Service request: Power outage near /);
  assert.match(letter.body, /^Dear Southern California Edison \(SCE\) Customer Service Team,/);
  // No placeholders to fill in: a blank name signs as a resident, a blank contact is left out.
  assert.match(letter.body, /Sincerely,\nA local resident$/);
  assert.doesNotMatch(letter.body, /\[|\]/);
  assert.ok(mailtoHref("s", "b", "not an email").startsWith("mailto:?subject="), "rejects a malformed recipient");
});

test("not sure which utility: the report waits for a pick instead of an unaddressed letter", async () => {
  const { result, target } = await anaheimPlant();
  const unsure = resolveUtility(target, result, "notsure");
  assert.equal(unsure.known, false);
  const routing = quickRouting(["tree"], unsure);
  assert.equal(routing.delivery, "pick");
  assert.equal(routing.email, null);
});

async function marion() {
  const data = await loadGridData();
  const sub = data.substations.find((s) => s.name === "Marion Substation");
  assert.ok(sub, "Marion Substation in the dataset");
  const result = scanArea(data, { lat: sub.lat, lon: sub.lon, radius_mi: 5 });
  return { data, result, sub, target: { kind: "substation", substation: sub } as ReportTarget };
}

test("Marion Substation (operator Southern California Edison) goes to SCE, not LADWP", async () => {
  const { result, target } = await marion();
  assert.equal(detectUtility(target, result).utility.key, "sce");
  const u = resolveUtility(target, result, null);
  assert.equal(u.utility.key, "sce");

  const tree = quickRouting(["tree"], u);
  assert.equal(tree.delivery, "email");
  assert.equal(tree.email, "safetrees@sce.com");
  assert.equal(tree.emailSource, "https://www.sce.com/factsheet/vegetation-management");
  const draft = buildDraft(target, result, null, false);
  const letter = quickReportLetter(draft, ["tree"], "", tree, { name: "Sam Park", contact: "(714) 555-0100" });
  assert.equal(letter.to, "safetrees@sce.com");
  assert.equal(letter.subject, "Safety report: Tree touching a power line near Marion Substation");
  assert.match(letter.body, /^Dear Southern California Edison \(SCE\) Vegetation Management Team,\n\nI am writing to report a possible safety hazard at Marion Substation \(33\.8177° N, 118\.0274° W\)\./);
  assert.match(letter.body, /- Marion Substation \(66 kV substation, operator: Southern California Edison\)/);
  assert.match(letter.body, /What I am requesting\n1\. Send a crew to inspect the equipment and make it safe\.\n2\. Trim the vegetation back to the clearances required by CPUC General Order 95, Rule 35\.\n3\. Reply with a reference number/);
  assert.match(letter.body, /Sincerely,\nSam Park\n\(714\) 555-0100$/);
  assert.doesNotMatch(letter.body, /LADWP|Los Angeles/);
  const href = mailtoHref(letter.subject, letter.body, letter.to);
  assert.ok(href.startsWith("mailto:safetrees@sce.com?subject=Safety%20report"), href.slice(0, 70));

  // Other SCE problems have no email: SCE's own report page instead.
  const broken = quickRouting(["old_broken"], u);
  assert.equal(broken.delivery, "form");
  assert.equal(broken.formUrl, "https://www.sce.com/outages-safety/report-outage-safety-issue");
});

test("every utility has a verified email or a report page, and tree reports go to tree teams", () => {
  for (const k of Object.keys(UTILITIES) as UtilityKey[]) {
    const u: UtilityInfo = UTILITIES[k];
    const addr = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
    if (u.email) {
      assert.match(u.email, addr, k);
      assert.ok(u.emailSource && /^https:\/\/|Department of Community Services/.test(u.emailSource), `${k} email has a source`);
    } else {
      assert.ok(u.noEmail && u.reportUrl, `${k}: no email, so it needs a reason and a report page`);
      assert.match(u.noEmail.source, /^https:\/\//);
    }
    if (u.treeEmail) {
      assert.match(u.treeEmail, addr, k);
      assert.match(u.treeEmailSource ?? "", /^https:\/\//);
    }
    const match = { utility: u, basis: "", known: true, source: "bill" as const };
    for (const hazards of [["tree"], ["old_broken"], ["outage"], []] as HazardId[][]) {
      const r = quickRouting(hazards, match);
      if (r.delivery === "email") assert.ok(r.email, k);
      else {
        assert.equal(r.delivery, "form", k);
        assert.ok(r.formUrl?.startsWith("https://"), k);
      }
    }
  }
  const tree = (k: UtilityKey) => quickRouting(["tree", "old_broken"], { utility: UTILITIES[k], basis: "", known: true, source: "bill" }).email;
  assert.equal(tree("sce"), "safetrees@sce.com");
  assert.equal(tree("sdge"), "VegetationManagementHelpDesk1@sdge.com");
  assert.equal(tree("pge"), "treesafety@pge.com");
  assert.equal(tree("ladwp"), null);
  assert.equal(tree("riverside"), "CallCenter@RiversideCA.gov");
});

test("letters read as a finished formal letter for every hazard mix and target kind, and always fit a mailto link", async () => {
  const { data, result, target: sub } = await marion();
  const line = result.lines[0];
  assert.ok(line, "a line near Marion");
  const plant = data.plants.find((p) => /AT&T Anaheim/i.test(p.plant_name))!;
  const targets: ReportTarget[] = [sub, { kind: "line", line }, { kind: "plant", plant }, { kind: "area" }];
  const ids = HAZARDS.filter((h) => !h.emergency).map((h) => h.id);
  const combos: HazardId[][] = [[]];
  for (const id of ids) for (const c of [...combos]) combos.push([...c, id]);
  const notes = ["", "the branch is sagging onto the wire", "Ünïcødé 🌳 ".repeat(60).trim(), "x".repeat(600)];
  const utils: UtilityKey[] = ["sce", "anaheim", "ladwp", "iid"];
  let n = 0;
  for (const t of targets) {
    const draft = buildDraft(t, result, null, true);
    for (const hazards of combos) {
      for (const k of utils) {
        const routing = quickRouting(hazards, { utility: UTILITIES[k], basis: "", known: true, source: "bill" });
        for (const note of notes) {
          const sender = n % 2 ? { name: "Jordan Lee", contact: "jordan@example.com" } : { name: "", contact: "" };
          const l = quickReportLetter(draft, hazards, note, routing, sender);
          n++;
          assert.match(l.subject, /^(Safety report|Service request): [A-Z]/);
          assert.doesNotMatch(l.subject, /Problem report|\(area\)/);
          assert.match(l.body, /^Dear .+ Team,\n\nI am writing to report /);
          assert.match(l.body, /\nWhat I am requesting\n1\. /);
          assert.match(l.body, /\n\nSincerely,\n(A local resident|Jordan Lee\njordan@example\.com)$/);
          assert.doesNotMatch(l.body, /\[|\]|Mapergy|911|full report|download|Computer estimate|Where to send|student-built|Center:|Middle of the line:/i);
          assert.ok(encodeURIComponent(l.body).length <= MAIL_BODY_MAX, `fits: ${encodeURIComponent(l.body).length}`);
          // The mailto body is the whole letter, never cut.
          const href = mailtoHref(l.subject, l.body, l.to);
          assert.equal(decodeURIComponent(href.slice(href.indexOf("&body=") + 6)), l.body);
          assert.equal(l.to, routing.email);
          if (!l.to) assert.ok(l.formUrl?.startsWith("https://"), "no email means a report page");
          if (k === "ladwp" || (k === "sce" && !hazards.includes("tree"))) assert.equal(l.to, null);
          if (k === "anaheim" || k === "iid") assert.ok(l.to);
        }
      }
    }
  }
  assert.ok(n > 500, `checked ${n} letters`);
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
