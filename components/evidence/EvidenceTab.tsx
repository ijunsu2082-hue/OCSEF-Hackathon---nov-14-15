"use client";

import { useMemo } from "react";
import { Panel } from "@/components/ui/kit";
import {
  claimsFor,
  formatClaimValue,
  methodLabel,
  provenanceChain,
  regionSubject,
} from "@/lib/evidence/citation";
import { getPredicate } from "@/lib/evidence/predicates";
import type { Claim } from "@/lib/evidence/schema";
import { useEvidence } from "./EvidenceProvider";
import { Cite, MethodBadge } from "./Citations";

export default function EvidenceTab({
  subject,
  regionId,
  title,
}: {
  subject: string;
  regionId: string;
  title?: string;
}) {
  const { bundle, index, codes } = useEvidence();

  const facilityClaims = useMemo(
    () => (index ? claimsFor(index, subject) : []),
    [index, subject],
  );
  const regionClaims = useMemo(
    () => (index ? claimsFor(index, regionSubject(regionId)) : []),
    [index, regionId],
  );

  if (!bundle || !index) {
    return (
      <Panel title="Evidence" hint="not generated">
        <p className="facility-note">
          No evidence bundle is loaded. Run <code>npm run evidence:build</code> to generate one,
          then reload. Numbers elsewhere in the app stay visible but are labelled unverified.
        </p>
      </Panel>
    );
  }

  const verification = bundle.verification;

  return (
    <>
      <Panel
        title="Verification"
        hint={verification.ok ? "pass" : "fail"}
        action={
          <span className={`verif-badge ${verification.ok ? "is-ok" : "is-bad"}`}>
            {verification.ok ? "VERIFIED" : "FAILED"}
          </span>
        }
      >
        <div className="verif-grid">
          <div>
            <b>{bundle.stats.claims}</b>
            <span>claims</span>
          </div>
          <div>
            <b>{bundle.stats.observed}</b>
            <span>observed</span>
          </div>
          <div>
            <b>{bundle.stats.derived}</b>
            <span>derived</span>
          </div>
          <div>
            <b>{bundle.stats.modeled}</b>
            <span>modeled</span>
          </div>
          <div>
            <b>{bundle.stats.snapshots}</b>
            <span>snapshots</span>
          </div>
        </div>
        <p className="table-note">
          Bundle <code>{bundle.bundle_id}</code> built {bundle.generated_at}. Registry{" "}
          <code>{bundle.registry_digest.slice(0, 18)}…</code>. Verification re-hashes every claim
          id, re-evaluates every derivation and re-applies every conflict resolution.
        </p>
        {verification.errors.length > 0 ? (
          <ul className="evidence-issues">
            {verification.errors.slice(0, 6).map((issue) => (
              <li key={`${issue.code}-${issue.detail}`}>
                <b>{issue.code}</b> {issue.detail}
              </li>
            ))}
          </ul>
        ) : null}
      </Panel>

      <Panel
        title={title ? `${title} evidence` : "Load-center evidence"}
        hint={`${facilityClaims.length} claims`}
      >
        <ClaimTable claims={facilityClaims} />
      </Panel>

      <Panel title="Region evidence" hint={`${regionClaims.length} claims`}>
        <ClaimTable claims={regionClaims} />
      </Panel>

      <Panel title="Sources" hint={`${bundle.sources.length} registered`}>
        <ul className="source-list">
          {bundle.sources.map((source) => {
            const snapshots = bundle.snapshots.filter(
              (snapshot) => snapshot.source_id === source.id,
            );
            return (
              <li key={source.id}>
                <div className="source-head">
                  <span className="source-code">{codes.get(source.id)}</span>
                  <div>
                    <b>{source.title}</b>
                    <span>{source.publisher}</span>
                  </div>
                  <span className={`authority authority-${source.authority}`}>
                    {source.authority}
                  </span>
                </div>
                <div className="source-meta">
                  <span>{source.license}</span>
                  <a href={source.homepage} target="_blank" rel="noreferrer">
                    source page
                  </a>
                  <code>{source.access.endpoint}</code>
                </div>
                {snapshots.length > 0 ? (
                  <div className="source-snapshots">
                    {snapshots.map((snapshot) => (
                      <div key={snapshot.id}>
                        <code>{snapshot.id}</code>
                        <span>
                          {snapshot.retrieved_at.slice(0, 10)} · {snapshot.bytes.toLocaleString()} B ·{" "}
                          <code title={snapshot.sha256}>{snapshot.sha256.slice(0, 16)}…</code> ·{" "}
                          {snapshot.cache_path}
                        </span>
                      </div>
                    ))}
                  </div>
                ) : null}
                {source.caveats.length > 0 ? (
                  <ul className="source-caveats">
                    {source.caveats.map((caveat) => (
                      <li key={caveat}>{caveat}</li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      </Panel>

      <Panel title="Disclosures" hint="what the model does not prove">
        <ul className="disclosure-list">
          {bundle.disclosures.map((disclosure) => (
            <li key={disclosure.id} className={`is-${disclosure.severity}`}>
              <b>{disclosure.severity}</b> {disclosure.text}
            </li>
          ))}
        </ul>
      </Panel>
    </>
  );
}

function ClaimTable({ claims }: { claims: Claim[] }) {
  const { codes, index } = useEvidence();
  if (claims.length === 0) {
    return <p className="facility-note">No claims for this subject.</p>;
  }
  return (
    <div className="table-wrap">
      <table className="ptable evidence-table">
        <thead>
          <tr>
            <th>Field</th>
            <th className="num-cell">Value</th>
            <th>Method</th>
            <th>Source</th>
            <th>Cite</th>
          </tr>
        </thead>
        <tbody>
          {claims.map((claim) => {
            const predicate = getPredicate(claim.predicate);
            const chain = claim.derivation && index
              ? provenanceChain(index, claim).length - 1
              : 0;
            return (
              <tr key={claim.id}>
                <td title={claim.predicate}>{predicate?.label ?? claim.predicate}</td>
                <td className="num-cell">
                  {formatClaimValue(claim)}
                  {claim.unit ? <em className="unit"> {claim.unit}</em> : null}
                </td>
                <td>
                  <MethodBadge method={claim.method} />
                  {chain > 0 ? <span className="chain-count"> +{chain}</span> : null}
                </td>
                <td>{claim.source_id ? codes.get(claim.source_id) ?? claim.source_id : "—"}</td>
                <td>
                  <Cite claim={claim} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
