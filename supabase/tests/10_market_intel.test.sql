-- Run with: psql -v ON_ERROR_STOP=1 -d <db> -f supabase/tests/10_market_intel.test.sql
-- (after 00_stub_supabase.sql + the migrations). Fails loudly on any broken assertion.
\set ON_ERROR_STOP on
begin;

-- helper: 768-dim embedding as json (unit basis vector a, plus small component on b)
create function pg_temp.emb(a int, b int default null, eps float default 0.05) returns jsonb language sql as $$
  select jsonb_agg(case when i = a then 1.0 when b is not null and i = b then eps else 0.0 end order by i)
  from generate_series(0, 767) i $$;

create function pg_temp.rec(src text, id text, disc text, title text, pub timestamptz, hash text default 'h1', eng jsonb default '{"score":5}')
returns jsonb language sql as $$
  select jsonb_build_object('source_id', src, 'source_record_id', id, 'discussion_key', disc, 'kind', 'issue',
    'url', 'https://example.org/' || id, 'title', title, 'excerpt', 'excerpt ' || title, 'published_at', pub,
    'engagement', eng, 'categories', jsonb_build_array('c1'), 'license', 'test', 'content_hash', hash) $$;

-- ---------------------------------------------------------------- 1. upsert + dedup
do $$
declare r jsonb; v_total bigint;
begin
  r := public.dr_upsert_records(jsonb_build_array(
    pg_temp.rec('github', 'g1', 'github:g1', 'Need offline sync for invoices', now() - interval '3 days'),
    pg_temp.rec('github', 'g1', 'github:g1', 'Need offline sync for invoices', now() - interval '3 days'),   -- in-batch duplicate
    pg_temp.rec('hackernews', 'h1', 'hackernews:h1', 'Ask HN: how do you sync invoices offline?', now() - interval '2 days'),
    jsonb_set(pg_temp.rec('github', 'bad', 'github:bad', 'bad url', now()), '{url}', '"javascript:alert(1)"'),
    jsonb_set(pg_temp.rec('nosuchsource', 'x', 'x:x', 'unknown source', now()), '{source_id}', '"nosuchsource"')));
  assert (r->>'inserted')::int = 2, format('inserted expected 2 got %s', r);
  assert (r->>'invalid')::int >= 1, 'bad url must be counted invalid';

  r := public.dr_upsert_records(jsonb_build_array(pg_temp.rec('github', 'g1', 'github:g1', 'Need offline sync for invoices', now() - interval '3 days')));
  assert (r->>'inserted')::int = 0 and (r->>'updated')::int = 0 and (r->>'duplicates')::int = 1, format('retry must be a pure duplicate: %s', r);

  select count(*) into v_total from public.dr_raw_records where url like 'javascript:%';
  assert v_total = 0, 'non-http url stored';
  assert (select records_total from public.dr_sources where id = 'github') = 1, 'records_total github';
  assert (select records_total from public.dr_sources where id = 'hackernews') = 1, 'records_total hn';

  -- changed content re-queues analysis; engagement-only change updates without re-queue
  update public.dr_raw_records set analysis_status = 'done', analyzed_hash = content_hash where source_record_id = 'g1';
  r := public.dr_upsert_records(jsonb_build_array(pg_temp.rec('github', 'g1', 'github:g1', 'Need offline sync for invoices', now(), 'h1', '{"score":9}')));
  assert (r->>'updated')::int = 1, 'engagement change should update';
  assert (select analysis_status from public.dr_raw_records where source_record_id = 'g1') = 'done', 'engagement-only change must not re-queue';
  r := public.dr_upsert_records(jsonb_build_array(pg_temp.rec('github', 'g1', 'github:g1', 'Need offline sync for invoices (edited)', now(), 'h2')));
  assert (select analysis_status from public.dr_raw_records where source_record_id = 'g1') = 'pending', 'content change must re-queue';
  assert (select count(*) from public.dr_raw_records) = 2, 'no accidental duplication';
  assert public.dr_existing_ids('github', array['g1', 'zzz']) = array['g1'], 'existing ids';
end $$;

-- ---------------------------------------------------------------- 2. signals + embedding clustering
do $$
declare ids uuid[]; v_pending jsonb; n int; c1 uuid; c2 uuid; v_clusters int;
begin
  -- more records: close semantic neighbours across sources, plus an unrelated one
  perform public.dr_upsert_records(jsonb_build_array(
    pg_temp.rec('stackexchange', 's1', 'stackexchange:s1', 'Software to sync invoices without internet?', now() - interval '1 day'),
    pg_temp.rec('github', 'g2', 'github:g2', 'Dark mode for dashboard', now() - interval '1 day')));
  v_pending := public.dr_claim_pending_records(50);
  assert jsonb_array_length(v_pending) = 4, format('pending expected 4: %s', jsonb_array_length(v_pending));

  n := public.dr_save_signals(jsonb_build_array(
    jsonb_build_object('record_id', (select id from public.dr_raw_records where source_record_id = 'g1'), 'content_hash', 'h2',
      'analysis_method', 'llm', 'model', 'test', 'is_problem', true, 'signal_type', 'feature_request',
      'problem_statement', 'Small businesses cannot sync invoices offline', 'industry', 'Finance & Payments', 'use_case', 'offline invoicing',
      'severity', 4, 'wtp_evidence', true, 'wtp_quote', 'we would pay', 'competitors', jsonb_build_array('Xero'), 'embedding', pg_temp.emb(0, 1)),
    jsonb_build_object('record_id', (select id from public.dr_raw_records where source_record_id = 'h1'), 'content_hash', 'h1',
      'analysis_method', 'llm', 'model', 'test', 'is_problem', true, 'signal_type', 'unmet_need',
      'problem_statement', 'No good way to sync invoices without internet', 'industry', 'Finance & Payments', 'severity', 3,
      'competitors', jsonb_build_array('Xero', 'QuickBooks'), 'embedding', pg_temp.emb(0, 2)),
    jsonb_build_object('record_id', (select id from public.dr_raw_records where source_record_id = 's1'), 'content_hash', 'h1',
      'analysis_method', 'llm', 'model', 'test', 'is_problem', true, 'signal_type', 'unmet_need',
      'problem_statement', 'Looking for invoice software that works offline', 'industry', 'Finance & Payments', 'severity', 4, 'embedding', pg_temp.emb(0, 3)),
    jsonb_build_object('record_id', (select id from public.dr_raw_records where source_record_id = 'g2'), 'content_hash', 'h1',
      'analysis_method', 'llm', 'model', 'test', 'is_problem', true, 'signal_type', 'feature_request',
      'problem_statement', 'Dashboard lacks a dark mode', 'industry', 'Developer Tools & DevOps', 'severity', 1, 'embedding', pg_temp.emb(500))));
  assert n = 4, format('signals saved expected 4 got %s', n);

  -- stale hash is ignored (record changed after claim)
  assert public.dr_save_signals(jsonb_build_array(jsonb_build_object('record_id', (select id from public.dr_raw_records where source_record_id = 'g2'),
    'content_hash', 'WRONG', 'analysis_method', 'llm', 'is_problem', false, 'signal_type', 'other'))) = 0, 'stale hash must be ignored';
  assert (select count(*) from public.dr_raw_records where analysis_status = 'pending') = 0, 'all analysed';

  assert public.dr_assign_pending_clusters(100, 0.8, 0.5) = 4, 'four signals to cluster';
  select count(*) into v_clusters from public.dr_clusters;
  assert v_clusters = 2, format('expected 2 clusters (3 similar + 1 unrelated) got %s', v_clusters);
  select cluster_id into c1 from public.dr_problem_signals where problem_statement like 'Small businesses%';
  assert (select count(*) from public.dr_problem_signals where cluster_id = c1) = 3, 'three offline-invoice records share a cluster';
  assert public.dr_assign_pending_clusters(100) = 0, 'clustering is idempotent';

  -- scoring + cross-platform stats
  assert public.dr_refresh_clusters(10) = 2, 'two dirty clusters refreshed';
  assert (select source_count from public.dr_clusters where id = c1) = 3, 'cross-platform: github + hackernews + stackexchange';
  assert (select unique_discussions from public.dr_clusters where id = c1) = 3, 'unique discussions';
  assert (select wtp_signals from public.dr_clusters where id = c1) = 1, 'wtp evidence count';
  assert (select competitors->>'xero' from public.dr_clusters where id = c1) = '2', 'competitor counted per discussion';
  assert (select growth_rate from public.dr_clusters where id = c1) is null, 'growth must be null with insufficient data';
  assert (select scores#>>'{components,demandGrowth,basis}' from public.dr_clusters where id = c1) = 'insufficient_data', 'growth basis labelled';
  assert (select scores#>>'{components,painIntensity,basis}' from public.dr_clusters where id = c1) = 'ai_estimate', 'severity labelled as estimate';
  assert (select scores#>>'{components,problemFrequency,basis}' from public.dr_clusters where id = c1) = 'measured', 'frequency labelled measured';
  assert (select composite_score from public.dr_clusters where id = c1) between 1 and 100, 'composite in range';
  assert (select confidence from public.dr_clusters where id = c1) = 'medium', 'confidence medium for 3 discussions / 3 sources';
  assert (select (scores->>'coverage')::numeric from public.dr_clusters where id = c1) < 1, 'coverage < 1 when components missing';
end $$;

-- ---------------------------------------------------------------- 3. growth is measured from publication dates
do $$
declare c uuid; i int; rid uuid;
begin
  for i in 1..8 loop
    perform public.dr_upsert_records(jsonb_build_array(pg_temp.rec('github', 'gr' || i, 'github:gr' || i, 'growth ' || i,
      case when i <= 6 then now() - interval '5 days' - (i || ' hours')::interval else now() - interval '40 days' end)));
    select id into rid from public.dr_raw_records where source_record_id = 'gr' || i;
    perform public.dr_save_signals(jsonb_build_array(jsonb_build_object('record_id', rid, 'content_hash', 'h1', 'analysis_method', 'llm',
      'is_problem', true, 'signal_type', 'complaint', 'problem_statement', 'Export to CSV is broken for large reports',
      'industry', 'Data & Analytics', 'severity', 5, 'embedding', pg_temp.emb(100, 101))));
  end loop;
  perform public.dr_assign_pending_clusters(100);
  perform public.dr_refresh_clusters(10);
  select id into c from public.dr_clusters where title like 'Export to CSV%';
  assert (select recent_discussions from public.dr_clusters where id = c) = 6, 'recent window';
  assert (select prior_discussions from public.dr_clusters where id = c) = 2, 'prior window';
  assert (select growth_rate from public.dr_clusters where id = c) = 200.0, format('growth (6-2)/2=200%% got %s', (select growth_rate from public.dr_clusters where id = c));
  assert (select scores#>>'{components,demandGrowth,basis}' from public.dr_clusters where id = c) = 'measured', 'growth measured';
end $$;

-- ---------------------------------------------------------------- 4. trigram fallback (no embeddings)
do $$
declare rid uuid; i int; n int;
begin
  for i in 1..3 loop
    perform public.dr_upsert_records(jsonb_build_array(pg_temp.rec('hackernews', 'tr' || i, 'hackernews:tr' || i, 'x', now())));
    select id into rid from public.dr_raw_records where source_record_id = 'tr' || i;
    perform public.dr_save_signals(jsonb_build_array(jsonb_build_object('record_id', rid, 'content_hash', 'h1', 'analysis_method', 'heuristic',
      'is_problem', true, 'signal_type', 'complaint',
      'problem_statement', case i when 3 then 'Hospital shift scheduling software is too expensive' else 'Restaurant inventory tracking spreadsheet is painful' end)));
  end loop;
  perform public.dr_assign_pending_clusters(100, 0.8, 0.5);
  assert (select count(distinct cluster_id) from public.dr_problem_signals where record_id in
    (select id from public.dr_raw_records where source_record_id in ('tr1', 'tr2'))) = 1, 'trigram: identical statements share a cluster';
  assert (select count(distinct cluster_id) from public.dr_problem_signals where record_id in
    (select id from public.dr_raw_records where source_record_id in ('tr1', 'tr3'))) = 2, 'trigram: unrelated statements stay apart';
end $$;

-- ---------------------------------------------------------------- 5. scheduling, locking, backoff
do $$
declare claimed jsonb; run1 uuid; again jsonb; v_next timestamptz; v_errs int;
begin
  claimed := public.dr_claim_due_sources(5, null, 600, 'schedule');
  assert jsonb_array_length(claimed) = 3, format('three implemented+enabled sources due: %s', claimed);
  assert not exists (select 1 from jsonb_array_elements(claimed) e where e->>'id' in ('reddit', 'google_trends', 'producthunt', 'kaggle', 'opendata')),
    'skipped sources must never be claimed';
  again := public.dr_claim_due_sources(5, null, 600, 'schedule');
  assert jsonb_array_length(again) = 0, 'locked sources must not be claimed twice (no duplicate jobs)';
  assert jsonb_array_length(public.dr_claim_due_sources(1, 'github', 600, 'manual')) = 0, 'manual sync cannot double-run a locked source';
  assert (select count(*) from public.dr_collection_runs) = 3, 'one run row per claim';

  select (e->>'run_id')::uuid into run1 from jsonb_array_elements(claimed) e where e->>'id' = 'github';
  perform public.dr_finish_run(run1, 'github', 'success', '{"cursor":"x"}', '{"requests":4,"fetched":10,"inserted":7,"updated":1,"duplicates":2}', null);
  select next_run_at into v_next from public.dr_sources where id = 'github';
  assert v_next > now() + interval '179 minutes' and v_next < now() + interval '181 minutes', 'next run = interval';
  assert (select cursor->>'cursor' from public.dr_sources where id = 'github') = 'x', 'cursor persisted';
  assert (select last_success_at from public.dr_sources where id = 'github') is not null, 'last success stamped';
  assert (select inserted from public.dr_collection_runs where id = run1) = 7, 'run stats stored';
  assert jsonb_array_length(public.dr_claim_due_sources(5, null, 600, 'schedule')) = 0, 'not due again until next_run_at';

  -- manual sync of an idle enabled source works even when not due
  claimed := public.dr_claim_due_sources(1, 'github', 600, 'manual');
  assert jsonb_array_length(claimed) = 1 and exists (select 1 from public.dr_collection_runs where trigger = 'manual' and source_id = 'github'), 'manual sync';
  run1 := (claimed->0->>'run_id')::uuid;
  perform public.dr_finish_run(run1, 'github', 'error', null, '{"errors":1}', 'boom');
  perform public.dr_finish_run(run1, 'github', 'error', null, '{"errors":1}', 'boom again');
  select next_run_at, consecutive_errors into v_next, v_errs from public.dr_sources where id = 'github';
  assert v_errs = 2 and v_next > now() + interval '359 minutes', format('exponential backoff after errors: %s %s', v_errs, v_next);
  assert (select status from public.dr_sources where id = 'github') = 'error', 'error status';
  assert (select cursor->>'cursor' from public.dr_sources where id = 'github') = 'x', 'cursor kept after failure';

  assert public.dr_acquire_lock('analysis', 60) and not public.dr_acquire_lock('analysis', 60), 'lock excludes second holder';
  perform public.dr_release_lock('analysis');
  assert public.dr_acquire_lock('analysis', 60), 'lock reacquirable after release';
  perform public.dr_note_usage('github', 3, 1, 1); perform public.dr_note_usage('github', 2, 0, 0);
  assert (select requests from public.dr_api_usage where source_id = 'github') = 5, 'usage accumulates';
  perform public.dr_set_quota('stackexchange', 300, 250, now() + interval '1 day');
  assert (select quota_remaining from public.dr_sources where id = 'stackexchange') = 250, 'quota stored';
end $$;

-- ---------------------------------------------------------------- 6. summaries
do $$
declare c uuid; r jsonb;
begin
  select id into c from public.dr_clusters where title like 'Small businesses%';
  r := public.dr_clusters_needing_summary(5, 3);
  assert jsonb_array_length(r) >= 1, 'cluster with 3 members needs summary';
  perform public.dr_save_cluster_summary(c, '{"title":"Offline invoicing","development_feasibility":4}');
  assert (select summary_dirty from public.dr_clusters where id = c) = false, 'summary clean';
  perform public.dr_refresh_clusters(10);
  assert (select scores#>>'{components,developmentFeasibility,value}' from public.dr_clusters where id = c)::numeric = 75, 'feasibility 4/5 -> 75';
end $$;

-- ---------------------------------------------------------------- 7. permissions (RLS / grants)
do $$ begin
  perform set_config('request.jwt.claim.sub', '', true);
end $$;
set local role anon;
do $$
declare ok boolean; j jsonb;
begin
  begin perform count(*) from public.dr_raw_records; ok := false; exception when insufficient_privilege then ok := true; end;
  assert ok, 'anon must not read raw records';
  begin perform count(*) from public.dr_clusters; ok := false; exception when insufficient_privilege then ok := true; end;
  assert ok, 'anon must not read clusters table directly';
  begin perform public.dr_upsert_records('[]'); ok := false; exception when insufficient_privilege then ok := true; end;
  assert ok, 'anon must not call collector functions';
  begin perform public.dr_claim_due_sources(); ok := false; exception when insufficient_privilege then ok := true; end;
  assert ok, 'anon must not claim sources';
  begin perform public.dr_cluster_evidence(gen_random_uuid()); ok := false; exception when insufficient_privilege then ok := true; end;
  assert ok, 'anon must not read evidence';

  j := public.dr_public_sources();
  assert jsonb_array_length(j) = 8, 'all 8 sources listed (3 implemented + 5 skipped with reasons)';
  assert (select count(*) from jsonb_array_elements(j) e where e->>'status' = 'unavailable') = 5, 'skipped sources show unavailable';
  assert (select bool_and(e->>'skip_reason' is not null) from jsonb_array_elements(j) e where e->>'availability' = 'skipped'), 'skip reasons documented';
  assert (public.dr_overview()->>'clusters_total')::int >= 3, 'overview readable';
  assert jsonb_array_length(public.dr_clusters_list(10, 0, null, 1, 'score')->'items') >= 3, 'clusters readable via RPC';
  assert (public.dr_clusters_list(10, 0, null, 2, 'score')->>'total')::int = 1, 'multi-source filter';
  assert (public.dr_clusters_list(10, 0, null, 1, 'score', 3)->>'total')::int = 2, 'min-discussions filter hides single mentions (3-discussion offline cluster + 8-discussion CSV cluster)';
  assert jsonb_array_length(public.dr_recent_signals(5, 0)) = 5, 'recent signals';
  assert (public.dr_is_admin()) = false, 'anon is not admin';
end $$;
reset role;

do $$ begin perform set_config('request.jwt.claim.sub', '11111111-1111-1111-1111-111111111111', true); end $$;
set local role authenticated;
do $$
declare ok boolean; c uuid;
begin
  select (public.dr_clusters_list(1, 0, null, 2, 'score')->'items'->0->>'id')::uuid into c;
  assert jsonb_array_length(public.dr_cluster_evidence(c, 10)) = 3, 'signed-in user reads evidence';
  begin perform public.dr_admin_set_source('github', false, null); ok := false; exception when insufficient_privilege then ok := true; end;
  assert ok, 'non-admin cannot change sources';
end $$;
reset role;

insert into public.dr_admins (user_id) values ('11111111-1111-1111-1111-111111111111');
set local role authenticated;
do $$
begin
  assert public.dr_is_admin(), 'admin recognised';
  perform public.dr_admin_set_source('github', false, 60);
  assert (select e->>'status' from jsonb_array_elements(public.dr_public_sources()) e where e->>'id' = 'github') = 'disabled', 'disabled via admin RPC';
  perform public.dr_admin_set_source('github', true, null);
  assert (select e->>'status' from jsonb_array_elements(public.dr_public_sources()) e where e->>'id' = 'github') <> 'disabled', 're-enabled via admin RPC';
  assert (select (e->>'interval_minutes')::int from jsonb_array_elements(public.dr_public_sources()) e where e->>'id' = 'github') = 60, 'interval updated';
  assert public.dr_public_sources() is not null;
end $$;
reset role;

do $$ begin
  begin perform public.dr_admin_set_source('reddit', true, null); assert false, 'skipped source must not be enable-able';
  exception when others then if sqlerrm like 'assert%' or sqlerrm like '%must not be%' then raise; end if; end;
end $$;

rollback;
\echo ALL SQL TESTS PASSED
