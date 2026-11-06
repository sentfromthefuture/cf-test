-- DemandRadar Phase 5: reserve AI brief quota while generation is in flight.
-- Ensure the billing/usage tables exist on environments bootstrapped from repository migrations.
create table if not exists public.ai_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null default ((now() at time zone 'utc')::date),
  count integer not null default 0,
  primary key (user_id, day)
);

create table if not exists public.subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,
  plan text not null default 'Free',
  status text not null default 'inactive',
  dodo_customer_id text,
  dodo_subscription_id text,
  current_period_end timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.webhook_events (
  event_id text primary key,
  type text,
  received_at timestamptz not null default now()
);

alter table public.ai_usage enable row level security;
alter table public.subscriptions enable row level security;
alter table public.webhook_events enable row level security;
revoke all on public.ai_usage, public.subscriptions, public.webhook_events from public, anon, authenticated;
grant all on public.ai_usage, public.subscriptions, public.webhook_events to service_role;

-- A reservation counts against the daily limit, but only a successful generation is committed.
create table if not exists public.ai_usage_reservations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null default ((now() at time zone 'utc')::date),
  expires_at timestamptz not null default (now() + interval '20 minutes'),
  created_at timestamptz not null default now()
);

create index if not exists ai_usage_reservations_user_day_idx
  on public.ai_usage_reservations (user_id, day, expires_at);

alter table public.ai_usage_reservations enable row level security;
revoke all on public.ai_usage_reservations from public, anon, authenticated;
grant all on public.ai_usage_reservations to service_role;

-- Serialize quota decisions per user/day so concurrent requests cannot oversubscribe.
create or replace function public.reserve_brief(p_user uuid, p_limit integer)
returns uuid
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_day date := (now() at time zone 'utc')::date;
  v_used integer;
  v_pending integer;
  v_id uuid;
begin
  if p_user is null or p_limit is null or p_limit < 1 then
    raise exception 'invalid quota reservation arguments';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user::text || ':' || v_day::text, 0));

  delete from public.ai_usage_reservations
   where user_id = p_user and day = v_day and expires_at <= now();

  select coalesce(count, 0) into v_used
    from public.ai_usage where user_id = p_user and day = v_day;
  v_used := coalesce(v_used, 0);

  select count(*) into v_pending
    from public.ai_usage_reservations
   where user_id = p_user and day = v_day and expires_at > now();

  if v_used + v_pending >= p_limit then
    return null;
  end if;

  insert into public.ai_usage_reservations (user_id, day)
  values (p_user, v_day)
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.commit_brief(p_reservation uuid)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user uuid;
  v_day date;
begin
  select user_id, day into v_user, v_day
    from public.ai_usage_reservations
   where id = p_reservation and expires_at > now()
   for update;

  if not found then
    return false;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user::text || ':' || v_day::text, 0));

  insert into public.ai_usage (user_id, day, count)
  values (v_user, v_day, 1)
  on conflict (user_id, day)
  do update set count = public.ai_usage.count + 1;

  delete from public.ai_usage_reservations where id = p_reservation;
  return true;
end;
$$;

create or replace function public.release_brief(p_reservation uuid)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_deleted integer;
begin
  delete from public.ai_usage_reservations where id = p_reservation;
  get diagnostics v_deleted = row_count;
  return v_deleted > 0;
end;
$$;

-- These RPCs are server-only. The caller must authenticate the user before invoking them.
revoke all on function public.reserve_brief(uuid, integer) from public, anon, authenticated;
revoke all on function public.commit_brief(uuid) from public, anon, authenticated;
revoke all on function public.release_brief(uuid) from public, anon, authenticated;
grant execute on function public.reserve_brief(uuid, integer) to service_role;
grant execute on function public.commit_brief(uuid) to service_role;
grant execute on function public.release_brief(uuid) to service_role;

-- Retire direct invocation of the older arbitrary-user quota increment RPC when present.
do $block$
begin
  if to_regprocedure('public.consume_brief(uuid,integer)') is not null then
    execute 'revoke all on function public.consume_brief(uuid, integer) from public, anon, authenticated';
    execute 'grant execute on function public.consume_brief(uuid, integer) to service_role';
  end if;
end;
$block$;
