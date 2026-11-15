import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test, type TestContext } from "node:test";
import { GET } from "../../app/api/location-report/[id]/reconciliation/route";
import { canonicalJson, digest } from "../../lib/evidence/canonical";
import { POLICIES_VERSION } from "./reconcile-policies";
import { RECONCILIATION_SCHEMA } from "./reconcile-report";
import { stateRoot } from "./pipeline";

const ID = `location-${"b".repeat(24)}`;

function scratch(t: TestContext): string {
  const prior = process.env.ETL_STATE_NAMESPACE;
  process.env.ETL_STATE_NAMESPACE = `reconcile-route-${randomUUID()}`;
  const root = stateRoot();
  t.after(async () => {
    await chmod(resolve(root, "reports", `${ID}.json`), 0o644).catch(() => {});
    await rm(root, { recursive: true, force: true });
    if (prior === undefined) delete process.env.ETL_STATE_NAMESPACE;
    else process.env.ETL_STATE_NAMESPACE = prior;
  });
  return root;
}

async function call(query = "") {
  const response = await GET(new Request(`http://localhost/api/location-report/${ID}/reconciliation${query}`), { params: Promise.resolve({ id: ID }) });
  const text = await response.text();
  return { status: response.status, cache: response.headers.get("cache-control"), policies: response.headers.get("x-policies-version"), text, body: JSON.parse(text) as unknown };
}

test("a filesystem error returns a generic 500 without paths or error text", async (t) => {
  const root = scratch(t);
  const path = resolve(root, "reports", `${ID}.json`);
  await mkdir(resolve(root, "reports"), { recursive: true });
  await writeFile(path, "{}");
  await chmod(path, 0o000);
  const result = await call();
  assert.equal(result.status, 500);
  assert.equal(result.cache, "no-store");
  assert.deepEqual(result.body, { error: "Reconciliation unavailable" });
  assert.ok(!/EACCES|etl-state|reports|location-/.test(result.text), result.text);
});

test("a known integrity failure passes through as 502; other errors stay generic", async (t) => {
  const root = scratch(t);
  // A stored revision whose content does not hash to its name.
  const wrong = "c".repeat(64);
  await mkdir(resolve(root, "revisions", ID), { recursive: true });
  await writeFile(resolve(root, "revisions", ID, `${wrong}.json`), JSON.stringify({ tampered: true }));
  const mismatch = await call(`?report=${wrong}`);
  assert.equal(mismatch.status, 502);
  assert.equal(mismatch.cache, "no-store");
  assert.deepEqual(mismatch.body, { error: "Report revision checksum mismatch" });

  // Any other failure deeper in reconciliation (here a stub report the policies cannot read) stays generic.
  const report = { stub: true };
  const revision = digest(report);
  await writeFile(resolve(root, "revisions", ID, `${revision}.json`), JSON.stringify(report));
  const internal = await call(`?report=${revision}`);
  assert.equal(internal.status, 500);
  assert.deepEqual(internal.body, { error: "Reconciliation unavailable" });
});

test("a missing report is still 404", async (t) => {
  scratch(t);
  const result = await call();
  assert.equal(result.status, 404);
  assert.deepEqual(result.body, { error: "Location report unavailable" });
});

test("immutable caching requires the URL to pin the current policies version", async (t) => {
  const root = scratch(t);
  const report = { stub: "cached" };
  const revision = digest(report);
  await mkdir(resolve(root, "revisions", ID), { recursive: true });
  await writeFile(resolve(root, "revisions", ID, `${revision}.json`), JSON.stringify(report));
  // A persisted, verifiable record for (revision, current policies).
  const unsigned = { schema: RECONCILIATION_SCHEMA, location: ID, report_revision: revision, policies_version: POLICIES_VERSION, comparisons: [] };
  await mkdir(resolve(root, "reconciliations", ID), { recursive: true });
  await writeFile(resolve(root, "reconciliations", ID, `${revision}.${POLICIES_VERSION.slice(0, 12)}.json`),
    canonicalJson({ ...unsigned, digest: digest(unsigned) }) + "\n");

  const pinned = await call(`?report=${revision}&policies=${POLICIES_VERSION.slice(0, 12)}`);
  assert.equal(pinned.status, 200);
  assert.equal(pinned.cache, "public, max-age=31536000, immutable");
  assert.equal(pinned.policies, POLICIES_VERSION);
  const reportOnly = await call(`?report=${revision}`);
  assert.equal(reportOnly.status, 200);
  assert.equal(reportOnly.cache, "public, max-age=300");
  for (const stale of ["0".repeat(12), POLICIES_VERSION.slice(0, 11), POLICIES_VERSION]) {
    const result = await call(`?report=${revision}&policies=${stale}`);
    assert.equal(result.status, 200);
    assert.equal(result.cache, "no-store", `policies=${stale}`);
  }
});
