// End-to-end tests of the `ai_smoke_test` action through the REAL Edge Function handler (auth, routing, store, HTTP client), against a fake PostgREST
// backend and a fake OpenRouter. Nothing here reaches a real network: every outbound request is intercepted and recorded, and an unknown host or RPC fails the test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decisionsBody } from './ai-test-utils.ts';

const KEY = 'sk-or-v1-test-key-not-real';
const SERVICE_KEY = 'svc-service-role-key';
const BASE_ENV: Record<string, string> = {
  SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: SERVICE_KEY, SUPABASE_ANON_KEY: 'anon', COLLECTOR_SECRET: 'cron-secret',
  DECISIONS_MIN_INTERVAL_MS: '1', OPENROUTER_MIN_INTERVAL_MS: '1',
};
// The handler reads Deno.env once at import, so the object it holds is mutated between tests instead of being replaced.
const ENV: Record<string, string> = { ...BASE_ENV };
const setEnv = (extra: Record<string, string> = {}) => { for (const k of Object.keys(ENV)) delete ENV[k]; Object.assign(ENV, BASE_ENV, extra); };
const AI_ON = { DECISIONS_ENABLED: 'true', OPENROUTER_ENABLED: 'true', OPENROUTER_API_KEY: KEY };

let handler: (req: Request) => Promise<Response>;
(globalThis as any).Deno = { env: { toObject: () => ENV }, serve: (h: typeof handler) => { handler = h; } };
await import('../../../collect/index.ts');

const DECISIONS_URL = 'https://openrouter.ai/api/alpha/decisions';
const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';
const summaryJson = {
  title: 'Offline invoicing', problem_description: 'Cannot invoice offline.', target_persona: 'Shop owners', existing_solutions: [], why_current_solutions_fall_short: 'Cost.',
  proposed_solution: 'Offline-first app.', suggested_features: ['sync'], monetization_hypothesis: 'Hypothesis: fee.', development_feasibility: 4, caveats: 'Thin evidence.',
};

type Rpc = { name: string; body: any };
type Ai = { url: string; authorization: string | undefined; body: any };

/** Fake Supabase (a small model of the dr_ai_cache state machine plus the RPCs the smoke test may use) and fake OpenRouter. Records everything. */
function installBackend(opts: { pending?: number; isAdmin?: boolean; ai?: 'ok' | '500' | '429' } = {}) {
  const pending = opts.pending ?? 25;
  const rpcs: Rpc[] = [];
  const ai: Ai[] = [];
  const hosts = new Set<string>();
  const unexpected: string[] = [];
  const cache = new Map<string, { id: string; status: 'pending' | 'succeeded' | 'failed'; result: unknown }>();
  let ids = 0;
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    hosts.add(new URL(url).host);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const ok = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });

    if (url.startsWith('https://openrouter.ai/')) {
      ai.push({ url, authorization: init?.headers?.authorization, body });
      if (opts.ai === '500') return new Response('{"error":"boom"}', { status: 500 });
      if (opts.ai === '429') return new Response('{}', { status: 429, headers: { 'retry-after': '1' } });
      if (url === DECISIONS_URL) return ok(decisionsBody());
      if (url === CHAT_URL) return ok({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(summaryJson) } }], usage: { prompt_tokens: 300, completion_tokens: 120, total_tokens: 420, cost: 0 } });
    }
    const name = /^https:\/\/x\.supabase\.co\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1];
    if (!name) { unexpected.push(url); return new Response('{"message":"unexpected host"}', { status: 400 }); }
    rpcs.push({ name, body });
    switch (name) {
      case 'dr_is_admin': return ok(opts.isAdmin ?? true);
      case 'dr_acquire_lock': return ok(true);
      case 'dr_release_lock': case 'dr_ai_cache_abandon': case 'dr_ai_cache_invalidate': return ok(null);
      case 'dr_claim_pending_records': {
        const n = Math.min(Math.max(body.p_limit, 1), 200, pending); // same clamp as the SQL function
        return ok(Array.from({ length: n }, (_, i) => ({ id: `r${i}`, source_id: 'github', kind: 'issue', title: `Need offline invoicing number ${i}`, excerpt: `I wish there was a tool for ${i}. It is frustrating.`, categories: ['label:feature request'], engagement: { score: 3 }, content_hash: `h${i}`, language: 'en' })));
      }
      case 'dr_ai_cache_begin': {
        const k = `${body.p_task}|${body.p_hash}|${body.p_model}|${body.p_version}`;
        const e = cache.get(k);
        if (!e) { const id = `c${++ids}`; cache.set(k, { id, status: 'pending', result: null }); return ok({ state: 'claimed', id, epoch: 1 }); }
        if (e.status === 'succeeded') return ok({ state: 'hit', id: e.id, result: e.result, citations: [], usage: {} });
        return ok({ state: 'busy', id: e.id });
      }
      case 'dr_ai_cache_complete': {
        for (const e of cache.values()) if (e.id === body.p_id) Object.assign(e, { status: 'succeeded', result: body.p_result });
        return ok(true);
      }
      case 'dr_ai_cache_fail': {
        for (const e of cache.values()) if (e.id === body.p_id) e.status = 'failed';
        return ok(true);
      }
      case 'dr_save_signal_ai': return ok(body.p_rows.length);
      case 'dr_ai_note_usage': return ok(null);
      default: unexpected.push(`rpc ${name}`); return new Response(JSON.stringify({ message: `unexpected rpc ${name}` }), { status: 400 });
    }
  }) as typeof fetch;
  return { rpcs, ai, hosts, unexpected, cache, names: () => rpcs.map((r) => r.name), restore: () => { globalThis.fetch = real; } };
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  handler(new Request('https://x.supabase.co/functions/v1/collect', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) }));
const admin = { authorization: 'Bearer admin-jwt' };

async function withBackend<T>(env: Record<string, string>, opts: Parameters<typeof installBackend>[0], fn: (b: ReturnType<typeof installBackend>) => Promise<T>) {
  setEnv(env);
  const b = installBackend(opts);
  try { return await fn(b); } finally { b.restore(); setEnv(); }
}

const ALLOWED_RPCS = new Set(['dr_is_admin', 'dr_acquire_lock', 'dr_release_lock', 'dr_claim_pending_records', 'dr_ai_cache_begin', 'dr_ai_cache_complete', 'dr_ai_cache_fail', 'dr_ai_cache_abandon',
  'dr_ai_cache_fail_storage', 'dr_ai_cache_invalidate', 'dr_save_signal_ai', 'dr_ai_note_usage']);
const NEVER_RPCS = ['dr_mark_skipped', 'dr_mark_analysis_failed', 'dr_save_signals', 'dr_claim_due_sources', 'dr_finish_run', 'dr_note_usage', 'dr_set_quota', 'dr_existing_ids', 'dr_upsert_records',
  'dr_requeue_heuristic_analysis', 'dr_assign_pending_clusters', 'dr_refresh_clusters', 'dr_clusters_needing_summary', 'dr_save_cluster_summary'];

// ------------------------------------------------------------------------------------------------ authorization

test('unauthorized: the schedule secret is refused with 403 and NOTHING is sent anywhere, even with both engines enabled', () =>
  withBackend(AI_ON, {}, async (b) => {
    const res = await post({ action: 'ai_smoke_test' }, { 'x-collector-secret': 'cron-secret' });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: 'forbidden' });
    assert.equal(b.rpcs.length, 0);
    assert.equal(b.ai.length, 0);
    assert.equal(b.hosts.size, 0);
  }));

test('unauthorized: the schedule secret plus an admin JWT is still treated as the scheduler and refused', () =>
  withBackend(AI_ON, {}, async (b) => {
    const res = await post({ action: 'ai_smoke_test' }, { 'x-collector-secret': 'cron-secret', ...admin });
    assert.equal(res.status, 403);
    assert.equal(b.rpcs.length + b.ai.length, 0);
  }));

test('unauthorized: a wrong schedule secret and no credentials at all are refused with 401', () =>
  withBackend(AI_ON, {}, async (b) => {
    assert.equal((await post({ action: 'ai_smoke_test' })).status, 401);
    assert.equal((await post({ action: 'ai_smoke_test' }, { 'x-collector-secret': 'wrong' })).status, 401);
    assert.equal(b.ai.length, 0);
    assert.equal(b.rpcs.filter((r) => r.name !== 'dr_is_admin').length, 0);
  }));

test('unauthorized: a signed-in NON-admin is refused; only the admin check ran, and no AI request was made', () =>
  withBackend(AI_ON, { isAdmin: false }, async (b) => {
    const res = await post({ action: 'ai_smoke_test' }, admin);
    assert.equal(res.status, 401);
    assert.deepEqual(b.names(), ['dr_is_admin']);
    assert.equal(b.ai.length, 0);
  }));

test('unauthorized: no body field can stand in for admin, and an unauthenticated caller learns nothing about which actions exist', () =>
  withBackend(AI_ON, { isAdmin: false }, async (b) => {
    const res = await post({ action: 'ai_smoke_test', admin: true, isAdmin: true, role: 'admin', trigger: 'manual', user_id: 'someone' }, admin);
    assert.equal(res.status, 401);
    assert.deepEqual(b.names(), ['dr_is_admin']);
    const unknown = await post({ action: 'definitely_not_an_action' });
    assert.equal(unknown.status, 401, 'auth is checked before the action is even looked at');
  }));

// ------------------------------------------------------------------------------------------------ behaviour for an admin

test('admin, engines not enabled: 200, nothing tested, and the database is not touched beyond the admin check', () =>
  withBackend({ OPENROUTER_API_KEY: KEY }, {}, async (b) => {
    const res = await post({ action: 'ai_smoke_test' }, admin);
    assert.equal(res.status, 200);
    const rep = await res.json();
    assert.equal(rep.overall, 'nothing_tested');
    assert.equal(rep.decisions.status, 'disabled');
    assert.equal(rep.lfm3.status, 'disabled');
    assert.deepEqual(b.names(), ['dr_is_admin']);
    assert.equal(b.ai.length, 0);
  }));

test('admin, both engines enabled: passes on 3 of 25 pending records with exactly 3 + 1 AI requests, to OpenRouter only', () =>
  withBackend(AI_ON, { pending: 25 }, async (b) => {
    const res = await post({ action: 'ai_smoke_test' }, admin);
    assert.equal(res.status, 200);
    const rep = await res.json();
    assert.equal(rep.testMode, true);
    assert.equal(rep.action, 'ai_smoke_test');
    assert.equal(rep.maxRecords, 3);
    assert.equal(rep.overall, 'passed');
    assert.equal(rep.ok, true);
    assert.equal(rep.records.selected, 3);
    assert.equal(rep.decisions.model, 'parallel/decisions-fast:free');
    assert.equal(rep.lfm3.model, 'baidu/ernie-5.5-flash-preview:free');
    assert.equal(typeof rep.elapsedMs, 'number');

    assert.equal(b.ai.filter((a) => a.url === DECISIONS_URL).length, 3);
    assert.equal(b.ai.filter((a) => a.url === CHAT_URL).length, 1);
    assert.equal(b.ai.length, 4);
    assert.deepEqual([...b.hosts].sort(), ['openrouter.ai', 'x.supabase.co']);
    assert.deepEqual(b.unexpected, []);
    const claims = b.rpcs.filter((r) => r.name === 'dr_claim_pending_records');
    assert.equal(claims.length, 1);
    assert.ok(claims[0].body.p_limit <= 12);
    const saved = b.rpcs.filter((r) => r.name === 'dr_save_signal_ai').flatMap((r) => r.body.p_rows);
    assert.equal(saved.length, 3);
    assert.equal(b.rpcs.filter((r) => r.name === 'dr_ai_note_usage').length, 2, 'one usage write per engine');
  }));

test('admin run touches ONLY the allowed RPCs; it never changes record status, sources, clusters or requeues anything', () =>
  withBackend(AI_ON, { pending: 25 }, async (b) => {
    await post({ action: 'ai_smoke_test' }, admin);
    for (const n of b.names()) assert.ok(ALLOWED_RPCS.has(n), `ai_smoke_test called disallowed rpc ${n}`);
    for (const never of NEVER_RPCS) assert.ok(!b.names().includes(never), `must not call ${never}`);
    assert.equal(b.names().filter((n) => n === 'dr_acquire_lock').length, 1);
    assert.equal(b.names().filter((n) => n === 'dr_release_lock').length, 1);
    assert.equal(b.rpcs.find((r) => r.name === 'dr_acquire_lock')!.body.p_name, 'ai_smoke_test');
    assert.equal(b.rpcs.find((r) => r.name === 'dr_release_lock')!.body.p_name, 'ai_smoke_test');
  }));

test('secrets: the response never contains the OpenRouter key or the service key, and neither key is ever sent to the wrong host', () =>
  withBackend(AI_ON, { pending: 25 }, async (b) => {
    const text = await (await post({ action: 'ai_smoke_test' }, admin)).text();
    assert.ok(!text.includes(KEY) && !text.includes(SERVICE_KEY) && !text.includes('cron-secret'));
    assert.ok(!/Need offline invoicing|frustrating/.test(text), 'no record content in the response');
    assert.ok(b.ai.every((a) => a.authorization === `Bearer ${KEY}`), 'only the OpenRouter key goes to OpenRouter');
    assert.ok(b.ai.every((a) => !JSON.stringify(a.body).includes(SERVICE_KEY) && !JSON.stringify(a.body).includes(KEY)));
  }));

test('caller input is ignored: a limit, model, record ids or source in the body change nothing', () =>
  withBackend(AI_ON, { pending: 50 }, async (b) => {
    const res = await post({ action: 'ai_smoke_test', limit: 500, maxRecords: 500, p_limit: 500, model: 'openai/gpt-4o', ids: ['r40', 'r41'], source: 'github', skipAnalysis: true, retries: 5, force: true }, admin);
    const rep = await res.json();
    assert.equal(rep.records.selected, 3);
    assert.deepEqual(rep.records.ids, ['r0', 'r1', 'r2']);
    assert.equal(rep.decisions.model, 'parallel/decisions-fast:free');
    assert.equal(b.ai.length, 4);
    assert.ok(b.rpcs.filter((r) => r.name === 'dr_claim_pending_records').every((r) => r.body.p_limit <= 12));
    assert.ok(!b.names().includes('dr_claim_due_sources'));
    assert.ok(b.ai.every((a) => a.body.model !== 'openai/gpt-4o'));
  }));

test('no automatic retries through the real HTTP client: a 500 from OpenRouter is sent once per engine, and the run stops cleanly', () =>
  withBackend(AI_ON, { pending: 25, ai: '500' }, async (b) => {
    const rep = await (await post({ action: 'ai_smoke_test' }, admin)).json();
    assert.equal(b.ai.length, 2, 'one Decisions request (circuit breaker stops the rest) and one summary request');
    assert.equal(rep.overall, 'failed');
    assert.equal(rep.decisions.stopped, 'unavailable (HTTP 500)');
    assert.equal(rep.decisions.usage.retries, 0);
    assert.ok(!b.names().includes('dr_save_signal_ai'), 'nothing is persisted from failed calls');
    assert.ok(!b.names().includes('dr_mark_analysis_failed'));
  }));

test('a 429 is neither waited out nor retried', () =>
  withBackend(AI_ON, { pending: 25, ai: '429' }, async (b) => {
    const rep = await (await post({ action: 'ai_smoke_test' }, admin)).json();
    assert.equal(b.ai.length, 2);
    assert.equal(rep.decisions.stopped, 'rate_limited (HTTP 429)');
  }));

test('a second invocation is served entirely from the cache: zero AI requests', () =>
  withBackend(AI_ON, { pending: 25 }, async (b) => {
    assert.equal((await (await post({ action: 'ai_smoke_test' }, admin)).json()).overall, 'passed');
    assert.equal(b.ai.length, 4);
    const again = await (await post({ action: 'ai_smoke_test' }, admin)).json();
    assert.equal(b.ai.length, 4, 'no new AI request');
    assert.equal(again.overall, 'passed');
    assert.deepEqual([again.decisions.cacheHits, again.lfm3.cacheHits, again.decisions.liveCalls, again.lfm3.liveCalls], [3, 1, 0, 0]);
  }));

test('no pending records: 200, nothing sent to any AI engine', () =>
  withBackend(AI_ON, { pending: 0 }, async (b) => {
    const rep = await (await post({ action: 'ai_smoke_test' }, admin)).json();
    assert.equal(rep.overall, 'nothing_tested');
    assert.equal(b.ai.length, 0);
  }));

// ------------------------------------------------------------------------------------------------ request handling and regressions

test('a truncated body is rejected with 400 before anything runs', () =>
  withBackend(AI_ON, {}, async (b) => {
    const res = await post('{"action":"ai_smoke_test"', admin);
    assert.equal(res.status, 400);
    assert.equal(b.ai.length, 0);
    assert.deepEqual(b.names(), ['dr_is_admin']);
  }));

test('the action is on the allowlist, and near-misses are still rejected with 400 (never a collection run)', () =>
  withBackend(AI_ON, {}, async (b) => {
    for (const action of ['AI_SMOKE_TEST', 'ai_smoke_test ', 'ai-smoke-test', 'ai_smoke']) {
      const res = await post({ action }, admin);
      assert.equal(res.status, 400, action);
      assert.ok((await res.json()).supported.includes('ai_smoke_test'));
    }
    assert.ok(!b.names().includes('dr_claim_due_sources'));
    assert.equal(b.ai.length, 0);
  }));
