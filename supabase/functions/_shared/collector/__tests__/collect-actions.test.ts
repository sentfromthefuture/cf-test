// The collect function accepts exactly three kinds of request: no action (normal collection), "reanalyse" and "analysis_test".
// Anything else must be a 400 that never reaches runCollection, a connector, or even the database.
// The environment has every external key switched on so that "no network call" is a real assertion, not an artefact of missing config.
import test from 'node:test';
import assert from 'node:assert/strict';

let handler: (req: Request) => Promise<Response>;
(globalThis as any).Deno = {
  env: {
    toObject: () => ({
      SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc', SUPABASE_ANON_KEY: 'anon', COLLECTOR_SECRET: 'cron-secret',
      GEMINI_API_KEY: 'gem-key', OPENROUTER_ENABLED: 'true', OPENROUTER_API_KEY: 'or-key', GITHUB_TOKEN: 'gh-token',
    }),
  },
  serve: (h: typeof handler) => { handler = h; },
};
await import('../../../collect/index.ts');

type Call = { url: string; rpc: string | null; body: any };

/** Fake Supabase: records EVERY outbound request (before answering). Anything that is not a known RPC on the project host throws. */
function installBackend(opts: { isAdmin?: boolean } = {}) {
  const calls: Call[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const rpc = /^https:\/\/x\.supabase\.co\/rest\/v1\/rpc\/([a-z_]+)$/.exec(url)?.[1] ?? null;
    calls.push({ url, rpc, body });
    if (!rpc) throw new Error(`unexpected outbound request: ${url}`);
    const ok = (v: unknown) => new Response(JSON.stringify(v), { status: 200 });
    switch (rpc) {
      case 'dr_is_admin': return ok(opts.isAdmin ?? true);
      case 'dr_acquire_lock': return ok(true);
      case 'dr_release_lock': case 'dr_mark_skipped': case 'dr_mark_analysis_failed': return ok(null);
      case 'dr_claim_pending_records': return ok([]);
      case 'dr_claim_due_sources': return ok([]);
      case 'dr_assign_pending_clusters': case 'dr_refresh_clusters': case 'dr_requeue_heuristic_analysis': return ok(0);
      case 'dr_clusters_needing_summary': return ok([]);
      default: throw new Error(`unexpected rpc ${rpc}`);
    }
  }) as typeof fetch;
  return { calls, rpcs: () => calls.map((c) => c.rpc), restore: () => { globalThis.fetch = real; } };
}
async function withBackend<T>(opts: Parameters<typeof installBackend>[0], fn: (b: ReturnType<typeof installBackend>) => Promise<T>) {
  const b = installBackend(opts);
  try { return await fn(b); } finally { b.restore(); }
}

const raw = (text: string, headers: Record<string, string> = {}) =>
  handler(new Request('https://x.supabase.co/functions/v1/collect', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: text }));
const post = (body: unknown, headers: Record<string, string> = {}) => raw(JSON.stringify(body), headers);
const admin = { authorization: 'Bearer admin-jwt' };
const cron = { 'x-collector-secret': 'cron-secret' };

/** Everything that means "a collection / source / queue / clustering action started". */
const COLLECTION_RPCS = [
  'dr_claim_due_sources', 'dr_finish_run', 'dr_note_usage', 'dr_set_quota', 'dr_existing_ids', 'dr_upsert_records',
  'dr_acquire_lock', 'dr_claim_pending_records', 'dr_requeue_heuristic_analysis', 'dr_assign_pending_clusters', 'dr_refresh_clusters',
];

// Includes: typos, wrong case, stray whitespace, falsy/odd JSON types, and names that exist on Object.prototype.
const UNKNOWN_ACTIONS: unknown[] = [
  'analysis_tset', 'ANALYSIS_TEST', 'Analysis_Test', 'Reanalyse', 'reanalyze', ' reanalyse', 'reanalyse ', 'analysis_test\n', 'analysis-test',
  'collect', 'sync', 'run', 'all', 'analysis_test,reanalyse', '', ' ',
  'constructor', '__proto__', 'toString', 'hasOwnProperty', 'prototype',
  0, 1, false, true, {}, [], ['reanalyse'], { action: 'reanalyse' },
];

for (const action of UNKNOWN_ACTIONS) {
  test(`unknown action ${JSON.stringify(action)} -> 400 for an admin, with only the admin check performed (no collection, no source claim)`, () =>
    withBackend({}, async (b) => {
      const res = await post({ action, source: 'github' }, admin);
      assert.equal(res.status, 400);
      const body = await res.json();
      assert.equal(body.error, 'unknown action');
      assert.deepEqual(body.supported, ['reanalyse', 'analysis_test', 'ai_smoke_test']);
      assert.equal(res.headers.get('access-control-allow-origin'), '*', 'the browser must be able to read the 400');
      assert.deepEqual(b.rpcs(), ['dr_is_admin'], `unknown action caused calls: ${JSON.stringify(b.rpcs())}`);
      for (const c of COLLECTION_RPCS) assert.ok(!b.rpcs().includes(c), `must not call ${c}`);
      for (const c of b.calls) assert.ok(c.url.startsWith('https://x.supabase.co/'), `outbound call to ${c.url}`); // no GitHub/HN/StackExchange/Gemini
    }));
}

test('unknown action with the schedule secret -> 400 and nothing is sent anywhere (cron can never be tricked into a collection run)', () =>
  withBackend({}, async (b) => {
    for (const action of ['analysis_tset', 'Reanalyse', '', 'constructor']) {
      const res = await post({ action }, cron);
      assert.equal(res.status, 400);
    }
    assert.equal(b.calls.length, 0);
  }));

test('auth is checked BEFORE the action: unauthenticated and non-admin callers get 401 for an unknown action, never 400', () =>
  withBackend({ isAdmin: false }, async (b) => {
    assert.equal((await post({ action: 'nonsense' })).status, 401);
    assert.equal((await post({ action: 'nonsense' }, admin)).status, 401);
    assert.equal((await post({ action: 'nonsense' }, { 'x-collector-secret': 'wrong' })).status, 401);
    assert.ok(b.rpcs().every((r) => r === 'dr_is_admin'));
  }));

// ---- unreadable bodies: the same fallthrough in another form ----

const BAD_BODIES: Array<[string, string]> = [
  ['truncated JSON that was meant to be analysis_test', '{"action":"analysis_test"'],
  ['truncated JSON that was meant to be reanalyse', '{"action":"reanalyse'],
  ['not JSON at all', 'action=analysis_test'],
  ['JSON null', 'null'],
  ['JSON array', '["analysis_test"]'],
  ['JSON string', '"analysis_test"'],
  ['JSON number', '1'],
  ['JSON boolean', 'true'],
];
for (const [label, text] of BAD_BODIES) {
  test(`unreadable body (${label}) -> 400, no collection`, () =>
    withBackend({}, async (b) => {
      const res = await raw(text, admin);
      assert.equal(res.status, 400);
      assert.deepEqual(b.rpcs(), ['dr_is_admin']);
    }));
}

test('unreadable body with the schedule secret -> 400, nothing sent', () =>
  withBackend({}, async (b) => {
    assert.equal((await raw('{"action":', cron)).status, 400);
    assert.equal(b.calls.length, 0);
  }));

// ---- valid requests keep working exactly as before ----

test('valid: no action ({}) as admin still runs a normal collection (claims due sources, runs analysis + clustering)', () =>
  withBackend({}, async (b) => {
    const res = await post({}, admin);
    assert.equal(res.status, 200);
    for (const r of ['dr_claim_due_sources', 'dr_acquire_lock', 'dr_assign_pending_clusters']) assert.ok(b.rpcs().includes(r), `expected ${r}`);
    assert.ok(!('testMode' in (await res.json())));
  }));

test('valid: scheduled run with the secret and body {} still works (this is exactly what pg_cron sends)', () =>
  withBackend({}, async (b) => {
    const res = await post({}, cron);
    assert.equal(res.status, 200);
    assert.ok(b.rpcs().includes('dr_claim_due_sources'));
    assert.ok(!b.rpcs().includes('dr_is_admin'));
    const claim = b.calls.find((c) => c.rpc === 'dr_claim_due_sources')!;
    assert.equal(claim.body.p_trigger, 'schedule');
  }));

test('valid: a genuinely empty body (and whitespace-only body) is still a normal collection run', () =>
  withBackend({}, async (b) => {
    assert.equal((await raw('', cron)).status, 200);
    assert.equal((await raw('  \n', admin)).status, 200);
    assert.equal(b.rpcs().filter((r) => r === 'dr_claim_due_sources').length, 2);
  }));

test('valid: an explicit "action": null is treated as no action', () =>
  withBackend({}, async (b) => {
    assert.equal((await post({ action: null }, admin)).status, 200);
    assert.ok(b.rpcs().includes('dr_claim_due_sources'));
  }));

test('valid: the manual-sync button shape { source } still forces just that source', () =>
  withBackend({}, async (b) => {
    assert.equal((await post({ source: 'github' }, admin)).status, 200);
    const claim = b.calls.find((c) => c.rpc === 'dr_claim_due_sources')!;
    assert.equal(claim.body.p_force, 'github');
    assert.equal(claim.body.p_trigger, 'manual');
  }));

test('valid: skipAnalysis:true still skips the analysis phase', () =>
  withBackend({}, async (b) => {
    assert.equal((await post({ skipAnalysis: true }, cron)).status, 200);
    assert.ok(b.rpcs().includes('dr_claim_due_sources'));
    assert.ok(!b.rpcs().includes('dr_acquire_lock'));
  }));

test('valid: reanalyse as admin still requeues up to 5000 then runs analysis only (no source claim)', () =>
  withBackend({}, async (b) => {
    const res = await post({ action: 'reanalyse' }, admin);
    assert.equal(res.status, 200);
    const rq = b.calls.find((c) => c.rpc === 'dr_requeue_heuristic_analysis');
    assert.ok(rq && rq.body.p_limit === 5000);
    assert.ok(!b.rpcs().includes('dr_claim_due_sources'));
    assert.equal((await res.json()).requeued, 0);
  }));

test('valid: reanalyse is still admin-only (schedule secret -> 403, nothing sent)', () =>
  withBackend({}, async (b) => {
    const res = await post({ action: 'reanalyse' }, cron);
    assert.equal(res.status, 403);
    assert.equal(b.calls.length, 0);
  }));

test('valid: analysis_test as admin still works and stays analysis-only; schedule secret still gets 403', () =>
  withBackend({}, async (b) => {
    const sched = await post({ action: 'analysis_test' }, cron);
    assert.equal(sched.status, 403);
    assert.equal(b.calls.length, 0);
    const res = await post({ action: 'analysis_test' }, admin);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).testMode, true);
    for (const never of ['dr_claim_due_sources', 'dr_requeue_heuristic_analysis', 'dr_assign_pending_clusters', 'dr_refresh_clusters']) assert.ok(!b.rpcs().includes(never), `must not call ${never}`);
  }));

test('valid: non-POST methods and CORS preflight are unchanged', async () => {
  assert.equal((await handler(new Request('https://x.supabase.co/functions/v1/collect', { method: 'GET' }))).status, 405);
  assert.equal((await handler(new Request('https://x.supabase.co/functions/v1/collect', { method: 'OPTIONS' }))).status, 204);
});
