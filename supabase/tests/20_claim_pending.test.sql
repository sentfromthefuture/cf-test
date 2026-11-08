-- Run with: psql -v ON_ERROR_STOP=1 -d <db> -f supabase/tests/20_claim_pending.test.sql
-- (after 00_stub_supabase.sql + the migrations; use a throwaway database). Everything is rolled back at the end.
--
-- Pins down what the analysis queue guarantees, because the guarded `analysis_test` action relies on it:
--   * dr_claim_pending_records(p_limit) returns at most least(greatest(p_limit,1),200) rows,
--   * despite its name it is READ-ONLY: it does not mark, lock, or otherwise touch any row,
--   * there is no 'processing'/'claimed' status a record could be stranded in,
--   * an interrupted analysis pass leaves every record in a final-or-pending state, and its lock frees itself.
-- If a future migration turns the function into a real claim (an UPDATE / FOR UPDATE), this file fails loudly and the
-- app-side cap in analysis.ts (ANALYSIS_TEST_MAX_RECORDS) must be re-examined.
\set ON_ERROR_STOP on
begin;

-- This file asserts exact row counts, so it needs a freshly migrated, EMPTY database (like 10_market_intel.test.sql).
do $$ begin
  assert not exists (select 1 from public.dr_raw_records), 'run this on a freshly migrated, empty throwaway database: dr_raw_records already has rows';
end $$;

-- ---------------------------------------------------------------- seed 250 pending records, oldest first
do $$
declare r jsonb;
begin
  r := public.dr_upsert_records((
    select jsonb_agg(jsonb_build_object('source_id', 'github', 'source_record_id', 'cp' || i, 'discussion_key', 'github:cp' || i,
      'kind', 'issue', 'url', 'https://example.org/cp' || i, 'title', 'I wish there was a tool for ' || i,
      'excerpt', 'It is frustrating that nothing does this ' || i, 'published_at', now(), 'engagement', '{"score":3}'::jsonb,
      'categories', jsonb_build_array('c1'), 'license', 'test', 'content_hash', 'h' || i))
    from generate_series(1, 250) i));
  assert (r->>'inserted')::int = 250, format('seed: expected 250 inserted, got %s', r);
  -- distinct, strictly increasing collected_at so "oldest first" is unambiguous (now() is constant inside a transaction)
  update public.dr_raw_records t set collected_at = now() - make_interval(secs => 1000 - q.rn)
    from (select id, row_number() over (order by source_record_id::text) as rn from public.dr_raw_records) q where t.id = q.id;
  assert (select count(*) from public.dr_raw_records where analysis_status = 'pending') = 250, 'all seeded rows start pending';
end $$;

-- Snapshot BEFORE any claim call (including section 1), so every call below is covered by the no-mutation checks in section 2.
create temp table snap as
  select id, ctid::text as c, xmax::text as x, analysis_status, analysis_attempts, analyzed_hash, collected_at, content_hash from public.dr_raw_records;
create temp table stat0 as
  select coalesce(n_tup_ins, 0) ins, coalesce(n_tup_upd, 0) upd, coalesce(n_tup_del, 0) del
  from (select 1) d left join pg_stat_xact_user_tables s on s.relname = 'dr_raw_records';

-- ---------------------------------------------------------------- 1. limit handling: min 1, max 200, default 20, NULL -> 1
do $$
declare c record; got int;
begin
  for c in select * from (values
      ('10', 10), ('1', 1), ('0', 1), ('-5', 1), ('-2147483648', 1), ('null', 1),
      ('200', 200), ('201', 200), ('1000000', 200), ('2147483647', 200)) as v(arg, want) loop
    execute format('select jsonb_array_length(public.dr_claim_pending_records(%s))', c.arg) into got;
    assert got = c.want, format('dr_claim_pending_records(%s) returned %s rows, expected %s', c.arg, got, c.want);
  end loop;
  assert jsonb_array_length(public.dr_claim_pending_records()) = 20, 'default limit is 20';
end $$;

-- ---------------------------------------------------------------- 2. READ-ONLY: no row is updated, locked, or re-written (compares against the snapshot taken before section 1)
do $$
declare i int; ids1 jsonb; ids2 jsonb;
begin
  for i in 1..60 loop perform public.dr_claim_pending_records((array[10, 1, 0, 200, 1000])[1 + i % 5]); end loop;

  assert not exists (select 1 from (
      select id, ctid::text c, xmax::text x, analysis_status, analysis_attempts, analyzed_hash, collected_at, content_hash from public.dr_raw_records
      except select * from snap) d), 'a row version changed (ctid/xmax/status/attempts/hash) after claim calls';
  assert not exists (select 1 from (
      select * from snap except select id, ctid::text, xmax::text, analysis_status, analysis_attempts, analyzed_hash, collected_at, content_hash from public.dr_raw_records) d),
    'a row disappeared or changed after claim calls';
  assert (select count(*) from public.dr_raw_records where analysis_status <> 'pending') = 0, 'claim must not change any status';
  assert (select count(*) from public.dr_raw_records where analysis_attempts <> 0) = 0, 'claim must not touch attempts';

  -- transaction-scoped heap counters: zero inserts/updates/deletes happened on dr_raw_records during the 60 calls
  assert (select coalesce(n_tup_upd, 0) - (select upd from stat0) from (select 1) d left join pg_stat_xact_user_tables s on s.relname = 'dr_raw_records') = 0, 'claim performed an UPDATE';
  assert (select coalesce(n_tup_ins, 0) - (select ins from stat0) from (select 1) d left join pg_stat_xact_user_tables s on s.relname = 'dr_raw_records') = 0, 'claim performed an INSERT';
  assert (select coalesce(n_tup_del, 0) - (select del from stat0) from (select 1) d left join pg_stat_xact_user_tables s on s.relname = 'dr_raw_records') = 0, 'claim performed a DELETE';

  -- documents current semantics: it is a peek, not a reservation. Two calls return the same rows, oldest first.
  ids1 := public.dr_claim_pending_records(10); ids2 := public.dr_claim_pending_records(10);
  assert ids1 = ids2, 'repeat calls return the same rows (peek semantics)';
  assert (select array_agg(e->>'id' order by ord) from jsonb_array_elements(ids1) with ordinality t(e, ord))
       = (select array_agg(id::text order by collected_at, id) from (select id, collected_at from public.dr_raw_records where analysis_status = 'pending' order by collected_at limit 10) q),
    'rows come back oldest-first';
end $$;

-- the function is a pure SELECT: it must not be declared volatile-with-writes; verify its source has no write verbs
do $$
declare src text;
begin
  select lower(prosrc) into src from pg_proc where proname = 'dr_claim_pending_records' and pronamespace = 'public'::regnamespace;
  assert src is not null, 'function exists';
  assert src !~ '\m(update|insert|delete|for\s+update|for\s+share|skip\s+locked|nowait|set\s+analysis_status)\M', 'claim function source must contain no write/lock verbs: ' || src;
end $$;

-- ---------------------------------------------------------------- 3. only pending rows are returned; no in-between status exists
do $$
declare ids uuid[]; ret jsonb;
begin
  select array_agg(id) into ids from (select id from public.dr_raw_records order by collected_at limit 9) q;
  update public.dr_raw_records set analysis_status = 'done'    where id = ids[1] or id = ids[2] or id = ids[3];
  update public.dr_raw_records set analysis_status = 'skipped' where id = ids[4] or id = ids[5] or id = ids[6];
  update public.dr_raw_records set analysis_status = 'failed', analysis_attempts = 3 where id = ids[7] or id = ids[8] or id = ids[9];
  ret := public.dr_claim_pending_records(200);
  assert (select count(*) from public.dr_raw_records where analysis_status = 'pending') = 241, 'setup: 241 rows are still pending';
  assert jsonb_array_length(ret) = 200, format('capped at 200 even though 241 are pending, got %s', jsonb_array_length(ret));
  assert not exists (select 1 from jsonb_array_elements(ret) e where (e->>'id')::uuid = any (ids)), 'done/skipped/failed rows must never be returned';

  -- the status column can only ever hold these four values, so there is nothing like 'processing' to be stranded in
  begin
    update public.dr_raw_records set analysis_status = 'processing' where id = ids[1];
    assert false, 'a processing status must not be storable';
  exception when check_violation then null; end;
  begin
    update public.dr_raw_records set analysis_status = 'claimed' where id = ids[1];
    assert false, 'a claimed status must not be storable';
  exception when check_violation then null; end;
  -- restore for the next sections
  update public.dr_raw_records set analysis_status = 'pending', analysis_attempts = 0 where id = any (ids);
end $$;

-- ---------------------------------------------------------------- 4. interruption: nothing is left half-done
do $$
declare ids uuid[]; hashes text[]; ok jsonb; n int;
begin
  select array_agg(id order by collected_at), array_agg(content_hash order by collected_at) into ids, hashes
    from (select id, content_hash, collected_at from public.dr_raw_records where analysis_status = 'pending' order by collected_at limit 10) q;
  assert array_length(ids, 1) = 10;

  -- (a) a save call that dies halfway (malformed 3rd signal) rolls back completely: no signals, no status changes
  begin
    perform public.dr_save_signals(jsonb_build_array(
      jsonb_build_object('record_id', ids[1], 'content_hash', hashes[1], 'analysis_method', 'heuristic', 'is_problem', true, 'signal_type', 'other'),
      jsonb_build_object('record_id', ids[2], 'content_hash', hashes[2], 'analysis_method', 'heuristic', 'is_problem', true, 'signal_type', 'other'),
      jsonb_build_object('record_id', 'not-a-uuid', 'content_hash', 'x', 'analysis_method', 'heuristic')));
    assert false, 'the malformed signal should have aborted the call';
  exception when invalid_text_representation then null; end;
  assert (select count(*) from public.dr_problem_signals) = 0, 'aborted save must leave no signals';
  assert (select count(*) from public.dr_raw_records where analysis_status <> 'pending') = 0, 'aborted save must leave every record pending';

  -- (b) a pass interrupted after saving 4 of 10: exactly 4 are done (with a signal each); the other 6 are plain pending again
  select public.dr_save_signals(jsonb_agg(jsonb_build_object('record_id', ids[i], 'content_hash', hashes[i],
           'analysis_method', 'heuristic', 'is_problem', true, 'signal_type', 'other'))) into n from generate_series(1, 4) i;
  assert n = 4;
  assert (select count(*) from public.dr_raw_records where analysis_status = 'done') = 4;
  assert (select count(*) from public.dr_raw_records where analysis_status = 'pending') = 246;
  assert (select count(*) from public.dr_raw_records where analysis_status not in ('pending', 'done')) = 0, 'no record may be in a limbo state';
  assert (select count(*) from public.dr_raw_records where analysis_attempts <> 0) = 0, 'interruption must not burn attempts';
  assert (select count(*) from public.dr_problem_signals s join public.dr_raw_records r on r.id = s.record_id where r.analysis_status <> 'done') = 0, 'every signal belongs to a done record';
end $$;

-- ---------------------------------------------------------------- 5. the analysis lock heals itself after an interrupted run
do $$
begin
  delete from public.dr_job_locks where name = 'analysis'; -- start from a known state (rolled back with everything else)
  assert public.dr_acquire_lock('analysis', 180) = true,  'first acquire wins';
  assert public.dr_acquire_lock('analysis', 180) = false, 'a second pass is blocked while the first holds it';
  -- simulate the 180s TTL elapsing after a crashed invocation that never reached releaseLock()
  update public.dr_job_locks set locked_until = now() - interval '1 second' where name = 'analysis';
  assert public.dr_acquire_lock('analysis', 180) = true,  'an expired lock is taken over without any manual cleanup';
  perform public.dr_release_lock('analysis');
  assert public.dr_acquire_lock('analysis', 180) = true,  'an explicitly released lock is immediately available';
end $$;

rollback;
\echo ALL CLAIM-PENDING SQL TESTS PASSED
