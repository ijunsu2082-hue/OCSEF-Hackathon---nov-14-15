import { test } from "node:test";
import assert from "node:assert/strict";
import { loadGridData } from "../lib/scan/data";
import { scanArea } from "../lib/scan/scan";
import {
  HAZARDS,
  MAIL_BODY_MAX,
  PASTE_LINE,
  areaPlace,
  sendableEmail,
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
  assert.equal(letter.subject, "Safety report: Tree touching a power line and damaged equipment at the AT&T Anaheim power plant");
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

test("investor-owned utility with no email for the problem: the email goes to the CPUC Consumer Affairs Branch", async () => {
  const { result, target, draft } = await anaheimPlant();
  const routing = quickRouting(["outage"], resolveUtility(target, result, "sce"));
  assert.equal(routing.delivery, "cpuc");
  assert.equal(routing.email, "consumer-affairs@cpuc.ca.gov");
  assert.equal(routing.emailSource, "https://www.cpuc.ca.gov/consumer-support/file-a-complaint/public-safety-complaint");
  const letter = quickReportLetter(draft, ["outage"], "", routing);
  assert.equal(letter.to, "consumer-affairs@cpuc.ca.gov");
  assert.equal(letter.recipient, "the CPUC");
  assert.equal(letter.subject, "Service request (Southern California Edison): Power outage at the AT&T Anaheim power plant");
  assert.match(letter.body, /^Dear CPUC Consumer Affairs Branch,\n\nI am writing to report a power outage near the AT&T Anaheim power plant/);
  assert.match(letter.body, /The equipment belongs to Southern California Edison \(SCE\)\. SCE does not publish an email address for these reports, so I am sending this to you\. Please forward it to SCE and let me know that it was received\./);
  assert.match(letter.body, /\nWhat I am asking SCE to do\n1\. /);
  assert.match(letter.body, /\nSCE contact\n- SCE phone: 1-800-611-1911\n- SCE report page: https:\/\/www\.sce\.com\/outages-safety\/report-outage-safety-issue\n/);
  // No placeholders to fill in: a blank name signs as a resident, a blank contact is left out.
  assert.match(letter.body, /Sincerely,\nA local resident$/);
  assert.doesNotMatch(letter.body, /\[|\]|____/);
  assert.ok(mailtoHref(letter.subject, letter.body, letter.to).startsWith("mailto:consumer-affairs@cpuc.ca.gov?subject="));
  assert.ok(mailtoHref("s", "b", "not an email").startsWith("mailto:?subject="), "rejects a malformed recipient");
});

test("LADWP publishes no email: To is empty and the body starts with the paste line", async () => {
  const { result, target, draft } = await anaheimPlant();
  const routing = quickRouting(["old_broken"], resolveUtility(target, result, "ladwp"));
  assert.equal(routing.delivery, "paste");
  assert.equal(routing.email, null);
  const letter = quickReportLetter(draft, ["old_broken"], "", routing);
  assert.equal(letter.to, null);
  assert.ok(letter.body.startsWith(`${PASTE_LINE}\nWhere to find it: LADWP does not publish one. Its report page is https://www.ladwp.com/account/report-problem and its phone number is 1-800-342-5397 (1-800-DIAL-DWP).\n(Delete these lines before sending.)\n\nDear LADWP Customer Service Team,`), letter.body.slice(0, 300));
  assert.ok(mailtoHref(letter.subject, letter.body, letter.to).startsWith("mailto:?subject="));
});

test("not sure which utility: the email opens with the paste line", async () => {
  const { result, target } = await anaheimPlant();
  const unsure = resolveUtility(target, result, "notsure");
  assert.equal(unsure.known, false);
  const routing = quickRouting(["tree"], unsure);
  assert.equal(routing.delivery, "paste");
  assert.equal(routing.email, null);
  const letter = quickReportLetter(buildDraft(target, result, null, false), ["tree"], "", routing);
  assert.ok(letter.body.startsWith(`${PASTE_LINE}\nWhere to find it: your electric utility's name`));
  assert.match(letter.body, /\n\nDear Customer Service Team,\n/);
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
  assert.equal(letter.subject, "Safety report: Tree touching a power line at Marion Substation");
  assert.equal(letter.recipient, "SCE's tree team");
  assert.match(letter.body, /^Dear SCE Vegetation Management Team,\n\nI am writing to report a possible safety hazard at Marion Substation in Stanton \(33\.8177° N, 118\.0274° W\)\./);
  assert.match(letter.body, /- Marion Substation, a 66 kV substation operated by Southern California Edison\n- Coordinates: 33\.8177° N, 118\.0274° W\n/);
  assert.match(letter.body, /What I am requesting\n1\. Send a crew to inspect the equipment and make it safe\.\n2\. Trim the vegetation back to the clearances required by CPUC General Order 95, Rule 35\.\n3\. Reply with a reference number/);
  assert.match(letter.body, /Sincerely,\nSam Park\n\(714\) 555-0100$/);
  assert.doesNotMatch(letter.body, /LADWP|Los Angeles/);
  const href = mailtoHref(letter.subject, letter.body, letter.to);
  assert.ok(href.startsWith("mailto:safetrees@sce.com?subject=Safety%20report"), href.slice(0, 70));

  // Other SCE problems have no SCE email: the CPUC Consumer Affairs Branch, asked to forward it.
  const broken = quickRouting(["old_broken"], u);
  assert.equal(broken.delivery, "cpuc");
  assert.equal(broken.email, "consumer-affairs@cpuc.ca.gov");
  const bl = quickReportLetter(draft, ["old_broken"], "", broken);
  assert.equal(bl.subject, "Safety report (Southern California Edison): Damaged equipment at Marion Substation");
  assert.match(bl.body, /^Dear CPUC Consumer Affairs Branch,/);
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
      else if (u.kind === "iou") {
        assert.equal(r.delivery, "cpuc", k);
        assert.equal(r.email, "consumer-affairs@cpuc.ca.gov");
      } else {
        assert.equal(r.delivery, "paste", k);
        assert.equal(r.email, null);
      }
      if (r.delivery !== "email") assert.ok(r.formUrl?.startsWith("https://"), k);
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
          assert.match(l.subject, /^(Safety report|Service request)( \([A-Z][^)]+\))?: [A-Z]/);
          assert.doesNotMatch(l.subject, /Problem report|\(area\)|near .* near |·/);
          assert.match(l.body, /^(To send: paste .+\nWhere to find it: .+\n\(Delete these lines before sending\.\)\n\n)?Dear .+(Team|Branch),\n\nI am writing to (report|request an inspection of) /);
          assert.match(l.body, /\nWhat I am (requesting|asking [^\n]+ to do)\n1\. /);
          assert.match(l.body, /\n\nSincerely,\n(A local resident|Jordan Lee\njordan@example\.com)$/);
          assert.doesNotMatch(l.body.replace(/^To send:[^]*?\n\n/, ""), /____|\[|\]|Mapergy|\\b911\\b|full report|download|Computer estimate|Where to send|student-built|Center:|Middle of the line:|operator:|owner:|·|\uFFFD| the the |\.\./i);
          assert.ok(encodeURIComponent(l.body).length <= MAIL_BODY_MAX, `fits: ${encodeURIComponent(l.body).length}`);
          // The mailto body is the whole letter, never cut.
          const href = mailtoHref(l.subject, l.body, l.to);
          assert.equal(decodeURIComponent(href.slice(href.indexOf("&body=") + 6)), l.body);
          assert.equal(l.to, routing.email);
          if (!l.to) assert.ok(l.body.startsWith(PASTE_LINE), "no recipient means the paste line comes first");
          if (k === "ladwp") assert.equal(l.to, null);
          if (k === "sce") assert.equal(l.to, hazards.includes("tree") ? "safetrees@sce.com" : "consumer-affairs@cpuc.ca.gov");
          if (k === "anaheim") assert.equal(l.to, "CustomerService@anaheim.net");
          if (k === "iid") assert.ok(l.to);
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

test("worst cases still fit uncut: every plant, every safety hazard, long non-Latin signature, emoji notes", async () => {
  const data = await loadGridData();
  const sce = { utility: UTILITIES.sce, basis: "", known: true, source: "bill" as const };
  const hz: HazardId[] = ["tree", "old_broken", "outage", "other"];
  const routes = [quickRouting(hz, sce), quickRouting(hz, { ...sce, utility: UTILITIES.ladwp }), quickRouting(["old_broken", "outage", "other"], sce)];
  const sender = { name: "東京電力株式会社の山田太郎".repeat(7).slice(0, 80), contact: "連絡先".repeat(40) };
  const empty = scanArea(data, { lat: 33.8177, lon: -118.02737, radius_mi: 1 });
  for (const plant of data.plants) {
    const draft = buildDraft({ kind: "plant", plant }, empty, null, false);
    for (const [i, routing] of routes.entries()) for (const note of ["", "😀".repeat(400)]) {
      const l = quickReportLetter(draft, i === 2 ? ["old_broken", "outage", "other"] : hz, note, routing, sender);
      assert.ok(encodeURIComponent(l.body).length <= MAIL_BODY_MAX, `${plant.plant_name}: ${encodeURIComponent(l.body).length}`);
      assert.doesNotMatch(l.body, /\uFFFD|full report/);
      assert.match(l.body, /\nSincerely,\n./);
    }
  }
});

test("area letters name the city, never the internal area label", () => {
  assert.equal(areaPlace("Long Beach · near Haynes"), "Long Beach");
  assert.equal(areaPlace("Anaheim area"), "Anaheim");
  assert.equal(areaPlace("Remote area · 23 mi from Blythe"), null);
});

test("every saved report gets an email: old ones without a recipient open with the paste line", () => {
  const base = {
    id: "x", createdAt: "2026-11-15T19:00:00Z", title: "Problem report: Marion Substation", subject: "Problem report: Marion Substation",
    assetLabel: "Marion Substation", location: { lat: 33.8, lon: -118, text: "" },
    contact: { name: "Los Angeles Department of Water and Power (LADWP)", url: "https://www.ladwp.com/account/report-problem" },
    text: "Old checklist text",
  };
  const legacy = sendableEmail(base);
  assert.equal(legacy.to, null);
  assert.ok(legacy.body.startsWith(`${PASTE_LINE}\n`));
  assert.match(legacy.body, /Old checklist text$/);
  const formOnly = sendableEmail({ ...base, email: { to: null, subject: "S", body: "Dear LADWP Customer Service Team,", formUrl: "https://www.ladwp.com/account/report-problem" } });
  assert.ok(formOnly.body.startsWith(PASTE_LINE));
  assert.match(formOnly.body, /\n\nDear LADWP Customer Service Team,$/);
  const addressed = { to: "safetrees@sce.com", subject: "S", body: "B" };
  assert.deepEqual(sendableEmail({ ...base, email: addressed }), addressed);
});
