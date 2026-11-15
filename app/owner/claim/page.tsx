"use client";

import { Suspense } from "react";
import { AccountButton } from "@/components/owner/AuthGate";
import { ClaimFlow } from "@/components/owner/ClaimFlow";
import { Loading, Page, isConfigured, useOwnerConfig } from "@/components/owner/ui";

/** /owner/claim?kind=&id= : claim a plant, substation or line and choose how to verify. */
export default function OwnerClaimPage() {
  const { config, error } = useOwnerConfig();
  return (
    <Page title="Claim an asset" actions={isConfigured(config) ? <AccountButton /> : null}>
      {/* useSearchParams needs a Suspense boundary in the App Router. */}
      <Suspense fallback={<Loading />}>
        <ClaimFlow config={config} configNote={error} />
      </Suspense>
    </Page>
  );
}
