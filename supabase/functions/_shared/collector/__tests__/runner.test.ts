import test from 'node:test';
import assert from 'node:assert/strict';
import { runCollection } from '../runner.ts';
import { Connector, FetchResult, RateLimitError, ConnectorError } from '../types.ts';
import { MemoryStore, rec, silentLog } from './helpers.ts';

/** Fake connector emitting `pages` of records, resumable via cursor.page. */
function pagedConnector(id: string, pages: string[][], opts: { failAtPage?: number; rateLimitAtPage?: number } = {}): Connector {
  return {
    id, name: id,
    checkConfig: () => ({ ok: true, missing: [], notes: [] }),
    async fetchBatch(ctx): Promise<FetchResult> {
      const page = Number((ctx.cursor as any).page ?? 0);
      if (opts.failAtPage === page) throw new ConnectorError('upstream exploded');
      if (opts.rateLimitAtPage === page) throw new RateLimitError('slow down', new Date('2026-11-04T13:00:00Z'));
      const ids = pages[page] ?? [];
      return { records: ids.map((i) => rec(id, i)), cursor: { page: page + 1 }, done: page + 1 >= pages.length, quota: { limit: 10, remaining: 5, resetAt: null } };
    },
  };
}

const run = (store: MemoryStore, connectors: Record<string, Connector>, o: Partial<Parameters<typeof runCollection>[0]> = {}) =>
  runCollection({ env: {}, store, connectors, trigger: 'manual', log: silentLog, skipAnalysis: true, ...o });

test('collects across pages, persists cursor, reports stats and quota', async () => {
  const store = new MemoryStore();
  store.addSource('gh');
  const rep = await run(store, { gh: pagedConnector('gh', [['1', '2'], ['3']]) });
  assert.equal(rep.sources[0].status, 'success');
  assert.equal(rep.sources[0].stats.inserted, 3);
  assert.equal(store.records.size, 3);
  assert.deepEqual(store.finished[0].cursor, { page: 2 });
  assert.equal(store.quotas.length, 2);
  assert.equal(store.usage.length, 1);
  assert.equal(store.sources.get('gh')!.locked, false, 'source unlocked after run');
});

test('re-running is safe: duplicates are detected, nothing is inserted twice', async () => {
  const store = new MemoryStore();
  store.addSource('gh');
  const c = pagedConnector('gh', [['1', '2']]);
  await run(store, { gh: c });
  store.sources.get('gh')!.cursor = {}; // replay the same window (e.g. a retried job)
  const rep = await run(store, { gh: c });
  assert.equal(rep.sources[0].stats.inserted, 0);
  assert.equal(rep.sources[0].stats.duplicates, 2);
  assert.equal(store.records.size, 2);
});

test('one failing connector never crashes the others', async () => {
  const store = new MemoryStore();
  ['good', 'bad', 'ghost'].forEach((s) => store.addSource(s));
  const rep = await runCollection({
    env: {}, store, trigger: 'schedule', log: silentLog, skipAnalysis: true,
    connectors: { good: pagedConnector('good', [['1']]), bad: pagedConnector('bad', [['1']], { failAtPage: 0 }) }, // 'ghost' has no connector
  });
  const by = Object.fromEntries(rep.sources.map((s) => [s.id, s]));
  assert.equal(by.good.status, 'success');
  assert.equal(by.bad.status, 'error');
  assert.match(by.bad.error!, /upstream exploded/);
  assert.equal(by.ghost.status, 'error');
  assert.match(by.ghost.error!, /no connector implemented/);
  assert.equal(store.records.size, 1);
  assert.equal(store.finished.length, 3, 'every claimed source is finished (none left locked)');
  assert.ok([...store.sources.values()].every((s) => !s.locked));
});

test('missing required configuration is an error, not a fake success', async () => {
  const store = new MemoryStore();
  store.addSource('needs-key');
  const c: Connector = { ...pagedConnector('needs-key', [['1']]), checkConfig: () => ({ ok: false, missing: ['SOME_API_KEY'], notes: [] }) };
  const rep = await run(store, { 'needs-key': c });
  assert.equal(rep.sources[0].status, 'error');
  assert.match(rep.sources[0].error!, /missing configuration: SOME_API_KEY/);
  assert.equal(store.records.size, 0);
});

test('rate limit: stops cleanly, keeps progress, reschedules after the reset time', async () => {
  const store = new MemoryStore();
  store.addSource('gh');
  const rep = await run(store, { gh: pagedConnector('gh', [['1'], ['2'], ['3']], { rateLimitAtPage: 1 }) });
  assert.equal(rep.sources[0].status, 'partial');
  assert.equal(store.records.size, 1, 'page 0 kept');
  assert.deepEqual(store.finished[0].cursor, { page: 1 }, 'cursor points at the page that was blocked');
  assert.equal(store.finished[0].nextRunAt!.toISOString(), '2026-11-04T13:00:00.000Z');
});

test('upstream quota exhaustion reported by a connector stops the run but keeps its records', async () => {
  const store = new MemoryStore();
  store.addSource('se');
  const c: Connector = { id: 'se', name: 'se', checkConfig: () => ({ ok: true, missing: [], notes: [] }),
    fetchBatch: async () => ({ records: [rec('se', '1')], cursor: { page: 1 }, done: false, rateLimitedUntil: '2026-11-05T00:00:00.000Z' }) };
  const rep = await run(store, { se: c });
  assert.equal(rep.sources[0].status, 'partial');
  assert.equal(store.records.size, 1);
  assert.equal(store.finished[0].nextRunAt!.toISOString(), '2026-11-05T00:00:00.000Z');
});

test('database failure mid-run: cursor does NOT advance past unsaved data', async () => {
  const store = new MemoryStore();
  store.addSource('gh', {}, { page: 0 });
  store.failUpsert = true;
  const rep = await run(store, { gh: pagedConnector('gh', [['1', '2'], ['3']]) });
  assert.equal(rep.sources[0].status, 'error');
  assert.deepEqual(store.finished[0].cursor, { page: 0 }, 'retry will re-fetch the same page');
  assert.equal(store.records.size, 0);
});

test('time budget exhaustion yields a partial run that resumes soon, not an error', async () => {
  const store = new MemoryStore();
  store.addSource('gh');
  let t = 0;
  const c = pagedConnector('gh', Array.from({ length: 100 }, (_, i) => [`${i}`]));
  const rep = await runCollection({ env: {}, store, trigger: 'schedule', log: silentLog, skipAnalysis: true, connectors: { gh: c }, budgetMs: 30_000, now: () => new Date((t += 4_000)) });
  assert.equal(rep.sources[0].status, 'partial');
  assert.ok(store.records.size > 0 && store.records.size < 100);
  assert.match(rep.sources[0].error!, /budget/);
  assert.ok(store.finished[0].nextRunAt);
});

test('manual sync of one source only claims that source; locked sources are not double-run', async () => {
  const store = new MemoryStore();
  store.addSource('a'); store.addSource('b');
  const conns = { a: pagedConnector('a', [['1']]), b: pagedConnector('b', [['1']]) };
  const rep = await run(store, conns, { source: 'b' });
  assert.deepEqual(rep.claimed, ['b']);
  store.sources.get('a')!.locked = true;
  const again = await run(store, conns);
  assert.deepEqual(again.claimed, ['b'], 'locked source skipped (no duplicate jobs)');
});

test('analysis without an LLM key: labelled heuristic signals, obvious non-problems skipped, nothing analysed twice', async () => {
  const store = new MemoryStore();
  store.addSource('gh');
  const conn: Connector = { id: 'gh', name: 'gh', checkConfig: () => ({ ok: true, missing: [], notes: [] }),
    fetchBatch: async () => ({ done: true, cursor: {}, records: [
      rec('gh', '1', { title: 'Wish there was an offline mode', excerpt: 'This is so frustrating when travelling, we would pay for it.' }),
      rec('gh', '2', { title: 'Bump version', excerpt: 'chore: release 1.2.3' }),
    ] }) };
  const rep = await runCollection({ env: {}, store, trigger: 'manual', log: silentLog, connectors: { gh: conn } });
  assert.equal(rep.analysis!.method, 'heuristic');
  assert.equal(rep.analysis!.skipped, 1);
  assert.equal(rep.analysis!.analysed, 1);
  assert.equal(rep.analysis!.problems, 1);
  const sig = [...store.signals.values()][0];
  assert.equal(sig.analysis_method, 'heuristic');
  assert.equal(sig.severity, null);

  const second = await runCollection({ env: {}, store, trigger: 'manual', log: silentLog, connectors: { gh: conn } });
  assert.equal(second.analysis!.claimed, 0, 'unchanged records are not re-analysed');
  assert.equal(store.signals.size, 1);
});

test('analysis lock: a concurrent analysis job is refused', async () => {
  const store = new MemoryStore();
  store.locks.add('analysis');
  const rep = await runCollection({ env: {}, store, trigger: 'schedule', log: silentLog });
  assert.equal(rep.analysis!.ran, false);
  assert.match(rep.analysis!.note!, /another analysis job/);
});

test('analysis with an LLM key: classification + 768-d embeddings flow to storage; LLM outage marks records for retry', async () => {
  const store = new MemoryStore();
  store.addSource('gh');
  const conn: Connector = { id: 'gh', name: 'gh', checkConfig: () => ({ ok: true, missing: [], notes: [] }),
    fetchBatch: async () => ({ done: true, cursor: {}, records: [rec('gh', '1', { title: 'Need offline invoices', excerpt: 'I wish there was offline invoicing. We would pay $15/month for it.' })] }) };
  const emb = Array.from({ length: 768 }, (_, i) => (i === 3 ? 1 : 0));
  let outage = false;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    if (outage) return new Response('boom', { status: 400 });
    const u = String(url);
    if (u.includes(':generateContent')) {
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ results: [{ i: 0, is_problem: true, signal_type: 'feature_request', problem_statement: 'Small businesses cannot invoice customers while offline', industry: 'Finance & Payments', severity: 4, wtp_quote: 'We would pay $15/month for it', competitors: [], language: 'en' }] }) }] } }] }), { status: 200 });
    }
    if (u.includes(':batchEmbedContents')) return new Response(JSON.stringify({ embeddings: [{ values: emb }] }), { status: 200 });
    throw new Error('unexpected url ' + u);
  }) as unknown as typeof fetch;

  const rep = await runCollection({ env: { GEMINI_API_KEY: 'k' }, store, trigger: 'manual', log: silentLog, connectors: { gh: conn }, fetchImpl, sleep: async () => {} });
  assert.equal(rep.analysis!.method, 'llm');
  const sig = [...store.signals.values()][0];
  assert.equal(sig.analysis_method, 'llm');
  assert.equal(sig.severity, 4);
  assert.equal(sig.wtp_evidence, true);
  assert.equal(sig.embedding!.length, 768);

  // outage: a changed record fails analysis and stays retryable (3 strikes -> failed), never silently "done"
  const store2 = new MemoryStore();
  store2.addSource('gh');
  outage = true;
  const rep2 = await runCollection({ env: { GEMINI_API_KEY: 'k' }, store: store2, trigger: 'manual', log: silentLog, connectors: { gh: conn }, fetchImpl, sleep: async () => {} });
  assert.ok(rep2.analysis!.failed >= 1);
  assert.equal(store2.signals.size, 0);
  assert.equal([...store2.records.values()][0].status, 'pending');
});

test('analysisOnly processes the queue without claiming or running any source', async () => {
  const store = new MemoryStore();
  store.addSource('gh');
  await store.upsertRecords([rec('gh', '1', { title: 'Wish there was offline mode', excerpt: 'This is frustrating, we would pay for it.' })]);
  const rep = await runCollection({ env: {}, store, trigger: 'manual', log: silentLog, analysisOnly: true, connectors: {} });
  assert.deepEqual(rep.claimed, []);
  assert.equal(rep.analysis!.analysed, 1);
  assert.equal(store.sources.get('gh')!.locked, false);
});

test('re-queue sends keyword-analysed records back through (now AI) analysis', async () => {
  const store = new MemoryStore();
  await store.upsertRecords([rec('gh', '1', { title: 'Wish there was offline mode', excerpt: 'This is frustrating when travelling.' })]);
  await runCollection({ env: {}, store, trigger: 'manual', log: silentLog, analysisOnly: true, connectors: {} });
  assert.equal([...store.signals.values()][0].analysis_method, 'heuristic');
  assert.equal(await store.requeueHeuristicAnalysis(100), 1);
  assert.equal(store.signals.size, 0);
  const emb = Array.from({ length: 768 }, (_, i) => (i === 1 ? 1 : 0));
  const fetchImpl = (async (url: string) => String(url).includes(':generateContent')
    ? new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ results: [{ i: 0, is_problem: true, signal_type: 'feature_request', problem_statement: 'Travellers cannot use the product without a connection', industry: 'Other', severity: 3, competitors: [], language: 'en' }] }) }] } }] }))
    : new Response(JSON.stringify({ embeddings: [{ values: emb }] }))) as unknown as typeof fetch;
  await runCollection({ env: { GEMINI_API_KEY: 'k' }, store, trigger: 'manual', log: silentLog, analysisOnly: true, connectors: {}, fetchImpl, sleep: async () => {} });
  assert.equal([...store.signals.values()][0].analysis_method, 'llm');
});
