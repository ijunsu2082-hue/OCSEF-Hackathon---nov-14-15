"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { Cite } from "@/components/evidence/Citations";
import { formatClaimValue } from "@/lib/evidence/citation";
import { getPredicate } from "@/lib/evidence/predicates";
import type { LocationReport } from "@/research/etl/pipeline";

export function LocationClaims({ report, socketOrigin }: { report: LocationReport; socketOrigin: string }) {
  const router = useRouter();
  const id = report.evidence.region.id;
  useEffect(() => {
    if (!socketOrigin) return;
    let socket: WebSocket | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let delay = 1000;
    let hash = report.state_hash;
    function connect() {
      socket = new WebSocket(new URL(`/ws/location/${id}`, socketOrigin));
      socket.onmessage = ({ data }) => {
        try {
          const event = JSON.parse(String(data));
          if (event.location_id !== id || typeof event.state_hash !== "string") return;
          delay = 1000;
          if (event.state_hash !== hash) {
            hash = event.state_hash;
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
            <dd>{formatClaimValue(claim)} <Cite claim={claim} /></dd>
          </div>
        ))}
      </dl>
      <h2>Coverage gaps</h2>
      <ul>{report.evidence.unresolved.map((item) => (
        <li key={item.predicate}>{item.predicate} · {item.reason} · {item.detail}</li>
      ))}</ul>
    </>
  );
}
