"use client";

import { useEffect, useId, useState } from "react";
import type { Claim } from "@/lib/owner/types";
import { KIND_WORD, isAssetKind } from "./assets";
import { fmtDate } from "./calendar";
import { BTN, ErrorText, INPUT, LINK, Loading, PRIMARY, api, errorStatus } from "./ui";

/*
 * /owner/admin: pending claims, oldest first, with Approve / Reject (+ reason).
 * The API decides who is an admin; a 403 shows a plain no-access message.
 */

type AdminClaim = Claim & { claimant_email?: string | null };

function Row({ c, onDone }: { c: AdminClaim; onDone: (c: Claim) => void }) {
  const id = useId();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const decide = async (decision: "verified" | "rejected") => {
    if (decision === "rejected" && !reason.trim()) {
      setError("Give a reason. The claimant will see it.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ claim: Claim }>(`/api/owner/admin/claims/${encodeURIComponent(c.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(decision === "rejected" ? { decision, reason: reason.trim() } : { decision }),
      });
      onDone(r.claim);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the decision.");
      setBusy(false);
    }
  };

  return (
    <li className="py-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
        <h3 className="text-[15px] font-semibold leading-snug">{c.asset_name}</h3>
        <p className="text-[13px] tabular-nums text-[#556070]">Submitted {fmtDate(c.created_at.slice(0, 10))}</p>
      </div>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-[14px]">
        <dt className="text-[#556070]">Asset</dt>
        <dd className="tabular-nums">
          {isAssetKind(c.asset_kind) ? KIND_WORD[c.asset_kind] : c.asset_kind} · id {c.asset_id}
        </dd>
        <dt className="text-[#556070]">Claimed owner</dt>
        <dd>{c.owner_name}</dd>
        <dt className="text-[#556070]">Method</dt>
        <dd>{c.method === "email_domain" ? "Work email" : "Uploaded proof"}</dd>
        <dt className="text-[#556070]">User</dt>
        <dd className="break-all">{c.user_id}</dd>
        {c.claimant_email && (
          <>
            <dt className="text-[#556070]">Email</dt>
            <dd className="break-all">{c.claimant_email}</dd>
          </>
        )}
        {c.note && (
          <>
            <dt className="text-[#556070]">Note</dt>
            <dd>{c.note}</dd>
          </>
        )}
        <dt className="text-[#556070]">Evidence</dt>
        <dd>
          {c.evidence_path ? (
            // Admin route redirects to a short-lived signed link for the stored file.
            <a
              href={`/api/owner/admin/claims/${encodeURIComponent(c.id)}/evidence`}
              target="_blank"
              rel="noopener noreferrer"
              className={LINK}
            >
              Open the uploaded file
            </a>
          ) : (
            <span className="text-[#556070]">No file uploaded</span>
          )}
        </dd>
      </dl>

      {rejecting && (
        <div className="mt-3">
          <label htmlFor={`${id}-reason`} className="block text-[13px] font-medium text-[#556070]">
            Reason (shown to the claimant)
          </label>
          <textarea
            id={`${id}-reason`}
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className={`${INPUT} mt-1`}
          />
        </div>
      )}
      {error && (
        <div className="mt-2">
          <ErrorText>{error}</ErrorText>
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {!rejecting ? (
          <>
            <button type="button" className={PRIMARY} disabled={busy} onClick={() => void decide("verified")}>
              Approve
            </button>
            <button type="button" className={`${BTN} h-10`} disabled={busy} onClick={() => setRejecting(true)}>
              Reject
            </button>
          </>
        ) : (
          <>
            <button type="button" className={`${BTN} h-10 text-[#dc2626]`} disabled={busy} onClick={() => void decide("rejected")}>
              Reject claim
            </button>
            <button type="button" className={`${BTN} h-10`} disabled={busy} onClick={() => setRejecting(false)}>
              Cancel
            </button>
          </>
        )}
      </div>
    </li>
  );
}

export function AdminQueue() {
  const [claims, setClaims] = useState<AdminClaim[] | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "forbidden" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Claim[]>([]);

  useEffect(() => {
    let alive = true;
    api<{ claims: AdminClaim[] }>("/api/owner/admin/claims?status=pending")
      .then((r) => {
        if (!alive) return;
        setClaims([...r.claims].sort((a, b) => a.created_at.localeCompare(b.created_at)));
        setState("ok");
      })
      .catch((e: unknown) => {
        if (!alive) return;
        if (errorStatus(e) === 403) setState("forbidden");
        else {
          setError(e instanceof Error ? e.message : "Could not load claims.");
          setState("error");
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  if (state === "loading") return <Loading />;
  if (state === "forbidden") {
    return (
      <section role="alert" className="rounded-[6px] border border-[#e6e9ee] px-5 py-5">
        <h2 className="text-[16px] font-semibold">You do not have access to this page</h2>
        <p className="mt-2 text-[14px] leading-relaxed text-[#556070]">
          Only reviewers can approve or reject claims. If you own an asset, go to{" "}
          <a href="/owner" className={LINK}>
            your filings
          </a>
          .
        </p>
      </section>
    );
  }
  if (state === "error") return <ErrorText>{error}</ErrorText>;

  const list = claims ?? [];
  return (
    <div>
      <p aria-live="polite" className="text-[14px] text-[#556070]">
        {list.length === 0 ? "No claims are waiting for review." : `${list.length} waiting for review, oldest first.`}
      </p>
      {done.length > 0 && (
        <ul className="mt-2 flex flex-col gap-0.5">
          {done.map((c) => (
            <li key={c.id} className="text-[13px] text-[#556070]">
              {c.status === "verified" ? "Approved" : "Rejected"}: {c.asset_name}
            </li>
          ))}
        </ul>
      )}
      {list.length > 0 && (
        <ul className="mt-4 divide-y divide-[#e6e9ee] border-y border-[#e6e9ee]">
          {list.map((c) => (
            <Row
              key={c.id}
              c={c}
              onDone={(d) => {
                setClaims((cs) => (cs ?? []).filter((x) => x.id !== c.id));
                setDone((ds) => [d, ...ds]);
              }}
            />
          ))}
        </ul>
      )}
    </div>
  );
}
