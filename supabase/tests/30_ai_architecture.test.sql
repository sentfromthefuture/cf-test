-- Tests for 20261109000000_ai_results_cache.sql (AI result cache, usage counters, per-signal AI outputs, evidence profile).
-- Run with: psql -v ON_ERROR_STOP=1 -d <db> -f supabase/tests/30_ai_architecture.test.sql
-- (after 00_stub_supabase.sql + the market-intel migrations + 20261109000000_ai_results_cache.sql). Fails loudly on any broken assertion.
-- Pure SQL: no external service is called. Everything runs inside one transaction that is rolled back.
\set ON_ERROR_STOP on
begin;

create function pg_temp.h(n text) returns text language sql as $$ select md5(n) || md5(n || 'x') $$;   -- 64 hex chars

-- ---------------------------------------------------------------- 1. canonical URL (same cases as decisions.test.ts)
do $$
declare c record;
begin
  for c in select * from (values
    ('https://www.Example.org/a/b/',                         'example.org/a/b'),
    ('http://example.org/a#frag',                            'example.org/a'),
    ('https://example.org/a?utm_source=x&utm_medium=y',      'example.org/a'),
    ('https://example.org/a?id=7&utm_source=x',              'example.org/a?id=7'),
    ('https://example.org/a?utm_source=x&id=7',              'example.org/a?id=7'),
    ('https://news.ycombinator.com/item?id=123',             'news.ycombinator.com/item?id=123'),
    ('https://example.org/a?fbclid=abc&gclid=def&ref=twitter', 'example.org/a'),
    ('  HTTPS://EXAMPLE.ORG  ',                              'example.org'),
    ('',                                                      null)
  ) as t(input, expected) loop
    assert public.dr_norm_url(c.input) is not distinct from c.expected,
      format('dr_norm_url(%L) = %L, expected %L', c.input, public.dr_norm_url(c.input), c.expected);
  end loop;
  assert public.dr_norm_url(null) is null, 'null stays null';
end $$;

-- ---------------------------------------------------------------- 2. cache state machine
do $$
declare b jsonb; id1 uuid; e1 bigint; ok boolean; r record;
begin
  -- first caller claims, a second caller for the same identity is told to wait (no duplicate concurrent processing)
  b := public.dr_ai_cache_begin('decisions', pg_temp.h('a'), 'parallel/decisions-fast:free', 'v1');
  assert b->>'state' = 'claimed', format('first caller claims: %s', b);
  id1 := (b->>'id')::uuid;
  e1 := (b->>'epoch')::bigint;
  assert e1 = 1, format('first lease has epoch 1, got %s', b);
  assert public.dr_ai_cache_begin('decisions', pg_temp.h('a'), 'parallel/decisions-fast:free', 'v1')->>'state' = 'busy', 'second caller must not compute';

  -- a failed/partial answer can never be stored as a success
  begin perform public.dr_ai_cache_complete(id1, e1, null); assert false, 'null result accepted';
  exception when others then if sqlerrm like 'assert%' then raise; end if; end;
  begin perform public.dr_ai_cache_complete(id1, e1, '[1,2]'::jsonb); assert false, 'non-object result accepted';
  exception when others then if sqlerrm like 'assert%' then raise; end if; end;
  assert (select status from public.dr_ai_cache where id = id1) = 'pending', 'rejected completes leave the row pending';
  begin insert into public.dr_ai_cache (task, input_hash, model, config_version, status, result)
          values ('decisions', pg_temp.h('direct'), 'm', 'v1', 'succeeded', null); assert false, 'succeeded without result accepted';
  exception when check_violation then null; end;
  begin insert into public.dr_ai_cache (task, input_hash, model, config_version, status, result)
          values ('decisions', pg_temp.h('direct2'), 'm', 'v1', 'failed', '{"x":1}'); assert false, 'failed row holding a result accepted';
  exception when check_violation then null; end;

  -- success is stored, then reused (hit), and counted
  assert public.dr_ai_cache_complete(id1, e1, '{"problemProbability":0.9}'::jsonb, '[{"url":"https://a.example/x"}]'::jsonb, '{"inputTokens":10}'::jsonb), 'complete returns true';
  assert not public.dr_ai_cache_complete(id1, e1, '{"problemProbability":0.1}'::jsonb), 'a finished row cannot be completed again (first result wins)';
  b := public.dr_ai_cache_begin('decisions', pg_temp.h('a'), 'parallel/decisions-fast:free', 'v1');
  assert b->>'state' = 'hit' and (b->'result'->>'problemProbability')::numeric = 0.9, format('reuse: %s', b);
  assert b->'citations'->0->>'url' = 'https://a.example/x', 'citations are returned with the hit';
  assert (public.dr_ai_cache_begin('decisions', pg_temp.h('a'), 'parallel/decisions-fast:free', 'v1')->>'state') = 'hit', 'still a hit';
  assert (select hit_count from public.dr_ai_cache where id = id1) = 2, 'hits are counted';

  -- cache identity: a different model, config version, input hash or task is NOT served the old result
  assert public.dr_ai_cache_begin('decisions', pg_temp.h('a'), 'parallel/decisions-fast:free', 'v2')->>'state' = 'claimed', 'new config version invalidates';
  assert public.dr_ai_cache_begin('decisions', pg_temp.h('a'), 'other/model:free', 'v1')->>'state' = 'claimed', 'new model invalidates';
  assert public.dr_ai_cache_begin('decisions', pg_temp.h('b'), 'parallel/decisions-fast:free', 'v1')->>'state' = 'claimed', 'new input hash misses';
  assert public.dr_ai_cache_begin('summary', pg_temp.h('a'), 'parallel/decisions-fast:free', 'v1')->>'state' = 'claimed', 'tasks do not share entries';
  assert (select status from public.dr_ai_cache where id = id1) = 'succeeded' and
         (select result->>'problemProbability' from public.dr_ai_cache where id = id1) = '0.9', 'the original entry is untouched';
  begin perform public.dr_ai_cache_begin('chat', pg_temp.h('a'), 'm', 'v1'); assert false, 'unknown task accepted';
  exception when check_violation then null; end;
  begin perform public.dr_ai_cache_begin('decisions', 'not-a-hash', 'm', 'v1'); assert false, 'bad hash accepted';
  exception when check_violation then null; end;

  -- input-level failure: no result stored, cooldown grows 1h -> 2h, then the row can be retried
  b := public.dr_ai_cache_begin('decisions', pg_temp.h('bad'), 'm', 'v1');
  assert b->>'state' = 'claimed';
  assert public.dr_ai_cache_fail((b->>'id')::uuid, (b->>'epoch')::bigint, 'invalid_response'), 'fail recorded';
  select * into r from public.dr_ai_cache where id = (b->>'id')::uuid;
  assert r.status = 'failed' and r.result is null and r.failed_attempts = 1 and r.last_failure = 'invalid_response', 'failure recorded without a result';
  assert r.retry_after > now() + interval '59 minutes' and r.retry_after <= now() + interval '61 minutes', format('first cooldown ~1h, got %s', r.retry_after - now());
  assert public.dr_ai_cache_begin('decisions', pg_temp.h('bad'), 'm', 'v1')->>'state' = 'cooldown', 'no retry during cooldown';
  update public.dr_ai_cache set retry_after = now() - interval '1 second' where id = r.id;
  b := public.dr_ai_cache_begin('decisions', pg_temp.h('bad'), 'm', 'v1');
  assert b->>'state' = 'claimed' and (b->>'epoch')::bigint = 2, format('retry allowed after the cooldown, with a newer epoch: %s', b);
  assert public.dr_ai_cache_fail(r.id, (b->>'epoch')::bigint, 'invalid_response');
  assert (select retry_after from public.dr_ai_cache where id = r.id) between now() + interval '119 minutes' and now() + interval '121 minutes', 'second cooldown ~2h';
  assert not public.dr_ai_cache_fail(r.id, (b->>'epoch')::bigint, 'again'), 'fail only applies to a pending row';

  -- service-level problem: release without blaming the input
  b := public.dr_ai_cache_begin('decisions', pg_temp.h('svc'), 'm', 'v1');
  perform public.dr_ai_cache_abandon((b->>'id')::uuid, (b->>'epoch')::bigint);
  assert not exists (select 1 from public.dr_ai_cache where id = (b->>'id')::uuid), 'abandon with no history removes the lease row';
  assert public.dr_ai_cache_begin('decisions', pg_temp.h('svc'), 'm', 'v1')->>'state' = 'claimed', 'immediately retryable after a service outage';
  -- ... and keeps earlier failure history when there was some
  update public.dr_ai_cache set retry_after = now() - interval '1 second' where id = r.id;
  b := public.dr_ai_cache_begin('decisions', pg_temp.h('bad'), 'm', 'v1');
  perform public.dr_ai_cache_abandon((b->>'id')::uuid, (b->>'epoch')::bigint);
  assert (select status || failed_attempts::text from public.dr_ai_cache where id = r.id) = 'failed2', 'history kept, attempts not inflated';

  -- crashed worker: an expired lease can be taken over
  b := public.dr_ai_cache_begin('decisions', pg_temp.h('crash'), 'm', 'v1');
  assert public.dr_ai_cache_begin('decisions', pg_temp.h('crash'), 'm', 'v1')->>'state' = 'busy';
  update public.dr_ai_cache set lease_until = now() - interval '1 second' where id = (b->>'id')::uuid;
  assert public.dr_ai_cache_begin('decisions', pg_temp.h('crash'), 'm', 'v1')->>'state' = 'claimed', 'expired lease is taken over';

  -- corrupt/obsolete stored result can be dropped so it is recomputed once
  perform public.dr_ai_cache_invalidate(id1);
  assert public.dr_ai_cache_begin('decisions', pg_temp.h('a'), 'parallel/decisions-fast:free', 'v1')->>'state' = 'claimed', 'invalidate -> recompute';
end $$;

-- ---------------------------------------------------------------- 2b. lease fencing: an expired worker cannot finish, fail or release a newer holder's lease
do $$
declare a jsonb; b jsonb; ea bigint; eb bigint; r public.dr_ai_cache%rowtype; k text := pg_temp.h('fence');
begin
  a := public.dr_ai_cache_begin('decisions', k, 'm', 'v1', 30);
  assert a->>'state' = 'claimed', 'A claims';
  ea := (a->>'epoch')::bigint;
  -- A's lease expires (slow request, paused worker); B takes over the same entry and the epoch moves forward
  update public.dr_ai_cache set lease_until = now() - interval '1 second' where id = (a->>'id')::uuid;
  b := public.dr_ai_cache_begin('decisions', k, 'm', 'v1', 30);
  assert b->>'state' = 'claimed' and b->>'id' = a->>'id', 'B took over the same entry';
  eb := (b->>'epoch')::bigint;
  assert eb > ea, format('the epoch must increase on takeover (%s -> %s)', ea, eb);

  -- the expired worker A can do nothing to the entry B now owns
  assert not public.dr_ai_cache_complete((a->>'id')::uuid, ea, '{"from":"A"}'::jsonb), 'a stale complete is refused';
  assert not public.dr_ai_cache_fail((a->>'id')::uuid, ea, 'stale'), 'a stale fail is refused';
  perform public.dr_ai_cache_abandon((a->>'id')::uuid, ea);   -- before fencing this DELETED B's lease
  select * into r from public.dr_ai_cache where id = (a->>'id')::uuid;
  assert found and r.status = 'pending' and r.result is null and r.lease_epoch = eb and r.failed_attempts = 0 and r.lease_until > now(),
    format('B''s lease must be untouched by A: %s', r);
  assert public.dr_ai_cache_begin('decisions', k, 'm', 'v1')->>'state' = 'busy', 'a third worker still sees B''s lease';
  assert not public.dr_ai_cache_complete((a->>'id')::uuid, eb + 100, '{"from":"X"}'::jsonb), 'an epoch that was never issued is refused';
  assert not public.dr_ai_cache_complete((a->>'id')::uuid, null, '{"from":"null"}'::jsonb), 'a missing epoch is refused';

  -- B, the current holder, completes; A cannot overwrite the result afterwards either
  assert public.dr_ai_cache_complete((b->>'id')::uuid, eb, '{"from":"B"}'::jsonb), 'the current holder completes';
  assert not public.dr_ai_cache_complete((a->>'id')::uuid, ea, '{"from":"A"}'::jsonb), 'a late stale complete is refused';
  select * into r from public.dr_ai_cache where id = (a->>'id')::uuid;
  assert r.status = 'succeeded' and r.result->>'from' = 'B', format('the stored result is the current holder''s: %s', r.result);

  -- a takeover of a failed entry (cooldown elapsed) is fenced the same way
  a := public.dr_ai_cache_begin('decisions', pg_temp.h('fence2'), 'm', 'v1'); ea := (a->>'epoch')::bigint;
  assert public.dr_ai_cache_fail((a->>'id')::uuid, ea, 'invalid_response');
  update public.dr_ai_cache set retry_after = now() - interval '1 second' where id = (a->>'id')::uuid;
  b := public.dr_ai_cache_begin('decisions', pg_temp.h('fence2'), 'm', 'v1');
  assert b->>'state' = 'claimed' and (b->>'epoch')::bigint > ea, 'the retry holds a newer epoch';
  assert not public.dr_ai_cache_fail((a->>'id')::uuid, ea, 'again'), 'a stale fail cannot touch the new attempt';
  assert not public.dr_ai_cache_complete((a->>'id')::uuid, ea, '{"from":"A"}'::jsonb), 'nor can a stale complete';
  select * into r from public.dr_ai_cache where id = (a->>'id')::uuid;
  assert r.status = 'pending' and r.lease_epoch = (b->>'epoch')::bigint and r.failed_attempts = 1, 'new attempt intact, history kept';
end $$;

-- housekeeping
do $$
declare b jsonb; n integer;
begin
  b := public.dr_ai_cache_begin('summary', pg_temp.h('old'), 'm', 'v1');
  perform public.dr_ai_cache_complete((b->>'id')::uuid, (b->>'epoch')::bigint, '{"t":1}');
  update public.dr_ai_cache set completed_at = now() - interval '400 days' where id = (b->>'id')::uuid;
  b := public.dr_ai_cache_begin('summary', pg_temp.h('fresh'), 'm', 'v1');
  perform public.dr_ai_cache_complete((b->>'id')::uuid, (b->>'epoch')::bigint, '{"t":2}');
  n := public.dr_ai_cache_prune(180);
  assert n >= 1, 'prune removed the stale result';
  assert public.dr_ai_cache_begin('summary', pg_temp.h('fresh'), 'm', 'v1')->>'state' = 'hit', 'recent results survive prune';
  assert public.dr_ai_cache_begin('summary', pg_temp.h('old'), 'm', 'v1')->>'state' = 'claimed', 'pruned result is gone';
  begin perform public.dr_ai_cache_prune(1); assert false, 'prune with tiny window accepted';
  exception when others then if sqlerrm like 'assert%' then raise; end if; end;
end $$;

-- ---------------------------------------------------------------- 3. usage counters
do $$
declare u public.dr_ai_usage%rowtype;
begin
  perform public.dr_ai_note_usage('decisions', '{"calls":3,"successes":2,"failures":1,"rate_limited":1,"http_requests":4,"cache_hits":5,"cache_misses":3,"input_tokens":100,"output_tokens":20,"reported_cost_usd":0.0004,"cost_reported_calls":2,"duration_ms":900}');
  perform public.dr_ai_note_usage('decisions', '{"calls":1,"successes":1,"http_requests":1,"input_tokens":50,"reported_cost_usd":-5,"calls_typo":9}');
  perform public.dr_ai_note_usage('decisions', null);
  select * into u from public.dr_ai_usage where engine = 'decisions';
  assert u.calls = 4 and u.successes = 3 and u.failures = 1 and u.rate_limited = 1 and u.http_requests = 5, format('counters add up: %s', u);
  assert u.cache_hits = 5 and u.cache_misses = 3 and u.input_tokens = 150 and u.output_tokens = 20 and u.duration_ms = 900, 'cache + token counters';
  assert u.reported_cost_usd = 0.0004 and u.cost_reported_calls = 2, 'negative cost is ignored, reported cost and its coverage are tracked separately';
  begin perform public.dr_ai_note_usage('gemini', '{}'); assert false, 'unknown engine accepted';
  exception when check_violation then null; end;
end $$;

-- ---------------------------------------------------------------- 4. clusters of signals (heuristic clustering, no embeddings)
create function pg_temp.r2(src text, id text, disc text, title text, pub timestamptz, url text default null)
returns jsonb language sql as $$
  select jsonb_build_object('source_id', src, 'source_record_id', id, 'discussion_key', disc, 'kind', 'issue',
    'url', coalesce(url, 'https://example.org/' || id), 'title', title, 'excerpt', 'excerpt ' || title, 'published_at', pub,
    'engagement', '{"score":5}'::jsonb, 'categories', jsonb_build_array('c1'), 'license', 'test', 'content_hash', 'h-' || id) $$;

create function pg_temp.sig(rid text, stmt text) returns void language plpgsql as $$
begin
  perform public.dr_save_signals(jsonb_build_array(jsonb_build_object(
    'record_id', (select id from public.dr_raw_records where source_record_id = rid), 'content_hash', 'h-' || rid,
    'analysis_method', 'llm', 'model', 'parallel/decisions-fast:free', 'is_problem', true, 'signal_type', 'complaint',
    'problem_statement', stmt, 'severity', 3)));
end $$;

do $$
declare
  stmt1 constant text := 'Restaurant inventory tracking spreadsheet is painful';
  stmt2 constant text := 'Freelancer invoice reminders are manual and tedious';
  c1 uuid; c2 uuid; p jsonb; p2 jsonb; i int; comp_before numeric; comp_after numeric; n int;
begin
  -- cluster 1: six discussions, but only four INDEPENDENT reports
  --   g1 and h1 are the same text cross-posted      -> collapse by identical opening text
  --   g2 and g3 are different texts, same canonical URL -> collapse by canonical URL
  perform public.dr_upsert_records(jsonb_build_array(
    pg_temp.r2('github',     'g1', 'github:g1',     'Need offline inventory sync',        now() - interval '3 days'),
    pg_temp.r2('hackernews', 'h1', 'hackernews:h1', 'Need offline inventory sync',        now() - interval '3 days'),
    pg_temp.r2('github',     'g2', 'github:g2',     'Inventory counts drift between sites', now() - interval '10 days', 'https://example.org/g2'),
    pg_temp.r2('github',     'g3', 'github:g3',     'Spreadsheet stock levels never match', now() - interval '12 days', 'https://www.Example.org/g2/?utm_source=x#frag'),
    pg_temp.r2('github',     'g4', 'github:g4',     'Stock take is slow and manual',       now() - interval '45 days'),
    pg_temp.r2('github',     'g5', 'github:g5',     'No tool for multi-site stock reports', now() - interval '75 days')));
  perform pg_temp.sig(x, stmt1) from unnest(array['g1','h1','g2','g3','g4','g5']) x;

  -- cluster 2: 8 distinct reports, clearly rising (6 in the last 30 days vs 2 in the 30 before: days 51 and 54)
  for i in 1..8 loop
    perform public.dr_upsert_records(jsonb_build_array(pg_temp.r2('github', 'e' || i, 'github:e' || i, 'Invoice reminder pain number ' || i,
      case when i <= 6 then now() - make_interval(days => i * 4) else now() - make_interval(days => 30 + i * 3) end)));
    perform pg_temp.sig('e' || i, stmt2);
  end loop;

  assert public.dr_assign_pending_clusters(100, 0.8, 0.5) = 14, 'all 14 signals clustered';
  select cluster_id into c1 from public.dr_problem_signals where record_id = (select id from public.dr_raw_records where source_record_id = 'g1');
  select cluster_id into c2 from public.dr_problem_signals where record_id = (select id from public.dr_raw_records where source_record_id = 'e1');
  assert c1 <> c2, 'two clusters';
  assert (select count(*) from public.dr_cluster_members where cluster_id = c1) = 6 and (select count(*) from public.dr_cluster_members where cluster_id = c2) = 8, 'cluster membership';
  perform public.dr_refresh_clusters(10);

  p := public.dr_cluster_profile(c1);
  -- independent evidence: duplicates are not counted as independent
  assert (p->'independent_reports'->>'unique_discussions')::int = 6, format('six discussions: %s', p->'independent_reports');
  assert (p->'independent_reports'->>'count')::int = 4, format('only four independent reports: %s', p->'independent_reports');
  assert (p->'independent_reports'->>'collapsed_duplicates')::int = 2, 'two duplicates collapsed';
  assert (p->'recurring_complaints'->>'problem_signals')::int = 6, 'recurring complaints still count every signal';
  assert (p->'recurring_complaints'->'by_signal_type'->>'complaint')::int = 6;
  -- persistence over time
  assert (p->'persistence'->>'active_weeks')::int = 4, format('four distinct active weeks: %s', p->'persistence');
  assert (p->'persistence'->>'span_weeks')::int >= 11 and (p->'persistence'->>'span_weeks')::int <= 12, 'span ~11-12 weeks';
  assert (p->'persistence'->>'ratio')::numeric > 0 and (p->'persistence'->>'ratio')::numeric < 1, 'ratio between 0 and 1';
  assert (p->'persistence'->>'weeks_since_last_report')::int = 0, 'latest report is this week';
  -- trend: too little data to call a trend
  assert p->'trend'->>'label' = 'insufficient_data' and p->'trend'->'growth_pct' = 'null'::jsonb, format('small sample is not a trend: %s', p->'trend');
  assert (p->'frequency'->>'recent_30d')::int = 2 and (p->'frequency'->>'prior_30d')::int = 1, format('windows: %s', p->'frequency');

  p2 := public.dr_cluster_profile(c2);
  assert p2->'trend'->>'label' = 'emerging' and (p2->'trend'->>'growth_pct')::numeric = 200, format('rising cluster is emerging: %s', p2->'trend');
  assert (p2->'independent_reports'->>'count')::int = 8 and (p2->'independent_reports'->>'collapsed_duplicates')::int = 0, 'no duplicates -> nothing collapsed';
  assert public.dr_cluster_profile('00000000-0000-0000-0000-000000000000') is null, 'unknown cluster -> null';

  -- ---------------------------------------------------------- 5. AI outputs are stored apart and never reach the demand score
  assert (p->'external_research_evidence'->>'citations')::int = 0 and p->'ai_model_confidence'->'average' = 'null'::jsonb, 'no AI data yet';
  -- stale rows (record changed since analysis) and out-of-range values are ignored
  assert public.dr_save_signal_ai(jsonb_build_array(
    jsonb_build_object('record_id', (select id from public.dr_raw_records where source_record_id = 'g1'), 'content_hash', 'STALE', 'problem_probability', 0.9, 'config_version', 'v1'),
    jsonb_build_object('record_id', (select id from public.dr_raw_records where source_record_id = 'g1'), 'content_hash', 'h-g1', 'problem_probability', 1.5, 'config_version', 'v1'),
    jsonb_build_object('record_id', (select id from public.dr_raw_records where source_record_id = 'g1'), 'content_hash', 'h-g1', 'problem_probability', 0.9, 'model_confidence', -0.1, 'config_version', 'v1'))) = 0,
    'stale or out-of-range rows are not saved';

  comp_before := (select composite_score from public.dr_clusters where id = c1);
  assert comp_before is not null, 'demand score exists';
  n := public.dr_save_signal_ai(jsonb_build_array(
    jsonb_build_object('record_id', (select id from public.dr_raw_records where source_record_id = 'g1'), 'content_hash', 'h-g1', 'problem_probability', 0.95, 'model_confidence', 0.99,
      'model', 'parallel/decisions-fast-20261106', 'requested_model', 'parallel/decisions-fast:free', 'config_version', 'v1',
      'citations', jsonb_build_array(jsonb_build_object('url', 'https://www.Docs.example.net/guide?utm_source=a'),
                                      jsonb_build_object('url', 'https://example.org/g1'))),                           -- the post's own URL
    jsonb_build_object('record_id', (select id from public.dr_raw_records where source_record_id = 'g2'), 'content_hash', 'h-g2', 'problem_probability', 0.9, 'model_confidence', 0.97, 'config_version', 'v1',
      'citations', jsonb_build_array(jsonb_build_object('url', 'https://docs.example.net/guide'),
                                      jsonb_build_object('url', 'https://other.example.com/x'),
                                      jsonb_build_object('title', 'no url here')))));
  assert n = 2, 'two AI rows saved';
  p := public.dr_cluster_profile(c1);
  assert (p->'external_research_evidence'->>'citations')::int = 3, format('own URL and URL-less entries excluded: %s', p->'external_research_evidence');
  assert (p->'external_research_evidence'->>'distinct_urls')::int = 2, 'tracking-parameter / www variants are the same source';
  assert (p->'external_research_evidence'->>'distinct_domains')::int = 2;
  assert (p->'ai_model_confidence'->>'average')::numeric = 0.98 and (p->'ai_model_confidence'->>'signals_with_confidence')::int = 2, format('confidence reported separately: %s', p->'ai_model_confidence');

  -- model confidence changes nothing in the demand score; independent-report counts do not move either
  update public.dr_signal_ai set model_confidence = 0.01, problem_probability = 0.51;
  update public.dr_clusters set stats_dirty = true where id = c1;
  perform public.dr_refresh_clusters(10);
  comp_after := (select composite_score from public.dr_clusters where id = c1);
  assert comp_after = comp_before, format('AI confidence must not change the demand score (%s -> %s)', comp_before, comp_after);
  p := public.dr_cluster_profile(c1);
  assert (p->'ai_model_confidence'->>'average')::numeric = 0.01, 'profile reflects the new confidence';
  assert (p->'demand_score'->>'composite_score')::numeric = comp_before, 'profile shows the unchanged demand score';
  assert (p->'independent_reports'->>'count')::int = 4, 'independent reports unaffected by AI data';
end $$;

-- ---------------------------------------------------------------- 5b. severity isolation: an AI severity estimate cannot move the score
-- A Decisions-style signal carries NO severity in dr_problem_signals (the estimate lives only in dr_signal_ai.answers.severity).
create function pg_temp.sig_ns(rid text, stmt text) returns void language plpgsql as $$
begin
  perform public.dr_save_signals(jsonb_build_array(jsonb_build_object(
    'record_id', (select id from public.dr_raw_records where source_record_id = rid), 'content_hash', 'h-' || rid,
    'analysis_method', 'llm', 'model', 'parallel/decisions-fast:free', 'is_problem', true, 'signal_type', 'complaint',
    'problem_statement', stmt)));
end $$;

do $$
declare
  stmt3 constant text := 'Subscription refund tracking is a manual mess';
  c1 uuid; c3 uuid; r record; i int; comp_before numeric; comp_after numeric;
begin
  select cluster_id into c1 from public.dr_problem_signals where record_id = (select id from public.dr_raw_records where source_record_id = 'g1');
  select severity_avg into r from public.dr_clusters where id = c1;
  assert r.severity_avg = 3.00, format('baseline: keyword/LLM-style signals carry severity 3 (avg %s)', r.severity_avg);

  -- (a) a cluster made ONLY of severity-less signals: pain is excluded (insufficient_data), not scored as zero
  for i in 1..4 loop
    perform public.dr_upsert_records(jsonb_build_array(pg_temp.r2('github', 'd' || i, 'github:d' || i, 'Subscription refund tracking pain ' || i, now() - make_interval(days => i * 4))));
    perform pg_temp.sig_ns('d' || i, stmt3);
  end loop;
  -- (b) one severity-less signal joining the existing cluster that already has severity data
  perform public.dr_upsert_records(jsonb_build_array(pg_temp.r2('github', 'd5', 'github:d5', 'Another inventory complaint', now() - interval '2 days')));
  perform pg_temp.sig_ns('d5', 'Restaurant inventory tracking spreadsheet is painful');
  assert public.dr_assign_pending_clusters(100, 0.8, 0.5) = 5, 'five severity-less signals clustered';
  select cluster_id into c3 from public.dr_problem_signals where record_id = (select id from public.dr_raw_records where source_record_id = 'd1');
  assert c3 is not null and c3 <> c1, 'the severity-less signals formed their own cluster';
  assert (select cluster_id from public.dr_problem_signals where record_id = (select id from public.dr_raw_records where source_record_id = 'd5')) = c1, 'd5 joined cluster 1';
  perform public.dr_refresh_clusters(10);

  select * into r from public.dr_clusters where id = c3;
  assert r.severity_avg is null, 'no severity in the demand row => no average';
  assert r.scores->'components'->'painIntensity'->>'basis' = 'insufficient_data' and r.scores->'components'->'painIntensity'->'value' = 'null'::jsonb,
    format('pain is excluded, not zero: %s', r.scores->'components'->'painIntensity');
  assert r.composite_score is not null and r.composite_score > 0, 'the cluster is still scored from its measured components';

  select * into r from public.dr_clusters where id = c1;
  assert r.members_count = 7, format('d5 is a member of cluster 1: %s', r.members_count);
  assert r.severity_avg = 3.00, format('a severity-less signal does not drag the existing severity average: %s', r.severity_avg);

  -- the AI severity estimates are stored in dr_signal_ai, and changing them moves nothing
  comp_before := (select composite_score from public.dr_clusters where id = c3);
  assert public.dr_save_signal_ai(jsonb_build_array(
    jsonb_build_object('record_id', (select id from public.dr_raw_records where source_record_id = 'd1'), 'content_hash', 'h-d1', 'problem_probability', 0.9, 'model_confidence', 0.9, 'config_version', 'v1',
      'answers', jsonb_build_object('severity', jsonb_build_object('value', 5, 'score', 4, 'confidence', 0.99))),
    jsonb_build_object('record_id', (select id from public.dr_raw_records where source_record_id = 'd2'), 'content_hash', 'h-d2', 'problem_probability', 0.9, 'model_confidence', 0.9, 'config_version', 'v1',
      'answers', jsonb_build_object('severity', jsonb_build_object('value', 5, 'score', 4, 'confidence', 0.99))))) = 2, 'estimates stored';
  assert (select answers->'severity'->>'value' from public.dr_signal_ai where record_id = (select id from public.dr_raw_records where source_record_id = 'd1')) = '5', 'the estimate is preserved in dr_signal_ai';
  update public.dr_clusters set stats_dirty = true where id in (c1, c3);
  perform public.dr_refresh_clusters(10);
  comp_after := (select composite_score from public.dr_clusters where id = c3);
  assert comp_after = comp_before, format('an AI severity of 5 must not change composite_score (%s -> %s)', comp_before, comp_after);
  select * into r from public.dr_clusters where id = c3;
  assert r.severity_avg is null and r.scores->'components'->'painIntensity'->>'basis' = 'insufficient_data', 'pain still excluded';
  update public.dr_signal_ai set answers = jsonb_set(answers, '{severity,value}', '1'::jsonb);
  update public.dr_clusters set stats_dirty = true where id = c3;
  perform public.dr_refresh_clusters(10);
  assert (select composite_score from public.dr_clusters where id = c3) = comp_before, 'and an AI severity of 1 changes nothing either';
end $$;

-- ---------------------------------------------------------------- 6. lock-down
do $$
begin
  assert not has_table_privilege('anon', 'public.dr_ai_cache', 'select') and not has_table_privilege('authenticated', 'public.dr_ai_cache', 'select'), 'cache table not readable by browser roles';
  assert not has_table_privilege('anon', 'public.dr_signal_ai', 'select') and not has_table_privilege('authenticated', 'public.dr_ai_usage', 'select'), 'AI tables not readable by browser roles';
  assert not has_function_privilege('anon', 'public.dr_cluster_profile(uuid)', 'execute') and not has_function_privilege('authenticated', 'public.dr_ai_cache_begin(text,text,text,text,integer)', 'execute'), 'AI functions not callable by browser roles';
  assert has_function_privilege('service_role', 'public.dr_ai_cache_begin(text,text,text,text,integer)', 'execute'), 'collector can use them';
  assert has_function_privilege('service_role', 'public.dr_ai_cache_complete(uuid,bigint,jsonb,jsonb,jsonb)', 'execute') and not has_function_privilege('authenticated', 'public.dr_ai_cache_abandon(uuid,bigint)', 'execute'), 'fenced functions are service_role only';
end $$;

rollback;
\echo ALL AI ARCHITECTURE SQL TESTS PASSED
