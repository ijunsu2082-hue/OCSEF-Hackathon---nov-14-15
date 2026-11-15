-- Mapergy owner portal: claims, tasks, admins, evidence storage.
-- Auth: Clerk session tokens via Supabase third-party auth. The Clerk user id is the
-- JWT "sub" claim, read with auth.jwt()->>'sub'. Shapes match lib/owner/types.ts.
-- Run once in the Supabase SQL editor (or `supabase db push`). Safe to re-run.

-- ---------------------------------------------------------------- admins

create table if not exists public.admins (
  user_id    text primary key check (length(user_id) between 1 and 64),
  created_at timestamptz not null default now()
);

alter table public.admins enable row level security;

-- Is the requesting user an admin? security definer so policies can call it without
-- needing read access to every admins row.
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.admins a where a.user_id = (select auth.jwt()->>'sub')
  );
$$;

revoke all on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated;

drop policy if exists "admins: read own row" on public.admins;
create policy "admins: read own row"
  on public.admins for select to authenticated
  using (user_id = (select auth.jwt()->>'sub'));
-- No insert/update/delete policies: add admins in the SQL editor (see docs/OWNER_PORTAL.md).

-- ---------------------------------------------------------------- claims

create table if not exists public.claims (
  id            uuid primary key default gen_random_uuid(),
  user_id       text not null default (auth.jwt()->>'sub') check (length(user_id) between 1 and 64),
  asset_kind    text not null check (asset_kind in ('plant', 'substation', 'line')),
  asset_id      text not null,
  asset_name    text not null check (length(asset_name) between 1 and 200),
  owner_name    text not null default '' check (length(owner_name) <= 200),
  method        text not null check (method in ('email_domain', 'document')),
  status        text not null default 'pending' check (status in ('pending', 'verified', 'rejected')),
  evidence_path text,
  note          text check (note is null or length(note) <= 500),
  decided_by    text check (decided_by is null or length(decided_by) <= 64),
  decided_at    timestamptz,
  reason        text check (reason is null or length(reason) <= 500),
  created_at    timestamptz not null default now(),
  constraint claims_asset_id_format check (
       (asset_kind = 'plant'      and asset_id ~ '^[1-9][0-9]{0,6}$')
    or (asset_kind = 'line'       and asset_id ~ '^[1-9][0-9]{0,14}$')
    or (asset_kind = 'substation' and asset_id ~ '^(node|way|relation)/[1-9][0-9]{0,14}$')
  ),
  constraint claims_evidence_in_own_folder check (
    evidence_path is null
    or (length(evidence_path) <= 400 and starts_with(evidence_path, user_id || '/' || id::text || '/'))
  ),
  constraint claims_decided_when_final check (status = 'pending' or decided_at is not null)
);

-- One open (pending or verified) claim per user per asset. Rejected claims can be re-filed.
create unique index if not exists claims_one_active_per_user_asset
  on public.claims (user_id, asset_kind, asset_id)
  where status in ('pending', 'verified');
create index if not exists claims_user_idx on public.claims (user_id);
create index if not exists claims_status_idx on public.claims (status, created_at);

alter table public.claims enable row level security;

-- Guard: users can never set status/decided_*/reason or change what was claimed.
-- Admins can only move pending -> verified/rejected, never on their own claim, and
-- decided_by/decided_at are stamped here from the token, not from the request.
-- Requests made with the service key (server only) or from the SQL editor skip the guard.
create or replace function public.claims_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  sub text := (select auth.jwt()->>'sub');
begin
  if current_user not in ('authenticated', 'anon') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    new.user_id       := sub;
    new.status        := 'pending';
    new.decided_by    := null;
    new.decided_at    := null;
    new.reason        := null;
    new.evidence_path := null;
    new.created_at    := now();
    return new;
  end if;

  if new.id <> old.id or new.user_id <> old.user_id or new.asset_kind <> old.asset_kind
     or new.asset_id <> old.asset_id or new.asset_name <> old.asset_name
     or new.owner_name <> old.owner_name or new.method <> old.method
     or new.created_at <> old.created_at then
    raise exception 'claim details cannot be changed' using errcode = '42501';
  end if;

  if new.status is distinct from old.status
     or new.reason is distinct from old.reason
     or new.decided_by is distinct from old.decided_by
     or new.decided_at is distinct from old.decided_at then
    if not public.is_admin() then
      raise exception 'only admins can decide claims' using errcode = '42501';
    end if;
    if old.user_id = sub then
      raise exception 'admins cannot decide their own claims' using errcode = '42501';
    end if;
    if old.status <> 'pending' or new.status not in ('verified', 'rejected') then
      raise exception 'only pending claims can be decided' using errcode = '42501';
    end if;
    new.decided_by := sub;
    new.decided_at := now();
  end if;

  if new.evidence_path is distinct from old.evidence_path or new.note is distinct from old.note then
    if old.user_id <> sub then
      raise exception 'only the claimant can change evidence or note' using errcode = '42501';
    end if;
    if old.status <> 'pending' then
      raise exception 'evidence can only be added while a claim is pending' using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists claims_guard on public.claims;
create trigger claims_guard
  before insert or update on public.claims
  for each row execute function public.claims_guard();

drop policy if exists "claims: owner reads own" on public.claims;
create policy "claims: owner reads own"
  on public.claims for select to authenticated
  using (user_id = (select auth.jwt()->>'sub'));

drop policy if exists "claims: owner inserts own pending" on public.claims;
create policy "claims: owner inserts own pending"
  on public.claims for insert to authenticated
  with check (
    user_id = (select auth.jwt()->>'sub')
    and status = 'pending'
    and decided_by is null and decided_at is null and reason is null
  );

drop policy if exists "claims: owner updates own pending" on public.claims;
create policy "claims: owner updates own pending"
  on public.claims for update to authenticated
  using (user_id = (select auth.jwt()->>'sub') and status = 'pending')
  with check (user_id = (select auth.jwt()->>'sub'));

drop policy if exists "claims: admins read all" on public.claims;
create policy "claims: admins read all"
  on public.claims for select to authenticated
  using ((select public.is_admin()));

drop policy if exists "claims: admins decide" on public.claims;
create policy "claims: admins decide"
  on public.claims for update to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

-- ---------------------------------------------------------------- tasks

create table if not exists public.tasks (
  id            uuid primary key default gen_random_uuid(),
  claim_id      uuid not null references public.claims (id) on delete cascade,
  obligation_id text not null check (obligation_id ~ '^[a-z0-9][a-z0-9._-]{0,79}$'),
  due           date not null,
  status        text not null default 'not_started' check (status in ('not_started', 'in_progress', 'filed')),
  filed_at      timestamptz,
  confirmation  text check (confirmation is null or length(confirmation) <= 100),
  note          text check (note is null or length(note) <= 1000),
  updated_at    timestamptz not null default now(),
  constraint tasks_one_per_deadline unique (claim_id, obligation_id, due),
  constraint tasks_filed_at_matches_status check ((status = 'filed') = (filed_at is not null))
);

create index if not exists tasks_claim_idx on public.tasks (claim_id, due);

alter table public.tasks enable row level security;

-- updated_at and filed_at are set here, not by the client.
create or replace function public.tasks_touch()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and new.claim_id <> old.claim_id then
    raise exception 'a task cannot move to another claim' using errcode = '42501';
  end if;
  new.updated_at := now();
  if new.status = 'filed' then
    if tg_op = 'UPDATE' and old.status = 'filed' and old.filed_at is not null then
      new.filed_at := old.filed_at;
    else
      new.filed_at := now();
    end if;
  else
    new.filed_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists tasks_touch on public.tasks;
create trigger tasks_touch
  before insert or update on public.tasks
  for each row execute function public.tasks_touch();

-- Tasks exist only for the user's own VERIFIED claims.
drop policy if exists "tasks: owner reads" on public.tasks;
create policy "tasks: owner reads"
  on public.tasks for select to authenticated
  using (exists (
    select 1 from public.claims c
    where c.id = tasks.claim_id and c.user_id = (select auth.jwt()->>'sub') and c.status = 'verified'
  ));

drop policy if exists "tasks: owner inserts" on public.tasks;
create policy "tasks: owner inserts"
  on public.tasks for insert to authenticated
  with check (exists (
    select 1 from public.claims c
    where c.id = tasks.claim_id and c.user_id = (select auth.jwt()->>'sub') and c.status = 'verified'
  ));

drop policy if exists "tasks: owner updates" on public.tasks;
create policy "tasks: owner updates"
  on public.tasks for update to authenticated
  using (exists (
    select 1 from public.claims c
    where c.id = tasks.claim_id and c.user_id = (select auth.jwt()->>'sub') and c.status = 'verified'
  ))
  with check (exists (
    select 1 from public.claims c
    where c.id = tasks.claim_id and c.user_id = (select auth.jwt()->>'sub') and c.status = 'verified'
  ));

-- ---------------------------------------------------------------- grants

revoke all on public.admins, public.claims, public.tasks from anon;
-- Supabase's default privileges give authenticated ALL on new public tables; take that back
-- (DELETE, TRUNCATE, TRIGGER, REFERENCES) and grant only what the API needs.
revoke all on public.admins, public.claims, public.tasks from authenticated;
grant select on public.admins to authenticated;
grant select, insert, update on public.claims to authenticated;
grant select, insert, update on public.tasks to authenticated;
grant select, insert, update on public.admins, public.claims, public.tasks to service_role;

-- ---------------------------------------------------------------- storage: claim evidence

-- Private bucket. 5 MB limit and PDF/PNG/JPEG only (the API checks the same rules).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('claim-evidence', 'claim-evidence', false, 5242880, array['application/pdf', 'image/png', 'image/jpeg'])
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- Paths are <user_id>/<claim_id>/<file name>.
-- Owners upload only into their own folder, for their own pending claim.
drop policy if exists "claim-evidence: owner uploads to own folder" on storage.objects;
create policy "claim-evidence: owner uploads to own folder"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'claim-evidence'
    and (storage.foldername(name))[1] = (select auth.jwt()->>'sub')
    and exists (
      select 1 from public.claims c
      where c.id::text = (storage.foldername(name))[2]
        and c.user_id = (select auth.jwt()->>'sub')
        and c.status = 'pending'
    )
  );

drop policy if exists "claim-evidence: owner reads own folder" on storage.objects;
create policy "claim-evidence: owner reads own folder"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'claim-evidence'
    and (storage.foldername(name))[1] = (select auth.jwt()->>'sub')
  );

drop policy if exists "claim-evidence: admins read" on storage.objects;
create policy "claim-evidence: admins read"
  on storage.objects for select to authenticated
  using (bucket_id = 'claim-evidence' and (select public.is_admin()));
