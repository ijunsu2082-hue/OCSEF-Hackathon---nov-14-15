import Workspace from "@/components/shell/Workspace";
import { getRegionOrThrow } from "@/lib/region";

export default function Page() {
  const region = getRegionOrThrow("westminster-100mi");
  return <Workspace region={region} />;
}
