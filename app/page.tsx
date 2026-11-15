import Workspace from "@/components/shell/Workspace";
import { loadEvidenceBundle } from "@/lib/evidence/load";
import { getRegionOrThrow } from "@/lib/region";

export default async function Page() {
  const region = getRegionOrThrow("westminster-100mi");
  const evidence = await loadEvidenceBundle(region.region.id);
  return <Workspace region={region} evidence={evidence} />;
}
