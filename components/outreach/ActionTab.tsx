"use client";

import { useEffect, useState, type CSSProperties } from "react";
import { Panel } from "@/components/ui/kit";
import { fmtDate } from "@/lib/format";
import type { AuditResponse, BriefResponse, FacilityProperties, SimResult } from "@/lib/types";

interface Props {
  properties: FacilityProperties;
  sim: SimResult;
}

export default function ActionTab({ properties, sim }: Props) {
  const [brief, setBrief] = useState("");
  const [source, setSource] = useState<BriefResponse["source"] | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [to, setTo] = useState(properties.provider.contact_email);
  const [sending, setSending] = useState(false);
  const [receipt, setReceipt] = useState<AuditResponse | null>(null);
  const [dispatchError, setDispatchError] = useState<string | null>(null);

  useEffect(() => {
    setBrief("");
    setSource(null);
    setModel(null);
    setGeneratedAt(null);
    setReceipt(null);
    setError(null);
    setDispatchError(null);
    setTo(properties.provider.contact_email);
  }, [properties.id, properties.provider.contact_email]);

  async function generate() {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/generate-brief", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          node_id: properties.id,
          simulation: sim,
          tone: "technical",
        }),
      });
      const data = (await response.json()) as BriefResponse & {
        error?: { message?: string };
      };
      if (!response.ok) {
        throw new Error(data?.error?.message ?? "Memo generation failed.");
      }
      setBrief(data.brief);
      setSource(data.source);
      setModel(data.model);
      setGeneratedAt(data.generated_at);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Memo generation failed.");
    } finally {
      setLoading(false);
    }
  }

  async function dispatch() {
    if (!brief) return;
    setSending(true);
    setDispatchError(null);
    setReceipt(null);
    try {
      const response = await fetch("/api/send-audit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ node_id: properties.id, brief, to }),
      });
      const data = (await response.json()) as AuditResponse & {
        error?: { message?: string };
      };
      if (!response.ok) {
        throw new Error(data?.error?.message ?? "Dispatch failed.");
      }
      setReceipt(data);
    } catch (err) {
      setDispatchError(err instanceof Error ? err.message : "Dispatch failed.");
    } finally {
      setSending(false);
    }
  }

  return (
    <>
      <Panel
        title="AI audit memo"
        action={
          source ? (
            <span className="pill pill-accent">
              {source === "gemini" ? "Gemini" : "Template"}
            </span>
          ) : null
        }
      >
        {brief ? (
          <>
            <div className="memo-head">
              <span className="memo-meta">
                {model ?? "deterministic fallback"}
                {generatedAt ? ` · ${fmtDate(generatedAt)}` : ""}
              </span>
              <button
                type="button"
                className="btn btn-ghost"
                style={{ width: "auto", padding: "4px 8px", fontSize: 9.5 }}
                onClick={generate}
                disabled={loading}
              >
                {loading ? "Working…" : "Regenerate"}
              </button>
            </div>
            <pre className="memo">{brief}</pre>
          </>
        ) : (
          <div className="empty">
            <b>No memo drafted yet</b>
            Generate a five-section audit memo from this facility&apos;s live numbers. Works
            without an API key — the deterministic template emits the same sections.
          </div>
        )}

        {!brief ? (
          <div className="btn-row">
            <button
              type="button"
              className="btn btn-primary"
              onClick={generate}
              disabled={loading}
            >
              {loading ? "Drafting memo…" : "Generate memo"}
            </button>
          </div>
        ) : null}

        {error ? <p className="error-text">{error}</p> : null}
      </Panel>

      <Panel title="Dispatch to provider">
        <div className="field">
          <label htmlFor="recipient">Recipient</label>
          <input
            id="recipient"
            type="email"
            value={to}
            onChange={(event) => setTo(event.target.value)}
            placeholder="operations@utility.example"
            autoComplete="off"
            spellCheck={false}
          />
          <small>
            One recipient only. Without a verified Resend domain, Resend delivers only to the
            account owner — the receipt tells you which mode was used.
          </small>
        </div>

        <button
          type="button"
          className="btn btn-primary"
          onClick={dispatch}
          disabled={!brief || sending}
        >
          {sending ? "Dispatching…" : brief ? "Dispatch memo" : "Draft a memo first"}
        </button>

        {receipt ? (
          <div
            className={`receipt ${
              receipt.delivered ? "is-live" : receipt.mode === "simulated" ? "is-sim" : "is-error"
            }`}
            style={{ marginTop: 12 }}
          >
            <div className="receipt-head">
              <b>
                {receipt.delivered
                  ? "Delivered"
                  : receipt.mode === "simulated"
                    ? "Simulated dispatch"
                    : "Not delivered"}
              </b>
              <span>{fmtDate(receipt.sent_at)}</span>
            </div>
            <p>
              {receipt.to} · {receipt.subject}
            </p>
            <p style={{ marginTop: 5 }}>{receipt.detail}</p>
            {receipt.provider_id ? (
              <p className="mono" style={{ marginTop: 5, fontSize: 9.5 }}>
                id {receipt.provider_id}
              </p>
            ) : null}
          </div>
        ) : null}

        {dispatchError ? <p className="error-text">{dispatchError}</p> : null}
      </Panel>

      <Panel title="What the provider receives">
        <ul className="signals">
          <li>
            <span className="signal-dot" style={{ "--c": "#38D6C4" } as CSSProperties} aria-hidden />
            <span>
              <b>Recommendation and screening economics</b>
              <br />
              <span>Intervention, capex, annual savings, payback and avoided carbon.</span>
            </span>
          </li>
          <li>
            <span className="signal-dot" style={{ "--c": "#4C8DFF" } as CSSProperties} aria-hidden />
            <span>
              <b>Stress exposure</b>
              <br />
              <span>Projected demand versus nameplate at 105 °F, plus the overload flag.</span>
            </span>
          </li>
          <li>
            <span className="signal-dot" style={{ "--c": "#E8A33D" } as CSSProperties} aria-hidden />
            <span>
              <b>One concrete next step</b>
              <br />
              <span>Interval data request and a joint site verification, not a brochure.</span>
            </span>
          </li>
        </ul>
      </Panel>
    </>
  );
}
