import Workspace from "@/components/shell/Workspace";
import { loadEvidenceBundle } from "@/lib/evidence/load";
import { loadRegionOrThrow } from "@/lib/region";

// Region data comes from Supabase (falling back to data/*.json); re-render
// periodically so a re-seed shows up without a rebuild.
export const revalidate = 300;

export default async function Page() {
  const region = await loadRegionOrThrow("westminster-100mi");
  const evidence = await loadEvidenceBundle(region.region.id);
  return <Workspace region={region} evidence={evidence} />;
}
