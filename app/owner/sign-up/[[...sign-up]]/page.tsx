import { SignUp } from "@clerk/nextjs";
import { SetupCard } from "@/components/owner/ui";
import { clerkConfigured, ownerConfigStatus, OWNER_HOME_PATH, OWNER_SIGN_IN_PATH, OWNER_SIGN_UP_PATH } from "@/lib/owner/config";

/** /owner/sign-up (Clerk path routing). Shows setup steps when Clerk keys are missing. */
export default function OwnerSignUpPage() {
  return (
    <main className="mx-auto flex w-full max-w-3xl flex-col items-center px-6 py-10">
      {clerkConfigured() ? (
        <SignUp
          path={OWNER_SIGN_UP_PATH}
          routing="path"
          signInUrl={OWNER_SIGN_IN_PATH}
          fallbackRedirectUrl={OWNER_HOME_PATH}
        />
      ) : (
        <div className="w-full">
          <SetupCard config={ownerConfigStatus()} />
        </div>
      )}
    </main>
  );
}
