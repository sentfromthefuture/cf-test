// Orchestration of Engine A over a batch: cache-first, bounded, circuit-breaker, no fallback, metering.
// Payloads are SYNTHETIC (see ai-test-utils.ts); these tests prove control flow and safety properties, not the live API.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AiCacheKey } from '../ai-common.ts';
import { DECISIONS_DEFAULT_MODEL, DecisionsConfig, decisionsInputHash } from '../decisions.ts';
import { classifyWithDecisions, DecisionsRunState, newDecisionsRunState } from '../decisions-runner.ts';
import { HttpError, RateLimitError } from '../types.ts';
import { MemoryStore, silentLog } from './helpers.ts';
import { decisionsBody, pending, scriptedHttp } from './ai-test-utils.ts';

const cfgFor = (http: ReturnType<typeof scriptedHttp>['http'], over: Partial<DecisionsConfig> = {}): DecisionsConfig => ({
  apiKey: 'sk-or-v1-test-key-not-real', model: DECISIONS_DEFAULT_MODEL, configVersion: 'decisions-v1', http, maxLivePerRun: 20, minProblemProbability: 0.5, ...over,
});
const recs = (n: number, prefix = 'r') => Array.from({ length: n }, (_, i) => pending(`${prefix}${i}`));
const run = (store: MemoryStore, cfg: DecisionsConfig, records = recs(3), state: DecisionsRunState = newDecisionsRunState(), timeLeft = 120_000) =>
  classifyWithDecisions({ cfg, store, records, state, log: silentLog, timeLeftMs: () => timeLeft }).then((out) => ({ out, state }));

test('happy path: one live request per record, signals and model outputs produced, usage metered', async () => {
  const store = new MemoryStore();
  const net = scriptedHttp(() => decisionsBody({ usage: { input_tokens: 400, output_tokens: 60, cost: 0 } }));
  const { out, state } = await run(store, cfgFor(net.http), recs(3));
  assert.equal(net.calls.length, 3);
  assert.equal(out.signals.length, 3);
  assert.equal(out.aiRows.length, 3);
  assert.deepEqual(out.failedIds, []);
  assert.equal(out.leftPending, 0);
  assert.ok(out.signals.every((s) => s.analysis_method === 'llm' && s.model === 'parallel/decisions-fast:free' && s.is_problem));
  assert.ok(out.aiRows.every((r) => r.model_confidence === 0.6 && r.citations.length === 1 && r.cache_id));
  const u = state.usage;
  assert.deepEqual({ calls: u.calls, successes: u.successes, failures: u.failures, misses: u.cache_misses, hits: u.cache_hits, http: u.http_requests }, { calls: 3, successes: 3, failures: 0, misses: 3, hits: 0, http: 3 });
  assert.equal(u.input_tokens, 1200);
  assert.equal(u.output_tokens, 180);
  assert.equal(u.cost_reported_calls, 3, 'cost was reported on every call');
  assert.equal(state.stopped, null);
});

test('every request targets only the Decisions endpoint with an explicit :free model and no routing fallback', async () => {
  const net = scriptedHttp(() => decisionsBody());
  await run(new MemoryStore(), cfgFor(net.http), recs(4));
  for (const c of net.calls) {
    assert.equal(c.url, 'https://openrouter.ai/api/alpha/decisions');
    assert.match(c.body.model, /:free$/);
    assert.equal(c.body.provider.allow_fallbacks, false);
  }
});

test('missing cost is unknown, not zero; HTTP-client retries are counted', async () => {
  const net = scriptedHttp((_c, n) => { if (n === 1) net.simulateRetry(); if (n === 2) net.simulateRateLimitResponse(); return decisionsBody({ usage: { input_tokens: 10, output_tokens: 2 } }); });
  const { state } = await run(new MemoryStore(), cfgFor(net.http), recs(3));
  assert.equal(state.usage.reported_cost_usd, 0);
  assert.equal(state.usage.cost_reported_calls, 0, 'no provider-reported cost => not counted as reported');
  assert.equal(state.usage.http_requests, 4, '3 calls + 1 internal retry');
  assert.equal(state.usage.rate_limited, 1);
});

test('identical content is analysed once; a rerun costs nothing', async () => {
  const store = new MemoryStore();
  const net = scriptedHttp(() => decisionsBody());
  const dup = [pending('a'), pending('b', { title: pending('a').title, excerpt: pending('a').excerpt, id: 'b' })]; // same text, different rows
  const first = await run(store, cfgFor(net.http), dup);
  assert.equal(net.calls.length, 1, 'two rows with identical text cost one request');
  assert.equal(first.out.signals.length, 2);
  assert.equal(first.state.cacheHits, 1);
  const second = await run(store, cfgFor(net.http), dup);
  assert.equal(net.calls.length, 1, 'rerunning unchanged input makes no request');
  assert.equal(second.state.usage.calls, 0);
  assert.equal(second.state.usage.cache_hits, 2);
  assert.equal(second.out.signals.length, 2);
  assert.deepEqual(second.out.signals.map((s) => s.problem_statement), first.out.signals.map((s) => s.problem_statement), 'same answer from the cache');
});

test('changing the model or the config version bypasses old cache entries', async () => {
  const store = new MemoryStore();
  const net = scriptedHttp(() => decisionsBody());
  await run(store, cfgFor(net.http), recs(2));
  assert.equal(net.calls.length, 2);
  await run(store, cfgFor(net.http), recs(2));
  assert.equal(net.calls.length, 2, 'same identity: cached');
  await run(store, cfgFor(net.http, { configVersion: 'decisions-v2' }), recs(2));
  assert.equal(net.calls.length, 4, 'new config version: recomputed');
  await run(store, cfgFor(net.http, { model: 'other/decision-model:free' }), recs(2));
  assert.equal(net.calls.length, 6, 'new model: recomputed');
});

test('the per-run request limit is a hard ceiling; the rest stays pending', async () => {
  const store = new MemoryStore();
  const net = scriptedHttp(() => decisionsBody());
  const { out, state } = await run(store, cfgFor(net.http, { maxLivePerRun: 2 }), recs(5));
  assert.equal(net.calls.length, 2);
  assert.equal(out.signals.length, 2);
  assert.equal(out.leftPending, 3);
  assert.deepEqual(out.failedIds, [], 'deferring is not failing');
  assert.match(state.stopped!, /per-run request limit/);
  // the limit is per RUN, shared across batches of the same run
  const state2 = newDecisionsRunState();
  const net2 = scriptedHttp(() => decisionsBody());
  await run(new MemoryStore(), cfgFor(net2.http, { maxLivePerRun: 3 }), recs(2, 'x'), state2);
  await run(new MemoryStore(), cfgFor(net2.http, { maxLivePerRun: 3 }), recs(5, 'y'), state2);
  assert.equal(net2.calls.length, 3);
});

test('cache hits do not consume the live-request budget', async () => {
  const store = new MemoryStore();
  const warm = scriptedHttp(() => decisionsBody());
  await run(store, cfgFor(warm.http), [pending('cached')]);
  const net = scriptedHttp(() => decisionsBody());
  const { out, state } = await run(store, cfgFor(net.http, { maxLivePerRun: 1 }), [pending('cached'), pending('new1'), pending('new2')]);
  assert.equal(net.calls.length, 1, 'only new1 went to the model');
  assert.equal(state.cacheHits, 1);
  assert.equal(out.signals.length, 2);
  assert.equal(out.leftPending, 1, 'new2 waits for the next run');
});

test('a rate limit stops the engine for the run: records stay pending, nothing is failed, nothing else is called', async () => {
  for (const make of [
    () => new RateLimitError('limited', new Date()), () => new HttpError('HTTP 429', 429), () => new HttpError('HTTP 503', 503), () => new HttpError('HTTP 529', 529),
    () => new HttpError('HTTP 524', 524), () => new HttpError('request timeout after 30000ms', 0), () => new HttpError('HTTP 401', 401), () => new HttpError('HTTP 404 model gone', 404),
  ]) {
    const store = new MemoryStore();
    const net = scriptedHttp(() => { throw make(); });
    const { out, state } = await run(store, cfgFor(net.http), recs(4));
    assert.equal(net.calls.length, 1, 'no further requests after the first service-level failure');
    assert.equal(out.signals.length, 0);
    assert.deepEqual(out.failedIds, [], 'service trouble must not mark records failed');
    assert.equal(out.leftPending, 4, 'every record stays pending');
    assert.ok(state.stopped, 'the reason is reported');
    assert.equal(store.aiCache.size, 0, 'no failure is recorded against the inputs');
    assert.equal(state.usage.failures, 1);
    assert.ok(!state.stopped!.includes('test-key'), 'no secret in the reason');
    // once the service is back, the same records are processed immediately (no cooldown was imposed)
    const ok = scriptedHttp(() => decisionsBody());
    const again = await run(store, cfgFor(ok.http), recs(4));
    assert.equal(again.out.signals.length, 4);
  }
});

test('there is no fallback: after a failure no other endpoint or model is ever tried', async () => {
  const net = scriptedHttp(() => { throw new HttpError('HTTP 503', 503); });
  await run(new MemoryStore(), cfgFor(net.http), recs(6));
  assert.deepEqual(net.calls.map((c) => c.url), ['https://openrouter.ai/api/alpha/decisions']);
});

test('an unusable answer fails only that record, is cooled down, and does not poison the rest', async () => {
  const store = new MemoryStore();
  const net = scriptedHttp((_c, n) => (n === 2 ? { answers: { is_problem: { type: 'noul', noul: 7 } } } : decisionsBody()));
  const { out, state } = await run(store, cfgFor(net.http), recs(4));
  assert.equal(out.signals.length, 3);
  assert.equal(out.failedIds.length, 1);
  assert.equal(out.failedIds[0], 'r1');
  assert.equal(state.invalid, 1);
  assert.equal(state.stopped, null, 'one bad answer does not stop the engine');
  const failed = [...store.aiCache.values()].filter((e) => e.status === 'failed');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].result, null, 'the bad answer was not cached as a result');
  // rerun: the bad input is NOT sent again, and waiting out its cooldown does not burn one of the record's attempts
  const net2 = scriptedHttp(() => decisionsBody());
  const again = await run(store, cfgFor(net2.http), recs(4));
  assert.equal(net2.calls.length, 0, 'three cached, one cooling down: zero requests');
  assert.deepEqual(again.out.failedIds, [], 'a cooldown is a deferral, not a failure');
  assert.equal(again.out.leftPending, 1);
  assert.equal(again.state.cooldown, 1);
});

test('a refusal on is_problem is an input-level failure, not an outage', async () => {
  const net = scriptedHttp(() => decisionsBody({ answers: { is_problem: { type: 'refusal' } } }));
  const { out, state } = await run(new MemoryStore(), cfgFor(net.http), recs(2));
  assert.equal(out.signals.length, 0);
  assert.deepEqual(out.failedIds, ['r0', 'r1']);
  assert.equal(state.invalid, 2);
});

test('repeated unusable answers in a row stop the engine (probable contract change); a success resets the streak', async () => {
  const bad = { answers: {} };
  const stopped = await run(new MemoryStore(), cfgFor(scriptedHttp(() => bad).http), recs(6));
  assert.equal(stopped.state.usage.calls, 3, 'stops after three in a row');
  assert.match(stopped.state.stopped!, /repeated unusable responses/);
  assert.equal(stopped.out.leftPending, 3);
  assert.equal(stopped.out.failedIds.length, 3);
  const pattern = [bad, bad, 'ok', bad, bad];
  const net = scriptedHttp((_c, n) => (pattern[n - 1] === 'ok' ? decisionsBody() : bad));
  const mixed = await run(new MemoryStore(), cfgFor(net.http), recs(5));
  assert.equal(mixed.state.usage.calls, 5, 'never three consecutive, so it keeps going');
  assert.equal(mixed.state.stopped, null);
});

test('a record another worker is already processing is left alone', async () => {
  const store = new MemoryStore();
  const rec = pending('busy');
  const k: AiCacheKey = { task: 'decisions', model: DECISIONS_DEFAULT_MODEL, configVersion: 'decisions-v1', hash: await decisionsInputHash(rec) };
  await store.aiCacheBegin(k, 120); // someone else holds the lease
  const net = scriptedHttp(() => decisionsBody());
  const { out, state } = await run(store, cfgFor(net.http), [rec, pending('free')]);
  assert.equal(net.calls.length, 1, 'only the free record was sent');
  assert.equal(out.signals.length, 1);
  assert.equal(out.leftPending, 1);
  assert.equal(state.busy, 1);
  assert.deepEqual(out.failedIds, []);
});

test('no live request is started when little time is left in the run', async () => {
  const net = scriptedHttp(() => decisionsBody());
  const { out, state } = await run(new MemoryStore(), cfgFor(net.http), recs(3), newDecisionsRunState(), 10_000);
  assert.equal(net.calls.length, 0);
  assert.equal(out.leftPending, 3);
  assert.match(state.stopped!, /not enough time/);
});

test('a cache outage cannot cause unbounded model calls: the engine stops and nothing is called', async () => {
  const store = new MemoryStore();
  store.failAiCache = true;
  const net = scriptedHttp(() => decisionsBody());
  const { out, state } = await run(store, cfgFor(net.http), recs(5));
  assert.equal(net.calls.length, 0, 'without a working cache the engine refuses to spend requests');
  assert.equal(out.signals.length, 0);
  assert.equal(out.leftPending, 5);
  assert.ok(state.stopped);
});

// ------------------------------------------------------------------ CACHE FIRST: limits apply only to a miss that needs a live request
const warm = async (store: MemoryStore, ids: string[]) => {
  const net = scriptedHttp(() => decisionsBody());
  await run(store, cfgFor(net.http), ids.map((id) => pending(id)));
  assert.equal(net.calls.length, ids.length, 'warm-up made one request per record');
};

test('CACHE FIRST: cached results are served even when the live-request budget is already exhausted', async () => {
  const store = new MemoryStore();
  await warm(store, ['c0', 'c1', 'c2']);
  const net = scriptedHttp(() => decisionsBody());
  const state = newDecisionsRunState();
  state.liveCalls = 2; // the run's whole budget (2) has already been spent
  const { out } = await run(store, cfgFor(net.http, { maxLivePerRun: 2 }), [pending('n0'), pending('c0'), pending('n1'), pending('c1'), pending('c2')], state);
  assert.equal(net.calls.length, 0, 'no live request: the budget is spent');
  assert.equal(out.signals.length, 3, 'all three cached records were still served');
  assert.deepEqual(out.signals.map((s) => s.record_id).sort(), ['c0', 'c1', 'c2']);
  assert.equal(out.leftPending, 2, 'only the two misses wait');
  assert.equal(state.cacheHits, 3);
  assert.equal(state.deferred, 2);
  assert.match(state.stopped!, /per-run request limit/);
  assert.deepEqual(out.failedIds, [], 'deferring a miss is not failing it');
  assert.equal([...store.aiCache.values()].filter((e) => e.status !== 'succeeded').length, 0, 'nothing was recorded against the deferred inputs');
});

test('CACHE FIRST: the budget runs out mid-batch, and cached records AFTER that point are still served', async () => {
  const store = new MemoryStore();
  await warm(store, ['c0', 'c1']);
  const net = scriptedHttp(() => decisionsBody());
  const { out, state } = await run(store, cfgFor(net.http, { maxLivePerRun: 1 }), [pending('n0'), pending('n1'), pending('n2'), pending('c0'), pending('c1')]);
  assert.equal(net.calls.length, 1, 'exactly one live request');
  assert.deepEqual(out.signals.map((s) => s.record_id).sort(), ['c0', 'c1', 'n0'], 'n0 live, c0 and c1 from the cache after the budget ran out');
  assert.equal(out.leftPending, 2);
  assert.equal(state.cacheHits, 2);
  assert.equal(state.liveCalls, 1);
});

test('CACHE FIRST: cached results are served when too little time is left for another request', async () => {
  const store = new MemoryStore();
  await warm(store, ['c0', 'c1']);
  const net = scriptedHttp(() => decisionsBody());
  const { out, state } = await run(store, cfgFor(net.http), [pending('n0'), pending('c0'), pending('c1')], newDecisionsRunState(), 10_000);
  assert.equal(net.calls.length, 0, 'no request is started with 10s left');
  assert.deepEqual(out.signals.map((s) => s.record_id).sort(), ['c0', 'c1']);
  assert.equal(out.leftPending, 1);
  assert.match(state.stopped!, /not enough time/);
  assert.equal(state.cacheHits, 2);
});

test('CACHE FIRST: after a service failure switches live requests off, cached records are still served', async () => {
  const store = new MemoryStore();
  await warm(store, ['c0', 'c1']);
  const net = scriptedHttp(() => { throw new HttpError('HTTP 429', 429); });
  const { out, state } = await run(store, cfgFor(net.http), [pending('n0'), pending('c0'), pending('n1'), pending('c1')]);
  assert.equal(net.calls.length, 1, 'one failed request, then no more');
  assert.deepEqual(out.signals.map((s) => s.record_id).sort(), ['c0', 'c1']);
  assert.equal(out.leftPending, 2);
  assert.deepEqual(out.failedIds, []);
  assert.match(state.stopped!, /rate_limited/);
  assert.equal([...store.aiCache.values()].filter((e) => e.status !== 'succeeded').length, 0, 'the outage was not recorded against any input');
});

test('CACHE FIRST: a deferred record is retried (not lost) once a later run has budget and time', async () => {
  const store = new MemoryStore();
  await warm(store, ['c0']);
  const net = scriptedHttp(() => decisionsBody());
  const first = await run(store, cfgFor(net.http, { maxLivePerRun: 1 }), [pending('n0'), pending('n1'), pending('c0')]);
  assert.equal(first.out.leftPending, 1);
  const calls = net.calls.length;
  const second = await run(store, cfgFor(net.http, { maxLivePerRun: 1 }), [pending('n1')]);
  assert.equal(net.calls.length, calls + 1, 'n1 is now sent exactly once');
  assert.equal(second.out.signals.length, 1);
  assert.equal(second.out.leftPending, 0);
});

test('CACHE FIRST: an already-deferred record is not looked up again within the same run', async () => {
  const store = new MemoryStore();
  const net = scriptedHttp(() => decisionsBody());
  const state = newDecisionsRunState();
  const cfg = cfgFor(net.http, { maxLivePerRun: 1 });
  await run(store, cfg, [pending('n0'), pending('n1')], state);
  const beginsAfterFirstBatch = store.aiCacheCalls.begin;
  const again = await run(store, cfg, [pending('n1')], state);
  assert.equal(store.aiCacheCalls.begin, beginsAfterFirstBatch, 'no further cache round trip for a record already known to be deferred');
  assert.equal(again.out.leftPending, 1);
  assert.equal(state.deferred, 1, 'counted once, not once per batch');
});
