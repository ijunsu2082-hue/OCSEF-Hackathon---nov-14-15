"use client";

import { AccountButton, AuthGate } from "@/components/owner/AuthGate";
import { Dashboard } from "@/components/owner/Dashboard";
import { Loading, Page, SetupCard, isConfigured, useOwnerConfig } from "@/components/owner/ui";

/** /owner: the owner's claims and filing timeline. Clerk components render only when configured. */
export default function OwnerDashboardPage() {
  const { config, error } = useOwnerConfig();
  const ready = isConfigured(config);
  return (
    <Page title="Your filings" actions={ready ? <AccountButton /> : null}>
      {!config ? (
        <Loading />
      ) : !ready ? (
        <SetupCard config={config} note={error} />
      ) : (
        <AuthGate
          signedOutText="Sign in to see the filings for the plants, substations and lines you own."
          returnTo="/owner"
        >
          <Dashboard />
        </AuthGate>
      )}
    </Page>
  );
}
