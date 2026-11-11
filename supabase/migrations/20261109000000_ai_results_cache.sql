-- DemandRadar AI architecture (Decisions Fast + optional LFM3 summaries):
-- persistent AI result cache, AI usage counters, per-signal model outputs and a read-only cluster evidence profile.
--
-- ADDITIVE ONLY with respect to everything that exists on main. This file creates new tables and new functions. It does not alter, drop or
-- replace any pre-existing table, column, constraint or function (in particular dr_save_signals and dr_refresh_clusters are untouched, so
-- existing scoring and rankings do not change), and it does not read or modify existing rows.
-- Like every dr_* object: RLS is enabled with NO policies and the functions are executable by service_role only.
-- Nothing here calls any external service.

-- ================================================================= tables
-- One row per (task, input, model, config version). Only status = 'succeeded' rows ever hold a result.
--   pending   a worker holds a lease and is computing it (prevents duplicate concurrent processing). Every lease carries a
--             FENCING TOKEN (lease_epoch); complete/fail/abandon only act for the holder of the CURRENT token, so a worker whose
--             lease expired and was taken over can no longer finish, fail or release the entry
--   succeeded validated result stored; reused forever until the identity changes (see invalidation rules in docs/AI_ARCHITECTURE.md)
--   failed    the INPUT produced an unusable answer (invalid/refused/bad request); no result stored; retried only after a growing cooldown
create table if not exists public.dr_ai_cache (
  id              uuid primary key default gen_random_uuid(),
  task            text not null check (task in ('decisions', 'summary')),
  input_hash      text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  model           text not null,
  config_version  text not null,
  status          text not null default 'pending' check (status in ('pending', 'succeeded', 'failed')),
  lease_until     timestamptz,
  lease_epoch     bigint not null default 0,   -- fencing token: incremented every time a lease is issued
  result          jsonb,
  citations       jsonb not null default '[]'::jsonb,
  usage           jsonb not null default '{}'::jsonb,
  hit_count       integer not null default 0,
  failed_attempts integer not null default 0,
  retry_after     timestamptz,
  last_failure    text,
  created_at      timestamptz not null default now(),
  completed_at    timestamptz,
  last_hit_at     timestamptz,
  constraint dr_ai_cache_identity unique (task, input_hash, model, config_version),
  constraint dr_ai_cache_succeeded_has_result check (status <> 'succeeded' or (result is not null and jsonb_typeof(result) = 'object')),
  constraint dr_ai_cache_only_succeeded_has_result check (status = 'succeeded' or result is null)
);
-- Upgrade safety: a database that already ran the FIRST revision of this migration has dr_ai_cache without the fencing column and the three
-- unfenced function signatures that revision created. Add the column, and remove ONLY those superseded signatures (they exist nowhere else:
-- they were never on main and nothing pre-existing depends on them) so an unfenced complete/fail/abandon can never be called.
alter table public.dr_ai_cache add column if not exists lease_epoch bigint not null default 0;
drop function if exists public.dr_ai_cache_complete(uuid, jsonb, jsonb, jsonb);
drop function if exists public.dr_ai_cache_fail(uuid, text);
drop function if exists public.dr_ai_cache_abandon(uuid);

create index if not exists dr_ai_cache_housekeeping_idx on public.dr_ai_cache (status, coalesce(last_hit_at, completed_at, created_at));

-- Per-engine, per-day counters (live calls, outcomes, cache effectiveness, tokens, provider-REPORTED cost).
-- reported_cost_usd is only what the provider said; cost_reported_calls shows how many calls reported one, because
-- a missing cost is unknown, not zero.
create table if not exists public.dr_ai_usage (
  engine              text not null check (engine in ('decisions', 'summary')),
  day                 date not null default (now() at time zone 'utc')::date,
  calls               bigint not null default 0,   -- live (non-cache) attempts
  successes           bigint not null default 0,
  failures            bigint not null default 0,
  rate_limited        bigint not null default 0,
  http_requests       bigint not null default 0,   -- includes retries; retries = http_requests - calls
  cache_hits          bigint not null default 0,
  cache_misses        bigint not null default 0,
  input_tokens        bigint not null default 0,
  output_tokens       bigint not null default 0,
  reported_cost_usd   numeric(18, 8) not null default 0,
  cost_reported_calls bigint not null default 0,
  duration_ms         bigint not null default 0,
  primary key (engine, day)
);

-- Model outputs for a signal, kept apart from dr_problem_signals so that model confidence can never leak into demand data.
create table if not exists public.dr_signal_ai (
  record_id           uuid primary key references public.dr_raw_records (id) on delete cascade,
  cache_id            uuid references public.dr_ai_cache (id) on delete set null,
  input_hash          text,
  model               text,                 -- exact build that answered, as reported by the provider
  requested_model     text,
  config_version      text not null,
  problem_probability numeric not null check (problem_probability between 0 and 1),
  model_confidence    numeric check (model_confidence between 0 and 1),   -- the model's self-assessment. NOT demand evidence.
  answers             jsonb not null default '{}'::jsonb,
  citations           jsonb not null default '[]'::jsonb,                 -- provider sources for the whole request
  evaluated_at        timestamptz not null default now()
);
create index if not exists dr_signal_ai_cache_idx on public.dr_signal_ai (cache_id);

alter table public.dr_ai_cache enable row level security;
alter table public.dr_ai_usage enable row level security;
alter table public.dr_signal_ai enable row level security;
revoke all on public.dr_ai_cache, public.dr_ai_usage, public.dr_signal_ai from anon, authenticated;

-- ================================================================= cache state machine
-- Atomically decides what the caller may do for this identity:
--   hit       a validated result exists (returned)
--   claimed   caller now holds the lease (returned with its fencing 'epoch') and must compute, then complete / fail / abandon
--             presenting that epoch
--   busy      another worker holds a fresh lease: do NOT call the model
--   cooldown  an earlier attempt on this input failed; do not retry before retry_after
create or replace function public.dr_ai_cache_begin(
  p_task text, p_hash text, p_model text, p_version text, p_lease_seconds integer default 120)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare
  v public.dr_ai_cache%rowtype;
  v_epoch bigint;
  v_lease interval := make_interval(secs => least(greatest(coalesce(p_lease_seconds, 120), 10), 900));
begin
  insert into public.dr_ai_cache (task, input_hash, model, config_version, status, lease_until, lease_epoch)
  values (p_task, p_hash, p_model, p_version, 'pending', now() + v_lease, 1)
  on conflict (task, input_hash, model, config_version) do nothing
  returning * into v;
  if v.id is not null then
    return jsonb_build_object('state', 'claimed', 'id', v.id, 'epoch', v.lease_epoch);
  end if;

  -- Row-lock so two concurrent callers cannot both decide to take over the same expired lease.
  select * into v from public.dr_ai_cache
   where task = p_task and input_hash = p_hash and model = p_model and config_version = p_version
   for update;
  if not found then
    return jsonb_build_object('state', 'busy');   -- removed between the two statements; the next run will claim it
  end if;

  if v.status = 'succeeded' then
    update public.dr_ai_cache set hit_count = hit_count + 1, last_hit_at = now() where id = v.id;
    return jsonb_build_object('state', 'hit', 'id', v.id, 'result', v.result, 'citations', v.citations, 'usage', v.usage);
  end if;
  if v.status = 'failed' and v.retry_after is not null and v.retry_after > now() then
    return jsonb_build_object('state', 'cooldown', 'id', v.id, 'retry_after', v.retry_after);
  end if;
  if v.status = 'pending' and v.lease_until is not null and v.lease_until > now() then
    return jsonb_build_object('state', 'busy', 'id', v.id);
  end if;

  -- expired lease (a worker died or is just slow) or a failed row whose cooldown has elapsed: take over, keeping the attempt
  -- history. The epoch moves forward, which fences out every earlier holder of this entry.
  update public.dr_ai_cache set status = 'pending', lease_until = now() + v_lease, lease_epoch = lease_epoch + 1
   where id = v.id returning lease_epoch into v_epoch;
  return jsonb_build_object('state', 'claimed', 'id', v.id, 'epoch', v_epoch);
end $$;

-- Stores a VALIDATED successful result. Refuses anything that is not a non-null JSON object, and only ever
-- transitions a row that is still pending AND whose current lease epoch equals p_epoch, so (a) a failed/partial answer
-- can never be recorded as a success and (b) a worker whose lease expired and was taken over cannot overwrite or pre-empt
-- the newer holder. Returns false (and changes nothing) when the caller no longer holds the lease.
create or replace function public.dr_ai_cache_complete(
  p_id uuid, p_epoch bigint, p_result jsonb, p_citations jsonb default '[]'::jsonb, p_usage jsonb default '{}'::jsonb)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare n integer;
begin
  if p_result is null or jsonb_typeof(p_result) <> 'object' then
    raise exception 'a successful AI result must be a non-null JSON object' using errcode = '22023';
  end if;
  update public.dr_ai_cache set
    status = 'succeeded', result = p_result,
    citations = case when jsonb_typeof(p_citations) = 'array' then p_citations else '[]'::jsonb end,
    usage = case when jsonb_typeof(p_usage) = 'object' then p_usage else '{}'::jsonb end,
    lease_until = null, retry_after = null, last_failure = null, completed_at = now()
   where id = p_id and status = 'pending' and lease_epoch = p_epoch;
  get diagnostics n = row_count;
  return n > 0;
end $$;

-- The INPUT produced an unusable answer (invalid response, refusal, rejected request). No result is stored; the row
-- records the failure and blocks retries for 1h, 2h, 4h ... capped at 7 days. Fenced like complete(): a stale holder cannot
-- mark an entry failed while a newer holder is working on it.
create or replace function public.dr_ai_cache_fail(p_id uuid, p_epoch bigint, p_reason text default null)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare n integer;
begin
  update public.dr_ai_cache set
    status = 'failed', result = null, lease_until = null,
    retry_after = now() + make_interval(hours => least(168, (2 ^ least(failed_attempts, 8))::integer)),
    failed_attempts = failed_attempts + 1,
    last_failure = left(coalesce(p_reason, 'failed'), 200)
   where id = p_id and status = 'pending' and lease_epoch = p_epoch;
  get diagnostics n = row_count;
  return n > 0;
end $$;

-- The SERVICE had a problem (rate limit, outage, bad credentials), not the input: release the lease without recording
-- a failure against the input, so it is picked up as soon as the service recovers.
create or replace function public.dr_ai_cache_abandon(p_id uuid, p_epoch bigint)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  -- Fenced: only the CURRENT lease holder can release. A stale worker must not delete or reset a newer worker's lease.
  update public.dr_ai_cache set status = 'failed', lease_until = null, retry_after = now()
   where id = p_id and status = 'pending' and lease_epoch = p_epoch and failed_attempts > 0;   -- keep earlier failure history
  delete from public.dr_ai_cache where id = p_id and status = 'pending' and lease_epoch = p_epoch and failed_attempts = 0;
end $$;

-- A stored result that no longer passes application validation (e.g. schema drift): remove it so it is recomputed once.
-- It can only ever remove a SUCCEEDED entry, so no caller (stale or not) can delete a pending lease or a failure record.
create or replace function public.dr_ai_cache_invalidate(p_id uuid)
returns void language sql security definer set search_path = public, extensions as $$
  delete from public.dr_ai_cache where id = p_id and status = 'succeeded';
$$;

-- Housekeeping for scheduled/manual use: drops results nobody has used for a long time, long-dead leases and old failures.
create or replace function public.dr_ai_cache_prune(p_older_than_days integer default 180)
returns integer language plpgsql security definer set search_path = public, extensions as $$
declare n integer := 0; k integer;
begin
  if p_older_than_days is null or p_older_than_days < 7 then raise exception 'p_older_than_days must be at least 7'; end if;
  delete from public.dr_ai_cache
   where status = 'succeeded' and coalesce(last_hit_at, completed_at, created_at) < now() - make_interval(days => p_older_than_days);
  get diagnostics k = row_count; n := n + k;
  delete from public.dr_ai_cache where status = 'pending' and lease_until < now() - interval '1 day';
  get diagnostics k = row_count; n := n + k;
  delete from public.dr_ai_cache where status = 'failed' and coalesce(retry_after, created_at) < now() - interval '30 days';
  get diagnostics k = row_count; n := n + k;
  return n;
end $$;

-- ================================================================= usage counters
create or replace function public.dr_ai_note_usage(p_engine text, p_counters jsonb)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare
  c jsonb := coalesce(p_counters, '{}'::jsonb);
begin
  insert into public.dr_ai_usage as u (engine, calls, successes, failures, rate_limited, http_requests, cache_hits, cache_misses,
                                       input_tokens, output_tokens, reported_cost_usd, cost_reported_calls, duration_ms)
  values (p_engine,
    greatest(0, coalesce((c->>'calls')::bigint, 0)), greatest(0, coalesce((c->>'successes')::bigint, 0)),
    greatest(0, coalesce((c->>'failures')::bigint, 0)), greatest(0, coalesce((c->>'rate_limited')::bigint, 0)),
    greatest(0, coalesce((c->>'http_requests')::bigint, 0)), greatest(0, coalesce((c->>'cache_hits')::bigint, 0)),
    greatest(0, coalesce((c->>'cache_misses')::bigint, 0)), greatest(0, coalesce((c->>'input_tokens')::bigint, 0)),
    greatest(0, coalesce((c->>'output_tokens')::bigint, 0)), greatest(0, coalesce((c->>'reported_cost_usd')::numeric, 0)),
    greatest(0, coalesce((c->>'cost_reported_calls')::bigint, 0)), greatest(0, coalesce((c->>'duration_ms')::bigint, 0)))
  on conflict (engine, day) do update set
    calls = u.calls + excluded.calls, successes = u.successes + excluded.successes, failures = u.failures + excluded.failures,
    rate_limited = u.rate_limited + excluded.rate_limited, http_requests = u.http_requests + excluded.http_requests,
    cache_hits = u.cache_hits + excluded.cache_hits, cache_misses = u.cache_misses + excluded.cache_misses,
    input_tokens = u.input_tokens + excluded.input_tokens, output_tokens = u.output_tokens + excluded.output_tokens,
    reported_cost_usd = u.reported_cost_usd + excluded.reported_cost_usd,
    cost_reported_calls = u.cost_reported_calls + excluded.cost_reported_calls, duration_ms = u.duration_ms + excluded.duration_ms;
end $$;

-- ================================================================= per-signal model outputs
-- Rows whose record changed since analysis (content_hash mismatch) or whose probabilities are out of range are ignored.
-- A cache_id that no longer exists (entry invalidated or pruned in between) is stored as NULL instead of raising a foreign-key
-- error, so one stale link can never make the whole call lose every other row's provenance.
create or replace function public.dr_save_signal_ai(p_rows jsonb)
returns integer language plpgsql security definer set search_path = public, extensions as $$
declare n integer := 0; s jsonb; v_p numeric; v_c numeric; v_cache uuid;
begin
  for s in select * from jsonb_array_elements(coalesce(p_rows, '[]'::jsonb)) loop
    if not exists (select 1 from public.dr_raw_records r
                   where r.id = (s->>'record_id')::uuid and r.content_hash = s->>'content_hash') then
      continue;
    end if;
    v_p := (s->>'problem_probability')::numeric;
    v_c := nullif(s->>'model_confidence', '')::numeric;
    if v_p is null or v_p < 0 or v_p > 1 or (v_c is not null and (v_c < 0 or v_c > 1)) then continue; end if;
    v_cache := nullif(s->>'cache_id', '')::uuid;
    if v_cache is not null and not exists (select 1 from public.dr_ai_cache where id = v_cache) then v_cache := null; end if;
    insert into public.dr_signal_ai as g (record_id, cache_id, input_hash, model, requested_model, config_version,
                                          problem_probability, model_confidence, answers, citations)
    values ((s->>'record_id')::uuid, v_cache, left(s->>'input_hash', 64), left(s->>'model', 120),
            left(s->>'requested_model', 120), left(coalesce(s->>'config_version', 'unknown'), 80), v_p, v_c,
            case when jsonb_typeof(s->'answers') = 'object' then s->'answers' else '{}'::jsonb end,
            case when jsonb_typeof(s->'citations') = 'array' then s->'citations' else '[]'::jsonb end)
    on conflict (record_id) do update set
      cache_id = excluded.cache_id, input_hash = excluded.input_hash, model = excluded.model,
      requested_model = excluded.requested_model, config_version = excluded.config_version,
      problem_probability = excluded.problem_probability, model_confidence = excluded.model_confidence,
      answers = excluded.answers, citations = excluded.citations, evaluated_at = now();
    n := n + 1;
  end loop;
  return n;
end $$;

-- ================================================================= evidence helpers (read-only)
-- Canonical form of a URL for duplicate detection: no scheme, no leading www., no fragment, no tracking parameters
-- (utm_*, fbclid, gclid, ref, ref_src), no trailing slash / dangling ? or &. Lower-cased. Mirrors normalizeUrl() in
-- supabase/functions/_shared/collector/decisions.ts (both are tested against the same cases).
create or replace function public.dr_norm_url(p_url text)
returns text language sql immutable as $$
  select nullif(
    regexp_replace(
      regexp_replace(
        regexp_replace(
          regexp_replace(
            regexp_replace(
              regexp_replace(lower(btrim(coalesce(p_url, ''))), '^[a-z][a-z0-9+.-]*://(www\.)?', ''),
              '#.*$', ''),
            '([?&])(utm_[a-z0-9_]+|fbclid|gclid|ref|ref_src)=[^&]*', '\1', 'g'),
          '\?&+', '?'),
        '&&+', '&', 'g'),
      '[?&/]+$', ''),
    '')
$$;

-- The separate measures for one cluster. Nothing in this profile is combined, and nothing here feeds
-- dr_clusters.composite_score (which is unchanged). In particular ai_model_confidence is reported on its own.
--   independent reports   discussions collapsed further when their opening posts are identical text or share a canonical URL
--   persistence           how many distinct calendar weeks saw an independent report, out of the weeks between first and last
--   trend                 independent reports in the last 30 days vs the 30 before; needs >= 5 in total, otherwise insufficient_data
--   research evidence     distinct external URLs the provider cited, excluding the post's own URL
create or replace function public.dr_cluster_profile(p_cluster uuid)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
declare
  v_c public.dr_clusters%rowtype;
  v_members integer; v_discussions integer; v_independent integer;
  v_first timestamptz; v_last timestamptz; v_active_weeks integer; v_span_weeks integer; v_weeks_since integer;
  v_recent integer; v_prior integer; v_growth numeric; v_trend text;
  v_types jsonb; v_conf numeric; v_conf_n integer; v_prob numeric;
  v_cites integer; v_cite_urls integer; v_domains integer;
begin
  select * into v_c from public.dr_clusters where id = p_cluster;
  if not found then return null; end if;

  with roots as (   -- one opening post per discussion (earliest published; ties by id)
    select distinct on (r.discussion_key) r.discussion_key,
           md5(lower(regexp_replace(coalesce(r.title, '') || ' ' || coalesce(r.excerpt, ''), '\s+', ' ', 'g'))) as text_key,
           public.dr_norm_url(r.url) as nurl, r.published_at
      from public.dr_cluster_members cm
      join public.dr_raw_records r on r.id = cm.record_id
      join public.dr_problem_signals sg on sg.record_id = r.id
     where cm.cluster_id = p_cluster and sg.is_problem
     order by r.discussion_key, r.published_at nulls last, r.id
  ), canon as (     -- same opening text, or the same canonical URL, means the same underlying source
    select discussion_key, published_at,
           case when nurl is null then text_key
                else least(text_key, min(text_key) over (partition by nurl)) end as canon
      from roots
  ), firsts as (    -- date each independent report first appeared
    select canon, min(published_at) as first_pub from canon group by canon
  )
  select (select count(*) from canon), (select count(*) from firsts),
         (select min(first_pub) from firsts), (select max(first_pub) from firsts),
         (select count(distinct date_trunc('week', first_pub)) from firsts where first_pub is not null),
         (select count(*) filter (where first_pub >= now() - interval '30 days') from firsts),
         (select count(*) filter (where first_pub < now() - interval '30 days' and first_pub >= now() - interval '60 days') from firsts)
    into v_discussions, v_independent, v_first, v_last, v_active_weeks, v_recent, v_prior;

  select count(*) into v_members
    from public.dr_cluster_members cm join public.dr_problem_signals sg on sg.record_id = cm.record_id
   where cm.cluster_id = p_cluster and sg.is_problem;

  v_span_weeks := case when v_first is null then 0
                       else floor(extract(epoch from (date_trunc('week', v_last) - date_trunc('week', v_first))) / 604800)::integer + 1 end;
  v_weeks_since := case when v_last is null then null else floor(extract(epoch from (now() - v_last)) / 604800)::integer end;
  v_growth := case when coalesce(v_recent, 0) + coalesce(v_prior, 0) >= 5
                   then round(((v_recent - v_prior)::numeric / greatest(v_prior, 1)) * 100, 1) end;
  v_trend := case when v_growth is null then 'insufficient_data'
                  when v_growth >= 50 and v_recent >= 3 then 'emerging'
                  when v_growth <= -30 then 'declining'
                  else 'stable' end;

  select coalesce(jsonb_object_agg(signal_type, cnt), '{}'::jsonb) into v_types from (
    select sg.signal_type, count(*) as cnt
      from public.dr_cluster_members cm join public.dr_problem_signals sg on sg.record_id = cm.record_id
     where cm.cluster_id = p_cluster and sg.is_problem group by 1) t;

  select round(avg(sa.model_confidence), 3), count(sa.model_confidence), round(avg(sa.problem_probability), 3)
    into v_conf, v_conf_n, v_prob
    from public.dr_cluster_members cm join public.dr_signal_ai sa on sa.record_id = cm.record_id
   where cm.cluster_id = p_cluster;

  select count(*), count(distinct nu), count(distinct split_part(nu, '/', 1)) into v_cites, v_cite_urls, v_domains from (
    select public.dr_norm_url(ci->>'url') as nu, public.dr_norm_url(r.url) as own
      from public.dr_cluster_members cm
      join public.dr_raw_records r on r.id = cm.record_id
      join public.dr_signal_ai sa on sa.record_id = cm.record_id
      cross join lateral jsonb_array_elements(sa.citations) ci
     where cm.cluster_id = p_cluster) c
   where nu is not null and nu is distinct from own;

  return jsonb_build_object(
    'cluster_id', p_cluster,
    'independent_reports', jsonb_build_object('count', v_independent, 'unique_discussions', v_discussions,
      'collapsed_duplicates', greatest(v_discussions - v_independent, 0),
      'basis', 'distinct discussions, collapsed when opening posts have identical text or share a canonical URL'),
    'recurring_complaints', jsonb_build_object('problem_signals', v_members, 'by_signal_type', v_types,
      'basis', 'every analysed problem signal in the cluster, including several from one discussion'),
    'frequency', jsonb_build_object('recent_30d', coalesce(v_recent, 0), 'prior_30d', coalesce(v_prior, 0),
      'basis', 'independent reports by first publication date'),
    'persistence', jsonb_build_object('active_weeks', coalesce(v_active_weeks, 0), 'span_weeks', v_span_weeks,
      'ratio', case when v_span_weeks > 0 then round(v_active_weeks::numeric / v_span_weeks, 3) end,
      'first_seen_at', v_first, 'last_seen_at', v_last, 'weeks_since_last_report', v_weeks_since,
      'basis', 'distinct calendar weeks with a new independent report / weeks between the first and the latest one'),
    'trend', jsonb_build_object('label', v_trend, 'growth_pct', v_growth, 'recent_30d', coalesce(v_recent, 0), 'prior_30d', coalesce(v_prior, 0),
      'basis', 'needs >= 5 independent reports across the two 30-day windows; emerging = growth >= 50% with >= 3 recent'),
    'external_research_evidence', jsonb_build_object('citations', v_cites, 'distinct_urls', v_cite_urls, 'distinct_domains', v_domains,
      'basis', 'provider-cited URLs deduplicated by canonical URL, excluding each post''s own URL; a citation is a source the model consulted, not proof of demand'),
    'ai_model_confidence', jsonb_build_object('average', v_conf, 'signals_with_confidence', coalesce(v_conf_n, 0), 'average_problem_probability', v_prob,
      'basis', 'the model''s self-assessment; reported separately and never used in ranking or in the demand score'),
    'demand_score', jsonb_build_object('composite_score', v_c.composite_score, 'data_confidence', v_c.confidence,
      'basis', 'unchanged dr_clusters.composite_score from dr_refresh_clusters')
  );
end $$;

-- ================================================================= grants (new functions only)
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname in (
              'dr_ai_cache_begin', 'dr_ai_cache_complete', 'dr_ai_cache_fail', 'dr_ai_cache_abandon', 'dr_ai_cache_invalidate',
              'dr_ai_cache_prune', 'dr_ai_note_usage', 'dr_save_signal_ai', 'dr_norm_url', 'dr_cluster_profile') loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;
