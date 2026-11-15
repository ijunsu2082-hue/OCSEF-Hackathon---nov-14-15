"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  claimsFor,
  confidenceLabel,
  facilitySubject,
  formatClaimValue,
  getClaim,
  getSnapshot,
  getSource,
  indexBundle,
  methodLabel,
  METHOD_COLOR,
  provenanceChain,
  regionSubject,
  sourceCodes,
  type ChainNode,
} from "@/lib/evidence/citation";
import { getPredicate } from "@/lib/evidence/predicates";
import type { Claim, ClaimIndex, EvidenceBundle } from "@/lib/evidence/schema";

interface EvidenceContextValue {
  bundle: EvidenceBundle | null;
  index: ClaimIndex | null;
  codes: Map<string, string>;
  claim: (subject: string, predicate: string) => Claim | null;
  open: (claim: Claim) => void;
  close: () => void;
  facilitySubject: typeof facilitySubject;
  regionSubject: typeof regionSubject;
}

const EvidenceContext = createContext<EvidenceContextValue | null>(null);

export function useEvidence(): EvidenceContextValue {
  const context = useContext(EvidenceContext);
  if (!context) {
    throw new Error("useEvidence must be used inside <EvidenceProvider>");
  }
  return context;
}

export function EvidenceProvider({
  bundle,
  children,
}: {
  bundle: EvidenceBundle | null;
  children: ReactNode;
}) {
  const index = useMemo(() => (bundle ? indexBundle(bundle) : null), [bundle]);
  const codes = useMemo(() => (bundle ? sourceCodes(bundle) : new Map<string, string>()), [bundle]);
  const [selected, setSelected] = useState<Claim | null>(null);

  const claim = useCallback(
    (subject: string, predicate: string) =>
      index ? getClaim(index, subject, predicate) : null,
    [index],
  );

  const value = useMemo<EvidenceContextValue>(
    () => ({
      bundle,
      index,
      codes,
      claim,
      open: setSelected,
      close: () => setSelected(null),
      facilitySubject,
      regionSubject,
    }),
    [bundle, index, codes, claim],
  );

  return (
    <EvidenceContext.Provider value={value}>
      {children}
      <CitationOverlay claim={selected} onClose={() => setSelected(null)} />
    </EvidenceContext.Provider>
  );
}

function CitationOverlay({ claim, onClose }: { claim: Claim | null; onClose: () => void }) {
  const { bundle, index, codes } = useEvidence();
  if (!claim || !bundle || !index) return null;

  const predicate = getPredicate(claim.predicate);
  const source = getSource(index, claim);
  const snapshot = getSnapshot(index, claim);
  const code = claim.source_id ? codes.get(claim.source_id) ?? claim.source_id : "runtime";
  // Only rendered when the claim has a derivation; an empty list keeps the
  // element type unambiguous for the chain walk below.
  const chain: ChainNode[] = claim.derivation ? provenanceChain(index, claim) : [];

  return (
    <div className="cite-overlay" role="presentation" onClick={onClose}>
      <div
        className="cite-card"
        role="dialog"
        aria-modal="true"
        aria-label="Citation detail"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="cite-card-head">
          <div>
            <span className="cite-kicker">{code} · {methodLabel(claim.method)}</span>
            <h4>{predicate?.label ?? claim.predicate}</h4>
          </div>
          <button type="button" className="cite-close" onClick={onClose} aria-label="Close citation">
            ×
          </button>
        </header>

        <div className="cite-value-row">
          <b style={{ color: METHOD_COLOR[claim.method] }}>
            {formatClaimValue(claim)}
            {claim.unit ? <em> {claim.unit}</em> : null}
          </b>
          <span className={`method-badge method-${claim.method}`}>
            {methodLabel(claim.method)} · {confidenceLabel(claim.confidence)}
          </span>
        </div>

        {source ? (
          <dl className="cite-facts">
            <dt>Source</dt>
            <dd>
              <a href={source.homepage} target="_blank" rel="noreferrer">
                {source.title}
              </a>
              <span>{source.publisher}</span>
            </dd>
            <dt>Authority</dt>
            <dd>{source.authority} · {source.license}</dd>
            <dt>Retrieved</dt>
            <dd>{claim.retrieved_at ?? "computed at runtime"}</dd>
            {claim.locator ? (
              <>
                <dt>Locator</dt>
                <dd><code>{claim.locator}</code></dd>
              </>
            ) : null}
            {snapshot ? (
              <>
                <dt>Snapshot</dt>
                <dd>
                  <code>{snapshot.id}</code>
                  <span>sha256 {snapshot.sha256}</span>
                  <span>{snapshot.bytes.toLocaleString()} bytes · {snapshot.cache_path}</span>
                </dd>
              </>
            ) : null}
          </dl>
        ) : (
          <p className="cite-note">
            {claim.method === "modeled"
              ? "Modeled value — no external source. See the model basis below."
              : "Computed at runtime from the citations below. Not written back to the static bundle."}
          </p>
        )}

        {claim.basis ? (
          <section className="cite-section">
            <h5>Model basis</h5>
            <p>{claim.basis}</p>
          </section>
        ) : null}

        {claim.derivation ? (
          <section className="cite-section">
            <h5>Working</h5>
            <code className="cite-expression">{claim.derivation.expression}</code>
            <ol className="chain">
              {chain.map((node) => {
                const nodePredicate = getPredicate(node.claim.predicate);
                return (
                  <li key={node.claim.id} style={{ marginLeft: node.depth * 12 }}>
                    <span className={`method-dot method-${node.claim.method}`} aria-hidden />
                    {nodePredicate?.label ?? node.claim.predicate}:{" "}
                    <b>{formatClaimValue(node.claim)}</b> {node.claim.unit ?? ""}
                    <span className="chain-meta">
                      {methodLabel(node.claim.method)}
                      {node.claim.source_id ? ` · ${codes.get(node.claim.source_id) ?? node.claim.source_id}` : ""}
                    </span>
                  </li>
                );
              })}
            </ol>
          </section>
        ) : null}

        {claim.caveats.length > 0 ? (
          <section className="cite-section">
            <h5>Caveats</h5>
            <ul>
              {claim.caveats.map((caveat) => (
                <li key={caveat}>{caveat}</li>
              ))}
            </ul>
          </section>
        ) : null}

        <footer className="cite-footer">
          <span>claim <code>{claim.id}</code></span>
          {claim.escalation ? (
            <span className="method-badge method-inferred">
              {claim.escalation.provider}/{claim.escalation.model} · {claim.escalation.verdict}
            </span>
          ) : null}
        </footer>
      </div>
    </div>
  );
}

export function useSubjectClaims(subject: string): Claim[] {
  const { index } = useEvidence();
  return useMemo(() => (index ? claimsFor(index, subject) : []), [index, subject]);
}
