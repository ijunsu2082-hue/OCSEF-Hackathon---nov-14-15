import { notFound } from "next/navigation";
import { EvidenceProvider } from "@/components/evidence/EvidenceProvider";
import { LocationClaims } from "./LocationClaims";
import { locationId, readReport } from "@/research/etl/pipeline";
import { readLocationAssets } from "@/research/etl/load-assets";

export const dynamic = "force-dynamic";

export default async function LocationReportPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const report = await readReport(id);
  if (!report) notFound();
  const inventoryId = locationId({ center: report.query.center, radius_miles: report.query.radius_miles });
  const assets = await readLocationAssets(inventoryId);
  const assetDatasets = assets
    ? (assets.data as {
        datasets: Array<{
          source: string;
          counts: { features: number; missing: Record<string, number> };
        }>;
      }).datasets
    : [];
  const pinnedAssetsUrl = assets ? `/api/location-report/${id}/assets?revision=${assets.revision}` : null;
  const socketOrigin = process.env.LOCATION_REPORT_SOCKET_ORIGIN ?? "";
  return (
    <main style={{ maxWidth: "65rem", margin: "2rem auto", padding: "0 1rem" }}>
      <EvidenceProvider bundle={report.evidence}>
        <LocationClaims report={report} socketOrigin={socketOrigin} />
        {assets && pinnedAssetsUrl && (
          <section aria-labelledby="inventory-title" style={{ marginTop: "2rem" }}>
            <h2 id="inventory-title">Loaded location inventory</h2>
            <p>
              Revision <code>{assets.revision}</code> ·{" "}
              <a href={pinnedAssetsUrl}>Open pinned inventory JSON</a>
            </p>
            <ul>
              {assetDatasets.map(({ source, counts }) => {
                const missing = Object.entries(counts.missing);
                return (
                  <li key={source}>
                    <strong>{source}</strong> · {counts.features} features
                    <span>
                      {" — "}{Object.hasOwn(counts.missing, "name")
                        ? `${counts.missing.name} missing name values.`
                        : "name field not tracked"}
                      {missing.some(([field]) => field !== "name") && ` Other missing fields ${missing
                        .filter(([field]) => field !== "name")
                        .map(([field, count]) => `${field} ${count}`)
                        .join(", ")}.`}
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>
        )}
      </EvidenceProvider>
    </main>
  );
}
