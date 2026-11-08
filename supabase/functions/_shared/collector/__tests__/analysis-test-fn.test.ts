// End-to-end tests of the `analysis_test` action through the real Edge Function handler, against a fake PostgREST backend.
// The environment deliberately has every external key switched ON (Gemini, OpenRouter, GitHub) to prove configuration cannot enable them.
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

/** Fake Supabase: records EVERY outbound request (before answering) and answers the RPCs the engine uses. */
function installBackend(opts: { pending?: number; isAdmin?: boolean } = {}) {
  const pending = opts.pending ?? 25;
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
      case 'dr_claim_pending_records': {
        const n = Math.min(Math.max(body.p_limit, 1), 200, pending); // same clamp as the SQL function
        return ok(Array.from({ length: n }, (_, i) => ({ id: `r${i}`, source_id: 'github', kind: 'issue', title: `title ${i}`, excerpt: `I wish there was a tool for ${i}. It is frustrating.`, categories: [], engagement: { score: 3 }, content_hash: `h${i}`, language: 'en' })));
      }
      case 'dr_save_signals': return ok(body.p_signals.length);
      case 'dr_claim_due_sources': return ok([]);
      case 'dr_assign_pending_clusters': case 'dr_refresh_clusters': case 'dr_requeue_heuristic_analysis': return ok(0);
      case 'dr_clusters_needing_summary': return ok([]);
      default: throw new Error(`unexpected rpc ${rpc}`);
    }
  }) as typeof fetch;
  return { calls, rpcs: () => calls.map((c) => c.rpc), restore: () => { globalThis.fetch = real; } };
}

const post = (body: unknown, headers: Record<string, string> = {}) =>
  handler(new Request('https://x.supabase.co/functions/v1/collect', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }));
const admin = { authorization: 'Bearer admin-jwt' };

async function withBackend<T>(opts: Parameters<typeof installBackend>[0], fn: (b: ReturnType<typeof installBackend>) => Promise<T>) {
  const b = installBackend(opts);
  try { return await fn(b); } finally { b.restore(); }
}

test('schedule-secret caller is rejected with 403 and nothing is sent anywhere', () =>
  withBackend({}, async (b) => {
    const res = await post({ action: 'analysis_test' }, { 'x-collector-secret': 'cron-secret' });
    assert.equal(res.status, 403);
    assert.deepEqual(await res.json(), { error: 'forbidden' });
    assert.equal(b.calls.length, 0);
  }));

test('schedule secret plus an admin JWT is still treated as the scheduler and rejected', () =>
  withBackend({}, async (b) => {
    const res = await post({ action: 'analysis_test' }, { 'x-collector-secret': 'cron-secret', ...admin });
    assert.equal(res.status, 403);
    assert.equal(b.calls.length, 0);
  }));

test('a signed-in NON-admin is rejected; only the admin check ran, no analysis RPC', () =>
  withBackend({ isAdmin: false }, async (b) => {
    const res = await post({ action: 'analysis_test' }, admin);
    assert.equal(res.status, 401);
    assert.deepEqual(b.rpcs(), ['dr_is_admin']);
  }));

test('no credentials at all: 401 and nothing sent', () =>
  withBackend({}, async (b) => {
    assert.equal((await post({ action: 'analysis_test' })).status, 401);
    assert.equal(b.calls.length, 0);
  }));

test('a body flag or user id cannot stand in for admin: admin status comes only from dr_is_admin', () =>
  withBackend({ isAdmin: false }, async (b) => {
    const res = await post({ action: 'analysis_test', admin: true, isAdmin: true, user_id: 'someone', role: 'admin' }, admin);
    assert.equal(res.status, 401);
    assert.deepEqual(b.rpcs(), ['dr_is_admin']);
  }));

test('admin run: capped at 10 of 25 pending, heuristic-only, zero summaries/clustering, test marker present', () =>
  withBackend({ pending: 25 }, async (b) => {
    const res = await post({ action: 'analysis_test' }, admin);
    assert.equal(res.status, 200);
    const rep = await res.json();
    assert.equal(rep.testMode, true);
    assert.equal(rep.action, 'analysis_test');
    assert.equal(rep.maxRecords, 10);
    assert.equal(rep.method, 'heuristic');
    assert.equal(rep.claimed, 10);
    assert.equal(rep.analysed, 10);
    assert.equal(rep.summaries, 0);
    assert.equal(rep.clustered, 0);
    assert.equal(rep.clustersRefreshed, 0);
    assert.equal(typeof rep.elapsedMs, 'number');

    const claims = b.calls.filter((c) => c.rpc === 'dr_claim_pending_records');
    assert.equal(claims.length, 1);
    assert.ok(claims[0].body.p_limit <= 10, `asked the database for ${claims[0].body.p_limit}`);
    const saved = b.calls.find((c) => c.rpc === 'dr_save_signals')!.body.p_signals as any[];
    assert.equal(saved.length, 10);
    assert.ok(saved.every((s) => s.analysis_method === 'heuristic'));
  }));

test('admin run touches ONLY the bounded analysis RPCs, and no host other than Supabase (no Gemini/OpenRouter/GitHub/HN/StackExchange)', () =>
  withBackend({ pending: 25 }, async (b) => {
    await post({ action: 'analysis_test' }, admin);
    const allowed = new Set(['dr_is_admin', 'dr_acquire_lock', 'dr_claim_pending_records', 'dr_mark_skipped', 'dr_save_signals', 'dr_release_lock']);
    for (const r of b.rpcs()) assert.ok(r && allowed.has(r), `analysis_test called disallowed rpc ${r}`);
    for (const c of b.calls) assert.ok(c.url.startsWith('https://x.supabase.co/rest/v1/rpc/'), `outbound call to ${c.url}`);
    for (const never of ['dr_claim_due_sources', 'dr_finish_run', 'dr_note_usage', 'dr_set_quota', 'dr_existing_ids', 'dr_upsert_records', 'dr_requeue_heuristic_analysis', 'dr_assign_pending_clusters', 'dr_refresh_clusters', 'dr_clusters_needing_summary', 'dr_save_cluster_summary']) {
      assert.ok(!b.rpcs().includes(never), `must not call ${never}`);
    }
  }));

test('caller-supplied source / skipAnalysis / limit fields are ignored: no source claim, still capped at 10', () =>
  withBackend({ pending: 50 }, async (b) => {
    const res = await post({ action: 'analysis_test', source: 'github', skipAnalysis: true, limit: 500, maxRecords: 500, p_limit: 500, reanalyse: true }, admin);
    const rep = await res.json();
    assert.equal(rep.claimed, 10);
    assert.ok(!b.rpcs().includes('dr_claim_due_sources'));
    assert.ok(!b.rpcs().includes('dr_requeue_heuristic_analysis'));
    assert.ok(b.calls.filter((c) => c.rpc === 'dr_claim_pending_records').every((c) => c.body.p_limit <= 10));
  }));

// ---- regression: existing behaviour of the other paths ----

test('regression: a normal admin sync (no action) still claims sources and still runs clustering', () =>
  withBackend({ pending: 0 }, async (b) => {
    const res = await post({}, admin);
    assert.equal(res.status, 200);
    assert.ok(b.rpcs().includes('dr_claim_due_sources'));
    assert.ok(b.rpcs().includes('dr_assign_pending_clusters'));
    assert.ok(!('testMode' in (await res.json())));
  }));

test('regression: reanalyse keeps its semantics (admin-only, requeues up to 5000) and is not what analysis_test does', () =>
  withBackend({ pending: 0 }, async (b) => {
    const sched = await post({ action: 'reanalyse' }, { 'x-collector-secret': 'cron-secret' });
    assert.equal(sched.status, 403);
    const res = await post({ action: 'reanalyse' }, admin);
    assert.equal(res.status, 200);
    const rq = b.calls.find((c) => c.rpc === 'dr_requeue_heuristic_analysis');
    assert.ok(rq && rq.body.p_limit === 5000);
  }));

test('regression: scheduled collection with the secret is still accepted', () =>
  withBackend({ pending: 0 }, async (b) => {
    const res = await post({}, { 'x-collector-secret': 'cron-secret' });
    assert.equal(res.status, 200);
    assert.ok(b.rpcs().includes('dr_claim_due_sources'));
  }));
