import Workspace from "@/components/shell/Workspace";
import { loadRegionOrThrow } from "@/lib/region";

// Region data comes from Supabase (falling back to data/*.json); re-render
// periodically so a re-seed shows up without a rebuild.
export const revalidate = 300;

export default async function Page() {
  const region = await loadRegionOrThrow("westminster-100mi");
  return <Workspace region={region} />;
}
