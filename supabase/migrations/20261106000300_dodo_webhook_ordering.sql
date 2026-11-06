-- Prevent delayed/retried Dodo subscription events from overwriting newer state.
-- Dodo's envelope timestamp is the time the event occurred (not delivery time).
alter table public.subscriptions
  add column if not exists dodo_event_timestamp timestamptz;

comment on column public.subscriptions.dodo_event_timestamp is
  'Timestamp of the newest Dodo subscription event applied to this row. Used to reject stale webhook deliveries.';

create or replace function public.apply_dodo_subscription_event(
  p_user uuid,
  p_plan text,
  p_status text,
  p_customer_id text,
  p_subscription_id text,
  p_period_end timestamptz,
  p_event_timestamp timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_applied boolean := false;
begin
  if p_user is null
     or nullif(p_plan, '') is null
     or nullif(p_status, '') is null
     or p_event_timestamp is null then
    raise exception 'invalid Dodo subscription event arguments';
  end if;

  insert into public.subscriptions (
    user_id,
    plan,
    status,
    dodo_customer_id,
    dodo_subscription_id,
    current_period_end,
    dodo_event_timestamp,
    updated_at
  )
  values (
    p_user,
    p_plan,
    p_status,
    p_customer_id,
    p_subscription_id,
    p_period_end,
    p_event_timestamp,
    now()
  )
  on conflict (user_id) do update
    set plan = excluded.plan,
        status = excluded.status,
        dodo_customer_id = coalesce(excluded.dodo_customer_id, public.subscriptions.dodo_customer_id),
        dodo_subscription_id = coalesce(excluded.dodo_subscription_id, public.subscriptions.dodo_subscription_id),
        current_period_end = coalesce(excluded.current_period_end, public.subscriptions.current_period_end),
        dodo_event_timestamp = excluded.dodo_event_timestamp,
        updated_at = now()
    where public.subscriptions.dodo_event_timestamp is null
       or excluded.dodo_event_timestamp > public.subscriptions.dodo_event_timestamp
  returning true into v_applied;

  return coalesce(v_applied, false);
end;
$$;

revoke all on function public.apply_dodo_subscription_event(uuid, text, text, text, text, timestamptz, timestamptz)
  from public, anon, authenticated;
grant execute on function public.apply_dodo_subscription_event(uuid, text, text, text, text, timestamptz, timestamptz)
  to service_role;
