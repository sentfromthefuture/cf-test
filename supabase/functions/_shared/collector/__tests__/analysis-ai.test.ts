// End-to-end behaviour of runAnalysis with the two AI engines, against the in-memory store.
// Proves: Decisions Fast classifies and caches; model outputs are stored apart from demand data; every failure mode degrades safely;
// LFM3 is optional and can never block core analysis; nothing is called unless explicitly enabled; test mode can reach neither engine.
// Payloads are SYNTHETIC (see ai-test-utils.ts): this is not evidence about the live APIs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { runAnalysis, AnalysisDeps } from '../analysis.ts';
import { LFM3_DEFAULT_MODEL, OpenRouterConfig } from '../ai.ts';
import { DECISIONS_DEFAULT_MODEL, DecisionsConfig } from '../decisions.ts';
import { HttpError } from '../types.ts';
import { MemoryStore, rec, silentLog } from './helpers.ts';
import { decisionsBody, scriptedHttp } from './ai-test-utils.ts';

class SummaryStore extends MemoryStore {
  needing: Array<{ id: string; statements: string[] }> = [];
  async clustersNeedingSummary() { return this.needing; }
}
const good = { title: 'Offline invoicing', problem_description: 'Shops cannot invoice offline.', target_persona: 'Shop owners', existing_solutions: ['Xero'], why_current_solutions_fall_short: 'Costly.', proposed_solution: 'Offline-first app.', suggested_features: ['a', 'b', 'c'], monetization_hypothesis: 'Hypothesis.', development_feasibility: 4, caveats: 'Thin.' };
const chat = (content: unknown) => ({ choices: [{ finish_reason: 'stop', message: { content } }], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } });
const clusters = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `c${i}`, statements: [`Need offline invoicing number ${i}, Xero is costly`, `Invoice app that works offline ${i}`] }));

async function seeded<T extends MemoryStore>(store: T, n: number, prefix = 'r'): Promise<T> {
  await store.upsertRecords(Array.from({ length: n }, (_, i) => rec('github', `${prefix}${i}`)));
  return store;
}
const statuses = (s: MemoryStore) => Object.fromEntries([...s.records.values()].map((r) => [r.source_record_id, r.status]));
const count = (s: MemoryStore, st: string) => [...s.records.values()].filter((r) => r.status === st).length;
const requeue = (s: MemoryStore) => { for (const r of s.records.values()) { r.status = 'pending'; r.attempts = 0; } s.signals.clear(); };

const decisionsCfg = (http: ReturnType<typeof scriptedHttp>['http'], over: Partial<DecisionsConfig> = {}): DecisionsConfig =>
  ({ apiKey: 'sk-or-v1-test-key-not-real', model: DECISIONS_DEFAULT_MODEL, configVersion: 'decisions-v1', http, maxLivePerRun: 20, minProblemProbability: 0.5, ...over });
const lfmCfg = (http: ReturnType<typeof scriptedHttp>['http']): OpenRouterConfig => ({ apiKey: 'sk-or-v1-test-key-not-real', model: LFM3_DEFAULT_MODEL, configVersion: 'summary-v1', http });
const deps = (store: MemoryStore, over: Partial<AnalysisDeps> = {}): AnalysisDeps => ({ store, gemini: null, log: silentLog, timeLeftMs: () => 120_000, ...over });

// ------------------------------------------------------------------ Decisions Fast end to end
test('Decisions: records are classified, saved, model outputs stored apart, usage recorded', async () => {
  const store = await seeded(new MemoryStore(), 4);
  const net = scriptedHttp(() => decisionsBody({ usage: { input_tokens: 400, output_tokens: 60, cost: 0 } }));
  const stats = await runAnalysis(deps(store, { decisions: decisionsCfg(net.http) }));
  assert.equal(stats.ran, true);
  assert.equal(stats.method, 'llm');
  assert.equal(stats.analysed, 4);
  assert.equal(stats.problems, 4);
  assert.equal(stats.failed, 0);
  assert.deepEqual(stats.decisions, { liveCalls: 4, cacheHits: 0, busy: 0, cooldown: 0, invalid: 0, deferred: 0, unstored: 0, stopped: null });
  assert.equal(count(store, 'done'), 4);
  assert.ok([...store.signals.values()].every((s) => s.analysis_method === 'llm' && s.model === 'parallel/decisions-fast:free'));
  assert.equal(store.signalAi.size, 4);
  const row = [...store.signalAi.values()][0];
  assert.equal(row.model_confidence, 0.6);
  assert.equal(row.citations.length, 1);
  assert.equal(store.aiUsage.length, 1, 'one usage flush per engine per run');
  assert.equal(store.aiUsage[0].engine, 'decisions');
  assert.deepEqual({ calls: store.aiUsage[0].usage.calls, ok: store.aiUsage[0].usage.successes, tokens: store.aiUsage[0].usage.input_tokens }, { calls: 4, ok: 4, tokens: 1600 });
  assert.equal(store.locks.size, 0, 'lock released');
});

test('Decisions: re-analysing unchanged content makes no requests at all', async () => {
  const store = await seeded(new MemoryStore(), 5);
  const net = scriptedHttp(() => decisionsBody());
  await runAnalysis(deps(store, { decisions: decisionsCfg(net.http) }));
  assert.equal(net.calls.length, 5);
  requeue(store); // e.g. a requeue/reanalyse pass over the same, unchanged records
  const stats = await runAnalysis(deps(store, { decisions: decisionsCfg(net.http) }));
  assert.equal(net.calls.length, 5, 'no new requests');
  assert.equal(stats.decisions!.liveCalls, 0);
  assert.equal(stats.decisions!.cacheHits, 5);
  assert.equal(stats.analysed, 5, 'results came from the cache');
});

test('Decisions: model confidence never changes the demand-facing signal rows', async () => {
  const run = async (conf: number, prob: number) => {
    const store = await seeded(new MemoryStore(), 3);
    const body = decisionsBody({ noul: prob });
    (body.answers.signal_type as any).confidence = conf; (body.answers.industry as any).confidence = conf; (body.answers.severity as any).confidence = conf;
    await runAnalysis(deps(store, { decisions: decisionsCfg(scriptedHttp(() => body).http) }));
    return store;
  };
  const hi = await run(0.99, 0.99);
  const lo = await run(0.05, 0.6);
  assert.deepEqual([...hi.signals.values()], [...lo.signals.values()], 'identical demand data whatever the model\'s confidence');
  assert.notDeepEqual([...hi.signalAi.values()].map((r) => r.model_confidence), [...lo.signalAi.values()].map((r) => r.model_confidence), 'but the confidences themselves are kept');
  for (const s of hi.signals.values()) assert.ok(!/confidence|probab/i.test(JSON.stringify(s)));
});

test('Decisions: a non-problem verdict is saved as a non-problem, with its model numbers', async () => {
  const store = await seeded(new MemoryStore(), 2);
  const stats = await runAnalysis(deps(store, { decisions: decisionsCfg(scriptedHttp(() => decisionsBody({ noul: 0.08 })).http) }));
  assert.equal(stats.analysed, 2);
  assert.equal(stats.problems, 0);
  assert.ok([...store.signals.values()].every((s) => !s.is_problem && s.problem_statement === null && s.severity === null));
  assert.ok([...store.signalAi.values()].every((r) => r.problem_probability === 0.08));
});

// ------------------------------------------------------------------ disabled by default; test mode cannot reach the engines
test('with no AI configured, nothing is called, cached or recorded (the production default)', async () => {
  const store = await seeded(new MemoryStore(), 3);
  const stats = await runAnalysis(deps(store));
  assert.equal(stats.method, 'heuristic');
  assert.equal(stats.decisions, undefined);
  assert.equal(stats.summaryAi, undefined);
  assert.ok([...store.signals.values()].every((s) => s.analysis_method === 'heuristic'));
  assert.equal(store.aiCache.size, 0);
  assert.equal(store.aiUsage.length, 0);
  assert.equal(store.signalAi.size, 0);
  assert.deepEqual(store.aiCacheCalls, { begin: 0, complete: 0, fail: 0, abandon: 0, invalidate: 0 });
});

test('test mode drops BOTH engines: no request can be made even when they are configured', async () => {
  const store = await seeded(new SummaryStore(), 3);
  store.needing = clusters(2);
  const net = scriptedHttp(() => { throw new Error('a request was made in test mode'); });
  const stats = await runAnalysis(deps(store, { testMode: true, decisions: decisionsCfg(net.http), openrouter: lfmCfg(net.http) }));
  assert.equal(net.calls.length, 0);
  assert.equal(stats.testMode, true);
  assert.equal(stats.decisions, undefined);
  assert.equal(stats.summaries, 0);
  assert.equal(store.aiCache.size, 0);
  assert.ok([...store.signals.values()].every((s) => s.analysis_method === 'heuristic'));
});

// ------------------------------------------------------------------ Decisions failure modes
test('Decisions rate-limited: records stay pending, nothing is failed, the run still completes', async () => {
  const store = await seeded(new MemoryStore(), 4);
  const net = scriptedHttp(() => { throw new HttpError('HTTP 429', 429); });
  const stats = await runAnalysis(deps(store, { decisions: decisionsCfg(net.http) }));
  assert.equal(net.calls.length, 1);
  assert.equal(stats.analysed, 0);
  assert.equal(stats.failed, 0);
  assert.equal(count(store, 'pending'), 4, 'nothing lost, nothing marked failed');
  assert.ok([...store.records.values()].every((r) => r.attempts === 0));
  assert.match(stats.note!, /Decisions engine stopped: rate_limited/);
  assert.match(stats.decisions!.stopped!, /rate_limited/);
  assert.equal(stats.ran, true);
  assert.equal(store.locks.size, 0);
  assert.equal(store.aiCache.size, 0);
  // the next run picks everything up as soon as the service is back
  const ok = scriptedHttp(() => decisionsBody());
  assert.equal((await runAnalysis(deps(store, { decisions: decisionsCfg(ok.http) }))).analysed, 4);
});

test('Decisions outage/timeouts/bad key behave the same: bounded, pending, no fallback', async () => {
  for (const [status, label] of [[503, 'unavailable'], [524, 'timeout'], [401, 'auth'], [404, 'not_found'], [402, 'quota']] as const) {
    const store = await seeded(new MemoryStore(), 3);
    const net = scriptedHttp(() => { throw new HttpError(`HTTP ${status}`, status); });
    const stats = await runAnalysis(deps(store, { decisions: decisionsCfg(net.http) }));
    assert.equal(net.calls.length, 1, label);
    assert.equal(count(store, 'pending'), 3, label);
    assert.equal(stats.failed, 0, label);
    assert.ok(net.calls.every((c) => c.url.endsWith('/alpha/decisions')), `${label}: no other endpoint`);
  }
});

test('Decisions per-run limit: bounded work per run, the remainder resumes next run, and the loop terminates', async () => {
  const store = await seeded(new MemoryStore(), 7);
  const net = scriptedHttp(() => decisionsBody());
  const first = await runAnalysis(deps(store, { decisions: decisionsCfg(net.http, { maxLivePerRun: 3 }) }));
  assert.equal(net.calls.length, 3);
  assert.equal(first.analysed, 3);
  assert.equal(count(store, 'pending'), 4);
  assert.equal(first.failed, 0);
  assert.equal(first.decisions!.liveCalls, 3);
  assert.ok(first.decisions!.deferred > 0);
  assert.equal(first.note, undefined, 'hitting the budget is normal, not an error');
  await runAnalysis(deps(store, { decisions: decisionsCfg(net.http, { maxLivePerRun: 3 }) }));
  await runAnalysis(deps(store, { decisions: decisionsCfg(net.http, { maxLivePerRun: 3 }) }));
  assert.equal(count(store, 'done'), 7, 'three runs drain seven records at three per run');
  assert.equal(net.calls.length, 7, 'each record was sent exactly once');
});

test('Decisions: an unusable answer is retried after its cooldown, not instantly and not forever', async () => {
  const store = await seeded(new MemoryStore(), 2);
  let now = 10_000_000;
  store.clock = () => now;
  let transient = true;
  const net = scriptedHttp((c) => (transient && c.body.state.title.includes('r0') ? { answers: {} } : decisionsBody()));
  const run = () => runAnalysis(deps(store, { decisions: decisionsCfg(net.http) }));
  const bad = () => [...store.records.values()].find((r) => r.source_record_id === 'r0')!;

  const s1 = await run();
  assert.equal(s1.analysed, 1, 'the good record is done');
  assert.equal(s1.failed, 1);
  assert.equal(s1.decisions!.invalid, 1);
  assert.deepEqual({ status: bad().status, attempts: bad().attempts }, { status: 'pending', attempts: 1 }, 'one real failure = one attempt, still retryable');
  assert.equal(net.calls.length, 2);

  await run(); await run();
  assert.equal(net.calls.length, 2, 'while cooling down, the bad input is never re-sent');
  assert.deepEqual({ status: bad().status, attempts: bad().attempts }, { status: 'pending', attempts: 1 }, 'waiting does not burn attempts');

  now += 61 * 60_000; // cooldown (1h) over; the provider has recovered
  transient = false;
  const s4 = await run();
  assert.equal(net.calls.length, 3, 'exactly one retry');
  assert.equal(s4.analysed, 1);
  assert.equal(bad().status, 'done', 'the transient failure healed itself');
});

test('Decisions: an input that keeps failing is tried three times over hours, then given up on', async () => {
  const store = await seeded(new MemoryStore(), 1);
  let now = 20_000_000;
  store.clock = () => now;
  const net = scriptedHttp(() => ({ answers: {} }));
  const run = () => runAnalysis(deps(store, { decisions: decisionsCfg(net.http) }));
  const rec0 = () => [...store.records.values()][0];
  await run();
  assert.deepEqual({ calls: net.calls.length, attempts: rec0().attempts, status: rec0().status }, { calls: 1, attempts: 1, status: 'pending' });
  now += 61 * 60_000; await run();
  assert.deepEqual({ calls: net.calls.length, attempts: rec0().attempts, status: rec0().status }, { calls: 2, attempts: 2, status: 'pending' });
  now += 61 * 60_000; await run();
  assert.equal(net.calls.length, 2, 'second cooldown is 2h, so one hour later it is still waiting');
  now += 61 * 60_000; await run();
  assert.deepEqual({ calls: net.calls.length, attempts: rec0().attempts, status: rec0().status }, { calls: 3, attempts: 3, status: 'failed' });
  now += 30 * 24 * 3600_000; await run();
  assert.equal(net.calls.length, 3, 'a failed record is never sent again');
});

test('Decisions: if the model outputs cannot be stored, records stay pending and the retry is free', async () => {
  class AiRowsFail extends MemoryStore { fail = true; async saveSignalAi(rows: any) { if (this.fail) throw new Error('db hiccup'); return super.saveSignalAi(rows); } }
  const store = await seeded(new AiRowsFail(), 3);
  const net = scriptedHttp(() => decisionsBody());
  const s1 = await runAnalysis(deps(store, { decisions: decisionsCfg(net.http) }));
  assert.equal(s1.analysed, 0, 'no record is marked done without its provenance');
  assert.equal(count(store, 'pending'), 3);
  assert.match(s1.note!, /AI output storage error/);
  assert.equal(store.signals.size, 0);
  store.fail = false;
  const s2 = await runAnalysis(deps(store, { decisions: decisionsCfg(net.http) }));
  assert.equal(net.calls.length, 3, 'the retry came entirely from the cache');
  assert.equal(s2.analysed, 3);
  assert.equal(store.signalAi.size, 3);
});

test('Decisions: usage telemetry is best-effort and a failure there cannot affect processing', async () => {
  const store = await seeded(new MemoryStore(), 3);
  store.failAiUsage = true;
  const stats = await runAnalysis(deps(store, { decisions: decisionsCfg(scriptedHttp(() => decisionsBody()).http) }));
  assert.equal(stats.analysed, 3);
  assert.equal(store.aiUsage.length, 0);
  assert.equal(store.locks.size, 0);
});

test('Decisions: with no working cache the engine spends nothing and the run survives', async () => {
  const store = await seeded(new MemoryStore(), 3);
  store.failAiCache = true;
  const net = scriptedHttp(() => decisionsBody());
  const stats = await runAnalysis(deps(store, { decisions: decisionsCfg(net.http) }));
  assert.equal(net.calls.length, 0);
  assert.equal(stats.analysed, 0);
  assert.equal(count(store, 'pending'), 3);
});

// ------------------------------------------------------------------ LFM3 is optional: it can never block core analysis
test('LFM3 failing (rate limit) does not touch core analysis; it stops after one request and nothing retries in a loop', async () => {
  const store = await seeded(new SummaryStore(), 4);
  store.needing = clusters(3);
  const lfm = scriptedHttp(() => { throw new HttpError('HTTP 429', 429); });
  const stats = await runAnalysis(deps(store, { openrouter: lfmCfg(lfm.http), maxOpenRouterSummaries: 5 }));
  assert.equal(stats.analysed, 4, 'core analysis completed');
  assert.equal(stats.problems, 4);
  assert.equal(stats.clustered, 4, 'clustering still ran');
  assert.equal(stats.summaries, 0);
  assert.equal(lfm.calls.length, 1, 'one request, then the engine is switched off for the run');
  assert.deepEqual(stats.summaryAi, { liveCalls: 1, cacheHits: 0, failures: 1, stopped: 'rate_limited' });
  assert.equal(store.summaries.size, 0);
  assert.equal(count(store, 'done'), 4);
  assert.equal(store.locks.size, 0);
});

test('LFM3 returning garbage or being down never raises, and never stops Decisions or the heuristic path', async () => {
  for (const handler of [() => chat('no json at all'), () => { throw new HttpError('HTTP 503', 503); }, () => ({}), () => { throw new Error('socket hang up'); }]) {
    const store = await seeded(new SummaryStore(), 3);
    store.needing = clusters(2);
    const decisions = scriptedHttp(() => decisionsBody());
    const stats = await runAnalysis(deps(store, { decisions: decisionsCfg(decisions.http), openrouter: lfmCfg(scriptedHttp(handler).http), maxOpenRouterSummaries: 5 }));
    assert.equal(stats.analysed, 3, 'core analysis is unaffected');
    assert.equal(stats.summaries, 0);
    assert.equal(store.summaries.size, 0, 'no half-built summary is saved');
    assert.equal(count(store, 'done'), 3);
  }
});

test('LFM3: an unusable summary for one cluster does not stop the next; it is not re-sent while cooling down', async () => {
  const store = await seeded(new SummaryStore(), 2);
  store.needing = clusters(2);
  const lfm = scriptedHttp((_c, n) => (n === 1 ? chat('prose only') : chat(JSON.stringify(good))));
  const s1 = await runAnalysis(deps(store, { openrouter: lfmCfg(lfm.http), maxOpenRouterSummaries: 5 }));
  assert.equal(s1.summaries, 1, 'the second cluster was still summarised');
  assert.equal(lfm.calls.length, 2);
  assert.deepEqual(store.summaries.has('c1'), true);
  assert.equal(s1.summaryAi!.stopped, null, 'one bad answer is not an outage');
  const s2 = await runAnalysis(deps(store, { openrouter: lfmCfg(lfm.http), maxOpenRouterSummaries: 5 }));
  assert.equal(lfm.calls.length, 2, 'neither the failed nor the successful cluster was sent again');
  assert.equal(s2.summaryAi!.cacheHits, 1);
});

test('LFM3 summaries are cached: an unchanged cluster is never summarised twice', async () => {
  const store = await seeded(new SummaryStore(), 2);
  store.needing = clusters(2);
  const lfm = scriptedHttp(() => chat(JSON.stringify(good)));
  const s1 = await runAnalysis(deps(store, { openrouter: lfmCfg(lfm.http), maxOpenRouterSummaries: 5 }));
  assert.equal(s1.summaries, 2);
  assert.equal(lfm.calls.length, 2);
  assert.equal(store.summaries.size, 2);
  const s2 = await runAnalysis(deps(store, { openrouter: lfmCfg(lfm.http), maxOpenRouterSummaries: 5 }));
  assert.equal(lfm.calls.length, 2, 'cluster flagged dirty again but the evidence is unchanged: no request');
  assert.equal(s2.summaries, 2, 'summaries are still (re)saved from the cache');
  assert.deepEqual(s2.summaryAi, { liveCalls: 0, cacheHits: 2, failures: 0, stopped: null });
  const usage = store.aiUsage.filter((u) => u.engine === 'summary');
  assert.equal(usage.length, 2, 'both runs recorded usage');
  assert.equal(usage[1].usage.cache_hits, 2);
});

test('LFM3 is not used unless configured, and it never replaces Decisions or runs on the Decisions endpoint', async () => {
  const store = await seeded(new SummaryStore(), 2);
  store.needing = clusters(1);
  const decisions = scriptedHttp(() => decisionsBody());
  const stats = await runAnalysis(deps(store, { decisions: decisionsCfg(decisions.http), maxOpenRouterSummaries: 5 }));
  assert.equal(stats.summaries, 0, 'no summary engine configured => no summaries, and no error');
  assert.ok(decisions.calls.every((c) => c.url.endsWith('/alpha/decisions') && c.body.model === 'parallel/decisions-fast:free'));
  const both = scriptedHttp((c) => (c.url.endsWith('/alpha/decisions') ? decisionsBody() : chat(JSON.stringify(good))));
  const store2 = await seeded(new SummaryStore(), 2);
  store2.needing = clusters(1);
  await runAnalysis(deps(store2, { decisions: decisionsCfg(both.http), openrouter: lfmCfg(both.http) }));
  const models = both.calls.map((c) => `${c.url.split('/').slice(-2).join('/')} ${c.body.model}`).sort();
  assert.deepEqual(models, ['alpha/decisions parallel/decisions-fast:free', 'alpha/decisions parallel/decisions-fast:free', 'chat/completions liquid/lfm-3-1.7b:free']);
  assert.ok(both.calls.every((c) => /:free$/.test(c.body.model)), 'every request in the system targets an explicit free model');
});

// ------------------------------------------------------------------ cache first and severity isolation, end to end
test('CACHE FIRST end to end: with the budget spent, queued records that are already cached still complete', async () => {
  const store = await seeded(new MemoryStore(), 6); // r0..r5, queue order r0..r5
  const net = scriptedHttp(() => decisionsBody());
  // warm the cache for the LAST three records only (r3..r5), as an earlier run or an identical earlier post would have
  const { classifyWithDecisions, newDecisionsRunState } = await import('../decisions-runner.ts');
  const all = await store.claimPending(100);
  await classifyWithDecisions({ cfg: decisionsCfg(net.http), store, records: all.filter((r) => ['r3', 'r4', 'r5'].some((x) => r.title!.includes(x))), state: newDecisionsRunState(), log: silentLog, timeLeftMs: () => 120_000 });
  assert.equal(net.calls.length, 3);
  const before = net.calls.length;

  const stats = await runAnalysis(deps(store, { decisions: decisionsCfg(net.http, { maxLivePerRun: 1 }) }));
  assert.equal(net.calls.length - before, 1, 'one live request: the budget');
  assert.equal(stats.analysed, 4, 'r0 live + r3, r4, r5 straight from the cache, although they sit behind records that could not be sent');
  assert.equal(stats.decisions!.cacheHits, 3);
  assert.equal(count(store, 'pending'), 2, 'only the two uncached records wait');
  assert.equal(stats.failed, 0);
  assert.equal(store.locks.size, 0);
  assert.equal(stats.note, undefined, 'running out of budget is normal, not an error');
});

test('SEVERITY ISOLATION end to end: Decisions never writes a severity into dr_problem_signals, but keeps it in dr_signal_ai', async () => {
  const store = await seeded(new MemoryStore(), 4);
  const stats = await runAnalysis(deps(store, { decisions: decisionsCfg(scriptedHttp(() => decisionsBody()).http) }));
  assert.equal(stats.problems, 4);
  assert.ok([...store.signals.values()].every((s) => s.is_problem && s.severity === null), 'no AI severity in the demand data');
  for (const row of store.signalAi.values()) assert.deepEqual((row.answers as any).severity, { value: 3, score: 2.4, confidence: 0.6 }, 'the estimate is preserved on its own row');
});

// ------------------------------------------------------------------ DURABILITY: a record is never done without durable provenance
const provenanceIsDurable = (store: MemoryStore) => {
  const byId = new Map([...store.aiCache.values()].map((e) => [e.id, e]));
  return [...store.signalAi.values()].every((r) => r.cache_id !== null && byId.get(r.cache_id)?.status === 'succeeded' && byId.get(r.cache_id)?.result !== null);
};

test('DURABILITY: if the cache write fails after a valid answer, nothing is persisted and the record stays pending', async () => {
  class WriteFails extends MemoryStore { broken = true; async aiCacheComplete(l: any, r: any, c: any, u: any): Promise<boolean> { if (this.broken) throw new Error('db hiccup'); return super.aiCacheComplete(l, r, c, u); } }
  const store = await seeded(new WriteFails(), 3);
  const net = scriptedHttp(() => decisionsBody());
  const s1 = await runAnalysis(deps(store, { decisions: decisionsCfg(net.http) }));
  assert.equal(s1.analysed, 0, 'no record was marked done');
  assert.equal(count(store, 'pending'), 3, 'all three are still pending');
  assert.equal(store.signals.size, 0, 'no signal was persisted');
  assert.equal(store.signalAi.size, 0, 'and no provenance row pointing at nothing');
  assert.equal(net.calls.length, 1, 'spending stops after the first answer that cannot be kept (not one wasted request per record)');
  assert.equal(s1.decisions!.unstored, 1);
  assert.match(s1.decisions!.stopped!, /cache write failed/);
  assert.equal(s1.failed, 0, 'a cache problem is never held against the record');
  assert.ok([...store.records.values()].every((r) => r.attempts === 0));
  assert.equal(store.locks.size, 0);

  store.broken = false; // the database recovers
  const s2 = await runAnalysis(deps(store, { decisions: decisionsCfg(net.http) }));
  assert.equal(s2.analysed, 3, 'the next run completes every record');
  assert.equal(net.calls.length, 4, 'safe retry: one live request per record, none repeated');
  assert.equal(store.signalAi.size, 3);
  assert.ok(provenanceIsDurable(store), 'every provenance row links to a stored, non-empty cache entry');
});

test('DURABILITY: if another worker holds the newer lease, only that record waits and it recovers from the cache', async () => {
  class LostLease extends MemoryStore {
    first = true;
    async aiCacheComplete(l: any, r: any, c: any, u: any): Promise<boolean> {
      if (this.first) {
        this.first = false;
        // another worker took over with a newer epoch and stored ITS answer; ours is fenced out
        const e = [...this.aiCache.values()].find((x) => x.id === l.id)!;
        Object.assign(e, { epoch: e.epoch + 1, status: 'succeeded', result: r, citations: c, usage: u, leaseUntil: null });
        return false;
      }
      return super.aiCacheComplete(l, r, c, u);
    }
  }
  const store = await seeded(new LostLease(), 3);
  const net = scriptedHttp(() => decisionsBody());
  const s1 = await runAnalysis(deps(store, { decisions: decisionsCfg(net.http) }));
  assert.equal(s1.analysed, 2, 'the two records whose answers were durably stored are done');
  assert.equal(count(store, 'pending'), 1, 'the record whose lease was lost waits');
  assert.equal(s1.decisions!.unstored, 1);
  assert.equal(s1.decisions!.stopped, null, 'losing one lease is not a reason to stop the engine');
  assert.equal(s1.failed, 0);
  assert.ok(provenanceIsDurable(store), 'no provenance row was saved for the unstored answer');
  const callsAfterFirst = net.calls.length;
  const s2 = await runAnalysis(deps(store, { decisions: decisionsCfg(net.http) }));
  assert.equal(net.calls.length, callsAfterFirst, 'recovered from the cache: the other worker\'s stored answer, no new request');
  assert.equal(s2.analysed, 1);
  assert.equal(s2.decisions!.cacheHits, 1);
  assert.equal(count(store, 'done'), 3);
  assert.ok(provenanceIsDurable(store));
});

test('DURABILITY: a lost lease on a stale worker never blocks its neighbours or marks anything failed', async () => {
  class AlwaysLost extends MemoryStore { async aiCacheComplete(): Promise<boolean> { return false; } }
  const store = await seeded(new AlwaysLost(), 4);
  const net = scriptedHttp(() => decisionsBody());
  const s = await runAnalysis(deps(store, { decisions: decisionsCfg(net.http) }));
  assert.equal(s.analysed, 0);
  assert.equal(count(store, 'pending'), 4);
  assert.equal(s.failed, 0);
  assert.equal(store.signalAi.size, 0, 'no provenance without a durable cache entry');
  assert.equal(store.locks.size, 0);
});
