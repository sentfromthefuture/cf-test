// End-to-end check of the real pipeline: runner -> SupabaseStore (PostgREST RPC) -> Postgres migrations -> dashboard RPCs.
//
//   SUPABASE_URL=... SUPABASE_SERVICE_KEY=... SUPABASE_ANON_KEY=... npx tsx supabase/tests/e2e.ts
//
// - GitHub is called LIVE (real API, real responses).
// - Hacker News / Stack Exchange are answered by a SYNTHETIC responder only when E2E_SYNTHETIC=1 (for environments that cannot
//   reach those hosts). Everything it reports about them proves the pipeline, not those APIs' availability.
// Works against a local `supabase start` stack, or PostgREST over a Postgres that has the migrations applied.
import { runCollection, SupabaseStore } from '../functions/_shared/collector/index.ts';
import { silentLogger } from './e2e-helpers.ts';

const url = process.env.SUPABASE_URL!;
const serviceKey = process.env.SUPABASE_SERVICE_KEY!;
const anonKey = process.env.SUPABASE_ANON_KEY!;
if (!url || !serviceKey || !anonKey) throw new Error('set SUPABASE_URL, SUPABASE_SERVICE_KEY, SUPABASE_ANON_KEY');
const synthetic = process.env.E2E_SYNTHETIC === '1';

const rpc = async (name: string, args: Record<string, unknown> = {}, key = anonKey) => {
  const r = await fetch(`${url}/rest/v1/rpc/${name}`, { method: 'POST', headers: { apikey: key, authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(args) });
  if (!r.ok) throw new Error(`${name}: HTTP ${r.status} ${await r.text()}`);
  return r.json() as Promise<any>;
};
let failed = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}`); if (!ok) failed++; };

const syntheticFetch: typeof fetch = async (input, init) => {
  const u = String(input);
  if (!synthetic || /api\.github\.com/.test(u)) return fetch(input, init);
  const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
  if (/hacker-news/.test(u)) {
    if (/askstories/.test(u)) return ok([9001]);
    if (/(top|show)stories/.test(u)) return ok([]);
    if (/item\/9001/.test(u)) return ok({ id: 9001, type: 'story', by: 'someone', time: Math.floor(Date.now() / 1000) - 3600, title: 'Ask HN: how do you keep track of client invoices when offline?', text: 'Spreadsheets are painful and manual. We would pay for a simple tool.', score: 30, descendants: 20, kids: [9002] });
    if (/item\/9002/.test(u)) return ok({ id: 9002, type: 'comment', parent: 9001, by: 'other', time: Math.floor(Date.now() / 1000) - 3000, text: 'Same here. Existing invoicing apps are too expensive and break when the connection drops, so it is a nightmare for small shops.' });
  }
  if (/stackexchange/.test(u)) return ok({ items: [], has_more: false, quota_max: 300, quota_remaining: 290 });
  throw new Error(`no synthetic route for ${u}`);
};

const store = new SupabaseStore(url, serviceKey);
const base = { env: {} as Record<string, string | undefined>, store, trigger: 'manual' as const, log: silentLogger, fetchImpl: syntheticFetch, budgetMs: 140_000 };

// 1) live GitHub collection + analysis
const r1 = await runCollection({ ...base, source: 'github' });
const gh = r1.sources[0];
console.log('github run:', JSON.stringify({ status: gh.status, ...gh.stats, error: gh.error }), 'analysis:', JSON.stringify(r1.analysis));
check(gh.status === 'success' || gh.status === 'partial', 'github run finished without hard error');
check(gh.stats.inserted > 0, `github inserted real records (${gh.stats.inserted})`);
check((r1.analysis?.analysed ?? 0) > 0, `analysis produced signals (${r1.analysis?.analysed}, method=${r1.analysis?.method})`);

let sources = await rpc('dr_public_sources');
const ghRow = sources.find((s: any) => s.id === 'github');
check(ghRow.records_total === gh.stats.inserted, 'dr_sources.records_total matches inserted rows');
check(ghRow.quota_limit != null, `quota recorded from response headers (${ghRow.quota_limit}/${ghRow.quota_remaining})`);
check(ghRow.requests_today > 0, `API usage tracked (${ghRow.requests_today} requests today)`);
check(ghRow.last_run?.status === gh.status, 'last_run visible to dashboard');

// 2) replay: wipe the stored cursor so the same window is fetched again; nothing may be duplicated
const before = (await rpc('dr_overview')).records_total;
class ReplayStore extends SupabaseStore {
  override async claimDueSources(o: Parameters<SupabaseStore['claimDueSources']>[0]) {
    return (await super.claimDueSources(o)).map((c) => ({ ...c, cursor: {} }));
  }
}
const r2a = await runCollection({ ...base, store: new ReplayStore(url, serviceKey), source: 'github', skipAnalysis: true });
const rp = r2a.sources[0];
console.log('replay:', JSON.stringify({ status: rp.status, ...rp.stats }));
check(rp.stats.fetched > 0, `replay re-fetched the same window (${rp.stats.fetched})`);
check(rp.stats.inserted <= 5, `replay inserted at most a handful of genuinely new issues (${rp.stats.inserted})`);
check(rp.stats.duplicates + rp.stats.updated >= rp.stats.fetched - 5, `replay was deduplicated (${rp.stats.duplicates} duplicates, ${rp.stats.updated} updated engagement)`);
check((await rpc('dr_overview')).records_total - before === rp.stats.inserted, 'row count grew only by genuinely new records');

// 3) synthetic HN + SE (only when requested)
if (synthetic) {
  const r2 = await runCollection({ ...base, source: 'hackernews', skipAnalysis: false });
  console.log('hackernews run:', JSON.stringify(r2.sources[0]), 'analysis:', JSON.stringify(r2.analysis));
  check(r2.sources[0].status === 'success', 'synthetic HN run succeeded');
  check(r2.sources[0].stats.inserted === 2, 'HN story + problem comment stored (2)');
  const r3 = await runCollection({ ...base, source: 'stackexchange', skipAnalysis: true });
  check(r3.sources[0].status === 'success', 'synthetic SE run succeeded (empty result set is fine)');
}

// 4) dashboard reads as an anonymous visitor
const ov = await rpc('dr_overview');
check(ov.records_total > 0 && ov.enabled_sources === 3 && ov.implemented_sources === 3, `overview: ${ov.records_total} records, ${ov.enabled_sources}/${ov.implemented_sources} sources enabled`);
check(ov.problems_total > 0, `problem signals present (${ov.problems_total})`);
check(ov.clusters_total > 0, `clusters formed (${ov.clusters_total})`);
const clusters = await rpc('dr_clusters_list', { p_limit: 5, p_offset: 0, p_industry: null, p_min_sources: 1, p_order: 'score', p_min_discussions: 1 });
check(clusters.items.length > 0 && clusters.items.every((c: any) => c.scores?.components?.problemFrequency?.basis === 'measured'), 'clusters carry explainable, basis-labelled scores');
const recent = await rpc('dr_recent_signals', { p_limit: 5, p_offset: 0 });
check(recent.length > 0 && recent.every((s: any) => /^https?:\/\//.test(s.url)), 'recent discoveries link back to their original source');
const act = await rpc('dr_activity', { p_days: 7 });
check(act.daily.length > 0 && act.runs.length > 0, 'activity series available');
const skipped = (await rpc('dr_public_sources')).filter((s: any) => s.availability === 'skipped');
check(skipped.length === 5 && skipped.every((s: any) => s.status === 'unavailable' && s.skip_reason && s.integration_requirements), 'unavailable sources are shown as unavailable with documented reasons');

// 5) security: anon cannot touch collector functions or tables
for (const fn of ['dr_upsert_records', 'dr_claim_due_sources', 'dr_save_signals']) {
  const r = await fetch(`${url}/rest/v1/rpc/${fn}`, { method: 'POST', headers: { apikey: anonKey, authorization: `Bearer ${anonKey}`, 'content-type': 'application/json' }, body: '{}' });
  check(r.status === 401 || r.status === 403 || r.status === 404, `anon denied on ${fn} (HTTP ${r.status})`);
}
const t = await fetch(`${url}/rest/v1/dr_raw_records?select=id&limit=1`, { headers: { apikey: anonKey, authorization: `Bearer ${anonKey}` } });
check(t.status === 401 || t.status === 403 || t.status === 404, `anon denied direct table read (HTTP ${t.status})`);

console.log(failed ? `\n${failed} CHECK(S) FAILED` : '\nE2E OK');
process.exit(failed ? 1 : 0);
