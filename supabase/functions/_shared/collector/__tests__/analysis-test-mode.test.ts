// Safety tests for the guarded `analysis_test` smoke test (docs/safe-analysis-test-mode.md).
// These prove the guarantees (cap, no source collection, no LLM, no summaries, no requeue, no global clustering), not just the response shape.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ANALYSIS_TEST_MAX_RECORDS, runAnalysis } from '../analysis.ts';
import { geminiConfigFromEnv, openRouterConfigFromEnv } from '../ai.ts';
import { runAnalysisTest } from '../runner.ts';
import { fakeHttp, MemoryStore, rec, silentLog } from './helpers.ts';

const worth = (id: string) => rec('github', id); // default excerpt reads as a genuine problem => worthAnalysing() is true
const notWorth = (id: string) => rec('github', id, { title: `release ${id}`, excerpt: `Version ${id} was released today.` });

async function seeded(n: number, make = worth, prefix = 'r') {
  const store = new MemoryStore();
  await store.upsertRecords(Array.from({ length: n }, (_, i) => make(`${prefix}${i}`)));
  return store;
}
const statusCounts = (s: MemoryStore) => {
  const out: Record<string, number> = {};
  for (const r of s.records.values()) out[r.status] = (out[r.status] ?? 0) + 1;
  return out;
};

/** Wraps a store and records every method called on it. */
function spy(store: MemoryStore) {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const proxy = new Proxy(store, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target);
      return typeof v === 'function' ? (...args: unknown[]) => { calls.push({ name: String(prop), args }); return v.apply(target, args); } : v;
    },
  }) as MemoryStore;
  return { store: proxy, calls, names: () => new Set(calls.map((c) => c.name)) };
}

const FORBIDDEN_FOR_TEST_MODE = [
  'claimDueSources', 'finishRun', 'noteUsage', 'setQuota', 'existingIds', 'upsertRecords', // source collection
  'requeueHeuristicAnalysis', // reanalyse
  'assignPendingClusters', 'refreshClusters', // global clustering
  'clustersNeedingSummary', 'saveClusterSummary', // summaries
];

test('hard cap: with 25 pending, exactly 10 are claimed and processed; the other 15 are untouched', async () => {
  const store = await seeded(25);
  const rep = await runAnalysisTest({ store, log: silentLog });
  assert.equal(ANALYSIS_TEST_MAX_RECORDS, 10);
  assert.equal(rep.claimed, 10);
  assert.equal(rep.analysed + rep.skipped, 10);
  assert.deepEqual(statusCounts(store), { done: 10, pending: 15 });
  assert.equal(store.signals.size, 10);
});

test('cap is enforced inside the analysis loop: a store that ignores the requested limit still cannot exceed 10', async () => {
  class OverClaimingStore extends MemoryStore {
    asked: number[] = [];
    async claimPending(limit: number) { this.asked.push(limit); return super.claimPending(1000); } // ignores `limit` like a buggy backend
  }
  const store = new OverClaimingStore();
  await store.upsertRecords(Array.from({ length: 40 }, (_, i) => worth(`o${i}`)));
  const rep = await runAnalysisTest({ store, log: silentLog });
  assert.equal(rep.claimed, 10);
  assert.deepEqual(statusCounts(store), { done: 10, pending: 30 });
  assert.ok(store.asked.length === 1 && store.asked[0] <= 10, `asked for ${store.asked}`); // one bounded claim, never re-claims
});

test('cap holds when a pass cannot finish its records: records that stay pending are not re-claimed in a loop', async () => {
  const store = await seeded(25);
  store.saveSignals = async () => 0; // nothing persists, so every record stays pending
  const sp = spy(store);
  const rep = await runAnalysisTest({ store: sp.store, log: silentLog });
  assert.equal(rep.claimed, 10);
  assert.equal(sp.calls.filter((c) => c.name === 'claimPending').length, 1);
});

test('test mode makes zero source-claim / connector / requeue / clustering / summary store calls', async () => {
  const store = await seeded(25);
  const sp = spy(store);
  await runAnalysisTest({ store: sp.store, log: silentLog });
  const used = sp.names();
  for (const name of FORBIDDEN_FOR_TEST_MODE) assert.ok(!used.has(name), `test mode must never call store.${name}`);
  // and positively: only the bounded analysis queue operations
  for (const name of used) assert.ok(['acquireLock', 'claimPending', 'markSkipped', 'saveSignals', 'releaseLock'].includes(name), `unexpected store.${name}`);
});

test('zero Gemini/OpenRouter calls and zero summaries, even when AI clients are supplied and a cluster is waiting for a summary', async () => {
  const net = fakeHttp(() => { throw new Error('network must not be used in test mode'); });
  const realFetch = globalThis.fetch;
  let strayFetch = 0;
  globalThis.fetch = (async () => { strayFetch++; throw new Error('global fetch must not be used'); }) as typeof fetch;
  try {
    const store = await seeded(12);
    store.clustersNeedingSummary = async () => [{ id: 'c1', statements: ['a', 'b'] }]; // would be summarised in normal mode
    const sp = spy(store);
    const stats = await runAnalysis({
      store: sp.store, log: silentLog, timeLeftMs: () => 100_000, testMode: true,
      gemini: geminiConfigFromEnv({ GEMINI_API_KEY: 'k' }, net.http),
      openrouter: openRouterConfigFromEnv({ OPENROUTER_ENABLED: 'true', OPENROUTER_API_KEY: 'k' }, net.http),
    });
    assert.equal(net.urls.length, 0, 'AI HTTP client must never be used');
    assert.equal(strayFetch, 0);
    assert.equal(stats.method, 'heuristic');
    assert.equal(stats.summaries, 0);
    assert.equal(store.summaries.size, 0);
    assert.ok(![...sp.names()].some((n) => ['clustersNeedingSummary', 'saveClusterSummary'].includes(n)));
    assert.ok([...store.signals.values()].every((s) => s.analysis_method === 'heuristic'));
  } finally { globalThis.fetch = realFetch; }
});

test('does not requeue or touch failed, skipped or already-processed records; no existing signal is replaced', async () => {
  const store = await seeded(3, worth, 'old');
  const [done, skipped, failed] = [...store.records.values()];
  done.status = 'done'; skipped.status = 'skipped'; failed.status = 'failed'; failed.attempts = 3;
  const prior = { record_id: done.id, content_hash: done.content_hash, analysis_method: 'heuristic', is_problem: true } as any;
  store.signals.set(done.id, prior);
  await store.upsertRecords(Array.from({ length: 4 }, (_, i) => worth(`new${i}`)));

  const sp = spy(store);
  const rep = await runAnalysisTest({ store: sp.store, log: silentLog });

  assert.equal(rep.claimed, 4);
  assert.equal(done.status, 'done'); assert.equal(skipped.status, 'skipped'); assert.equal(failed.status, 'failed'); assert.equal(failed.attempts, 3);
  assert.equal(store.signals.get(done.id), prior, 'previously saved signal must be left as-is');
  assert.ok(!sp.names().has('requeueHeuristicAnalysis') && !sp.names().has('markFailed'));
});

test('records that are not worth analysing are skipped within the cap, and the report adds up', async () => {
  const store = new MemoryStore();
  await store.upsertRecords([...Array.from({ length: 6 }, (_, i) => worth(`w${i}`)), ...Array.from({ length: 8 }, (_, i) => notWorth(`n${i}`))]);
  const rep = await runAnalysisTest({ store, log: silentLog });
  assert.equal(rep.claimed, 10);
  assert.equal(rep.analysed + rep.skipped + rep.failed, rep.claimed);
  assert.equal(rep.failed, 0);
});

test('report carries every required metric, the test-mode marker, and zeroes where the guarantee is zero', async () => {
  const rep = await runAnalysisTest({ store: await seeded(3), log: silentLog });
  for (const k of ['testMode', 'action', 'maxRecords', 'method', 'ran', 'claimed', 'analysed', 'skipped', 'problems', 'failed', 'clustered', 'clustersRefreshed', 'summaries', 'elapsedMs']) assert.ok(k in rep, `missing ${k}`);
  assert.equal(rep.testMode, true);
  assert.equal(rep.action, 'analysis_test');
  assert.equal(rep.maxRecords, 10);
  assert.equal(rep.method, 'heuristic');
  assert.equal(rep.clustered, 0);
  assert.equal(rep.clustersRefreshed, 0);
  assert.equal(rep.summaries, 0);
  assert.equal(typeof rep.elapsedMs, 'number');
});

test('empty queue: a clean no-op report', async () => {
  const rep = await runAnalysisTest({ store: new MemoryStore(), log: silentLog });
  assert.equal(rep.claimed, 0);
  assert.equal(rep.analysed, 0);
});

test('a concurrent analysis pass blocks the test (it does not bypass the lock) and claims nothing', async () => {
  const store = await seeded(5);
  store.locks.add('analysis');
  const rep = await runAnalysisTest({ store, log: silentLog });
  assert.equal(rep.ran, false);
  assert.equal(rep.claimed, 0);
  assert.equal(statusCounts(store).pending, 5);
});

// ---- regression: the normal (non-test) analysis path is behaviourally unchanged ----

test('normal analysis is unchanged: no 10-record cap, clustering and refresh still run, no test marker', async () => {
  const store = await seeded(150);
  const sp = spy(store);
  const stats = await runAnalysis({ store: sp.store, gemini: null, log: silentLog, timeLeftMs: () => 100_000 });
  assert.equal(stats.claimed, 150);
  assert.equal(stats.analysed, 150);
  assert.ok(stats.clustered > 0 && stats.clustersRefreshed > 0);
  assert.ok(sp.names().has('assignPendingClusters') && sp.names().has('refreshClusters'));
  assert.ok(!('testMode' in stats));
  assert.equal(statusCounts(store).pending, undefined);
});

test('normal analysis still summarises clusters when an AI client is configured', async () => {
  const store = await seeded(4);
  store.clustersNeedingSummary = async () => [{ id: 'c1', statements: ['a', 'b'] }];
  const sp = spy(store);
  const net = fakeHttp(() => ({ candidates: [] }));
  await runAnalysis({ store: sp.store, gemini: geminiConfigFromEnv({ GEMINI_API_KEY: 'k' }, net.http), log: silentLog, timeLeftMs: () => 100_000 });
  assert.ok(sp.names().has('clustersNeedingSummary'), 'normal mode must keep its summary step');
});
