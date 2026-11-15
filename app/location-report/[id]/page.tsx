import { notFound } from "next/navigation";
import LocationReport from "./LocationReport";
import { parseLocationReportId } from "@/lib/scan/locationReport";

export const dynamic = "force-dynamic";

export default async function LocationReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const area = parseLocationReportId(id);
  if (!area) notFound();
  return <LocationReport
    area={area}
    socketOrigin={process.env.LOCATION_REPORT_SOCKET_ORIGIN ?? process.env.ETL_WS_ORIGIN ?? ""}
  />;
}
