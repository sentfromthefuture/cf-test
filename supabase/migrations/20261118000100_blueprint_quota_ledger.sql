-- Blueprint has its own daily quota ledger. It deliberately does not reuse Gemini PRD tables.
-- A reservation represents one complete blueprint (all three passes), not one model call.
create table if not exists public.dr_blueprint_usage (
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  committed integer not null default 0 check (committed >= 0),
  primary key (user_id, day)
);

create table if not exists public.dr_blueprint_reservations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  request_key text not null check (length(request_key) between 8 and 128),
  status text not null default 'reserved' check (status in ('reserved', 'committed', 'released')),
  expires_at timestamptz not null default (now() + interval '30 minutes'),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (user_id, day, request_key)
);

create index if not exists dr_blueprint_reservations_user_day_idx
  on public.dr_blueprint_reservations (user_id, day, status, expires_at);

alter table public.dr_blueprint_usage enable row level security;
alter table public.dr_blueprint_reservations enable row level security;
revoke all on public.dr_blueprint_usage, public.dr_blueprint_reservations from public, anon, authenticated;
grant all on public.dr_blueprint_usage, public.dr_blueprint_reservations to service_role;

-- Serializes quota checks per user/day. Idempotent retries with the same request key return
-- the existing live reservation rather than consuming another slot.
create or replace function public.dr_blueprint_reserve(
  p_user uuid, p_request_key text, p_daily_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_day date := (now() at time zone 'utc')::date;
  v_used integer := 0;
  v_pending integer := 0;
  v_existing public.dr_blueprint_reservations%rowtype;
  v_id uuid;
begin
  if p_user is null or p_request_key is null or length(p_request_key) < 8
     or length(p_request_key) > 128 or p_daily_limit is null or p_daily_limit < 1 then
    raise exception 'invalid Blueprint quota reservation arguments';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user::text || ':' || v_day::text, 0));

  select * into v_existing
    from public.dr_blueprint_reservations
   where user_id = p_user and day = v_day and request_key = p_request_key
   for update;

  if found and v_existing.status = 'reserved' and v_existing.expires_at > now() then
    return jsonb_build_object('status', 'reserved', 'reservation_id', v_existing.id, 'reused', true);
  end if;
  if found and v_existing.status = 'committed' then
    return jsonb_build_object('status', 'committed', 'reservation_id', v_existing.id, 'reused', true);
  end if;

  update public.dr_blueprint_reservations
     set status = 'released'
   where user_id = p_user and day = v_day and status = 'reserved' and expires_at <= now();

  select committed into v_used
    from public.dr_blueprint_usage where user_id = p_user and day = v_day;
  v_used := coalesce(v_used, 0);

  select count(*) into v_pending
    from public.dr_blueprint_reservations
   where user_id = p_user and day = v_day and status = 'reserved' and expires_at > now();

  if v_used + v_pending >= p_daily_limit then
    return jsonb_build_object('status', 'limit_reached');
  end if;

  insert into public.dr_blueprint_reservations (user_id, day, request_key)
  values (p_user, v_day, p_request_key)
  on conflict (user_id, day, request_key) do update
    set status = 'reserved', expires_at = now() + interval '30 minutes', completed_at = null
  returning id into v_id;

  return jsonb_build_object('status', 'reserved', 'reservation_id', v_id, 'reused', false);
end;
$$;

create or replace function public.dr_blueprint_commit(p_reservation uuid)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_user uuid;
  v_day date;
  v_status text;
begin
  select user_id, day, status into v_user, v_day, v_status
    from public.dr_blueprint_reservations
   where id = p_reservation and expires_at > now()
   for update;

  if not found then return false; end if;
  if v_status = 'committed' then return true; end if;
  if v_status <> 'reserved' then return false; end if;

  perform pg_advisory_xact_lock(hashtextextended(v_user::text || ':' || v_day::text, 0));

  insert into public.dr_blueprint_usage (user_id, day, committed)
  values (v_user, v_day, 1)
  on conflict (user_id, day) do update
    set committed = public.dr_blueprint_usage.committed + 1;

  update public.dr_blueprint_reservations
     set status = 'committed', completed_at = now()
   where id = p_reservation;
  return true;
end;
$$;

create or replace function public.dr_blueprint_release(p_reservation uuid)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_count integer;
begin
  update public.dr_blueprint_reservations
     set status = 'released', completed_at = now()
   where id = p_reservation and status = 'reserved';
  get diagnostics v_count = row_count;
  return v_count > 0;
end;
$$;

revoke all on function public.dr_blueprint_reserve(uuid, text, integer) from public, anon, authenticated;
revoke all on function public.dr_blueprint_commit(uuid) from public, anon, authenticated;
revoke all on function public.dr_blueprint_release(uuid) from public, anon, authenticated;
grant execute on function public.dr_blueprint_reserve(uuid, text, integer) to service_role;
grant execute on function public.dr_blueprint_commit(uuid) to service_role;
grant execute on function public.dr_blueprint_release(uuid) to service_role;
