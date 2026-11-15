"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { Cite } from "@/components/evidence/Citations";
import { ReconciliationBadge, type ReconciliationMark } from "@/components/evidence/ReconciliationBadge";
import { digest } from "@/lib/evidence/canonical";
import { formatClaimValue } from "@/lib/evidence/citation";
import { getPredicate } from "@/lib/evidence/predicates";
import type { LocationReport } from "@/research/etl/pipeline";
import type { Reconciliation, ReconciliationSide } from "@/research/etl/reconcile-report";

function sideValue(side: ReconciliationSide) {
  if (!side.observation) return <em>{side.issue ?? "no value"}</em>;
  const { value, scope } = side.observation;
  const shown = typeof value === "number" ? value.toLocaleString("en-US", { maximumFractionDigits: 2 }) : value;
  return <strong>{shown} {scope.unit}</strong>;
}

/**
 * `reconciliation` may be supplied by a server parent. When omitted, the
 * persisted reconciliation for exactly this report revision is fetched.
 */
export function LocationClaims({ report, socketOrigin, reconciliation: supplied }: {
  report: LocationReport; socketOrigin: string; reconciliation?: Reconciliation | null;
}) {
  const router = useRouter();
  const id = report.evidence.region.id;
  const revision = useMemo(() => digest(report), [report]);
  const [fetched, setFetched] = useState<{ revision: string; record: Reconciliation | null; error?: string } | null>(null);
  useEffect(() => {
    if (supplied !== undefined) return;
    const controller = new AbortController();
    fetch(`/api/location-report/${id}/reconciliation?report=${revision}`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : `HTTP ${response.status}`);
        if (body?.report_revision !== revision) throw new Error("Reconciliation is bound to a different report revision");
        setFetched({ revision, record: body as Reconciliation });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setFetched({ revision, record: null, error: error instanceof Error ? error.message : "Reconciliation unavailable" });
      });
    return () => controller.abort();
  }, [id, revision, supplied]);
  const current = fetched?.revision === revision ? fetched : null;
  const reconciliation = supplied !== undefined ? supplied : current?.record ?? null;
  const marks = useMemo(() => {
    const byClaim = new Map<string, ReconciliationMark[]>();
    for (const comparison of reconciliation?.comparisons ?? []) {
      for (const claimId of [...comparison.left.claim_ids, ...comparison.right.claim_ids]) {
        const list = byClaim.get(claimId) ?? [];
        list.push({ status: comparison.status, policy: comparison.policy, reason: comparison.reason });
        byClaim.set(claimId, list);
      }
    }
    return byClaim;
  }, [reconciliation]);
  useEffect(() => {
    if (!socketOrigin) return;
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let delay = 1000;
    let hash = report.state_hash;
    let inventoryRevision: string | undefined;
    function connect() {
      socket = new WebSocket(new URL(`/ws/location/${id}`, socketOrigin));
      socket.onmessage = ({ data }) => {
        try {
          const event = JSON.parse(String(data));
          if (event.location_id !== id) return;
          delay = 1000;
          if (event.event === "STATE_UPDATE" && typeof event.state_hash === "string" && event.state_hash !== hash) {
            hash = event.state_hash;
            router.refresh();
          } else if (event.event === "INVENTORY_UPDATE" && typeof event.inventory_revision === "string" &&
            event.inventory_revision !== inventoryRevision) {
            inventoryRevision = event.inventory_revision;
            router.refresh();
          }
        } catch {
          // Malformed events carry no report state.
        }
      };
      socket.onclose = () => {
        if (stopped) return;
        retry = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 30000);
      };
    }
    connect();
    return () => {
      stopped = true;
      clearTimeout(retry);
      socket?.close();
    };
  }, [id, report.state_hash, router, socketOrigin]);
  return (
    <>
      <h1>{report.evidence.region.name}</h1>
      <p><a href={`/api/location-report/${id}`}>Download report JSON</a></p>
      {report.evidence.disclosures.map((item) => <p key={item.id}>{item.text}</p>)}
      <dl>
        {report.evidence.claims.map((claim) => (
          <div key={claim.id} style={{ display: "flex", gap: "1rem", marginBlock: ".5rem" }}>
            <dt>{getPredicate(claim.predicate)?.label ?? claim.predicate}</dt>
            <dd>{formatClaimValue(claim)} <Cite claim={claim} reconciliation={marks.get(claim.id)} /></dd>
          </div>
        ))}
      </dl>
      <h2>Provider reconciliation</h2>
      {reconciliation ? (
        <>
          <p>
            Reviewed provider comparisons for this report revision. Disagreeing values are never averaged; a
            value is selected only by a policy authority.
          </p>
          <ul>{reconciliation.comparisons.map((comparison) => (
            <li key={comparison.policy} data-status={comparison.status} style={{ marginBlock: ".75rem" }}>
              <div>
                <code>{comparison.policy}</code>
                <ReconciliationBadge status={comparison.status} policy={comparison.policy} reason={comparison.reason} />
                {comparison.independent ? " · independent publishers" : ""}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem", marginBlock: ".25rem" }}>
                {(["left", "right"] as const).map((key) => (
                  <div key={key} data-side={key}>
                    <div><code>{comparison[key].source}</code>{comparison.selected === key ? " · selected" : ""}</div>
                    <div>{sideValue(comparison[key])}</div>
                  </div>
                ))}
              </div>
              {comparison.status === "conflict" && comparison.selected === null ? (
                <div>Both candidate values are retained; no value is selected.</div>
              ) : null}
              {comparison.reason ? <div style={{ color: "var(--muted)" }}>{comparison.reason}</div> : null}
            </li>
          ))}</ul>
        </>
      ) : (
        <p>{current?.error ? `Reconciliation unavailable: ${current.error}` : "Reconciliation not loaded."}</p>
      )}
      <h2>Coverage gaps</h2>
      <ul>{report.evidence.unresolved.map((item) => (
        <li key={item.predicate}>{item.predicate} · {item.reason} · {item.detail}</li>
      ))}</ul>
    </>
  );
}
