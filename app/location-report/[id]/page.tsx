import type { Metadata } from "next";
import { parseReportId } from "@/lib/scan/reportLink";
import LocationReport, { InvalidReport } from "./LocationReport";

export const metadata: Metadata = { title: "GridSentinel · Location report" };

export default async function LocationReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const area = parseReportId(id);
  if (!area) return <InvalidReport id={id} />;
  return <LocationReport area={area} />;
}
