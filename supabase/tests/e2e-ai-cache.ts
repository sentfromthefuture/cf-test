// End-to-end check of the AI cache RPCs exactly as Supabase serves them: the REAL SupabaseStore -> real PostgREST -> Postgres with the
// migrations applied. It proves what unit tests cannot: that the arguments the TypeScript sends are accepted by the SQL functions (names,
// types, the fencing epoch), that a stale lease cannot alter a newer one, and that only service_role may call the new functions.
//
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... SUPABASE_ANON_KEY=... SUPABASE_AUTHENTICATED_KEY=... npx tsx supabase/tests/e2e-ai-cache.ts
//
// Same setup as e2e.ts (a local `supabase start` stack, or PostgREST over a DISPOSABLE Postgres with the migrations applied; keys are JWTs
// carrying role=service_role / anon / authenticated). Not part of CI. It writes a few cache/provenance rows and takes ~12 s because it waits
// for a real lease to expire (the shortest lease the database allows is 10 s). Never point it at production. No external AI service is called.
import { SupabaseStore } from '../functions/_shared/collector/index.ts';
import type { AiCacheKey } from '../functions/_shared/collector/ai-common.ts';

const url = process.env.SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_KEY!;
const anonKey = process.env.SUPABASE_ANON_KEY!;
const authKey = process.env.SUPABASE_AUTHENTICATED_KEY!;
if (!url || !serviceKey || !anonKey || !authKey) throw new Error('set SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_ANON_KEY, SUPABASE_AUTHENTICATED_KEY');

let failed = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failed++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const raw = async (name: string, args: Record<string, unknown>, key: string) => {
  const r = await fetch(`${url}/rest/v1/rpc/${name}`, { method: 'POST', headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(args) });
  let body: any = null;
  try { body = await r.json(); } catch { /* empty */ }
  return { status: r.status, body };
};

const store = new SupabaseStore(url, serviceKey);
const run = Math.random().toString(16).slice(2).padEnd(64, '0').slice(0, 64); // unique, valid 64-char hex identity per run
const key = (suffix: string): AiCacheKey => ({ task: 'decisions', model: 'e2e-test:free', configVersion: `e2e-${run.slice(0, 8)}`, hash: run.slice(0, 60) + suffix.padStart(4, '0') }); // distinct identity per suffix

// ------------------------------------------------------------------ 1. the real store against the real functions
const k1 = key('1');
const a = await store.aiCacheBegin(k1, 120);
check(a.state === 'claimed' && typeof (a as any).epoch === 'number', `begin -> claimed with a numeric fencing epoch (${JSON.stringify(a)})`);
const leaseA = { id: (a as any).id as string, epoch: (a as any).epoch as number };
check((await store.aiCacheBegin(k1, 120)).state === 'busy', 'a second caller is told to wait');
check(await store.aiCacheComplete(leaseA, { problemProbability: 0.9, from: 'A' }, [{ url: 'https://example.org/x' }], { inputTokens: 5 }) === true, 'the current holder completes (real argument types accepted)');
const hit = await store.aiCacheBegin(k1, 120) as any;
check(hit.state === 'hit' && hit.result?.from === 'A' && hit.citations?.[0]?.url === 'https://example.org/x', 'the stored result is served as a hit');
check(await store.aiCacheComplete(leaseA, { from: 'A-again' }, [], {}) === false, 'a finished entry cannot be completed again');
await store.aiNoteUsage('decisions', { calls: 1, successes: 1, failures: 0, rate_limited: 0, http_requests: 1, cache_hits: 0, cache_misses: 1, input_tokens: 5, output_tokens: 2, reported_cost_usd: 0, cost_reported_calls: 1, duration_ms: 10 });
check(true, 'usage counters accepted');

// ------------------------------------------------------------------ 2. fencing: an EXPIRED holder cannot alter the newer lease
const k2 = key('2');
const stale = await store.aiCacheBegin(k2, 10) as any; // 10 s is the shortest lease the database allows
const staleLease = { id: stale.id as string, epoch: stale.epoch as number };
console.log('...waiting 11 s for the lease to expire');
await sleep(11_000);
const fresh = await store.aiCacheBegin(k2, 120) as any;
check(fresh.state === 'claimed' && fresh.id === stale.id && fresh.epoch > staleLease.epoch, `takeover of the expired lease moves the epoch forward (${staleLease.epoch} -> ${fresh.epoch})`);
const freshLease = { id: fresh.id as string, epoch: fresh.epoch as number };
check(await store.aiCacheComplete(staleLease, { from: 'STALE' }, [], {}) === false, 'a stale complete is refused');
await store.aiCacheFail(staleLease, 'stale');   // must be a no-op
await store.aiCacheAbandon(staleLease);         // before fencing this deleted the new holder's lease
check((await store.aiCacheBegin(k2, 120)).state === 'busy', "the new holder's lease survived the stale fail and abandon (a third caller still waits)");
check(await store.aiCacheComplete(freshLease, { from: 'FRESH' }, [], {}) === true, 'the current holder completes');
check(await store.aiCacheComplete(staleLease, { from: 'STALE-LATE' }, [], {}) === false, 'a late stale complete is refused');
const after = await store.aiCacheBegin(k2, 120) as any;
check(after.state === 'hit' && after.result?.from === 'FRESH', "the stored result is the current holder's");

// ------------------------------------------------------------------ 3. provenance: a vanished cache link must not cost any row its provenance
const tag = run.slice(0, 8);
await store.upsertRecords([1, 2].map((i) => ({
  source_id: 'github', source_record_id: `e2e-${tag}-${i}`, discussion_key: `github:e2e-${tag}-${i}`, kind: 'issue' as const, url: `https://example.org/e2e/${tag}/${i}`,
  title: `e2e ${i}`, excerpt: `I wish there was a tool for e2e ${i}. It is frustrating.`, author_ref: null, parent_source_record_id: null, published_at: new Date().toISOString(),
  updated_at_source: null, engagement: { score: 1 }, categories: [], language: 'en', license: 'test', attribution: null, content_hash: `h-e2e-${tag}-${i}`,
})));
const claimed = (await store.claimPending(500)).filter((r) => r.content_hash.startsWith(`h-e2e-${tag}`));
check(claimed.length === 2, 'two real records are pending (inserted through the real upsert RPC)');
const provenance = (r: (typeof claimed)[number], cacheId: string | null) => ({
  record_id: r.id, content_hash: r.content_hash, cache_id: cacheId, input_hash: 'a'.repeat(64), model: 'e2e', requested_model: 'e2e:free', config_version: 'v1',
  problem_probability: 0.8, model_confidence: 0.5, answers: { severity: { value: 3, score: 2, confidence: 0.5 } }, citations: [],
});
const saved = await store.saveSignalAi([provenance(claimed[0], leaseA.id), provenance(claimed[1], '99999999-9999-9999-9999-999999999999')]);
check(saved === 2, `one link to a cache entry that does not exist does not cost the other row (or itself) its provenance (saved ${saved}/2)`);

// ------------------------------------------------------------------ 4. grants, as PostgREST enforces them
const fns: Array<[string, Record<string, unknown>]> = [
  ['dr_ai_cache_begin', { p_task: 'decisions', p_hash: run, p_model: 'm', p_version: 'v' }],
  ['dr_ai_cache_complete', { p_id: leaseA.id, p_epoch: leaseA.epoch, p_result: { x: 1 } }],
  ['dr_ai_cache_fail', { p_id: leaseA.id, p_epoch: leaseA.epoch }],
  ['dr_ai_cache_abandon', { p_id: leaseA.id, p_epoch: leaseA.epoch }],
  ['dr_ai_cache_invalidate', { p_id: '00000000-0000-0000-0000-000000000000' }],
  ['dr_ai_cache_prune', { p_older_than_days: 365 }],
  ['dr_ai_note_usage', { p_engine: 'decisions', p_counters: {} }],
  ['dr_save_signal_ai', { p_rows: [] }],
  ['dr_norm_url', { p_url: 'https://www.example.org/a' }],
  ['dr_cluster_profile', { p_cluster: '00000000-0000-0000-0000-000000000000' }],
];
for (const [fn, args] of fns) {
  const svc = await raw(fn, args, serviceKey);
  check(svc.status < 300, `${fn}: service_role may call it (HTTP ${svc.status})`);
  for (const [role, k] of [['anon', anonKey], ['authenticated', authKey]] as const) {
    const r = await raw(fn, args, k);
    check(r.status >= 400 && /permission denied|42501/i.test(JSON.stringify(r.body)), `${fn}: ${role} is denied (HTTP ${r.status}, ${String(r.body?.code ?? '')} ${String(r.body?.message ?? '').slice(0, 60)})`);
  }
}

console.log(failed === 0 ? '\nALL AI CACHE E2E CHECKS PASSED' : `\n${failed} AI CACHE E2E CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
