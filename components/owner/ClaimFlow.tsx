"use client";

import { useEffect, useId, useMemo, useState, type FormEvent } from "react";
import { useSearchParams } from "next/navigation";
import { loadGridData, type GridData } from "@/lib/scan";
import { kvLabel, lineMiles } from "@/lib/scan/labels";
import type { Claim, OwnedAsset, VerifyMethod } from "@/lib/owner/types";
import { AuthGate } from "./AuthGate";
import {
  KIND_WORD,
  assetName,
  assetRef,
  claimHref,
  findAsset,
  isAssetKind,
  ownerFromData,
  ownerSource,
  searchAssets,
} from "./assets";
import { ErrorText, INPUT, LINK, Loading, PRIMARY, SetupCard, api, isConfigured, type OwnerConfig } from "./ui";

/*
 * /owner/claim?kind=&id= : show the asset's public details, then let a signed-in user
 * claim it with a work email or an uploaded document.
 */

const MAX_BYTES = 10 * 1024 * 1024;
const FILE_TYPES = ["application/pdf", "image/png", "image/jpeg"];

function fmtMw(mw: number): string {
  return `${(mw >= 100 ? Math.round(mw) : Math.round(mw * 10) / 10).toLocaleString("en-US")} MW`;
}

function detailRows(a: OwnedAsset): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [];
  if (a.kind === "plant") {
    const p = a.plant;
    rows.push({ label: "EIA plant code", value: String(p.plant_code) });
    if (p.utility_name) rows.push({ label: "Utility (EIA)", value: p.utility_name });
    const place = [p.city, p.county ? `${p.county} County` : ""].filter(Boolean).join(", ");
    if (place) rows.push({ label: "Location", value: place });
    if (p.nameplate_mw > 0) rows.push({ label: "Nameplate capacity", value: fmtMw(p.nameplate_mw) });
    if (p.generator_count > 0) rows.push({ label: "Generators", value: String(p.generator_count) });
  } else if (a.kind === "substation") {
    const s = a.substation;
    const kv = kvLabel(s.voltage_kv, s.kv_inferred);
    if (kv) rows.push({ label: "Voltage", value: kv });
    if (s.operator) rows.push({ label: "Operator (OpenStreetMap)", value: s.operator });
    rows.push({ label: "OpenStreetMap id", value: s.osm_id });
    rows.push({ label: "Location", value: `${s.lat.toFixed(4)}, ${s.lon.toFixed(4)}` });
  } else {
    const l = a.line;
    const kv = kvLabel(l.voltage_kv, l.kv_inferred);
    if (kv) rows.push({ label: "Voltage", value: kv });
    if (l.operator) rows.push({ label: "Operator (OpenStreetMap)", value: l.operator });
    const mi = lineMiles(l);
    rows.push({ label: "Length", value: `${mi >= 10 ? Math.round(mi) : Math.round(mi * 10) / 10} mi` });
    rows.push({ label: "OpenStreetMap id", value: String(l.osm_id) });
  }
  return rows;
}

function AssetDetails({ a }: { a: OwnedAsset }) {
  return (
    <section aria-labelledby="claim-asset" className="border-b border-[#e6e9ee] pb-6">
      <p className="text-[13px] text-[#6b7583]">{KIND_WORD[a.kind]}</p>
      <h2 id="claim-asset" className="mt-0.5 text-[18px] font-semibold leading-snug">
        {assetName(a)}
      </h2>
      <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-6 gap-y-1 text-[14px]">
        {detailRows(a).map((r) => (
          <div key={r.label} className="contents">
            <dt className="text-[#556070]">{r.label}</dt>
            <dd className="font-medium tabular-nums text-[#1d2733]">{r.value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-3 text-[12px] text-[#6b7583]">
        Source: {a.kind === "plant" ? "EIA-860 2025" : "OpenStreetMap"}
      </p>
      {a.kind === "substation" && a.substation.name_source === "state_list" && (
        <p className="mt-1 text-[12px] text-[#6b7583]">
          Name matched by location from California&apos;s state substation list.
        </p>
      )}
    </section>
  );
}

function Search({ grid }: { grid: GridData }) {
  const [q, setQ] = useState("");
  const id = useId();
  const results = useMemo(() => searchAssets(grid, q), [grid, q]);
  return (
    <section aria-labelledby={`${id}-h`}>
      <h2 id={`${id}-h`} className="text-[17px] font-semibold">
        Find your asset
      </h2>
      <label htmlFor={`${id}-q`} className="mt-3 block text-[13px] font-medium text-[#556070]">
        Name or EIA plant code
      </label>
      <input
        id={`${id}-q`}
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        className={`${INPUT} mt-1`}
        autoComplete="off"
      />
      {q.trim().length >= 2 && (
        <p className="mt-2 text-[13px] text-[#6b7583]" aria-live="polite">
          {results.length === 0 ? "No matches." : `${results.length}${results.length >= 20 ? "+" : ""} matches`}
        </p>
      )}
      {results.length > 0 && (
        <ul className="mt-2 divide-y divide-[#e6e9ee] border-y border-[#e6e9ee]">
          {results.map((a) => {
            const r = assetRef(a);
            return (
              <li key={`${r.kind}-${r.id}`} className="py-2">
                <a href={claimHref(a)} className={`text-[14px] font-medium ${LINK}`}>
                  {assetName(a)}
                </a>
                <span className="text-[13px] text-[#556070]">
                  {" · "}
                  {KIND_WORD[a.kind]}
                  {a.kind === "plant" ? ` · plant code ${a.plant.plant_code}` : ""}
                  {ownerFromData(a) ? ` · ${ownerFromData(a)}` : ""}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

function Result({ claim }: { claim: Claim }) {
  if (claim.status === "verified") {
    return (
      <section role="status" className="rounded-[6px] border border-[#e6e9ee] px-5 py-5">
        <h2 className="text-[16px] font-semibold text-[#0369a1]">Verified</h2>
        <p className="mt-2 text-[14px] leading-relaxed text-[#1d2733]">
          Your claim on {claim.asset_name} is verified. Your filing calendar is ready.
        </p>
        <a href="/owner" className={`${PRIMARY} mt-4`}>
          Go to your filings
        </a>
      </section>
    );
  }
  if (claim.status === "rejected") {
    return (
      <section role="status" className="rounded-[6px] border border-[#e6e9ee] px-5 py-5">
        <h2 className="text-[16px] font-semibold text-[#dc2626]">Rejected</h2>
        {claim.reason && <p className="mt-2 text-[14px] leading-relaxed">Reason: {claim.reason}</p>}
        <p className="mt-2 text-[14px]">
          <a href="/owner" className={LINK}>
            Back to your filings
          </a>
        </p>
      </section>
    );
  }
  return (
    <section role="status" className="rounded-[6px] border border-[#e6e9ee] px-5 py-5">
      <h2 className="text-[16px] font-semibold">Pending review</h2>
      <p className="mt-2 text-[14px] leading-relaxed text-[#1d2733]">
        We received your claim on {claim.asset_name}. A reviewer will check it. You can follow its status on your
        filings page.
      </p>
      <a href="/owner" className={`${PRIMARY} mt-4`}>
        Go to your filings
      </a>
    </section>
  );
}

export function ClaimForm({ asset }: { asset: OwnedAsset }) {
  const id = useId();
  const [owner, setOwner] = useState(ownerFromData(asset));
  const [method, setMethod] = useState<VerifyMethod>("email_domain");
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [claim, setClaim] = useState<Claim | null>(null);
  const [needsUpload, setNeedsUpload] = useState(false);
  const fromData = ownerFromData(asset);

  const fileError =
    method === "document" && file
      ? !FILE_TYPES.includes(file.type)
        ? "Use a PDF, PNG or JPG file."
        : file.size > MAX_BYTES
          ? "The file is larger than 5 MB."
          : null
      : null;

  const upload = async (c: Claim) => {
    if (!file) return c;
    const fd = new FormData();
    fd.append("file", file);
    const r = await api<{ claim: Claim }>(`/api/owner/claims/${encodeURIComponent(c.id)}/evidence`, {
      method: "POST",
      body: fd,
    });
    return r.claim;
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!owner.trim()) return setError("Enter the organization that owns this asset.");
    if (method === "document" && !file) return setError("Choose a file to upload.");
    if (fileError) return setError(fileError);
    setBusy(true);
    try {
      let c = claim;
      if (!c) {
        const r = await api<{ claim: Claim }>("/api/owner/claims", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            asset: assetRef(asset),
            asset_name: assetName(asset),
            owner_name: owner.trim(),
            method,
            ...(note.trim() ? { note: note.trim() } : {}),
          }),
        });
        c = r.claim;
        setClaim(c);
      }
      if (method === "document") {
        setNeedsUpload(true);
        c = await upload(c);
        setClaim(c);
        setNeedsUpload(false);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong. Try again.");
    } finally {
      setBusy(false);
    }
  };

  if (claim && !needsUpload) return <Result claim={claim} />;

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-6">
      <div>
        <label htmlFor={`${id}-owner`} className="block text-[14px] font-semibold">
          Owner organization
        </label>
        <input
          id={`${id}-owner`}
          value={owner}
          onChange={(e) => setOwner(e.target.value)}
          className={`${INPUT} mt-1.5`}
          disabled={!!claim}
          required
        />
        {fromData && <p className="mt-1 text-[12px] text-[#6b7583]">Filled in from {ownerSource(asset)}.</p>}
      </div>

      <fieldset disabled={!!claim}>
        <legend className="text-[14px] font-semibold">How do you want to verify?</legend>
        <div className="mt-2 flex flex-col gap-3">
          <label className="flex cursor-pointer gap-3 rounded-[6px] border border-[#e6e9ee] px-4 py-3 has-[:checked]:border-[#0ea5e9]">
            <input
              type="radio"
              name="method"
              value="email_domain"
              checked={method === "email_domain"}
              onChange={() => setMethod("email_domain")}
              className="mt-1 accent-[#0ea5e9]"
            />
            <span>
              <span className="block text-[14px] font-semibold">Work email</span>
              <span className="block text-[14px] leading-snug text-[#556070]">
                Your verified work email must be on the owner&apos;s official domain. We check the email on the
                account you signed in with.
              </span>
            </span>
          </label>
          <label className="flex cursor-pointer gap-3 rounded-[6px] border border-[#e6e9ee] px-4 py-3 has-[:checked]:border-[#0ea5e9]">
            <input
              type="radio"
              name="method"
              value="document"
              checked={method === "document"}
              onChange={() => setMethod("document")}
              className="mt-1 accent-[#0ea5e9]"
            />
            <span>
              <span className="block text-[14px] font-semibold">Upload proof</span>
              <span className="block text-[14px] leading-snug text-[#556070]">
                PDF, PNG or JPG up to 5 MB: e.g. an EIA filing confirmation, an interconnection agreement, or a
                signed letter on company letterhead. A reviewer checks it by hand.
              </span>
            </span>
          </label>
        </div>
      </fieldset>

      {method === "document" && (
        <div>
          <label htmlFor={`${id}-file`} className="block text-[14px] font-semibold">
            Proof document
          </label>
          <input
            id={`${id}-file`}
            type="file"
            accept=".pdf,.png,.jpg,.jpeg,application/pdf,image/png,image/jpeg"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            aria-describedby={`${id}-file-help`}
            className="mt-1.5 block text-[14px] text-[#1d2733] file:mr-3 file:h-9 file:rounded-[6px] file:border file:border-[#e6e9ee] file:bg-white file:px-3 file:text-[14px] file:font-medium"
          />
          <p id={`${id}-file-help`} className="mt-1 text-[12px] text-[#6b7583]">
            PDF, PNG or JPG, up to 5 MB.
          </p>
          {fileError && <ErrorText>{fileError}</ErrorText>}
        </div>
      )}

      <div>
        <label htmlFor={`${id}-note`} className="block text-[14px] font-semibold">
          Note for the reviewer <span className="font-normal text-[#556070]">(optional)</span>
        </label>
        <textarea
          id={`${id}-note`}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={3}
          disabled={!!claim}
          className={`${INPUT} mt-1.5`}
        />
      </div>

      {error && <ErrorText>{error}</ErrorText>}
      {claim && needsUpload && !busy && (
        <p className="text-[14px] text-[#556070]">Your claim was saved, but the file did not upload. Choose the file again if needed and retry.</p>
      )}

      <div>
        <button type="submit" className={PRIMARY} disabled={busy}>
          {busy ? "Submitting…" : claim && needsUpload ? "Retry upload" : "Submit claim"}
        </button>
      </div>
    </form>
  );
}

export function ClaimFlow({ config, configNote }: { config: OwnerConfig | null; configNote?: string | null }) {
  const params = useSearchParams();
  const kind = params.get("kind");
  const id = params.get("id");
  const [grid, setGrid] = useState<GridData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    loadGridData()
      .then((g) => alive && setGrid(g))
      .catch(() => alive && setLoadError("Could not load the map data. Reload the page to try again."));
    return () => {
      alive = false;
    };
  }, []);

  const asset = useMemo(
    () => (grid && isAssetKind(kind) && id ? findAsset(grid, { kind, id }) : null),
    [grid, kind, id],
  );

  if (loadError) return <ErrorText>{loadError}</ErrorText>;
  if (!grid) return <Loading />;

  if (!asset) {
    return (
      <div className="flex flex-col gap-4">
        {kind && id && (
          <p className="text-[14px] leading-relaxed text-[#556070]">
            That asset is not in the current map data. Search by name or plant code instead.
          </p>
        )}
        <Search grid={grid} />
      </div>
    );
  }

  const here = claimHref(asset);
  return (
    <div className="flex flex-col gap-6">
      <AssetDetails a={asset} />
      {!config ? (
        <Loading />
      ) : !isConfigured(config) ? (
        <SetupCard config={config} note={configNote} />
      ) : (
        <AuthGate signedOutText="Sign in to claim this asset. After you verify that you own it, you get its filing calendar." returnTo={here}>
          <ClaimForm asset={asset} />
        </AuthGate>
      )}
      <p className="text-[14px]">
        <a href="/owner/claim" className={LINK}>
          Claim a different asset
        </a>
      </p>
    </div>
  );
}
