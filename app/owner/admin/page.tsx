"use client";

import { AccountButton, AuthGate } from "@/components/owner/AuthGate";
import { AdminQueue } from "@/components/owner/AdminQueue";
import { Loading, Page, SetupCard, isConfigured, useOwnerConfig } from "@/components/owner/ui";

/** /owner/admin: review queue for ownership claims (admins only; the API returns 403 otherwise). */
export default function OwnerAdminPage() {
  const { config, error } = useOwnerConfig();
  const ready = isConfigured(config);
  return (
    <Page title="Review claims" actions={ready ? <AccountButton /> : null}>
      {!config ? (
        <Loading />
      ) : !ready ? (
        <SetupCard config={config} note={error} />
      ) : (
        <AuthGate signedOutText="Sign in with a reviewer account to see pending claims." returnTo="/owner/admin">
          <AdminQueue />
        </AuthGate>
      )}
    </Page>
  );
}
