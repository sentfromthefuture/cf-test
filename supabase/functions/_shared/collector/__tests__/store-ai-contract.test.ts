// Contract test between SupabaseStore (TypeScript) and the migration (SQL): every RPC the store makes for the AI cache, usage counters and
// model outputs must name a function that exists in 20261109000000_ai_results_cache.sql, send only parameters that function declares, and
// omit none of its required ones. A typo here would otherwise only surface in production. No database or network is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SupabaseStore } from '../store.ts';
import { emptyAiUsage } from '../ai-common.ts';
import type { SignalAiRow } from '../decisions.ts';

const sql = readFileSync(new URL('../../../../migrations/20261109000000_ai_results_cache.sql', import.meta.url), 'utf8');

/** name -> { all: declared params, required: params without a default } parsed from the migration itself. */
function signatures() {
  const out = new Map<string, { all: string[]; required: string[] }>();
  for (const m of sql.matchAll(/create or replace function public\.(\w+)\(([^)]*)\)/g)) {
    const params = m[2].split(',').map((p) => p.trim()).filter(Boolean);
    out.set(m[1], { all: params.map((p) => p.split(/\s+/)[0]), required: params.filter((p) => !/\bdefault\b/i.test(p)).map((p) => p.split(/\s+/)[0]) });
  }
  return out;
}

function recordingStore(respond: (name: string) => unknown) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const fetchImpl = (async (url: string, init: { body: string }) => {
    const name = String(url).split('/rpc/')[1];
    calls.push({ name, args: JSON.parse(init.body) });
    return new Response(JSON.stringify(respond(name)), { status: 200 });
  }) as unknown as typeof fetch;
  return { store: new SupabaseStore('https://example.supabase.co', 'service-key-not-real', fetchImpl), calls };
}

const lease = { id: '11111111-1111-1111-1111-111111111111', epoch: 3 };
const aiRow: SignalAiRow = {
  record_id: '22222222-2222-2222-2222-222222222222', content_hash: 'h', cache_id: null, input_hash: 'a'.repeat(64), model: 'm', requested_model: 'm:free',
  config_version: 'v1', problem_probability: 0.9, model_confidence: 0.5, answers: {}, citations: [],
};

test('the migration declares every function the store calls, with fencing parameters on complete/fail/abandon', () => {
  const sig = signatures();
  for (const fn of ['dr_ai_cache_begin', 'dr_ai_cache_complete', 'dr_ai_cache_fail', 'dr_ai_cache_abandon', 'dr_ai_cache_invalidate', 'dr_ai_note_usage', 'dr_save_signal_ai']) assert.ok(sig.has(fn), `${fn} missing from the migration`);
  for (const fn of ['dr_ai_cache_complete', 'dr_ai_cache_fail', 'dr_ai_cache_abandon']) assert.ok(sig.get(fn)!.required.includes('p_epoch'), `${fn} must REQUIRE the fencing epoch`);
  assert.deepEqual(sig.get('dr_ai_cache_invalidate')!.all, ['p_id'], 'invalidate stays an unfenced delete-by-id, as designed');
});

test('every RPC the store makes matches the SQL signature (names, required parameters, fencing epoch)', async () => {
  const { store, calls } = recordingStore((name) => (name === 'dr_ai_cache_begin' ? { state: 'claimed', id: lease.id, epoch: lease.epoch } : name === 'dr_ai_cache_complete' ? true : name === 'dr_save_signal_ai' ? 1 : null));
  const begun = await store.aiCacheBegin({ task: 'decisions', model: 'm:free', configVersion: 'v1', hash: 'a'.repeat(64) }, 120);
  assert.deepEqual(begun, { state: 'claimed', id: lease.id, epoch: lease.epoch });
  assert.equal(await store.aiCacheComplete(lease, { ok: 1 }, [{ url: 'https://e.org' }], { t: 1 }), true);
  await store.aiCacheFail(lease, 'invalid_response');
  await store.aiCacheAbandon(lease);
  await store.aiCacheInvalidate(lease.id);
  await store.aiNoteUsage('decisions', { ...emptyAiUsage(), calls: 1 });
  assert.equal(await store.saveSignalAi([aiRow]), 1);

  const sig = signatures();
  assert.equal(calls.length, 7);
  for (const c of calls) {
    const s = sig.get(c.name);
    assert.ok(s, `${c.name}: not a function in the migration`);
    for (const k of Object.keys(c.args)) assert.ok(s!.all.includes(k), `${c.name}: sends "${k}", which the SQL function does not declare (${s!.all.join(', ')})`);
    for (const r of s!.required) assert.ok(r in c.args, `${c.name}: required parameter "${r}" is not sent`);
  }
  const by = (n: string) => calls.find((c) => c.name === n)!.args;
  assert.equal(by('dr_ai_cache_complete').p_epoch, 3);
  assert.equal(by('dr_ai_cache_fail').p_epoch, 3);
  assert.equal(by('dr_ai_cache_abandon').p_epoch, 3, 'the lease epoch is what authorises every write after a claim');
  assert.equal(by('dr_ai_cache_complete').p_id, lease.id);
});

test('the store rejects a lease without an epoch and reports a refused (fenced) completion as false', async () => {
  const noEpoch = recordingStore(() => ({ state: 'claimed', id: lease.id }));
  await assert.rejects(noEpoch.store.aiCacheBegin({ task: 'summary', model: 'm:free', configVersion: 'v1', hash: 'b'.repeat(64) }, 60), /fencing epoch/);
  const fenced = recordingStore(() => false);
  assert.equal(await fenced.store.aiCacheComplete(lease, { ok: 1 }, [], {}), false, 'the database said this worker no longer holds the lease');
  const garbage = recordingStore(() => ({ nope: true }));
  await assert.rejects(garbage.store.aiCacheBegin({ task: 'summary', model: 'm:free', configVersion: 'v1', hash: 'b'.repeat(64) }, 60), /unexpected value/);
});
