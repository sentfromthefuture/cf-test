-- Atomically persist a completed Blueprint and commit its one-per-blueprint quota reservation.
-- This avoids both uncharged completed results and charged reservations without a saved result.
create or replace function public.dr_blueprint_finalize(
  p_reservation uuid,
  p_user uuid,
  p_cluster uuid,
  p_request_key_hash text,
  p_request_params jsonb,
  p_schema_version text,
  p_model text,
  p_config_version text,
  p_evidence_pack_sha256 text,
  p_blueprint jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_day date;
  v_status text;
  v_request_key text;
  v_result_id uuid;
  v_created_at timestamptz;
begin
  if p_reservation is null or p_user is null or p_cluster is null
     or p_request_key_hash is null or p_request_key_hash !~ '^[a-f0-9]{64}$'
     or p_evidence_pack_sha256 is null or p_evidence_pack_sha256 !~ '^[a-f0-9]{64}$'
     or p_schema_version <> 'product-blueprint.v1'
     or p_model is null or p_model !~ '^[a-z0-9][a-z0-9._-]*/[a-z0-9][a-z0-9._-]*:free$'
     or p_config_version is null or length(p_config_version) < 1
     or jsonb_typeof(p_request_params) <> 'object'
     or jsonb_typeof(p_blueprint) <> 'object'
     or p_blueprint #>> '{meta,contract_version}' <> 'product-blueprint.v1'
     or p_blueprint #>> '{meta,evidence_pack,pack_sha256}' <> p_evidence_pack_sha256 then
    raise exception 'invalid Blueprint finalization arguments';
  end if;

  -- Match reserve/commit lock ordering: advisory user/day lock before reservation row lock.
  select day into v_day
    from public.dr_blueprint_reservations
   where id = p_reservation and user_id = p_user;

  if not found then
    raise exception 'Blueprint reservation not found';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(p_user::text || ':' || v_day::text, 0));

  select status, request_key into v_status, v_request_key
    from public.dr_blueprint_reservations
   where id = p_reservation and user_id = p_user
   for update;

  if not found or v_request_key <> p_request_key_hash then
    raise exception 'Blueprint reservation identity mismatch';
  end if;

  if v_status = 'committed' then
    select id, created_at into v_result_id, v_created_at
      from public.dr_blueprints
     where user_id = p_user and cluster_id = p_cluster
       and request_key_hash = p_request_key_hash;
    if not found then
      raise exception 'committed Blueprint reservation has no result';
    end if;
    return jsonb_build_object('status', 'completed', 'id', v_result_id, 'created_at', v_created_at);
  end if;

  if v_status <> 'reserved'
     or not exists (
       select 1 from public.dr_blueprint_reservations
        where id = p_reservation and expires_at > now()
     ) then
    raise exception 'Blueprint reservation is not active';
  end if;

  insert into public.dr_blueprints (
    user_id, cluster_id, request_key_hash, request_params, schema_version,
    model, config_version, evidence_pack_sha256, blueprint
  ) values (
    p_user, p_cluster, p_request_key_hash, p_request_params, p_schema_version,
    p_model, p_config_version, p_evidence_pack_sha256, p_blueprint
  )
  on conflict (user_id, cluster_id, request_key_hash) do nothing
  returning id, created_at into v_result_id, v_created_at;

  if v_result_id is null then
    raise exception 'Blueprint result already exists without a committed reservation';
  end if;

  insert into public.dr_blueprint_usage (user_id, day, committed)
  values (p_user, v_day, 1)
  on conflict (user_id, day) do update
    set committed = public.dr_blueprint_usage.committed + 1;

  update public.dr_blueprint_reservations
     set status = 'committed', completed_at = now()
   where id = p_reservation;

  return jsonb_build_object('status', 'completed', 'id', v_result_id, 'created_at', v_created_at);
end;
$$;

revoke all on function public.dr_blueprint_finalize(uuid, uuid, uuid, text, jsonb, text, text, text, text, jsonb)
  from public, anon, authenticated;
grant execute on function public.dr_blueprint_finalize(uuid, uuid, uuid, text, jsonb, text, text, text, text, jsonb)
  to service_role;
