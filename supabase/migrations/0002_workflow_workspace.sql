-- Shared, revisioned owner workflows and audit-safe contextual ranking.
-- Auth is Clerk via Supabase third-party JWTs; never accept actor ids from clients.

create table if not exists public.workflow_workspaces (
  id text primary key check (length(id) between 1 and 100),
  owner_user_id text not null check (length(owner_user_id) between 1 and 64),
  is_personal boolean not null default false,
  created_at timestamptz not null default now(),
  constraint workflow_personal_id check (
    (is_personal and id = 'personal:' || owner_user_id) or
    (not is_personal and id not like 'personal:%')
  )
);

create table if not exists public.workflow_workspace_members (
  workspace_id text not null references public.workflow_workspaces(id) on delete cascade,
  user_id text not null check (length(user_id) between 1 and 64),
  role text not null check (role in ('owner', 'editor', 'viewer')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);

create or replace function public.workflow_is_member(p_workspace_id text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workflow_workspace_members m
    where m.workspace_id = p_workspace_id and m.user_id = (select auth.jwt()->>'sub')
  );
$$;

create or replace function public.workflow_can_edit(p_workspace_id text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workflow_workspace_members m
    where m.workspace_id = p_workspace_id
      and m.user_id = (select auth.jwt()->>'sub')
      and m.role in ('owner', 'editor')
  );
$$;

create or replace function public.workflow_is_owner(p_workspace_id text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workflow_workspace_members m
    where m.workspace_id = p_workspace_id
      and m.user_id = (select auth.jwt()->>'sub') and m.role = 'owner'
  );
$$;

revoke all on function public.workflow_is_member(text) from public, anon;
revoke all on function public.workflow_can_edit(text) from public, anon;
revoke all on function public.workflow_is_owner(text) from public, anon;
grant execute on function public.workflow_is_member(text) to authenticated;
grant execute on function public.workflow_can_edit(text) to authenticated;
grant execute on function public.workflow_is_owner(text) to authenticated;

create or replace function public.workflow_add_owner_member()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.workflow_workspace_members(workspace_id, user_id, role)
  values (new.id, new.owner_user_id, 'owner')
  on conflict (workspace_id, user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists workflow_workspace_owner_member on public.workflow_workspaces;
create trigger workflow_workspace_owner_member after insert on public.workflow_workspaces
for each row execute function public.workflow_add_owner_member();

create or replace function public.workflow_personal_workspace()
returns text language plpgsql security definer set search_path = '' as $$
declare
  sub text := (select auth.jwt()->>'sub');
  workspace_id text;
begin
  if sub is null or length(sub) < 1 or length(sub) > 64 then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  workspace_id := 'personal:' || sub;
  insert into public.workflow_workspaces(id, owner_user_id, is_personal)
  values (workspace_id, sub, true)
  on conflict (id) do nothing;
  return workspace_id;
end;
$$;
revoke all on function public.workflow_personal_workspace() from public, anon;
grant execute on function public.workflow_personal_workspace() to authenticated;

alter table public.workflow_workspaces enable row level security;
alter table public.workflow_workspace_members enable row level security;
drop policy if exists "workflow workspaces: members read" on public.workflow_workspaces;
create policy "workflow workspaces: members read" on public.workflow_workspaces
  for select to authenticated using (public.workflow_is_member(id));
drop policy if exists "workflow workspaces: self create" on public.workflow_workspaces;
create policy "workflow workspaces: self create" on public.workflow_workspaces
  for insert to authenticated with check (
    owner_user_id = (select auth.jwt()->>'sub') and
    (is_personal = false or id = 'personal:' || (select auth.jwt()->>'sub'))
  );
drop policy if exists "workflow members: members read" on public.workflow_workspace_members;
create policy "workflow members: members read" on public.workflow_workspace_members
  for select to authenticated using (public.workflow_is_member(workspace_id));
drop policy if exists "workflow members: owner manage" on public.workflow_workspace_members;
create policy "workflow members: owner manage" on public.workflow_workspace_members
  for all to authenticated using (public.workflow_is_owner(workspace_id))
  with check (public.workflow_is_owner(workspace_id));
grant select, insert on public.workflow_workspaces to authenticated;
grant select, insert, update, delete on public.workflow_workspace_members to authenticated;

create table if not exists public.workflow_drafts (
  workspace_id text not null references public.workflow_workspaces(id) on delete cascade,
  area_key text not null check (length(area_key) between 5 and 100),
  revision integer not null check (revision > 0),
  state jsonb not null check (jsonb_typeof(state) = 'object'),
  updated_by text not null check (length(updated_by) between 1 and 64),
  updated_at timestamptz not null default now(),
  primary key (workspace_id, area_key)
);

create table if not exists public.workflow_draft_history (
  workspace_id text not null,
  area_key text not null,
  revision integer not null,
  state jsonb not null check (jsonb_typeof(state) = 'object'),
  updated_by text not null,
  updated_at timestamptz not null,
  primary key (workspace_id, area_key, revision),
  foreign key (workspace_id, area_key)
    references public.workflow_drafts(workspace_id, area_key) on delete cascade
);

create or replace function public.workflow_record_draft_history()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.workflow_draft_history(workspace_id, area_key, revision, state, updated_by, updated_at)
  values (new.workspace_id, new.area_key, new.revision, new.state, new.updated_by, new.updated_at)
  on conflict (workspace_id, area_key, revision) do nothing;
  return new;
end;
$$;
drop trigger if exists workflow_draft_history_insert on public.workflow_drafts;
create trigger workflow_draft_history_insert after insert or update on public.workflow_drafts
for each row execute function public.workflow_record_draft_history();

alter table public.workflow_drafts enable row level security;
alter table public.workflow_draft_history enable row level security;
drop policy if exists "workflow drafts: members read" on public.workflow_drafts;
create policy "workflow drafts: members read" on public.workflow_drafts
  for select to authenticated using (public.workflow_is_member(workspace_id));
drop policy if exists "workflow drafts: editors write" on public.workflow_drafts;
create policy "workflow drafts: editors write" on public.workflow_drafts
  for all to authenticated using (public.workflow_can_edit(workspace_id))
  with check (public.workflow_can_edit(workspace_id));
drop policy if exists "workflow draft history: members read" on public.workflow_draft_history;
create policy "workflow draft history: members read" on public.workflow_draft_history
  for select to authenticated using (public.workflow_is_member(workspace_id));
grant select, insert, update on public.workflow_drafts to authenticated;
grant select on public.workflow_draft_history to authenticated;

create or replace function public.workflow_save_draft(
  p_workspace_id text, p_area_key text, p_expected_revision integer, p_state jsonb
)
returns setof public.workflow_drafts
language plpgsql security definer set search_path = '' as $$
declare
  saved public.workflow_drafts;
  actor text := (select auth.jwt()->>'sub');
begin
  if actor is null or length(actor) < 1 or length(actor) > 64
     or p_expected_revision < 0 or p_expected_revision > 2147483646
     or p_state is null or jsonb_typeof(p_state) <> 'object' or pg_column_size(p_state) > 262144
     or length(p_area_key) < 5 or length(p_area_key) > 100 then
    raise exception 'invalid workflow draft' using errcode = '22023';
  end if;
  if p_workspace_id is null or not public.workflow_can_edit(p_workspace_id) then
    raise exception 'workflow edit permission required' using errcode = '42501';
  end if;

  update public.workflow_drafts d
     set revision = d.revision + 1, state = p_state,
         updated_by = actor, updated_at = now()
   where d.workspace_id = p_workspace_id and d.area_key = p_area_key
     and d.revision = p_expected_revision
  returning d.* into saved;
  if found then return next saved; return; end if;

  if p_expected_revision = 0 then
    insert into public.workflow_drafts(workspace_id, area_key, revision, state, updated_by)
    values (p_workspace_id, p_area_key, 1, p_state, actor)
    returning * into saved;
    return next saved;
  end if;
end;
$$;
revoke all on function public.workflow_save_draft(text, text, integer, jsonb) from public, anon;
grant execute on function public.workflow_save_draft(text, text, integer, jsonb) to authenticated;

create table if not exists public.workflow_impressions (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null references public.workflow_workspaces(id) on delete cascade,
  user_id text not null check (length(user_id) between 1 and 64),
  area_key text not null check (length(area_key) between 5 and 100),
  epoch integer not null check (epoch > 0),
  candidate_ids text[] not null check (cardinality(candidate_ids) between 1 and 20),
  ordered_ids text[] not null check (cardinality(ordered_ids) between 1 and 20),
  ranker_version text not null check (length(ranker_version) between 1 and 40),
  screening_version text not null check (length(screening_version) between 1 and 40),
  screening_gates jsonb not null check (jsonb_typeof(screening_gates) = 'array'),
  context_features jsonb not null check (jsonb_typeof(context_features) = 'object'),
  created_at timestamptz not null default now(),
  unique (workspace_id, id, epoch, ranker_version)
);
create index if not exists workflow_impressions_workspace_recent_idx
  on public.workflow_impressions(workspace_id, created_at desc);
alter table public.workflow_impressions enable row level security;
drop policy if exists "workflow impressions: members read" on public.workflow_impressions;
create policy "workflow impressions: members read" on public.workflow_impressions
  for select to authenticated using (public.workflow_is_member(workspace_id));
revoke insert, update, delete on public.workflow_impressions from authenticated, anon;
grant select on public.workflow_impressions to authenticated;
grant select, insert, update, delete on public.workflow_impressions to service_role;

create table if not exists public.workflow_feedback (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null references public.workflow_workspaces(id) on delete cascade,
  impression_id uuid not null,
  user_id text not null check (length(user_id) between 1 and 64),
  option_id text not null check (length(option_id) between 1 and 100),
  event text not null check (event in ('approve', 'reject', 'export', 'capex')),
  value text check (value is null or length(value) <= 200),
  reward double precision not null check (reward between -1 and 1),
  context_features jsonb not null check (jsonb_typeof(context_features) = 'object'),
  rank_epoch integer not null check (rank_epoch > 0),
  ranker_version text not null check (length(ranker_version) between 1 and 40),
  created_at timestamptz not null default now(),
  unique (workspace_id, user_id, impression_id, option_id),
  foreign key (workspace_id, impression_id, rank_epoch, ranker_version)
    references public.workflow_impressions(workspace_id, id, epoch, ranker_version) on delete cascade
);
create index if not exists workflow_feedback_workspace_recent_idx
  on public.workflow_feedback(workspace_id, created_at desc);

create table if not exists public.workflow_capex_preferences (
  workspace_id text not null references public.workflow_workspaces(id) on delete cascade,
  user_id text not null check (length(user_id) between 1 and 64),
  impression_id uuid not null references public.workflow_impressions(id) on delete cascade,
  option_id text not null check (length(option_id) between 1 and 100),
  value text check (value is null or length(value) <= 200),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id, impression_id, option_id)
);
alter table public.workflow_feedback enable row level security;
alter table public.workflow_capex_preferences enable row level security;
drop policy if exists "workflow feedback: members read" on public.workflow_feedback;
create policy "workflow feedback: members read" on public.workflow_feedback
  for select to authenticated using (public.workflow_is_member(workspace_id));
drop policy if exists "workflow capex: members read" on public.workflow_capex_preferences;
create policy "workflow capex: members read" on public.workflow_capex_preferences
  for select to authenticated using (public.workflow_is_member(workspace_id));
revoke insert, update, delete on public.workflow_feedback, public.workflow_capex_preferences from authenticated, anon;
grant select on public.workflow_feedback, public.workflow_capex_preferences to authenticated;
grant select, insert, update, delete on public.workflow_feedback, public.workflow_capex_preferences to service_role;

create or replace function public.workflow_submit_feedback(
  p_workspace_id text, p_impression_id uuid, p_option_id text, p_event text, p_value text default null
)
returns text language plpgsql security definer set search_path = '' as $$
declare
  actor text := (select auth.jwt()->>'sub');
  impression public.workflow_impressions;
  prior public.workflow_feedback;
  reward_value double precision;
  priority integer;
  prior_priority integer;
begin
  if actor is null or length(actor) < 1 or length(actor) > 64 or not public.workflow_is_member(p_workspace_id) then
    raise exception 'workflow member required' using errcode = '42501';
  end if;
  if p_value is not null and length(p_value) > 200 then
    raise exception 'feedback value too long' using errcode = '22023';
  end if;
  select * into impression from public.workflow_impressions i
   where i.id = p_impression_id and i.workspace_id = p_workspace_id;
  if not found then raise exception 'workflow impression not found' using errcode = '23503'; end if;
  if p_option_id = 'packet' and p_event = 'export' then
    insert into public.workflow_packet_exports(workspace_id, user_id, impression_id, value)
    values (p_workspace_id, actor, p_impression_id, p_value)
    on conflict (workspace_id, user_id, impression_id) do update
      set value = coalesce(excluded.value, workflow_packet_exports.value), created_at = now();
    return 'recorded';
  end if;
  if not (p_option_id = any(impression.candidate_ids)) then
    raise exception 'option was not in impression' using errcode = '22023';
  end if;
  if p_event = 'capex' then
    insert into public.workflow_capex_preferences(workspace_id, user_id, impression_id, option_id, value)
    values (p_workspace_id, actor, p_impression_id, p_option_id, p_value)
    on conflict (workspace_id, user_id, impression_id, option_id) do update
      set value = coalesce(excluded.value, workflow_capex_preferences.value), created_at = now();
    return 'preference_recorded';
  end if;
  reward_value := case p_event when 'approve' then 1.0 when 'reject' then -1.0 when 'export' then 0.25 else null end;
  priority := case p_event when 'reject' then 3 when 'approve' then 2 when 'export' then 1 else 0 end;
  if reward_value is null then raise exception 'unsupported feedback event' using errcode = '22023'; end if;
  select * into prior from public.workflow_feedback f
   where f.workspace_id = p_workspace_id and f.user_id = actor
     and f.impression_id = p_impression_id and f.option_id = p_option_id;
  if found then
    prior_priority := case prior.event when 'reject' then 3 when 'approve' then 2 else 1 end;
    if priority <= prior_priority then return 'duplicate'; end if;
  end if;
  insert into public.workflow_feedback(workspace_id, impression_id, user_id, option_id, event, value, reward, context_features, rank_epoch, ranker_version)
  values (p_workspace_id, p_impression_id, actor, p_option_id, p_event, p_value, reward_value, impression.context_features, impression.epoch, impression.ranker_version)
  on conflict (workspace_id, user_id, impression_id, option_id) do update
    set event = excluded.event, value = excluded.value, reward = excluded.reward,
        context_features = excluded.context_features, rank_epoch = excluded.rank_epoch,
        ranker_version = excluded.ranker_version, created_at = now()
    where (case workflow_feedback.event when 'reject' then 3 when 'approve' then 2 else 1 end) < priority;
  if found then return case when prior.id is null then 'recorded' else 'updated' end; end if;
  return 'duplicate';
end;
$$;
revoke all on function public.workflow_submit_feedback(text, uuid, text, text, text) from public, anon;
grant execute on function public.workflow_submit_feedback(text, uuid, text, text, text) to authenticated;

create table if not exists public.workflow_packet_exports (
  workspace_id text not null references public.workflow_workspaces(id) on delete cascade,
  user_id text not null check (length(user_id) between 1 and 64),
  impression_id uuid not null references public.workflow_impressions(id) on delete cascade,
  value text check (value is null or length(value) <= 200),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id, impression_id)
);
alter table public.workflow_packet_exports enable row level security;
drop policy if exists "workflow packet exports: members read" on public.workflow_packet_exports;
create policy "workflow packet exports: members read" on public.workflow_packet_exports
  for select to authenticated using (public.workflow_is_member(workspace_id));
revoke insert, update, delete on public.workflow_packet_exports from authenticated, anon;
grant select on public.workflow_packet_exports to authenticated;
grant select, insert, update, delete on public.workflow_packet_exports to service_role;

-- Rank controls never delete feedback. Each reset starts a clean epoch; rollback
-- creates a new branch that reads the selected epoch and its saved training lineage.
create table if not exists public.workflow_rank_epochs (
  workspace_id text not null references public.workflow_workspaces(id) on delete cascade,
  epoch integer not null check (epoch > 0),
  action text not null check (action in ('initial', 'reset', 'rollback')),
  parent_epoch integer,
  training_epochs integer[] not null default '{}',
  created_by text not null check (length(created_by) between 1 and 64),
  created_at timestamptz not null default now(),
  primary key (workspace_id, epoch),
  foreign key (workspace_id, parent_epoch)
    references public.workflow_rank_epochs(workspace_id, epoch)
);
create table if not exists public.workflow_rank_state (
  workspace_id text not null references public.workflow_workspaces(id) on delete cascade,
  current_epoch integer not null check (current_epoch > 0),
  updated_by text not null check (length(updated_by) between 1 and 64),
  updated_at timestamptz not null default now(),
  primary key (workspace_id),
  foreign key (workspace_id, current_epoch)
    references public.workflow_rank_epochs(workspace_id, epoch)
);
alter table public.workflow_impressions drop constraint if exists workflow_impressions_rank_epoch_fk;
alter table public.workflow_impressions add constraint workflow_impressions_rank_epoch_fk
  foreign key (workspace_id, epoch)
  references public.workflow_rank_epochs(workspace_id, epoch);
alter table public.workflow_rank_epochs enable row level security;
alter table public.workflow_rank_state enable row level security;
drop policy if exists "workflow rank epochs: members read" on public.workflow_rank_epochs;
create policy "workflow rank epochs: members read" on public.workflow_rank_epochs
  for select to authenticated using (public.workflow_is_member(workspace_id));
drop policy if exists "workflow rank state: members read" on public.workflow_rank_state;
create policy "workflow rank state: members read" on public.workflow_rank_state
  for select to authenticated using (public.workflow_is_member(workspace_id));
grant select on public.workflow_rank_epochs, public.workflow_rank_state to authenticated;
revoke insert, update, delete on public.workflow_rank_epochs, public.workflow_rank_state from authenticated, anon;
grant select, insert, update, delete on public.workflow_rank_epochs, public.workflow_rank_state to service_role;

create or replace function public.workflow_get_rank_epoch(p_workspace_id text)
returns table(current_epoch integer, training_epochs integer[])
language plpgsql security definer set search_path = '' as $$
declare
  actor text := (select auth.jwt()->>'sub');
  current_row public.workflow_rank_state;
begin
  if actor is null or not public.workflow_is_member(p_workspace_id) then
    raise exception 'workflow member required' using errcode = '42501';
  end if;
  insert into public.workflow_rank_epochs(workspace_id, epoch, action, training_epochs, created_by)
  values (p_workspace_id, 1, 'initial', '{}', actor)
  on conflict (workspace_id, epoch) do nothing;
  insert into public.workflow_rank_state(workspace_id, current_epoch, updated_by)
  values (p_workspace_id, 1, actor)
  on conflict (workspace_id) do nothing;
  select * into current_row from public.workflow_rank_state s
   where s.workspace_id = p_workspace_id;
  return query select current_row.current_epoch,
    (select e.training_epochs from public.workflow_rank_epochs e
      where e.workspace_id = p_workspace_id and e.epoch = current_row.current_epoch);
end;
$$;
revoke all on function public.workflow_get_rank_epoch(text) from public, anon;
grant execute on function public.workflow_get_rank_epoch(text) to authenticated;

create or replace function public.workflow_control_rank(
  p_workspace_id text, p_action text, p_target_epoch integer default null
)
returns table(current_epoch integer, training_epochs integer[])
language plpgsql security definer set search_path = '' as $$
declare
  actor text := (select auth.jwt()->>'sub');
  prior public.workflow_rank_state;
  target public.workflow_rank_epochs;
  next_epoch integer;
  lineage integer[];
begin
  if actor is null or not public.workflow_is_owner(p_workspace_id) then
    raise exception 'workflow owner required' using errcode = '42501';
  end if;
  if p_action not in ('reset', 'rollback') then
    raise exception 'invalid rank control' using errcode = '22023';
  end if;
  perform * from public.workflow_get_rank_epoch(p_workspace_id);
  select * into prior from public.workflow_rank_state s
   where s.workspace_id = p_workspace_id for update;
  next_epoch := prior.current_epoch + 1;
  if p_action = 'reset' then
    lineage := '{}';
  else
    if p_target_epoch is null or p_target_epoch = prior.current_epoch then
      raise exception 'invalid rollback target' using errcode = '22023';
    end if;
    select * into target from public.workflow_rank_epochs e
     where e.workspace_id = p_workspace_id and e.epoch = p_target_epoch;
    if not found then raise exception 'rank epoch not found' using errcode = 'P0002'; end if;
    lineage := array_append(target.training_epochs, target.epoch);
  end if;
  insert into public.workflow_rank_epochs(workspace_id, epoch, action, parent_epoch, training_epochs, created_by)
  values (p_workspace_id, next_epoch, p_action,
    case when p_action = 'rollback' then p_target_epoch else prior.current_epoch end, lineage, actor);
  update public.workflow_rank_state s set current_epoch = next_epoch, updated_by = actor, updated_at = now()
   where s.workspace_id = p_workspace_id;
  return query select next_epoch, lineage;
end;
$$;
revoke all on function public.workflow_control_rank(text, text, integer) from public, anon;
grant execute on function public.workflow_control_rank(text, text, integer) to authenticated;

/* The RPC validates membership, impression and candidate before writing. */
create or replace function public.workflow_feedback_guard()
returns trigger language plpgsql set search_path = '' as $$
declare
  impression public.workflow_impressions;
begin
  new.user_id := (select auth.jwt()->>'sub');
  if new.user_id is null or not public.workflow_is_member(new.workspace_id) then
    raise exception 'workflow member required' using errcode = '42501';
  end if;
  select * into impression from public.workflow_impressions i
   where i.id = new.impression_id and i.workspace_id = new.workspace_id;
  if not found then raise exception 'workflow impression not found' using errcode = '23503'; end if;
  if not (new.option_id = any(impression.candidate_ids)) and not (new.option_id = 'packet' and new.event = 'export') then
    raise exception 'option was not in impression' using errcode = '22023';
  end if;
  new.context_features := impression.context_features;
  new.reward := case new.event when 'approve' then 1.0 when 'reject' then -1.0 when 'export' then 0.25 when 'capex' then 0 end;
  new.created_at := now();
  return new;
end;
$$;
drop trigger if exists workflow_feedback_guard_insert on public.workflow_feedback;
create trigger workflow_feedback_guard_insert before insert on public.workflow_feedback
for each row execute function public.workflow_feedback_guard();

alter table public.workflow_feedback enable row level security;

-- Draft writes must pass through the compare-and-swap RPC so every update increments
-- the revision, records the authenticated actor and creates an immutable history row.
revoke insert, update on public.workflow_drafts from authenticated, anon;
