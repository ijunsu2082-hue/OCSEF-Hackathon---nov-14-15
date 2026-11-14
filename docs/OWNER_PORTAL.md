# Owner portal setup

The owner portal (`/owner`) lets infrastructure owners sign in, claim a plant, substation
or line, get verified, and track their filings. Sign-in is Clerk. Data and evidence files
are in Supabase. Supabase trusts Clerk session tokens (third-party auth), so row level
security (RLS) in Postgres decides what each user can read and write.

Until you add keys, nothing breaks: the team app at `/` and the public map at `/scan` work
as before, `/owner` pages show setup steps, and `/api/owner/*` answers
`503 {"error":"not_configured"}`. `GET /api/owner/config` reports `{ "clerk": bool, "supabase": bool }`.

You create the Clerk and Supabase accounts yourself. Steps:

## 1. Create a Clerk application

1. Sign in at https://dashboard.clerk.com and create an application.
2. Sign-in methods: open **User & authentication** and turn on **Email** (with
   **Email verification code** or **Email verification link**). Email is what proves a
   work address. You can also allow Google sign-in. Only emails that Clerk verified with
   `email_code`, `email_link` or `from_oauth_google` count for automatic approval; an
   email from any other sign-in method (for example Microsoft) leaves the claim pending for
   an admin, because some providers pass along emails they never checked. Turn off
   phone-only and username-only sign-in, since those accounts have no email to check.
3. Open **API keys** and copy the publishable key and the secret key (step 5).
4. Connect Clerk to Supabase: open https://dashboard.clerk.com/setup/supabase, choose
   your options, activate the integration and copy the **Clerk domain** it shows. This
   adds the `role: "authenticated"` claim that Supabase needs to Clerk session tokens.
   No JWT template is needed (the JWT-template integration is deprecated).

## 2. Create a Supabase project and trust Clerk

1. Create a project at https://supabase.com/dashboard.
2. Open **Authentication > Sign In / Providers > Third-Party Auth**
   (https://supabase.com/dashboard/project/_/auth/third-party), add **Clerk**, and paste
   the Clerk domain from step 1.4.
3. Copy keys (step 5):
   - **Project Settings > Data API**: the project URL (base URL only, no `/rest/v1`).
   - **Project Settings > API Keys**: the **publishable** key, and optionally the
     **secret** key (or the legacy `service_role` key).

## 3. Run the migration

Open **SQL Editor** in Supabase, paste all of `supabase/migrations/0001_owner_portal.sql`
and run it. (With the Supabase CLI linked to the project, `supabase db push` does the same.)
It is safe to run again. It creates:

- `public.claims`, `public.tasks`, `public.admins` with RLS turned on for all three.
- Rules enforced in the database, not only in the API:
  - Users read and create only their own claims (`user_id = auth.jwt()->>'sub'`). The
    database stamps `user_id`, `status = 'pending'` and clears `decided_*` on insert, so a
    user can never create a verified claim or change status, `decided_by`, `decided_at`,
    `reason`, or what was claimed.
  - One open (pending or verified) claim per user per asset.
  - Tasks exist only for the user's own verified claims; one task per
    (claim, obligation, due date).
  - Admins (rows in `admins`) can read all claims and move a pending claim to verified or
    rejected, never their own. `decided_by` and `decided_at` come from the admin's token.
  - `authenticated` loses Supabase's default ALL privileges on these tables and gets back
    only select (admins) and select, insert, update (claims, tasks).
- The private storage bucket `claim-evidence` (5 MB limit; PDF, PNG, JPEG) with policies:
  owners upload to and read from `<their user id>/<claim id>/...` for their own pending
  claim; admins can read all files.

If the bucket insert fails on your project, create it by hand in **Storage**: name
`claim-evidence`, not public, 5 MB file limit, allowed types `application/pdf, image/png,
image/jpeg`. The storage policies in the migration apply either way.

## 4. Make yourself an admin

Sign in once at `/owner/sign-in` (after step 5), then copy your user id (starts with
`user_`) from **Users** in the Clerk Dashboard and run in the Supabase SQL Editor:

```sql
insert into public.admins (user_id) values ('user_xxxxxxxxxxxxxxxxxxxxxxxxxxx');
```

There is no API to add admins; this is on purpose.

## 5. Fill `.env.local`

Copy `.env.example` to `.env.local` and fill in the owner portal block, then restart
`npm run dev`. Never commit `.env.local`.

| Variable | Value | Secret? |
| --- | --- | --- |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk publishable key (`pk_...`) | No, sent to the browser |
| `CLERK_SECRET_KEY` | Clerk secret key (`sk_...`) | **Yes**, server only |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL` | `/owner/sign-in` | No |
| `NEXT_PUBLIC_CLERK_SIGN_UP_URL` | `/owner/sign-up` | No |
| `NEXT_PUBLIC_CLERK_SIGN_IN_FALLBACK_REDIRECT_URL` | `/owner` | No |
| `NEXT_PUBLIC_CLERK_SIGN_UP_FALLBACK_REDIRECT_URL` | `/owner` | No |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL | No |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Supabase publishable key (`sb_publishable_...`) or legacy anon key | No, RLS protects the data |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase secret key (`sb_secret_...`) or legacy `service_role` key. Optional. | **Yes**, server only, never `NEXT_PUBLIC_` |
| `OWNER_DATA_ORIGIN` | Optional. Site origin to read `/layers/*.geojson` from if the server cannot read `public/` (defaults to Netlify's `URL`) | No |

The other variables in `.env.example` (Gemini, Resend) belong to other features.

On Netlify, add the same variables to the site's environment variables and redeploy.

### Why the service key exists (and where it is used)

The browser never gets it. The Supabase URL and publishable key are public, so anyone
signed in could call Supabase directly with their own token; that is why the database
refuses to let a user set their own claim to verified. For **email_domain** claims the
server checks the user's Clerk primary email itself (it must be verified in Clerk and on
an official domain for the owner in `lib/owner/domains.ts`; free-mail never counts) and
then marks that single claim verified with the service key
(`markVerifiedByEmailDomain` in `lib/owner/db.ts`). Every other read and write uses the
user's own token. Without the key, email_domain claims stay pending for an admin.

## How verification works

- **Work email** (`email_domain`): verified at once only if the account's primary email is
  verified in Clerk and its domain equals, or is a subdomain of, an official domain of
  the owner named in public data (EIA-860 `utility_name` for plants, OpenStreetMap
  `operator` for substations and lines). `sce.com.evil.io` does not match `sce.com`.
  Otherwise the claim is pending.
- **Document** (`document`): always pending until an admin decides. Files go to
  `claim-evidence/<user_id>/<claim_id>/<file name>`.
- Documents are PDF, PNG or JPG up to 5 MB. Netlify caps function request bodies at about
  6 MB, so a larger limit could not be reached.
- The owner name always comes from the asset's public data; the claimant cannot edit it
  but can add a note (for example a subsidiary name). Assets whose public data names no
  owner can be claimed only with a document.
- A user can also insert a claim straight through the Supabase REST API with any
  `owner_name` or `asset_name`. So the admin list shows the owner and asset name from
  public data (`public_data_mismatch` lists what the stored claim got wrong), and the
  admin decision route refuses to approve (409) a claim whose stored owner or asset name
  does not match public data or whose asset is not in public data. Such claims can still
  be rejected.
- A user can also upload any bytes labelled as a PDF straight to Storage. Before signing a
  file URL, the admin evidence route downloads the file and re-checks its first bytes
  (`%PDF-`, the PNG signature or the JPEG signature); other files are refused with 422.
- Limitation: an automatic approval is checked once, when the claim is created. It is not
  re-checked if the user later changes their primary email or leaves the company. An admin
  has to reject such claims by hand.

To add an owner to automatic email verification, add an entry to `lib/owner/domains.ts`
with the exact names used in our data and a domain you confirmed on the owner's official
website, then run `npm test`.

## API

| Method and path | Who | Result |
| --- | --- | --- |
| `GET /api/owner/config` | anyone | `{ clerk, supabase }` |
| `GET /api/owner/claims` | signed in | `{ claims }` (own) |
| `POST /api/owner/claims` | signed in | `{ claim, verification }` |
| `POST /api/owner/claims/:id/evidence` | claimant, pending claim | multipart `file`, `{ claim }` |
| `GET /api/owner/tasks?claim_id=` | claimant, verified claim | `{ tasks }` |
| `PUT /api/owner/tasks` | claimant, verified claim | `{ task }` |
| `GET /api/owner/admin/claims?status=pending` | admin | `{ claims }`, each with `claimant_email` (primary email from Clerk, or null) and `public_data_mismatch` (empty when the claim matches public data) |
| `POST /api/owner/admin/claims/:id` | admin | `{ claim }`; 409 when approving a claim that does not match public data |
| `GET /api/owner/admin/claims/:id/evidence` | admin | redirect to a 5-minute signed file URL (`?format=json` for `{ url }`); 422 when the file is not a real PDF, PNG or JPG |

Errors are `{ "error": "<sentence>" }` with 400, 401, 403, 404, 409, 413, 422 or 503.

## Checks

- `npm test` runs `tests/verify.test.ts` (domain matching, lookalikes, free-mail,
  unverified email, trusted verification strategies, input and file validation, and
  stored-claim vs public-data checks).
- After setup: sign in at `/owner/sign-in`, claim a plant, confirm the row appears in
  `claims` in the Supabase table editor, then sign in as a second user and confirm the
  first user's claim is not visible.
