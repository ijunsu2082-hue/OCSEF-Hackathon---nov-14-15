// Live check of owner-plan source lookups for Westminster HS.
// Usage: npx tsx scripts/verify-owner-sources.ts
import { lookupOwnerSources } from "../lib/owner/ownerSources";

async function main() {
  const res = await lookupOwnerSources({ lat: 33.7538, lon: -118.0111, radiusMi: 5, sector: "electric" });
  console.log(`retrievedAt ${res.retrievedAt}  items ${res.items.length}`);
  for (const it of res.items) {
    console.log(`\n[${it.status}] ${it.kind} ${it.id}${it.deadline ? `  deadline ${it.deadline}` : ""}`);
    console.log(`  ${it.title}`);
    console.log(`  ${it.url}`);
    console.log(`  ${it.detail}`);
  }
  const unresolved = res.items.filter((i) => i.status === "unresolved").length;
  console.log(`\nunresolved ${unresolved} / ${res.items.length}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
