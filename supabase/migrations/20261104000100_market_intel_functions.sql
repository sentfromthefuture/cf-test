-- DemandRadar market-intelligence collection engine: functions (part 2 of 2)
-- Collector-facing functions are executable by service_role only.
-- Read functions for the dashboard are SECURITY DEFINER and return aggregates / public links only.

-- ================================================================= locks
create or replace function public.dr_acquire_lock(p_name text, p_seconds integer default 300)
returns boolean language plpgsql security definer set search_path = public, extensions as $$
declare v_got boolean;
begin
  insert into public.dr_job_locks (name, locked_until) values (p_name, now() + make_interval(secs => p_seconds))
  on conflict (name) do update set locked_until = excluded.locked_until
    where public.dr_job_locks.locked_until < now()
  returning true into v_got;
  return coalesce(v_got, false);
end $$;

create or replace function public.dr_release_lock(p_name text)
returns void language sql security definer set search_path = public, extensions as $$
  update public.dr_job_locks set locked_until = now() - interval '1 second' where name = p_name;
$$;

-- ================================================================= scheduling
-- Atomically claims sources that are due (or one forced source, for manual sync). A claimed source
-- is locked, so overlapping cron ticks / double clicks cannot run the same connector twice.
create or replace function public.dr_claim_due_sources(
  p_limit integer default 3, p_force text default null, p_lock_seconds integer default 600, p_trigger text default 'schedule')
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v_result jsonb;
begin
  with due as (
    select s.id from public.dr_sources s
    where s.availability = 'implemented' and s.enabled
      and (s.locked_until is null or s.locked_until < now())
      and ((p_force is not null and s.id = p_force)
           or (p_force is null and (s.next_run_at is null or s.next_run_at <= now())))
    order by s.next_run_at nulls first
    limit p_limit
    for update skip locked
  ), claimed as (
    update public.dr_sources s
       set status = 'running', locked_until = now() + make_interval(secs => p_lock_seconds),
           last_run_at = now(), updated_at = now()
      from due where s.id = due.id
    returning s.id, s.config, s.cursor, s.interval_minutes
  ), runs as (
    insert into public.dr_collection_runs (source_id, trigger)
    select id, p_trigger from claimed
    returning id, source_id
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', c.id, 'config', c.config, 'cursor', c.cursor,
           'interval_minutes', c.interval_minutes, 'run_id', r.id)), '[]'::jsonb)
    into v_result
    from claimed c join runs r on r.source_id = c.id;
  return v_result;
end $$;

create or replace function public.dr_finish_run(
  p_run uuid, p_source text, p_status text, p_cursor jsonb, p_stats jsonb, p_error text,
  p_next_run_at timestamptz default null)
returns void language plpgsql security definer set search_path = public, extensions as $$
declare v_errs integer; v_interval integer;
begin
  if p_status not in ('success', 'partial', 'error') then raise exception 'invalid status %', p_status; end if;

  update public.dr_collection_runs set
    status = p_status, finished_at = now(),
    requests = coalesce((p_stats->>'requests')::int, 0), fetched = coalesce((p_stats->>'fetched')::int, 0),
    inserted = coalesce((p_stats->>'inserted')::int, 0), updated = coalesce((p_stats->>'updated')::int, 0),
    duplicates = coalesce((p_stats->>'duplicates')::int, 0), errors = coalesce((p_stats->>'errors')::int, 0),
    error = left(p_error, 500), details = coalesce(p_stats->'details', '{}'::jsonb)
  where id = p_run and source_id = p_source;

  select case when p_status = 'error' then consecutive_errors + 1 else 0 end, interval_minutes
    into v_errs, v_interval from public.dr_sources where id = p_source;

  update public.dr_sources set
    cursor = coalesce(p_cursor, cursor),
    status = case when p_status = 'error' then 'error' else 'idle' end,
    locked_until = null,
    consecutive_errors = v_errs,
    last_success_at = case when p_status = 'success' then now() else last_success_at end,
    last_error = case when p_status = 'success' then null else left(p_error, 500) end,
    last_error_at = case when p_status = 'success' then last_error_at else now() end,
    next_run_at = coalesce(p_next_run_at,
      now() + make_interval(mins => least(v_interval * power(2, greatest(v_errs - 1, 0))::int, 1440))),
    updated_at = now()
  where id = p_source;
end $$;

create or replace function public.dr_note_usage(p_source text, p_requests integer, p_errors integer, p_rate_limited integer)
returns void language sql security definer set search_path = public, extensions as $$
  insert into public.dr_api_usage as u (source_id, day, requests, errors, rate_limited)
  values (p_source, (now() at time zone 'utc')::date, greatest(p_requests, 0), greatest(p_errors, 0), greatest(p_rate_limited, 0))
  on conflict (source_id, day) do update set
    requests = u.requests + excluded.requests, errors = u.errors + excluded.errors,
    rate_limited = u.rate_limited + excluded.rate_limited;
$$;

create or replace function public.dr_set_quota(p_source text, p_limit integer, p_remaining integer, p_reset timestamptz)
returns void language sql security definer set search_path = public, extensions as $$
  update public.dr_sources set quota_limit = p_limit, quota_remaining = p_remaining, quota_reset_at = p_reset, updated_at = now()
  where id = p_source;
$$;

-- ================================================================= raw records
create or replace function public.dr_existing_ids(p_source text, p_ids text[])
returns text[] language sql security definer set search_path = public, extensions as $$
  select coalesce(array_agg(source_record_id), '{}') from public.dr_raw_records
  where source_id = p_source and source_record_id = any (p_ids);
$$;

-- Idempotent bulk upsert: safe to retry. Unchanged rows are left untouched and counted as duplicates;
-- a changed content_hash re-queues the record for analysis, unchanged content is never re-analysed.
create or replace function public.dr_upsert_records(p_records jsonb)
returns jsonb language plpgsql security definer set search_path = public, extensions as $$
declare v_total integer; v_valid integer; v_ins integer := 0; v_upd integer := 0;
begin
  v_total := coalesce(jsonb_array_length(p_records), 0);
  if v_total = 0 then
    return jsonb_build_object('total', 0, 'inserted', 0, 'updated', 0, 'duplicates', 0, 'invalid', 0);
  end if;

  with input as (
    select distinct on (x.source_id, x.source_record_id) x.*
    from jsonb_to_recordset(p_records) as x(
      source_id text, source_record_id text, discussion_key text, kind text, url text, title text, excerpt text,
      author_ref text, parent_source_record_id text, published_at timestamptz, updated_at_source timestamptz,
      engagement jsonb, categories jsonb, language text, license text, attribution text, content_hash text)
    where x.source_id is not null and x.source_record_id is not null and x.discussion_key is not null
      and x.kind is not null and x.license is not null and x.content_hash is not null
      and x.url ~* '^https?://'
      and exists (select 1 from public.dr_sources s where s.id = x.source_id)
    order by x.source_id, x.source_record_id
  ), ups as (
    insert into public.dr_raw_records as r (
      source_id, source_record_id, discussion_key, kind, url, title, excerpt, author_ref, parent_source_record_id,
      published_at, updated_at_source, engagement, categories, language, license, attribution, content_hash)
    select i.source_id, i.source_record_id, i.discussion_key, left(i.kind, 40), left(i.url, 2048),
           left(i.title, 500), left(i.excerpt, 2000), left(i.author_ref, 128), left(i.parent_source_record_id, 128),
           i.published_at, i.updated_at_source, coalesce(i.engagement, '{}'::jsonb),
           array(select left(c, 80) from jsonb_array_elements_text(coalesce(i.categories, '[]'::jsonb)) c limit 30),
           left(i.language, 12), left(i.license, 200), left(i.attribution, 600), i.content_hash
    from input i
    on conflict (source_id, source_record_id) do update set
      engagement = excluded.engagement,
      updated_at_source = excluded.updated_at_source,
      title = excluded.title, excerpt = excluded.excerpt, categories = excluded.categories,
      content_hash = excluded.content_hash,
      analysis_status = case when r.content_hash is distinct from excluded.content_hash then 'pending' else r.analysis_status end,
      analysis_attempts = case when r.content_hash is distinct from excluded.content_hash then 0 else r.analysis_attempts end
    where r.content_hash is distinct from excluded.content_hash or r.engagement is distinct from excluded.engagement
    returning r.source_id, (xmax = 0) as inserted
  ), bump as (
    update public.dr_sources s set records_total = s.records_total + c.n
    from (select source_id, count(*) as n from ups where inserted group by source_id) c
    where s.id = c.source_id
    returning 1
  )
  select count(*) filter (where inserted), count(*) filter (where not inserted) into v_ins, v_upd from ups;

  select count(*) into v_valid from jsonb_array_elements(p_records) e
   where e->>'url' ~* '^https?://' and e->>'source_record_id' is not null;

  return jsonb_build_object('total', v_total, 'inserted', v_ins, 'updated', v_upd,
    'duplicates', greatest(v_valid - v_ins - v_upd, 0), 'invalid', greatest(v_total - v_valid, 0));
end $$;

-- ================================================================= analysis queue
create or replace function public.dr_claim_pending_records(p_limit integer default 20)
returns jsonb language sql security definer set search_path = public, extensions as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', id, 'source_id', source_id, 'kind', kind, 'title', title, 'excerpt', excerpt,
    'categories', categories, 'engagement', engagement, 'content_hash', content_hash, 'language', language)), '[]'::jsonb)
  from (select * from public.dr_raw_records where analysis_status = 'pending'
        order by collected_at limit least(greatest(p_limit, 1), 200)) q;
$$;

create or replace function public.dr_mark_skipped(p_ids uuid[])
returns integer language plpgsql security definer set search_path = public, extensions as $$
declare n integer;
begin
  update public.dr_raw_records set analysis_status = 'skipped', analyzed_hash = content_hash
   where id = any (p_ids) and analysis_status = 'pending';
  get diagnostics n = row_count; return n;
end $$;

create or replace function public.dr_mark_analysis_failed(p_ids uuid[])
returns integer language plpgsql security definer set search_path = public, extensions as $$
declare n integer;
begin
  update public.dr_raw_records
     set analysis_attempts = analysis_attempts + 1,
         analysis_status = case when analysis_attempts + 1 >= 3 then 'failed' else 'pending' end
   where id = any (p_ids);
  get diagnostics n = row_count; return n;
end $$;

-- Saves AI/heuristic output. Rows whose content changed since the record was claimed are ignored.
create or replace function public.dr_save_signals(p_signals jsonb)
returns integer language plpgsql security definer set search_path = public, extensions as $$
declare n integer := 0; s jsonb; v_emb extensions.vector(768);
begin
  for s in select * from jsonb_array_elements(coalesce(p_signals, '[]'::jsonb)) loop
    if not exists (select 1 from public.dr_raw_records r
                   where r.id = (s->>'record_id')::uuid and r.content_hash = s->>'content_hash') then
      continue;
    end if;
    v_emb := null;
    if jsonb_typeof(s->'embedding') = 'array' and jsonb_array_length(s->'embedding') = 768 then
      v_emb := (s->'embedding')::text::extensions.vector(768);
    end if;
    insert into public.dr_problem_signals as g (
      record_id, analysis_method, model, is_problem, signal_type, problem_statement, industry, use_case,
      severity, wtp_evidence, wtp_quote, competitors, language, embedding)
    values (
      (s->>'record_id')::uuid, s->>'analysis_method', left(s->>'model', 80), coalesce((s->>'is_problem')::boolean, false),
      coalesce(s->>'signal_type', 'other'), left(s->>'problem_statement', 400), left(s->>'industry', 80), left(s->>'use_case', 120),
      nullif(s->>'severity', '')::smallint, coalesce((s->>'wtp_evidence')::boolean, false), left(s->>'wtp_quote', 300),
      array(select left(c, 80) from jsonb_array_elements_text(coalesce(s->'competitors', '[]'::jsonb)) c limit 10),
      left(s->>'language', 12), v_emb)
    on conflict (record_id) do update set
      analysis_method = excluded.analysis_method, model = excluded.model, is_problem = excluded.is_problem,
      signal_type = excluded.signal_type, problem_statement = excluded.problem_statement, industry = excluded.industry,
      use_case = excluded.use_case, severity = excluded.severity, wtp_evidence = excluded.wtp_evidence,
      wtp_quote = excluded.wtp_quote, competitors = excluded.competitors, language = excluded.language,
      embedding = coalesce(excluded.embedding, g.embedding), analyzed_at = now();
    update public.dr_raw_records set analysis_status = 'done', analyzed_hash = content_hash
     where id = (s->>'record_id')::uuid;
    n := n + 1;
  end loop;
  return n;
end $$;

-- ================================================================= clustering
-- Embedding path: nearest centroid by cosine similarity. Fallback path (no embedding): pg_trgm title similarity.
create or replace function public.dr_assign_cluster(
  p_record uuid, p_threshold double precision default 0.80, p_trgm_threshold double precision default 0.5)
returns uuid language plpgsql security definer set search_path = public, extensions as $$
declare s public.dr_problem_signals%rowtype; v_cluster uuid; v_sim double precision;
begin
  select * into s from public.dr_problem_signals where record_id = p_record;
  if not found or not s.is_problem or s.problem_statement is null then return null; end if;
  if s.cluster_id is not null then return s.cluster_id; end if;

  perform pg_advisory_xact_lock(hashtext('dr_assign_cluster'));

  if s.embedding is not null then
    select c.id, 1 - (c.centroid <=> s.embedding) into v_cluster, v_sim
      from public.dr_clusters c where c.centroid is not null
      order by c.centroid <=> s.embedding limit 1;
    if v_sim is null or v_sim < p_threshold then v_cluster := null; end if;
  else
    perform set_config('pg_trgm.similarity_threshold', p_trgm_threshold::text, true);
    select c.id, similarity(c.title, s.problem_statement) into v_cluster, v_sim
      from public.dr_clusters c where c.title % s.problem_statement
      order by similarity(c.title, s.problem_statement) desc limit 1;
  end if;

  if v_cluster is null then
    insert into public.dr_clusters (title, industry, use_case, centroid, members_count, first_seen_at, last_seen_at)
    values (s.problem_statement, s.industry, s.use_case, s.embedding, 0, now(), now())
    returning id into v_cluster;
    v_sim := 1;
  end if;

  insert into public.dr_cluster_members (cluster_id, record_id, similarity) values (v_cluster, p_record, v_sim)
  on conflict (record_id) do nothing;
  update public.dr_problem_signals set cluster_id = v_cluster where record_id = p_record;
  update public.dr_clusters set
    members_count = members_count + 1,
    centroid = case when centroid is not null and s.embedding is not null then centroid + s.embedding else centroid end,
    stats_dirty = true,
    summary_dirty = summary_dirty or summary is null
      or (members_count + 1) >= 1.5 * coalesce((summary->>'members_at')::numeric, 0),
    updated_at = now()
  where id = v_cluster;
  return v_cluster;
end $$;

create or replace function public.dr_assign_pending_clusters(
  p_limit integer default 200, p_threshold double precision default 0.80, p_trgm_threshold double precision default 0.5)
returns integer language plpgsql security definer set search_path = public, extensions as $$
declare r record; n integer := 0;
begin
  for r in select record_id from public.dr_problem_signals
            where is_problem and cluster_id is null and problem_statement is not null
            order by analyzed_at limit p_limit loop
    perform public.dr_assign_cluster(r.record_id, p_threshold, p_trgm_threshold);
    n := n + 1;
  end loop;
  return n;
end $$;

-- Recomputes measured aggregates and the explainable score for clusters whose membership changed.
-- Every component carries its basis: measured | ai_estimate | evidence_count | derived | insufficient_data.
create or replace function public.dr_refresh_clusters(p_limit integer default 100)
returns integer language plpgsql security definer set search_path = public, extensions as $$
declare
  c record; v_done integer := 0;
  v_u integer; v_members integer; v_sources text[]; v_first jsonb; v_eng bigint; v_firstseen timestamptz; v_lastseen timestamptz;
  v_recent integer; v_prior integer; v_growth numeric; v_sev numeric; v_wtp integer; v_comp jsonb; v_ncomp integer;
  v_industry text; v_usecase text; v_spreading boolean;
  v_freq numeric; v_gr numeric; v_pain numeric; v_wtps numeric; v_gap numeric; v_feas numeric; v_feas_raw numeric;
  v_wsum numeric; v_acc numeric; v_composite numeric; v_conf text;
  w_freq constant numeric := 25; w_gr constant numeric := 20; w_pain constant numeric := 20;
  w_wtp constant numeric := 15; w_gap constant numeric := 10; w_feas constant numeric := 10;
begin
  for c in select id, summary from public.dr_clusters where stats_dirty order by updated_at limit p_limit loop
    select count(*), count(distinct r.discussion_key), array_agg(distinct r.source_id), min(r.published_at), max(r.published_at),
           count(distinct r.discussion_key) filter (where r.published_at >= now() - interval '30 days'),
           count(distinct r.discussion_key) filter (where r.published_at < now() - interval '30 days' and r.published_at >= now() - interval '60 days'),
           avg(sg.severity)::numeric,
           count(distinct r.discussion_key) filter (where sg.wtp_evidence),
           mode() within group (order by sg.industry) filter (where sg.industry is not null and sg.industry <> 'Other'),
           mode() within group (order by sg.use_case) filter (where sg.use_case is not null)
      into v_members, v_u, v_sources, v_firstseen, v_lastseen, v_recent, v_prior, v_sev, v_wtp, v_industry, v_usecase
      from public.dr_cluster_members cm
      join public.dr_raw_records r on r.id = cm.record_id
      join public.dr_problem_signals sg on sg.record_id = r.id
     where cm.cluster_id = c.id;

    select coalesce(jsonb_object_agg(source_id, first_pub), '{}'::jsonb) into v_first
      from (select r.source_id, min(r.published_at) as first_pub
              from public.dr_cluster_members cm join public.dr_raw_records r on r.id = cm.record_id
             where cm.cluster_id = c.id group by r.source_id) f;

    select coalesce(sum(e.val), 0)::bigint into v_eng
      from public.dr_cluster_members cm join public.dr_raw_records r on r.id = cm.record_id
      cross join lateral (select coalesce(sum(value::numeric), 0) as val from jsonb_each_text(r.engagement)
                           where value ~ '^-?[0-9]+(\.[0-9]+)?$') e
     where cm.cluster_id = c.id;

    select coalesce(jsonb_object_agg(name, cnt), '{}'::jsonb), count(*) into v_comp, v_ncomp
      from (select lower(x) as name, count(distinct r.discussion_key) as cnt
              from public.dr_cluster_members cm
              join public.dr_raw_records r on r.id = cm.record_id
              join public.dr_problem_signals sg on sg.record_id = r.id
              cross join lateral unnest(sg.competitors) x
             where cm.cluster_id = c.id group by 1 order by 2 desc limit 20) q;

    if v_members = 0 or v_members is null then
      update public.dr_clusters set members_count = 0, stats_dirty = false, updated_at = now() where id = c.id;
      continue;
    end if;

    v_growth := case when coalesce(v_recent, 0) + coalesce(v_prior, 0) >= 5
                     then round(((v_recent - v_prior)::numeric / greatest(v_prior, 1)) * 100, 1) end;
    select exists (select 1 from jsonb_each_text(v_first) f
                    where f.value::timestamptz >= now() - interval '30 days') and cardinality(v_sources) >= 2
      into v_spreading;

    v_freq := least(100, round(100 * ln(1 + v_u) / ln(51)));
    v_gr   := case when v_growth is null then null else greatest(0, least(100, round(50 + v_growth / 2))) end;
    v_pain := case when v_sev is null then null else round((v_sev - 1) / 4 * 100) end;
    v_wtps := least(100, round(100 * ln(1 + v_wtp) / ln(11)));
    v_gap  := case when v_ncomp = 0 then null else greatest(0, 100 - 20 * v_ncomp) end;
    v_feas_raw := nullif(c.summary->>'development_feasibility', '')::numeric;
    v_feas := case when v_feas_raw between 1 and 5 then round((v_feas_raw - 1) / 4 * 100) end;

    v_wsum := w_freq + w_wtp + (case when v_gr is not null then w_gr else 0 end)
              + (case when v_pain is not null then w_pain else 0 end)
              + (case when v_gap is not null then w_gap else 0 end)
              + (case when v_feas is not null then w_feas else 0 end);
    v_acc := w_freq * v_freq + w_wtp * v_wtps + coalesce(w_gr * v_gr, 0) + coalesce(w_pain * v_pain, 0)
             + coalesce(w_gap * v_gap, 0) + coalesce(w_feas * v_feas, 0);
    v_composite := round(v_acc / v_wsum);
    v_conf := case when v_u >= 10 and cardinality(v_sources) >= 2 then 'high'
                   when v_u >= 4 or cardinality(v_sources) >= 2 then 'medium' else 'low' end;

    update public.dr_clusters set
      industry = coalesce(v_industry, industry), use_case = coalesce(v_usecase, use_case),
      members_count = v_members, unique_discussions = v_u, source_count = cardinality(v_sources), sources = v_sources,
      source_first_seen = v_first, spreading = coalesce(v_spreading, false), engagement_total = v_eng,
      first_seen_at = v_firstseen, last_seen_at = v_lastseen, recent_discussions = coalesce(v_recent, 0),
      prior_discussions = coalesce(v_prior, 0), growth_rate = v_growth, severity_avg = round(v_sev, 2),
      wtp_signals = coalesce(v_wtp, 0), competitors = v_comp, composite_score = v_composite, confidence = v_conf,
      scores = jsonb_build_object(
        'formula', 'Weighted mean of the components that have data (weights renormalised). Mentions are not demand: frequency counts unique discussions, willingness-to-pay needs explicit evidence.',
        'components', jsonb_build_object(
          'problemFrequency', jsonb_build_object('value', v_freq, 'weight', w_freq, 'basis', 'measured',
              'inputs', jsonb_build_object('unique_discussions', v_u, 'members', v_members, 'sources', v_sources),
              'method', '100*ln(1+unique_discussions)/ln(51), saturating at 50 discussions'),
          'demandGrowth', jsonb_build_object('value', v_gr, 'weight', w_gr,
              'basis', case when v_gr is null then 'insufficient_data' else 'measured' end,
              'inputs', jsonb_build_object('recent_30d', v_recent, 'prior_30d', v_prior, 'growth_pct', v_growth),
              'method', '50 + growth%/2 clamped 0-100; needs >=5 discussions across the two 30-day windows'),
          'painIntensity', jsonb_build_object('value', v_pain, 'weight', w_pain,
              'basis', case when v_pain is null then 'insufficient_data' else 'ai_estimate' end,
              'inputs', jsonb_build_object('avg_severity_1_to_5', round(v_sev, 2)),
              'method', 'mean AI-estimated severity mapped 1-5 -> 0-100'),
          'willingnessToPay', jsonb_build_object('value', v_wtps, 'weight', w_wtp, 'basis', 'evidence_count',
              'inputs', jsonb_build_object('discussions_with_explicit_wtp_evidence', coalesce(v_wtp, 0)),
              'method', '100*ln(1+evidence discussions)/ln(11); zero when no explicit evidence found'),
          'competitionGap', jsonb_build_object('value', v_gap, 'weight', w_gap,
              'basis', case when v_gap is null then 'insufficient_data' else 'derived' end,
              'inputs', jsonb_build_object('distinct_competitors_named', v_ncomp),
              'method', '100 - 20*competitors named in discussions; unknown when none named (absence of mentions is not absence of competition)'),
          'developmentFeasibility', jsonb_build_object('value', v_feas, 'weight', w_feas,
              'basis', case when v_feas is null then 'insufficient_data' else 'ai_estimate' end,
              'inputs', jsonb_build_object('ai_feasibility_1_to_5', v_feas_raw), 'method', 'AI-estimated when a cluster summary exists')),
        'measured_context', jsonb_build_object('engagement_total', v_eng, 'source_count', cardinality(v_sources)),
        'coverage', round(v_wsum / 100, 2), 'composite', v_composite),
      stats_dirty = false, updated_at = now()
    where id = c.id;
    v_done := v_done + 1;
  end loop;
  return v_done;
end $$;

-- ================================================================= cluster summaries (AI narrative)
create or replace function public.dr_clusters_needing_summary(p_limit integer default 3, p_min_members integer default 3)
returns jsonb language sql security definer set search_path = public, extensions as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', c.id, 'industry', c.industry, 'sources', c.sources, 'members', c.members_count,
    'statements', (select coalesce(jsonb_agg(st), '[]'::jsonb) from (
        select distinct sg.problem_statement as st
          from public.dr_cluster_members cm join public.dr_problem_signals sg on sg.record_id = cm.record_id
         where cm.cluster_id = c.id and sg.problem_statement is not null limit 20) s))), '[]'::jsonb)
  from (select * from public.dr_clusters
         where summary_dirty and (members_count >= p_min_members or (source_count >= 2 and members_count >= 2))
         order by composite_score desc nulls last limit least(greatest(p_limit, 1), 20)) c;
$$;

create or replace function public.dr_save_cluster_summary(p_cluster uuid, p_summary jsonb)
returns void language sql security definer set search_path = public, extensions as $$
  update public.dr_clusters set
    summary = p_summary || jsonb_build_object('members_at', members_count, 'ai_generated', true),
    summary_dirty = false, summarized_at = now(), stats_dirty = true, updated_at = now()
  where id = p_cluster;
$$;

-- ================================================================= dashboard reads (anon + authenticated)
create or replace function public.dr_public_sources()
returns jsonb language sql stable security definer set search_path = public, extensions as $$
  select coalesce(jsonb_agg(row order by ord), '[]'::jsonb) from (
    select
      case s.availability when 'implemented' then 0 else 1 end as ord,
      jsonb_build_object(
        'id', s.id, 'name', s.name, 'description', s.description, 'availability', s.availability,
        'enabled', s.enabled,
        'status', case when s.availability = 'skipped' then 'unavailable'
                       when not s.enabled then 'disabled'
                       when s.status = 'running' and s.locked_until < now() then 'stalled'
                       else s.status end,
        'interval_minutes', s.interval_minutes, 'records_total', s.records_total,
        'last_run_at', s.last_run_at, 'last_success_at', s.last_success_at, 'next_run_at', s.next_run_at,
        'last_error', left(s.last_error, 200),
        'quota_limit', s.quota_limit, 'quota_remaining', s.quota_remaining, 'quota_reset_at', s.quota_reset_at,
        'license_note', s.license_note, 'skip_reason', s.skip_reason, 'access_restriction', s.access_restriction,
        'official_api', s.official_api, 'integration_requirements', s.integration_requirements, 'docs_url', s.docs_url,
        'requests_today', coalesce(u.requests, 0), 'errors_today', coalesce(u.errors, 0),
        'rate_limited_today', coalesce(u.rate_limited, 0),
        'last_run', (select jsonb_build_object('status', r.status, 'fetched', r.fetched, 'inserted', r.inserted,
                       'duplicates', r.duplicates, 'errors', r.errors, 'finished_at', r.finished_at, 'trigger', r.trigger)
                     from public.dr_collection_runs r where r.source_id = s.id order by r.started_at desc limit 1)
      ) as row
    from public.dr_sources s
    left join public.dr_api_usage u on u.source_id = s.id and u.day = (now() at time zone 'utc')::date
  ) q;
$$;

create or replace function public.dr_overview()
returns jsonb language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object(
    'records_total', (select coalesce(sum(records_total), 0) from public.dr_sources),
    'records_24h', (select count(*) from public.dr_raw_records where collected_at >= now() - interval '24 hours'),
    'records_prev_24h', (select count(*) from public.dr_raw_records where collected_at >= now() - interval '48 hours' and collected_at < now() - interval '24 hours'),
    'problems_total', (select count(*) from public.dr_problem_signals where is_problem),
    'problems_24h', (select count(*) from public.dr_problem_signals where is_problem and analyzed_at >= now() - interval '24 hours'),
    'pending_analysis', (select count(*) from public.dr_raw_records where analysis_status = 'pending'),
    'clusters_total', (select count(*) from public.dr_clusters where members_count > 0),
    'clusters_multi_source', (select count(*) from public.dr_clusters where source_count >= 2),
    'clusters_summarised', (select count(*) from public.dr_clusters where summary is not null),
    'implemented_sources', (select count(*) from public.dr_sources where availability = 'implemented'),
    'enabled_sources', (select count(*) from public.dr_sources where availability = 'implemented' and enabled),
    'last_collection_at', (select max(last_success_at) from public.dr_sources),
    'by_source', (select coalesce(jsonb_agg(jsonb_build_object('source_id', id, 'name', name, 'records', records_total) order by records_total desc), '[]'::jsonb)
                    from public.dr_sources where availability = 'implemented'),
    'top_industry', (select jsonb_build_object('industry', industry, 'unique_discussions', d)
                       from (select industry, sum(unique_discussions) d from public.dr_clusters
                              where industry is not null group by industry order by d desc limit 1) t),
    'fastest_growing', (select jsonb_build_object('id', id, 'title', title, 'growth_rate', growth_rate)
                          from public.dr_clusters where growth_rate is not null order by growth_rate desc limit 1),
    'industries', (select coalesce(jsonb_agg(jsonb_build_object('industry', industry, 'clusters', n, 'unique_discussions', d) order by d desc), '[]'::jsonb)
                     from (select industry, count(*) n, sum(unique_discussions) d from public.dr_clusters
                            where industry is not null and members_count > 0 group by industry order by d desc limit 12) t)
  );
$$;

create or replace function public.dr_activity(p_days integer default 14)
returns jsonb language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object(
    'daily', (select coalesce(jsonb_agg(jsonb_build_object('day', day, 'source_id', source_id, 'records', n) order by day), '[]'::jsonb)
                from (select (collected_at at time zone 'utc')::date as day, source_id, count(*) n
                        from public.dr_raw_records
                       where collected_at >= now() - make_interval(days => least(greatest(p_days, 1), 90))
                       group by 1, 2) t),
    'runs', (select coalesce(jsonb_agg(jsonb_build_object('day', day, 'runs', runs, 'errors', errs) order by day), '[]'::jsonb)
               from (select (started_at at time zone 'utc')::date as day, count(*) runs, count(*) filter (where status = 'error') errs
                       from public.dr_collection_runs
                      where started_at >= now() - make_interval(days => least(greatest(p_days, 1), 90))
                      group by 1) t));
$$;

create or replace function public.dr_recent_signals(p_limit integer default 20, p_offset integer default 0)
returns jsonb language sql stable security definer set search_path = public, extensions as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'record_id', r.id, 'source_id', r.source_id, 'title', r.title, 'url', r.url, 'published_at', r.published_at,
    'problem_statement', sg.problem_statement, 'signal_type', sg.signal_type, 'industry', sg.industry,
    'analysis_method', sg.analysis_method, 'cluster_id', sg.cluster_id, 'analyzed_at', sg.analyzed_at)
    order by sg.analyzed_at desc), '[]'::jsonb)
  from (select * from public.dr_problem_signals where is_problem
         order by analyzed_at desc limit least(greatest(p_limit, 1), 100) offset greatest(p_offset, 0)) sg
  join public.dr_raw_records r on r.id = sg.record_id;
$$;

create or replace function public.dr_clusters_list(
  p_limit integer default 50, p_offset integer default 0, p_industry text default null,
  p_min_sources integer default 1, p_order text default 'score', p_min_discussions integer default 1)
returns jsonb language sql stable security definer set search_path = public, extensions as $$
  select jsonb_build_object(
    'total', (select count(*) from public.dr_clusters c where c.members_count > 0 and c.source_count >= p_min_sources
               and c.unique_discussions >= p_min_discussions and (p_industry is null or c.industry = p_industry)),
    'items', coalesce(jsonb_agg(to_jsonb(q) - 'sort_key'), '[]'::jsonb))
  from (
    select c.id, c.title, c.industry, c.use_case, c.members_count, c.unique_discussions, c.source_count, c.sources,
           c.source_first_seen, c.spreading, c.engagement_total, c.first_seen_at, c.last_seen_at,
           c.recent_discussions, c.prior_discussions, c.growth_rate, c.severity_avg, c.wtp_signals, c.competitors,
           c.scores, c.composite_score, c.confidence, c.summary, c.summarized_at,
           row_number() over (order by case p_order
                 when 'growth' then c.growth_rate when 'discussions' then c.unique_discussions::numeric
                 when 'recent' then extract(epoch from c.last_seen_at) else c.composite_score end desc nulls last, c.id) as sort_key
      from public.dr_clusters c
     where c.members_count > 0 and c.source_count >= p_min_sources and c.unique_discussions >= p_min_discussions
       and (p_industry is null or c.industry = p_industry)
     order by sort_key
     limit least(greatest(p_limit, 1), 100) offset greatest(p_offset, 0)) q;
$$;

create or replace function public.dr_cluster_timeline(p_cluster uuid, p_weeks integer default 12)
returns jsonb language sql stable security definer set search_path = public, extensions as $$
  select coalesce(jsonb_agg(jsonb_build_object('week', week, 'source_id', source_id, 'discussions', n) order by week), '[]'::jsonb)
  from (select (date_trunc('week', r.published_at))::date as week, r.source_id, count(distinct r.discussion_key) n
          from public.dr_cluster_members cm join public.dr_raw_records r on r.id = cm.record_id
         where cm.cluster_id = p_cluster and r.published_at >= now() - make_interval(weeks => least(greatest(p_weeks, 1), 104))
         group by 1, 2) t;
$$;

-- Evidence excerpts need a signed-in user (excerpts of third-party content are not served to anonymous visitors).
create or replace function public.dr_cluster_evidence(p_cluster uuid, p_limit integer default 20)
returns jsonb language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if auth.uid() is null then raise exception 'sign in required' using errcode = '28000'; end if;
  return (select coalesce(jsonb_agg(e order by (e->>'rank')::int), '[]'::jsonb) from (
    select jsonb_build_object(
      'rank', row_number() over (order by coalesce((select sum(value::numeric) from jsonb_each_text(r.engagement) where value ~ '^-?[0-9]+(\.[0-9]+)?$'), 0) desc, r.published_at desc),
      'record_id', r.id, 'source_id', r.source_id, 'kind', r.kind, 'title', r.title, 'excerpt', left(r.excerpt, 400), 'url', r.url,
      'engagement', r.engagement, 'published_at', r.published_at, 'license', r.license, 'attribution', r.attribution,
      'signal_type', sg.signal_type, 'problem_statement', sg.problem_statement, 'analysis_method', sg.analysis_method) as e
    from public.dr_cluster_members cm
    join public.dr_raw_records r on r.id = cm.record_id
    join public.dr_problem_signals sg on sg.record_id = r.id
    where cm.cluster_id = p_cluster
    limit least(greatest(p_limit, 1), 50)) t);
end $$;

-- ================================================================= admin controls
create or replace function public.dr_is_admin()
returns boolean language sql stable security definer set search_path = public, extensions as $$
  select exists (select 1 from public.dr_admins where user_id = auth.uid());
$$;

create or replace function public.dr_admin_set_source(p_source text, p_enabled boolean default null, p_interval integer default null)
returns void language plpgsql security definer set search_path = public, extensions as $$
begin
  if not public.dr_is_admin() then raise exception 'admin only' using errcode = '42501'; end if;
  if p_interval is not null and (p_interval < 5 or p_interval > 10080) then raise exception 'interval must be 5-10080 minutes'; end if;
  update public.dr_sources set
    enabled = coalesce(p_enabled, enabled),
    interval_minutes = coalesce(p_interval, interval_minutes),
    status = case when p_enabled is false then 'disabled' when p_enabled is true and status = 'disabled' then 'idle' else status end,
    next_run_at = case when p_enabled is true and not enabled then null else next_run_at end,
    updated_at = now()
  where id = p_source and availability = 'implemented';
  if not found then raise exception 'unknown or unavailable source %', p_source; end if;
end $$;

-- ================================================================= grants
do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.proname like 'dr\_%' loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
    execute format('grant execute on function %s to service_role', f.sig);
  end loop;
end $$;

grant execute on function public.dr_public_sources(), public.dr_overview(), public.dr_activity(integer),
  public.dr_recent_signals(integer, integer), public.dr_clusters_list(integer, integer, text, integer, text, integer),
  public.dr_cluster_timeline(uuid, integer), public.dr_is_admin() to anon, authenticated;
grant execute on function public.dr_cluster_evidence(uuid, integer),
  public.dr_admin_set_source(text, boolean, integer) to authenticated;
