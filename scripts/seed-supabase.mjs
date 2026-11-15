#!/usr/bin/env node
// Load every dataset in data/ and public/layers/ into Supabase Postgres.
//
//   SUPABASE_DB_URL="postgresql://postgres.<ref>:<password>@<host>:5432/postgres" node scripts/seed-supabase.mjs
//   # or, without the DB password, using a Supabase personal access token:
//   SUPABASE_ACCESS_TOKEN="sbp_..." node scripts/seed-supabase.mjs
//
// SUPABASE_DB_URL may also be set in .env.local. The script applies the schema in
// supabase/migrations/, then replaces the contents of every table and checks row
// counts, so it is safe to re-run.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => fs.readFileSync(path.join(root, p), "utf8");
const json = (p) => JSON.parse(read(p));

function dbUrl() {
  if (process.env.SUPABASE_DB_URL) return process.env.SUPABASE_DB_URL;
  const envFile = path.join(root, ".env.local");
  if (fs.existsSync(envFile)) {
    const m = fs.readFileSync(envFile, "utf8").match(/^SUPABASE_DB_URL\s*=\s*"?([^"\n]+)"?/m);
    if (m) return m[1].trim();
  }
  throw new Error("Set SUPABASE_DB_URL (env or .env.local).");
}

// ---- build rows -------------------------------------------------------------
const regions = json("data/regions.json").map((r) => ({
  id: r.id, name: r.name, state: r.state,
  center_lat: r.center[0], center_lon: r.center[1],
  radius_miles: r.radius_miles, bounds: r.bounds, grid_zone: r.grid_zone,
}));

const nodesFile = json("data/nodes.json");
const nodes = nodesFile.features.map((f, i) => {
  const { id, name, type, ...groups } = f.properties;
  return {
    id, region_id: nodesFile.region_id, name, type,
    lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1],
    provider: groups.provider ?? null, infrastructure: groups.infrastructure ?? null,
    energy_profile: groups.energy_profile ?? null, upgrade_potential: groups.upgrade_potential ?? null,
    sort_order: i,
  };
});
const nodeFlows = (nodesFile.flows ?? []).map((fl, i) => ({
  id: fl.id, region_id: nodesFile.region_id, from_node: fl.from, to_node: fl.to,
  label: fl.label, mva: fl.mva, sort_order: i,
}));

const layer = (name) => json(`public/layers/${name}.geojson`);
const plantsFc = layer("plants");
const substationsFc = layer("substations");
const transmissionFc = layer("transmission");

const point = (f, i) => ({ ...f.properties, lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], sort_order: i });
const plants = plantsFc.features.map(point);
const substations = substationsFc.features.map(point);
const transmission = transmissionFc.features.map((f, i) => ({ ...f.properties, geometry: f.geometry, sort_order: i }));

const nicheCases = json("public/layers/niche_cases.json").map((c, i) => ({ ...c, chart: c.chart ?? null, sort_order: i }));

const [header, ...lines] = read("public/layers/line_rating_2024_westminster_hs.csv").trim().split(/\r?\n/);
const cols = header.split(",").map((c) => c.toLowerCase());
const lineRatings = lines.map((line) => {
  const vals = line.split(",");
  const row = { dataset: "westminster_hs_2024" };
  cols.forEach((c, i) => { row[c] = c === "time" ? vals[i] : vals[i] === "" ? null : Number(vals[i]); });
  return row;
});

const layerMetadata = [
  { layer: "plants", metadata: plantsFc.metadata ?? {} },
  { layer: "substations", metadata: substationsFc.metadata ?? {} },
  { layer: "transmission", metadata: transmissionFc.metadata ?? {} },
];

// Children after parents for inserts; reverse order for deletes.
const tables = [
  ["regions", regions], ["nodes", nodes], ["node_flows", nodeFlows],
  ["plants", plants], ["substations", substations], ["transmission_lines", transmission],
  ["niche_cases", nicheCases], ["line_ratings", lineRatings], ["layer_metadata", layerMetadata],
];

// ---- load -------------------------------------------------------------------
// Two transports:
//  * SUPABASE_DB_URL            -> direct Postgres, whole load in one transaction.
//  * SUPABASE_ACCESS_TOKEN (+ SUPABASE_PROJECT_REF) -> Supabase Management API
//    (POST /v1/projects/{ref}/database/query). No DB password needed; each table is
//    replaced in its own request, so re-run the script if it stops part-way.
const PROJECT_REF = process.env.SUPABASE_PROJECT_REF || "kqqbbtlawfcjrylecfxt";

function managementClient(token) {
  return {
    transactional: false,
    async connect() {},
    async end() {},
    async query(sql, params) {
      // Inline the single json parameter as a dollar-quoted literal.
      if (params) sql = sql.replace("$1::json", `$seed$${params[0]}$seed$::json`);
      const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ query: sql }),
      });
      const body = await res.text();
      if (!res.ok) throw new Error(`Management API ${res.status}: ${body.slice(0, 500)}`);
      return { rows: JSON.parse(body || "[]") };
    },
  };
}

const client = process.env.SUPABASE_ACCESS_TOKEN && !process.env.SUPABASE_DB_URL
  ? managementClient(process.env.SUPABASE_ACCESS_TOKEN)
  : Object.assign(new pg.Client({ connectionString: dbUrl(), ssl: { rejectUnauthorized: false } }), { transactional: true });
await client.connect();
try {
  const migrations = fs.readdirSync(path.join(root, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
  for (const m of migrations) await client.query(read(`supabase/migrations/${m}`));

  // pg path: one transaction. API path: one request per chunk (kept around ~1 MB).
  // json (not jsonb) so object key order from the source files is preserved.
  const CHUNK = client.transactional ? 2000 : 1000;
  if (client.transactional) await client.query("begin");
  for (const [t] of [...tables].reverse()) await client.query(`delete from public.${t}`);
  for (const [t, rows] of tables) {
    for (let i = 0; i < rows.length; i += CHUNK) {
      await client.query(
        `insert into public.${t} select * from json_populate_recordset(null::public.${t}, $1::json)`,
        [JSON.stringify(rows.slice(i, i + CHUNK))],
      );
    }
  }
  if (client.transactional) await client.query("commit");

  let ok = true;
  for (const [t, rows] of tables) {
    const { rows: [{ n }] } = await client.query(`select count(*)::int as n from public.${t}`);
    const match = n === rows.length;
    ok &&= match;
    console.log(`${match ? "ok " : "MISMATCH"} ${t.padEnd(20)} source=${rows.length} db=${n}`);
  }
  if (!ok) process.exitCode = 1;
} catch (err) {
  await client.query("rollback").catch(() => {});
  throw err;
} finally {
  await client.end();
}
