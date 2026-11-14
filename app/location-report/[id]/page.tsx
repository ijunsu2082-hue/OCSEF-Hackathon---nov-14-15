import { notFound } from "next/navigation";
import { EvidenceProvider } from "@/components/evidence/EvidenceProvider";
import { LocationClaims } from "./LocationClaims";
import { readReport } from "@/research/etl/pipeline";

export const dynamic = "force-dynamic";

export default async function LocationReportPage({ params }: { params: Promise<{ id: string }> }) {
  const report = await readReport((await params).id);
  if (!report) notFound();
  const socketOrigin = process.env.LOCATION_REPORT_SOCKET_ORIGIN ?? "";
  return (
    <main style={{ maxWidth: "65rem", margin: "2rem auto", padding: "0 1rem" }}>
      <EvidenceProvider bundle={report.evidence}>
        <LocationClaims report={report} socketOrigin={socketOrigin} />
      </EvidenceProvider>
    </main>
  );
}
