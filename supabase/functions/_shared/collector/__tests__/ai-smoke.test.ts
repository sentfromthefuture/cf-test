// Tests for the `ai_smoke_test` module (ai-smoke.ts). Every external call is MOCKED: the AI engines are scripted HTTP clients with SYNTHETIC
// payloads shaped after OpenRouter's published schemas, and the database is the in-memory MemoryStore. No real API request is ever made.
// They prove orchestration, safety limits, persistence checks and usage accounting - not model quality or live availability.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PendingRecord, worthAnalysing } from '../ai.ts';
import { AI_SMOKE_TEST_CANDIDATE_WINDOW, AI_SMOKE_TEST_MAX_RECORDS, AiSmokeStore, AiSmokeTestReport, runAiSmokeTest } from '../ai-smoke.ts';
import { Env, HttpError, RawRecordInput } from '../types.ts';
import { MemoryStore, rec, silentLog } from './helpers.ts';
import { Call, decisionsBody, scriptedHttp } from './ai-test-utils.ts';

const KEY = 'sk-or-v1-test-key-not-real';
const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
const BOTH: Env = { DECISIONS_ENABLED: 'true', OPENROUTER_ENABLED: 'true', OPENROUTER_API_KEY: KEY };
const DECISIONS_ONLY: Env = { DECISIONS_ENABLED: 'true', OPENROUTER_API_KEY: KEY };
const LFM3_ONLY: Env = { OPENROUTER_ENABLED: 'true', OPENROUTER_API_KEY: KEY };

const summaryJson = {
  title: 'Offline invoicing for small shops', problem_description: 'Shop owners cannot invoice when the connection drops.', target_persona: 'Small shop owners',
  existing_solutions: [], why_current_solutions_fall_short: 'Too expensive for tiny shops.', proposed_solution: 'An offline-first invoicing app that syncs later.',
  suggested_features: ['offline mode', 'sync'], monetization_hypothesis: 'Hypothesis: low monthly fee.', development_feasibility: 4, caveats: 'Only a few statements.',
};
const chat = (content: unknown, usage: object = { prompt_tokens: 300, completion_tokens: 120, total_tokens: 420, cost: 0 }) =>
  ({ choices: [{ finish_reason: 'stop', message: { content } }], usage });

type Handler = (call: Call, n: number) => unknown;
const okHandler: Handler = (call) => {
  if (call.url === DECISIONS_URL) return decisionsBody();
  if (call.url === CHAT_URL) return chat(JSON.stringify(summaryJson));
  throw new Error(`unexpected URL in test: ${call.url}`);
};
/** Per-endpoint overrides on top of the all-good handler. */
const handler = (over: { decisions?: Handler; chat?: Handler }): Handler => (call, n) =>
  call.url === DECISIONS_URL && over.decisions ? over.decisions(call, n) : call.url === CHAT_URL && over.chat ? over.chat(call, n) : okHandler(call, n);

/** n pending records that the production gate lets through, oldest first. */
function seeded(n: number, over: (i: number) => Partial<RawRecordInput> = () => ({})): MemoryStore {
  const s = new MemoryStore();
  for (let i = 0; i < n; i++) {
    s.records.set(`github|r${i}`, { ...rec('github', `r${i}`, { title: `Need offline invoicing number ${i}`, categories: ['label:feature request'], ...over(i) }), id: `id-${i}`, status: 'pending', attempts: 0 });
  }
  return s;
}

const FORBIDDEN = ['markSkipped', 'markFailed', 'saveSignals', 'requeueHeuristicAnalysis', 'claimDueSources', 'finishRun', 'noteUsage', 'setQuota', 'existingIds', 'upsertRecords',
  'assignPendingClusters', 'refreshClusters', 'clustersNeedingSummary', 'saveClusterSummary'];
const ALLOWED = new Set(['acquireLock', 'releaseLock', 'claimPending', 'aiCacheBegin', 'aiCacheComplete', 'aiCacheFail', 'aiCacheAbandon', 'aiCacheFailStorage', 'aiCacheInvalidate', 'aiNoteUsage', 'saveSignalAi']);

/** Wraps a store so every method call is recorded, and any call that could change a record's status, a source or a cluster THROWS. */
function guarded(store: MemoryStore) {
  const calls: string[] = [];
  const proxy = new Proxy(store, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== 'function' || typeof prop !== 'string') return v;
      return (...args: unknown[]) => {
        calls.push(prop);
        if (FORBIDDEN.includes(prop)) throw new Error(`FORBIDDEN store call from the smoke test: ${prop}`);
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
  return { store: proxy as unknown as AiSmokeStore, calls };
}

async function run(o: { env: Env; mem?: MemoryStore; pending?: number; handler?: Handler; budgetMs?: number; store?: (mem: MemoryStore) => AiSmokeStore }) {
  const mem = o.mem ?? seeded(o.pending ?? 5);
  const g = o.store ? { store: o.store(mem), calls: [] as string[] } : guarded(mem);
  const net = scriptedHttp(o.handler ?? okHandler);
  const report = await runAiSmokeTest({ store: g.store, env: o.env, http: net.http, log: silentLog, budgetMs: o.budgetMs });
  return { report, mem, calls: g.calls, net, httpCalls: net.calls };
}

const urls = (calls: Call[]) => calls.map((c) => c.url);
const count = (calls: Call[], url: string) => calls.filter((c) => c.url === url).length;
const statuses = (r: AiSmokeTestReport) => [r.decisions.status, r.lfm3.status];
const cacheEntries = (mem: MemoryStore, task: string) => [...mem.aiCache.values()].filter((e) => e.task === task);

// ------------------------------------------------------------------------------------------------ configuration: nothing is tested, nothing is touched

test('both engines disabled: nothing tested, and no database or network access at all', async () => {
  for (const env of [{}, { OPENROUTER_API_KEY: KEY }, { DECISIONS_ENABLED: 'false', OPENROUTER_ENABLED: 'false', OPENROUTER_API_KEY: KEY }, { DECISIONS_ENABLED: 'TRUE', OPENROUTER_ENABLED: '1', OPENROUTER_API_KEY: KEY }]) {
    const { report, calls, httpCalls } = await run({ env });
    assert.equal(report.overall, 'nothing_tested');
    assert.equal(report.ok, false);
    assert.deepEqual(statuses(report), ['disabled', 'disabled']);
    assert.deepEqual(calls, [], 'not even the lock may be taken');
    assert.equal(httpCalls.length, 0);
    assert.match(report.note ?? '', /nothing was tested/);
  }
});

test('missing API key: both engines are reported as misconfigured, nothing is sent, and the issue names the variable (not a value)', async () => {
  const { report, calls, httpCalls } = await run({ env: { DECISIONS_ENABLED: 'true', OPENROUTER_ENABLED: 'true' } });
  assert.deepEqual(statuses(report), ['misconfigured', 'misconfigured']);
  assert.equal(report.overall, 'nothing_tested');
  assert.match(report.decisions.issue!, /OPENROUTER_API_KEY is not set/);
  assert.match(report.lfm3.issue!, /OPENROUTER_API_KEY is not set/);
  assert.deepEqual(calls, []);
  assert.equal(httpCalls.length, 0);
});

test('invalid model configuration (any model that is not an explicit :free slug): misconfigured, never sent', async () => {
  for (const paid of ['openai/gpt-4o-mini', 'liquid/lfm-3-1.7b', 'parallel/decisions-fast', 'a/b:nitro', 'not-a-slug']) {
    const { report, calls, httpCalls } = await run({ env: { ...BOTH, DECISIONS_MODEL: paid, OPENROUTER_MODEL: paid } });
    assert.deepEqual(statuses(report), ['misconfigured', 'misconfigured'], paid);
    assert.match(report.decisions.issue!, /not an explicit :free model/);
    assert.match(report.lfm3.issue!, /not an explicit :free model/);
    assert.equal(report.decisions.model, null);
    assert.deepEqual(calls, []);
    assert.equal(httpCalls.length, 0);
  }
});

test('one engine misconfigured does not stop the other: only the valid engine is called', async () => {
  const { report, httpCalls } = await run({ env: { ...BOTH, DECISIONS_MODEL: 'openai/gpt-4o' } });
  assert.deepEqual(statuses(report), ['misconfigured', 'passed']);
  assert.equal(report.overall, 'partial');
  assert.deepEqual(urls(httpCalls), [CHAT_URL]);
});

// ------------------------------------------------------------------------------------------------ each engine on its own

test('Decisions Fast success (LFM3 off): 3 live calls, cached, provenance rows written, usage recorded, and no record changes status', async () => {
  const { report, mem, calls, httpCalls } = await run({ env: DECISIONS_ONLY, pending: 5 });
  const d = report.decisions;
  assert.equal(d.status, 'passed');
  assert.equal(d.model, 'parallel/decisions-fast:free');
  assert.deepEqual([d.attempted, d.succeeded, d.failed, d.notCompleted, d.liveCalls, d.cacheHits], [3, 3, 0, 0, 3, 0]);
  assert.deepEqual(d.cache, { verified: 3, unverified: 0 });
  assert.deepEqual(d.output, { table: 'dr_signal_ai', expected: 3, written: 3 });
  assert.equal(d.usage.recorded, 'ok');
  assert.equal(report.lfm3.status, 'disabled');
  assert.equal(report.overall, 'partial', 'LFM3 was not exercised, so the pair is not fully verified');
  // the real model was only ever addressed at the Decisions endpoint, with the free model, and never at the chat endpoint
  assert.deepEqual(urls(httpCalls), [DECISIONS_URL, DECISIONS_URL, DECISIONS_URL]);
  assert.ok(httpCalls.every((c) => c.body.model === 'parallel/decisions-fast:free' && c.body.provider.allow_fallbacks === false));
  // persisted: cache + model-output table
  assert.equal(cacheEntries(mem, 'decisions').filter((e) => e.status === 'succeeded').length, 3);
  assert.equal(mem.signalAi.size, 3);
  // untouched: records stay pending, no demand signals, no attempts counted
  assert.ok([...mem.records.values()].every((r) => r.status === 'pending' && r.attempts === 0));
  assert.equal(mem.signals.size, 0);
  assert.ok(!calls.some((c) => FORBIDDEN.includes(c)));
});

test('LFM3 success (Decisions off): one summary request, cached and verified, nothing written to clusters', async () => {
  const { report, mem, httpCalls } = await run({ env: LFM3_ONLY, pending: 5 });
  const l = report.lfm3;
  assert.equal(l.status, 'passed');
  assert.equal(l.model, 'liquid/lfm-3-1.7b:free');
  assert.deepEqual([l.attempted, l.succeeded, l.failed, l.notCompleted, l.liveCalls, l.cacheHits], [1, 1, 0, 0, 1, 0]);
  assert.deepEqual(l.cache, { verified: 1, unverified: 0 });
  assert.deepEqual(l.output, { table: null, expected: 0, written: 0 });
  assert.equal(report.decisions.status, 'disabled');
  assert.deepEqual(urls(httpCalls), [CHAT_URL]);
  assert.equal(httpCalls[0].body.model, 'liquid/lfm-3-1.7b:free');
  assert.equal(cacheEntries(mem, 'summary').filter((e) => e.status === 'succeeded').length, 1);
  assert.equal(mem.summaries.size, 0, 'no real cluster summary may be written');
  assert.equal(mem.signalAi.size, 0);
});

test('both engines succeed: overall passed, exactly 3 + 1 live requests', async () => {
  const { report, httpCalls } = await run({ env: BOTH });
  assert.deepEqual(statuses(report), ['passed', 'passed']);
  assert.equal(report.overall, 'passed');
  assert.equal(report.ok, true);
  assert.equal(httpCalls.length, 4);
  assert.equal(report.records.selected, 3);
  assert.equal(report.note, undefined);
});

test('the engines are independent: LFM3 still runs when Decisions fails, and Decisions still runs when LFM3 fails', async () => {
  // Decisions rejected (bad key): stops at the first request, LFM3 unaffected
  const a = await run({ env: BOTH, handler: handler({ decisions: () => { throw new HttpError('HTTP 401: unauthorized', 401); } }) });
  assert.deepEqual(statuses(a.report), ['failed', 'passed']);
  assert.equal(a.report.overall, 'partial');
  assert.equal(a.report.ok, false);
  assert.equal(a.report.decisions.stopped, 'auth (HTTP 401)');
  assert.equal(count(a.httpCalls, DECISIONS_URL), 1, 'the circuit breaker stops after the first service-level failure: no retry loop over the other records');
  assert.equal(a.mem.signalAi.size, 0);
  assert.equal(cacheEntries(a.mem, 'decisions').length, 0, 'the lease of the failed attempt is released, leaving no pending cache row');
  assert.equal(a.report.decisions.usage.failures, 1);

  // LFM3 returns something that is not JSON: an unusable answer, recorded with a cooldown (never stored as a result)
  const b = await run({ env: BOTH, handler: handler({ chat: () => chat('definitely not json') }) });
  assert.deepEqual(statuses(b.report), ['passed', 'failed']);
  assert.equal(b.report.overall, 'partial');
  assert.match(b.report.lfm3.issue!, /invalid_response/);
  assert.equal(b.report.lfm3.failed, 1);
  const failed = cacheEntries(b.mem, 'summary');
  assert.equal(failed.length, 1);
  assert.equal(failed[0].status, 'failed');
  assert.equal(failed[0].result, null);
  assert.equal(b.report.decisions.output.written, 3, 'Decisions output was still persisted');
});

test('both engines failing: overall failed, one request each (no retries, no fallback), nothing persisted', async () => {
  const { report, mem, httpCalls } = await run({
    env: BOTH,
    handler: handler({ decisions: () => { throw new HttpError('HTTP 429: slow down', 429); }, chat: () => { throw new HttpError('HTTP 503: unavailable', 503); } }),
  });
  assert.deepEqual(statuses(report), ['failed', 'failed']);
  assert.equal(report.overall, 'failed');
  assert.equal(report.ok, false);
  assert.equal(report.decisions.stopped, 'rate_limited (HTTP 429)');
  assert.equal(report.lfm3.stopped, 'unavailable (HTTP 503)');
  assert.deepEqual(urls(httpCalls), [DECISIONS_URL, CHAT_URL]);
  assert.equal(mem.signalAi.size, 0);
  assert.ok([...mem.aiCache.values()].every((e) => e.status !== 'succeeded'));
  assert.ok([...mem.records.values()].every((r) => r.status === 'pending' && r.attempts === 0), 'failures must not touch record status or attempt counters');
});

test('unusable Decisions answers for every record: counted as failures, stop after 3, and still no record is marked failed', async () => {
  const { report, mem, httpCalls } = await run({ env: DECISIONS_ONLY, handler: () => ({ model: 'x', answers: {} }) });
  assert.equal(report.decisions.status, 'failed');
  assert.equal(report.decisions.failed, 3);
  assert.equal(httpCalls.length, 3);
  assert.match(report.decisions.issue!, /3 unusable responses/);
  assert.ok([...mem.records.values()].every((r) => r.status === 'pending' && r.attempts === 0));
});

test('a partial result is reported as partial, not passed: two records answered, one unusable', async () => {
  let n = 0;
  const { report } = await run({ env: DECISIONS_ONLY, handler: () => (++n === 2 ? { model: 'x', answers: {} } : decisionsBody()) });
  assert.equal(report.decisions.status, 'partial');
  assert.deepEqual([report.decisions.succeeded, report.decisions.failed], [2, 1]);
  assert.equal(report.decisions.output.written, 2);
});

// ------------------------------------------------------------------------------------------------ record selection and the cap

test('empty eligible set: nothing is sent to any engine', async () => {
  const none = await run({ env: BOTH, mem: new MemoryStore() });
  assert.equal(none.report.overall, 'nothing_tested');
  assert.deepEqual(statuses(none.report), ['not_run', 'not_run']);
  assert.deepEqual(none.report.records, { candidatesRead: 0, eligible: 0, selected: 0, ids: [] });
  assert.match(none.report.note!, /no eligible pending records/);
  assert.equal(none.httpCalls.length, 0);
  assert.equal(none.mem.aiCache.size, 0);

  // records exist but none passes the production gate
  const boring = seeded(6, () => ({ title: 'Released version 2 today', excerpt: 'Changelog attached.', categories: [] }));
  const pending = [...boring.records.values()].map((r) => ({ ...r }) as unknown as PendingRecord);
  assert.ok(pending.every((p) => !worthAnalysing(p)), 'precondition: these are obvious non-problems');
  const some = await run({ env: BOTH, mem: boring });
  assert.equal(some.report.records.candidatesRead, 6);
  assert.equal(some.report.records.eligible, 0);
  assert.equal(some.report.overall, 'nothing_tested');
  assert.equal(some.httpCalls.length, 0);
});

test('more than three eligible records: exactly three are used, the oldest, and the rest are untouched', async () => {
  const mem = seeded(40);
  const { report, httpCalls, calls } = await run({ env: { ...BOTH, DECISIONS_MAX_PER_RUN: '100' }, mem });
  assert.equal(AI_SMOKE_TEST_MAX_RECORDS, 3);
  assert.equal(report.maxRecords, 3);
  assert.deepEqual(report.records.ids, ['id-0', 'id-1', 'id-2']);
  assert.equal(report.records.selected, 3);
  assert.ok(report.records.candidatesRead <= AI_SMOKE_TEST_CANDIDATE_WINDOW);
  assert.equal(count(httpCalls, DECISIONS_URL), 3, 'DECISIONS_MAX_PER_RUN=100 cannot raise the ceiling');
  assert.equal(count(httpCalls, CHAT_URL), 1);
  assert.equal(mem.signalAi.size, 3);
  assert.deepEqual([...mem.signalAi.keys()].sort(), ['id-0', 'id-1', 'id-2']);
  assert.equal([...mem.records.values()].filter((r) => r.status === 'pending').length, 40);
  assert.equal(calls.filter((c) => c === 'claimPending').length, 1, 'one read-only look at the oldest pending rows');
});

test('a store that over-returns cannot raise the cap or the look-ahead window (literal limits, not the module constants)', async () => {
  const mem = seeded(100);
  const asked: number[] = [];
  mem.claimPending = async (limit: number) => { asked.push(limit); return [...mem.records.values()].slice(0, 80).map((r) => ({ id: r.id, source_id: r.source_id, kind: r.kind, title: r.title, excerpt: r.excerpt, categories: r.categories, engagement: r.engagement, content_hash: r.content_hash, language: r.language })); };
  const { report, httpCalls } = await run({ env: BOTH, mem });
  assert.equal(AI_SMOKE_TEST_CANDIDATE_WINDOW, 12);
  assert.deepEqual(asked, [12], 'one read, asking for at most 12 rows');
  assert.equal(report.records.candidatesRead, 12, 'an over-returned reply is cut back to the window');
  assert.equal(report.records.selected, 3);
  assert.equal(count(httpCalls, DECISIONS_URL), 3);
});

test('eligible records behind non-eligible ones are found, and the non-eligible ones are neither sent nor changed', async () => {
  const mem = seeded(8, (i) => (i < 2 ? { title: 'Released version 2 today', excerpt: 'Changelog attached.', categories: [] } : {}));
  const { report, httpCalls } = await run({ env: DECISIONS_ONLY, mem });
  assert.deepEqual(report.records.ids, ['id-2', 'id-3', 'id-4']);
  assert.equal(httpCalls.length, 3);
  assert.equal(mem.records.get('github|r0')!.status, 'pending', 'it is NOT marked skipped, unlike in a real analysis pass');
});

test('the configured per-run request limit still applies below the ceiling', async () => {
  const { report, httpCalls } = await run({ env: { ...DECISIONS_ONLY, DECISIONS_MAX_PER_RUN: '1' } });
  assert.equal(httpCalls.length, 1);
  assert.equal(report.decisions.status, 'partial');
  assert.deepEqual([report.decisions.succeeded, report.decisions.notCompleted], [1, 2]);
  assert.match(report.decisions.issue!, /per-run request limit reached/);
});

test('not enough time left: no live request is started (Decisions), and LFM3 is judged on its own threshold', async () => {
  const { report, httpCalls } = await run({ env: BOTH, budgetMs: 30_000 });
  assert.equal(report.decisions.status, 'failed');
  assert.equal(report.decisions.liveCalls, 0);
  assert.match(report.decisions.issue!, /not enough time/);
  assert.deepEqual(urls(httpCalls), [CHAT_URL]);
  const tiny = await run({ env: LFM3_ONLY, budgetMs: 10_000 });
  assert.equal(tiny.report.lfm3.status, 'not_run');
  assert.equal(tiny.httpCalls.length, 0);
});

// ------------------------------------------------------------------------------------------------ cache behaviour

test('cache hit behaviour: a second run costs no live request at all and still verifies both engines', async () => {
  const mem = seeded(5);
  const first = await run({ env: BOTH, mem });
  assert.equal(first.httpCalls.length, 4);
  assert.equal(mem.aiCache.size, 4);

  const second = await run({ env: BOTH, mem });
  assert.equal(second.httpCalls.length, 0, 'identical inputs are served from the cache');
  assert.equal(second.report.overall, 'passed');
  assert.deepEqual([second.report.decisions.liveCalls, second.report.decisions.cacheHits], [0, 3]);
  assert.deepEqual([second.report.lfm3.liveCalls, second.report.lfm3.cacheHits], [0, 1]);
  assert.deepEqual(second.report.decisions.cache, { verified: 3, unverified: 0 });
  assert.equal(second.report.decisions.usage.cacheHits, 3);
  assert.equal(second.report.decisions.usage.calls, 0);
  assert.equal(second.report.decisions.output.written, 3, 'provenance rows are upserted, not duplicated');
  assert.equal(mem.signalAi.size, 3);
  assert.equal(mem.aiCache.size, 4);
});

test('a failed input is not re-sent while it is cooling down', async () => {
  const mem = seeded(5);
  await run({ env: LFM3_ONLY, mem, handler: () => chat('not json') });
  const again = await run({ env: LFM3_ONLY, mem });
  assert.equal(again.httpCalls.length, 0);
  assert.equal(again.report.lfm3.status, 'failed');
  assert.match(again.report.lfm3.issue!, /cooling down/);
});

test('persistence is verified, not assumed: an answer that is reported stored but is not in the cache fails the check', async () => {
  const mem = seeded(5);
  const realComplete = mem.aiCacheComplete.bind(mem);
  mem.aiCacheComplete = async (lease, result, citations, usage) => { await realComplete(lease, result, citations, usage); mem.aiCache.clear(); return true; }; // "succeeds" but nothing survives
  const { report } = await run({ env: BOTH, mem });
  assert.equal(report.decisions.status, 'partial');
  assert.deepEqual(report.decisions.cache, { verified: 0, unverified: 3 });
  assert.match(report.decisions.issue!, /3 cache entries could not be verified/);
  assert.equal(report.decisions.output.written, 0, 'provenance is only written for verified entries');
  assert.equal(mem.signalAi.size, 0);
  assert.equal(report.lfm3.cache.unverified, 1);
  assert.equal(mem.aiCache.size, 0, 'the verification probe releases its own lease and leaves no empty row behind');
});

test('verification checks identity and validity, not just presence: a wrong entry or a result that no longer validates is not "verified"', async () => {
  const mem = seeded(5);
  const realBegin = mem.aiCacheBegin.bind(mem);
  let hits = 0;
  mem.aiCacheBegin = async (key, lease) => {
    const b = await realBegin(key, lease);
    if (b.state !== 'hit') return b;
    hits++; // in a first run the only hits are the verification re-reads
    if (hits === 2) return { ...b, id: 'some-other-entry' };      // a different cache entry than the one the answer was stored under
    if (hits === 3) return { ...b, result: { unexpected: true } }; // a stored result that fails validation
    return b;
  };
  const { report } = await run({ env: DECISIONS_ONLY, mem });
  assert.equal(hits, 3);
  assert.deepEqual(report.decisions.cache, { verified: 1, unverified: 2 });
  assert.equal(report.decisions.status, 'partial');
  assert.match(report.decisions.issue!, /2 cache entries could not be verified/);
  assert.deepEqual(report.decisions.output, { table: 'dr_signal_ai', expected: 1, written: 1 }, 'only the verified answer gets a provenance row');
  assert.equal(mem.signalAi.size, 1);
});

test('a verification read that finds the entry busy, or that throws, counts as unverified', async () => {
  const busy = seeded(5);
  const realComplete = busy.aiCacheComplete.bind(busy);
  busy.aiCacheComplete = async (lease, result, citations, usage) => { // stored, then looks like somebody else holds a fresh lease on it
    const ok = await realComplete(lease, result, citations, usage);
    for (const e of busy.aiCache.values()) Object.assign(e, { status: 'pending', result: null, leaseUntil: Date.now() + 60_000 });
    return ok;
  };
  const a = await run({ env: LFM3_ONLY, mem: busy });
  assert.deepEqual(a.report.lfm3.cache, { verified: 0, unverified: 1 });
  assert.equal(a.report.lfm3.status, 'partial');

  const broken = seeded(5);
  const completeThenBreak = broken.aiCacheComplete.bind(broken);
  const realBegin = broken.aiCacheBegin.bind(broken);
  let down = false;
  broken.aiCacheComplete = async (...args) => { const ok = await completeThenBreak(...args); down = true; return ok; };
  broken.aiCacheBegin = async (...args) => { if (down) throw new Error('cache read failed'); return realBegin(...args); };
  const b = await run({ env: DECISIONS_ONLY, mem: broken });
  assert.equal(b.report.decisions.cache.unverified >= 1, true);
  assert.notEqual(b.report.decisions.status, 'passed');
});

test('no retries: with the real HTTP client, a 500 is sent exactly once per engine (the production client would retry once)', async () => {
  const seen: string[] = [];
  const fetchImpl = (async (input: unknown) => { seen.push(String((input as { url?: string }).url ?? input)); return new Response('{"error":"boom"}', { status: 500 }); }) as typeof fetch;
  const mem = seeded(5);
  const report = await runAiSmokeTest({ store: guarded(mem).store, env: { ...BOTH, DECISIONS_MIN_INTERVAL_MS: '1', OPENROUTER_MIN_INTERVAL_MS: '1' }, fetchImpl, log: silentLog });
  assert.deepEqual(seen, [DECISIONS_URL, CHAT_URL]);
  assert.equal(report.overall, 'failed');
  assert.equal(report.decisions.usage.httpRequests, 1);
  assert.equal(report.decisions.usage.retries, 0);
  assert.equal(report.lfm3.usage.retries, 0);
  assert.equal(report.decisions.stopped, 'unavailable (HTTP 500)');
});

test('a 429 is not waited out or retried either', async () => {
  const seen: string[] = [];
  const fetchImpl = (async (input: unknown) => { seen.push(String((input as { url?: string }).url ?? input)); return new Response('{}', { status: 429, headers: { 'retry-after': '1' } }); }) as typeof fetch;
  const report = await runAiSmokeTest({ store: guarded(seeded(5)).store, env: { ...BOTH, DECISIONS_MIN_INTERVAL_MS: '1', OPENROUTER_MIN_INTERVAL_MS: '1' }, fetchImpl, log: silentLog });
  assert.equal(seen.length, 2);
  assert.equal(report.decisions.stopped, 'rate_limited (HTTP 429)');
  assert.equal(report.decisions.usage.rateLimited, 1);
});

// ------------------------------------------------------------------------------------------------ output table

test('the model-output write failing is reported, not thrown', async () => {
  const mem = seeded(5);
  mem.saveSignalAi = async () => { throw new Error('db unavailable'); };
  const { report } = await run({ env: DECISIONS_ONLY, mem });
  assert.equal(report.decisions.status, 'partial');
  assert.match(report.decisions.issue!, /dr_signal_ai write failed/);
  assert.equal(report.decisions.output.written, 0);
});

test('rows the database refuses to store are noticed (stored count below expected)', async () => {
  const mem = seeded(5);
  mem.saveSignalAi = async () => 1;
  const { report } = await run({ env: DECISIONS_ONLY, mem });
  assert.equal(report.decisions.status, 'partial');
  assert.match(report.decisions.issue!, /dr_signal_ai stored 1 of 3 rows/);
});

// ------------------------------------------------------------------------------------------------ usage accounting

test('usage accounting: counters add up, are recorded once per engine, and match what the provider reported', async () => {
  const { report, mem } = await run({ env: BOTH });
  const d = report.decisions.usage;
  assert.deepEqual([d.calls, d.successes, d.failures, d.httpRequests, d.retries, d.cacheMisses, d.cacheHits], [3, 3, 0, 3, 0, 3, 0]);
  assert.deepEqual([d.inputTokens, d.outputTokens], [3 * 420, 3 * 66]);
  assert.equal(d.reportedCostUsd, 0, 'a provider-reported cost of 0 is reported as 0');
  assert.equal(d.costReportedCalls, 3);
  assert.equal(d.tokensReported, true);
  assert.equal(d.consistent, true);
  assert.equal(d.recorded, 'ok');
  const l = report.lfm3.usage;
  assert.deepEqual([l.calls, l.successes, l.inputTokens, l.outputTokens, l.consistent, l.recorded], [1, 1, 300, 120, true, 'ok']);
  // exactly one dr_ai_usage write per engine, carrying the same numbers
  assert.deepEqual(mem.aiUsage.map((u) => u.engine), ['decisions', 'summary']);
  assert.equal(mem.aiUsage[0].usage.input_tokens, 1260);
  assert.equal(mem.aiUsage[0].usage.calls, 3);
  assert.equal(mem.aiUsage[1].usage.output_tokens, 120);
});

test('usage accounting: a missing cost is unknown (null), not free, and missing token counts are flagged', async () => {
  const { report } = await run({ env: BOTH, handler: handler({ decisions: () => decisionsBody({ usage: { input_tokens: 10, output_tokens: 5 } }), chat: () => chat(JSON.stringify(summaryJson), {}) }) });
  assert.equal(report.decisions.usage.reportedCostUsd, null);
  assert.equal(report.decisions.usage.costReportedCalls, 0);
  assert.equal(report.decisions.usage.tokensReported, true);
  assert.equal(report.lfm3.usage.tokensReported, false);
  assert.equal(report.lfm3.usage.reportedCostUsd, null);
});

test('usage accounting: a failed attempt is counted as a failure, not as a success', async () => {
  const { report, mem } = await run({ env: LFM3_ONLY, handler: () => { throw new HttpError('HTTP 500: boom', 500); } });
  const u = report.lfm3.usage;
  assert.deepEqual([u.calls, u.successes, u.failures, u.httpRequests, u.consistent], [1, 0, 1, 1, true]);
  assert.equal(mem.aiUsage[0].usage.failures, 1);
});

test('usage that cannot be recorded downgrades the engine to partial but never throws', async () => {
  const mem = seeded(5);
  mem.failAiUsage = true;
  const { report } = await run({ env: BOTH, mem });
  assert.deepEqual(statuses(report), ['partial', 'partial']);
  assert.equal(report.decisions.usage.recorded, 'failed');
  assert.match(report.decisions.issue!, /usage could not be recorded/);
  assert.equal(report.decisions.cache.verified, 3, 'the answers themselves are still cached');
});

test('an HTTP client that did retry would be visible: retries = requests - calls', async () => {
  const net = scriptedHttp(() => decisionsBody());
  const mem = seeded(5);
  const original = net.http.postJson.bind(net.http);
  net.http.postJson = (async (...a: Parameters<typeof original>) => { net.simulateRetry(); return original(...a); }) as typeof net.http.postJson;
  const report = await runAiSmokeTest({ store: guarded(mem).store, env: DECISIONS_ONLY, http: net.http, log: silentLog });
  assert.equal(report.decisions.usage.retries, 3);
});

// ------------------------------------------------------------------------------------------------ safety properties

test('only the allowed store operations are ever used, in every scenario (the guard throws on anything else)', async () => {
  const scenarios: Array<Parameters<typeof run>[0]> = [
    { env: BOTH },
    { env: BOTH, handler: handler({ decisions: () => { throw new HttpError('HTTP 401: x', 401); }, chat: () => chat('nope') }) },
    { env: BOTH, handler: () => ({ model: 'x', answers: {} }) },
    { env: DECISIONS_ONLY, pending: 50 },
    { env: LFM3_ONLY, pending: 0 },
  ];
  for (const s of scenarios) {
    const { calls } = await run(s);
    for (const c of calls) assert.ok(ALLOWED.has(c), `unexpected store call ${c}`);
    for (const never of FORBIDDEN) assert.ok(!calls.includes(never), `must never call ${never}`);
  }
});

test('the report never contains the API key, provider error text, or any record content', async () => {
  const echo = new HttpError(`HTTP 400: bad request for key ${KEY} and text "Need offline invoicing number 0 frustrating"`, 400);
  const scenarios = [
    await run({ env: BOTH }),
    await run({ env: BOTH, handler: () => { throw echo; } }),
    await run({ env: { ...BOTH, DECISIONS_MODEL: `bad-${KEY}` } }),
  ];
  for (const { report } of scenarios) {
    const text = JSON.stringify(report);
    assert.ok(!text.includes(KEY), 'API key leaked into the report');
    assert.ok(!text.includes('sk-or-'), 'key-shaped text leaked into the report');
    for (const content of ['Need offline invoicing', 'frustrating', 'I wish there was', 'bad request']) assert.ok(!text.includes(content), `report contains "${content}"`);
  }
});

test('the request sent to the provider carries the post text only as data and the key only in the Authorization header', async () => {
  const { httpCalls } = await run({ env: BOTH });
  for (const c of httpCalls) {
    assert.equal(c.headers.authorization, `Bearer ${KEY}`);
    assert.ok(!JSON.stringify(c.body).includes(KEY));
  }
});

test('the lock: a second concurrent smoke test is refused without reading or sending anything, and the lock is always released', async () => {
  const mem = seeded(5);
  mem.locks.add('ai_smoke_test');
  const blocked = await run({ env: BOTH, mem });
  assert.match(blocked.report.note!, /another ai_smoke_test is still running/);
  assert.equal(blocked.report.overall, 'nothing_tested');
  assert.deepEqual(blocked.calls, ['acquireLock']);
  assert.equal(blocked.httpCalls.length, 0);
  assert.ok(mem.locks.has('ai_smoke_test'), 'it must not release a lock it does not hold');

  mem.locks.clear();
  await run({ env: BOTH, mem });
  assert.equal(mem.locks.size, 0, 'released after a normal run');
  await run({ env: BOTH, mem: seeded(5), handler: () => { throw new HttpError('HTTP 401: x', 401); } });
  const throwing = seeded(5);
  throwing.claimPending = async () => { throw new Error('db down'); };
  await assert.rejects(() => run({ env: BOTH, mem: throwing }), /db down/);
  assert.equal(throwing.locks.size, 0, 'released even when the database read fails');
});

test('the smoke test is a pure function of the environment and the database: it takes no caller input', async () => {
  // the options object has no field for a limit, model, record ids or source; the only knobs are the injected dependencies
  const { report } = await run({ env: { ...BOTH, DECISIONS_MODEL: 'parallel/decisions-fast:free', OPENROUTER_MODEL: 'liquid/lfm-3-1.7b:free' } });
  assert.equal(report.decisions.model, 'parallel/decisions-fast:free');
  assert.equal(report.lfm3.model, 'liquid/lfm-3-1.7b:free');
  assert.equal(report.testMode, true);
  assert.equal(report.action, 'ai_smoke_test');
});

test('an unusable LFM3 answer is reported with its reason and token counts, not just "invalid_response"', async () => {
  const exhausted = () => ({
    id: 'gen-x', provider: 'Liquid', model: 'liquid/lfm-3-1.7b-20261106:free',
    choices: [{ index: 0, finish_reason: 'length', native_finish_reason: 'length', message: { role: 'assistant', content: null, reasoning: 'thinking about the statements '.repeat(40) } }],
    usage: { prompt_tokens: 300, completion_tokens: 1600, total_tokens: 1900, cost: 0 },
  });
  const a = await run({ env: BOTH, handler: handler({ chat: exhausted }) });
  assert.deepEqual(statuses(a.report), ['passed', 'failed']);
  const issue = a.report.lfm3.issue!;
  assert.match(issue, /^summary request failed: invalid_response \[reasoning_exhausted_budget, finish_reason=length, completion_tokens=1600\/1600\]/);
  assert.ok(issue.length < 200, 'short enough to be shown whole in the admin panel');
  assert.ok(!issue.includes('thinking about'), 'model text is never part of the report');
  assert.equal(a.report.lfm3.stopped, null, 'an unusable answer is about the input, not a reason to stop the engine');
  assert.deepEqual({ live: a.report.lfm3.liveCalls, failed: a.report.lfm3.failed, calls: a.report.lfm3.usage.calls, failures: a.report.lfm3.usage.failures, consistent: a.report.lfm3.usage.consistent }, { live: 1, failed: 1, calls: 1, failures: 1, consistent: true });
  assert.deepEqual({ inTok: a.report.lfm3.usage.inputTokens, outTok: a.report.lfm3.usage.outputTokens, recorded: a.report.lfm3.usage.recorded }, { inTok: 300, outTok: 1600, recorded: 'ok' }, 'the tokens the provider spent are accounted for');
  const entries = cacheEntries(a.mem, 'summary');
  assert.deepEqual({ n: entries.length, status: entries[0].status, result: entries[0].result }, { n: 1, status: 'failed', result: null });
  assert.equal(a.report.decisions.output.written, 3, 'Decisions Fast is unaffected');
  assert.equal(count(a.httpCalls, CHAT_URL), 1, 'one request, no retry');

  // A provider-side failure on the choice stops the engine and leaves no marker against the cluster.
  const b = await run({ env: BOTH, handler: handler({ chat: () => ({ choices: [{ finish_reason: 'error', error: { code: 503, message: 'x' }, message: { content: null } }] }) }) });
  assert.equal(b.report.lfm3.status, 'failed');
  assert.match(b.report.lfm3.issue!, /unavailable \(HTTP 503\) \[provider_error, finish_reason=error\]/);
  assert.match(b.report.lfm3.stopped!, /^unavailable/);
  assert.equal(cacheEntries(b.mem, 'summary').length, 0);
});
