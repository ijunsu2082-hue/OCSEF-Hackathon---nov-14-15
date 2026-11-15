"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { loadGridData, type GridData } from "@/lib/scan";
import type { Claim, ClaimStatus, Obligation, Task } from "@/lib/owner/types";
import { KIND_WORD, findAsset, isAssetKind } from "./assets";
import { addDaysIso, buildIcs, daysBetween, downloadText, todayIso } from "./calendar";
import { deadlinesIn, obligationsForAsset } from "./engine";
import { Timeline, Undated, type TimelineEntry } from "./Timeline";
import { BTN, ErrorText, LINK, Loading, api } from "./ui";

/*
 * Signed-in owner dashboard: my claims, then a 12-month timeline of filings for the
 * verified ones. Deadlines come from lib/owner/obligations.ts; task status is stored
 * via /api/owner/tasks.
 */

const CLAIM_STATUS: Record<ClaimStatus, { word: string; color: string }> = {
  pending: { word: "Pending review", color: "#556070" },
  verified: { word: "Verified", color: "#0369a1" },
  rejected: { word: "Rejected", color: "#dc2626" },
};

const taskKey = (claimId: string, obligationId: string, due: string) => `${claimId}|${obligationId}|${due}`;

function ClaimList({ claims }: { claims: Claim[] }) {
  return (
    <ul className="divide-y divide-[#e6e9ee] border-y border-[#e6e9ee]">
      {claims.map((c) => {
        const s = CLAIM_STATUS[c.status];
        return (
          <li key={c.id} className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 py-3">
            <div className="min-w-0">
              <p className="text-[15px] font-semibold leading-snug">{c.asset_name}</p>
              <p className="text-[13px] leading-snug text-[#556070]">
                {isAssetKind(c.asset_kind) ? KIND_WORD[c.asset_kind] : c.asset_kind}
                {c.owner_name ? ` · ${c.owner_name}` : ""}
                {" · "}
                {c.method === "email_domain" ? "Work email" : "Uploaded proof"}
              </p>
              {c.status === "rejected" && c.reason && (
                <p className="mt-0.5 text-[13px] leading-snug text-[#1d2733]">Reason: {c.reason}</p>
              )}
            </div>
            <p className="shrink-0 text-[14px] font-semibold" style={{ color: s.color }}>
              {s.word}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

export function Dashboard() {
  const [claims, setClaims] = useState<Claim[] | null>(null);
  const [grid, setGrid] = useState<GridData | null>(null);
  const [tasks, setTasks] = useState<Map<string, Task>>(new Map());
  const [error, setError] = useState<string | null>(null);
  const today = useMemo(() => todayIso(), []);

  useEffect(() => {
    let alive = true;
    api<{ claims: Claim[] }>("/api/owner/claims")
      .then(async (r) => {
        if (!alive) return;
        setClaims(r.claims);
        const verified = r.claims.filter((c) => c.status === "verified");
        if (verified.length === 0) return;
        const [g, ...taskLists] = await Promise.all([
          loadGridData(),
          ...verified.map((c) => api<{ tasks: Task[] }>(`/api/owner/tasks?claim_id=${encodeURIComponent(c.id)}`)),
        ]);
        if (!alive) return;
        const m = new Map<string, Task>();
        for (const tl of taskLists as { tasks: Task[] }[]) {
          for (const t of tl.tasks) m.set(taskKey(t.claim_id, t.obligation_id, t.due), t);
        }
        setGrid(g as GridData);
        setTasks(m);
      })
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : "Could not load your claims."));
    return () => {
      alive = false;
    };
  }, []);

  const plan = useMemo(() => {
    if (!claims || !grid) return null;
    const end = addDaysIso(today, 365);
    const dated: TimelineEntry[] = [];
    const undated: { key: string; assetName: string; obligation: Obligation }[] = [];
    const missing: Claim[] = [];
    for (const c of claims) {
      if (c.status !== "verified" || !isAssetKind(c.asset_kind)) continue;
      const asset = findAsset(grid, { kind: c.asset_kind, id: c.asset_id });
      if (!asset) {
        missing.push(c);
        continue;
      }
      // Start at the verification date (capped at one year back) so missed filings since then show as overdue.
      const verifiedOn = (c.decided_at ?? c.created_at).slice(0, 10);
      const start = verifiedOn < today ? (daysBetween(verifiedOn, today) > 365 ? addDaysIso(today, -365) : verifiedOn) : today;
      const months = 12 + Math.ceil(daysBetween(start, today) / 30);
      for (const o of obligationsForAsset(asset)) {
        const ds = deadlinesIn(o, start, months).filter((x) => x.due >= start && x.due <= end);
        if (ds.length === 0) {
          undated.push({ key: `${c.id}|${o.id}`, assetName: c.asset_name, obligation: o });
          continue;
        }
        for (const dl of ds) {
          const key = taskKey(c.id, o.id, dl.due);
          const task = tasks.get(key) ?? null;
          // Past items only stay on the timeline while they are not filed.
          if (dl.due < today && task?.status === "filed") continue;
          dated.push({ key, claim: c, assetName: c.asset_name, obligation: o, deadline: dl, task });
        }
      }
    }
    return { dated, undated, missing };
    // tasks are read for initial status only; Timeline items keep their own state after saving.
  }, [claims, grid, today]);

  const onSaved = useCallback((key: string, t: Task) => {
    setTasks((m) => new Map(m).set(key, t));
  }, []);

  const exportIcs = () => {
    if (!plan) return;
    const ics = buildIcs(
      plan.dated.map((e) => ({
        uid: `${e.claim.id}-${e.obligation.id}-${e.deadline.due}@gridsentinel`,
        date: e.deadline.due,
        summary: `${e.obligation.form} due: ${e.assetName}`,
        description: [
          e.obligation.title,
          `${e.obligation.agency}`,
          `Period: ${e.deadline.periodLabel}`,
          `Rule: ${e.obligation.dueRule}`,
          `Form: ${e.obligation.formUrl}`,
        ].join("\n"),
        url: e.obligation.formUrl,
      })),
    );
    downloadText("owner-filings.ics", "text/calendar;charset=utf-8", ics);
  };

  if (error) return <ErrorText>{error}</ErrorText>;
  if (!claims) return <Loading />;

  const verifiedCount = claims.filter((c) => c.status === "verified").length;

  return (
    <div className="flex flex-col gap-10">
      <section aria-labelledby="my-claims">
        <div className="flex items-baseline justify-between gap-4">
          <h2 id="my-claims" className="text-[17px] font-semibold">
            My assets
          </h2>
          <a href="/owner/claim" className={`text-[14px] ${LINK}`}>
            Claim an asset
          </a>
        </div>
        <div className="mt-3">
          {claims.length === 0 ? (
            <p className="text-[14px] leading-relaxed text-[#556070]">
              You have not claimed any assets yet. Find your plant, substation or line on the{" "}
              <a href="/" className={LINK}>
                map
              </a>{" "}
              and choose &quot;Owner filings&quot;, or{" "}
              <a href="/owner/claim" className={LINK}>
                search by name or plant code
              </a>
              .
            </p>
          ) : (
            <ClaimList claims={claims} />
          )}
        </div>
      </section>

      {verifiedCount > 0 && (
        <section aria-labelledby="timeline">
          <div className="flex flex-wrap items-baseline justify-between gap-4">
            <h2 id="timeline" className="text-[17px] font-semibold">
              Filings in the next 12 months
            </h2>
            {plan && plan.dated.length > 0 && (
              <button type="button" className={BTN} onClick={exportIcs}>
                Add to calendar (.ics)
              </button>
            )}
          </div>
          <p className="mt-1 text-[13px] leading-snug text-[#6b7583]">
            Due dates follow each agency&apos;s published rule. Check the official form page before you file.
          </p>
          <div className="mt-4">
            {!plan ? (
              <Loading>Loading your filings…</Loading>
            ) : (
              <>
                {plan.missing.length > 0 && (
                  <p className="mb-4 text-[14px] text-[#556070]">
                    {plan.missing.map((c) => c.asset_name).join(", ")}: not found in the current map data, so no
                    filings are listed for {plan.missing.length === 1 ? "it" : "them"}.
                  </p>
                )}
                <Timeline entries={plan.dated} today={today} onSaved={onSaved} />
                {plan.undated.length > 0 && (
                  <div className="mt-8">
                    <h3 className="text-[15px] font-semibold">When something happens</h3>
                    <p className="mt-1 text-[13px] text-[#6b7583]">These filings have no fixed date. They are due after an event.</p>
                    <div className="mt-3">
                      <Undated items={plan.undated} />
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
