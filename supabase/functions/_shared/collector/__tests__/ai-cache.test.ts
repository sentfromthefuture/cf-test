// Persistent AI-result cache behaviour (cachedCompute + the in-memory mirror of the dr_ai_cache_* state machine).
// The SQL itself is tested for real against Postgres in supabase/tests/30_ai_architecture.test.sql and 31_ai_cache_concurrency.sh;
// these tests prove the application-side rules on top of it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AiCacheKey, AiCallError, aiInputHash, cachedCompute, canonicalJson, Computed } from '../ai-common.ts';
import { MemoryStore, silentLog } from './helpers.ts';

const HASH = 'a'.repeat(64);
const key = (over: Partial<AiCacheKey> = {}): AiCacheKey => ({ task: 'decisions', model: 'parallel/decisions-fast:free', configVersion: 'decisions-v1', hash: HASH, ...over });

/** Counts how often the (expensive) model call really happens. */
function counted(value: Record<string, unknown> = { ok: 1 }, citations: unknown[] = [{ url: 'https://e.org/x' }]) {
  const state = { n: 0 };
  const compute = async (): Promise<Computed<Record<string, unknown>>> => {
    state.n++;
    return { value: { ...value, call: state.n }, result: { ...value, call: state.n }, citations, usage: { inputTokens: 5 } };
  };
  return { state, compute };
}
const revive = (s: unknown) => (s && typeof s === 'object' && (s as any).ok === 1 ? (s as Record<string, unknown>) : null);

test('input hash is stable, key-order independent and sensitive to content', async () => {
  assert.equal(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] }), canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }));
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]), 'array order matters');
  assert.equal(canonicalJson({ a: 1, b: undefined }), canonicalJson({ a: 1 }), 'undefined is dropped like JSON does');
  const h = await aiInputHash({ task: 'x', state: { title: 't', text: 'u' } });
  assert.match(h, /^[0-9a-f]{64}$/);
  assert.equal(await aiInputHash({ state: { text: 'u', title: 't' }, task: 'x' }), h);
  assert.notEqual(await aiInputHash({ task: 'x', state: { title: 't', text: 'v' } }), h);
  assert.notEqual(await aiInputHash({ task: 'y', state: { title: 't', text: 'u' } }), h);
});

test('a successful result is persisted, and only after it succeeded', async () => {
  const store = new MemoryStore();
  const { state, compute } = counted();
  const out = await cachedCompute(store, key(), compute, revive, { log: silentLog });
  assert.equal(out.status, 'computed');
  assert.equal(out.status === 'computed' && out.stored, true);
  const entry = [...store.aiCache.values()][0];
  assert.equal(entry.status, 'succeeded');
  assert.deepEqual(entry.result, { ok: 1, call: 1 });
  assert.deepEqual(entry.citations, [{ url: 'https://e.org/x' }]);
  assert.deepEqual(entry.usage, { inputTokens: 5 });
  assert.equal(state.n, 1);
});

test('an identical request is served from the cache: the model is not called again', async () => {
  const store = new MemoryStore();
  const { state, compute } = counted();
  await cachedCompute(store, key(), compute, revive);
  for (let i = 0; i < 3; i++) {
    const out = await cachedCompute(store, key(), compute, revive);
    assert.equal(out.status, 'hit');
    assert.equal(out.status === 'hit' && (out.value as any).call, 1, 'the original answer is reused');
  }
  assert.equal(state.n, 1, 'one live call for four identical requests');
  assert.equal([...store.aiCache.values()][0].hits, 3);
});

test('model, config version, input hash and task each form a separate cache identity', async () => {
  const store = new MemoryStore();
  const { state, compute } = counted();
  await cachedCompute(store, key(), compute, revive);
  const variants: Array<Partial<AiCacheKey>> = [{ model: 'other/model:free' }, { configVersion: 'decisions-v2' }, { configVersion: 'decisions-v1+r2' }, { hash: 'b'.repeat(64) }, { task: 'summary' }];
  for (const v of variants) {
    const out = await cachedCompute(store, key(v), compute, revive);
    assert.equal(out.status, 'computed', `${JSON.stringify(v)} must NOT reuse the old result`);
  }
  assert.equal(state.n, 1 + variants.length);
  assert.equal(store.aiCache.size, 1 + variants.length);
  assert.equal((await cachedCompute(store, key(), compute, revive)).status, 'hit', 'the original entry is untouched and still valid');
});

test('concurrent duplicate requests: exactly one computes, the rest are told to wait', async () => {
  const store = new MemoryStore();
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const state = { n: 0 };
  const compute = async (): Promise<Computed<Record<string, unknown>>> => {
    state.n++;
    await gate;
    return { value: { ok: 1 }, result: { ok: 1 }, citations: [], usage: {} };
  };
  const runs = [1, 2, 3, 4, 5].map(() => cachedCompute(store, key(), compute, revive));
  await new Promise((r) => setTimeout(r, 10));
  release();
  const outs = await Promise.all(runs);
  assert.equal(state.n, 1, 'the model was called once');
  assert.deepEqual(outs.map((o) => o.status).sort(), ['busy', 'busy', 'busy', 'busy', 'computed']);
  assert.equal((await cachedCompute(store, key(), compute, revive)).status, 'hit', 'afterwards everyone shares the stored answer');
});

test('a crashed worker does not block the input forever: its lease expires', async () => {
  const store = new MemoryStore();
  let now = 1_000_000;
  store.clock = () => now;
  const { state, compute } = counted();
  await store.aiCacheBegin(key(), 120); // a worker claims the lease and then dies
  assert.equal((await cachedCompute(store, key(), compute, revive)).status, 'busy');
  now += 119_000;
  assert.equal((await cachedCompute(store, key(), compute, revive)).status, 'busy', 'still within the lease');
  now += 2_000;
  assert.equal((await cachedCompute(store, key(), compute, revive)).status, 'computed', 'expired lease is taken over');
  assert.equal(state.n, 1);
});

test('an input-level failure is never stored as a result; it cools down with growing backoff', async () => {
  const store = new MemoryStore();
  let now = 5_000_000;
  store.clock = () => now;
  let n = 0;
  const bad = async (): Promise<Computed<Record<string, unknown>>> => { n++; throw new AiCallError('answer did not validate', 'invalid_response'); };
  await assert.rejects(cachedCompute(store, key(), bad, revive), (e: AiCallError) => e.kind === 'invalid_response');
  let entry = [...store.aiCache.values()][0];
  assert.equal(entry.status, 'failed');
  assert.equal(entry.result, null, 'a failed answer is not a stored result');
  assert.equal(entry.lastFailure, 'invalid_response');
  assert.equal(entry.failedAttempts, 1);
  const out = await cachedCompute(store, key(), bad, revive);
  assert.equal(out.status, 'cooldown', 'no new request during the cooldown');
  assert.equal(n, 1);
  now += 61 * 60_000;
  await assert.rejects(cachedCompute(store, key(), bad, revive), AiCallError);
  assert.equal(n, 2, 'retried once the 1h cooldown elapsed');
  now += 61 * 60_000;
  assert.equal((await cachedCompute(store, key(), bad, revive)).status, 'cooldown', 'second cooldown is 2h, not 1h');
  now += 61 * 60_000;
  await assert.rejects(cachedCompute(store, key(), bad, revive), AiCallError);
  assert.equal(n, 3);
  entry = [...store.aiCache.values()][0];
  assert.equal(entry.failedAttempts, 3);
  assert.equal(entry.result, null);
  // and a later success replaces the failure marker with a real result
  now += 10 * 24 * 3600_000;
  const { compute } = counted();
  assert.equal((await cachedCompute(store, key(), compute, revive)).status, 'computed');
  assert.equal([...store.aiCache.values()][0].status, 'succeeded');
});

test('a service-level failure releases the lease without blaming the input, so it is retryable immediately', async () => {
  for (const kind of ['rate_limited', 'unavailable', 'timeout', 'auth', 'not_found', 'quota', 'network'] as const) {
    const store = new MemoryStore();
    await assert.rejects(cachedCompute(store, key(), async () => { throw new AiCallError('x', kind, 500); }, revive), (e: AiCallError) => e.kind === kind && e.systemic);
    assert.equal(store.aiCache.size, 0, `${kind}: nothing recorded against the input`);
    const { compute } = counted();
    assert.equal((await cachedCompute(store, key(), compute, revive)).status, 'computed', `${kind}: next attempt is not delayed`);
  }
  const store = new MemoryStore();
  await assert.rejects(cachedCompute(store, key(), async () => { throw new TypeError('bug'); }, revive), (e: AiCallError) => e.kind === 'unavailable');
  assert.equal(store.aiCache.size, 0, 'an unknown error is treated as the service\'s problem');
});

test('a cache write failure does not lose a valid answer or leave the input locked', async () => {
  class CompleteFails extends MemoryStore { async aiCacheComplete(): Promise<boolean> { throw new Error('write failed'); } }
  const store = new CompleteFails();
  const { state, compute } = counted();
  const out = await cachedCompute(store, key(), compute, revive, { log: silentLog });
  assert.equal(out.status, 'computed');
  assert.equal(out.status === 'computed' && out.stored, false);
  assert.equal(store.aiCache.size, 0, 'lease released, nothing stored');
  assert.equal(state.n, 1);
});

test('a stored result that no longer validates is dropped and recomputed exactly once', async () => {
  const store = new MemoryStore();
  let calls = 0;
  const compute = async (): Promise<Computed<Record<string, unknown>>> => { calls++; return { value: { v: calls }, result: { v: calls }, citations: [], usage: {} }; };
  const reviveV2 = (s: unknown) => ((s as any)?.v >= 2 ? (s as Record<string, unknown>) : null); // v1 is "from an older schema"
  assert.equal((await cachedCompute(store, key(), compute, reviveV2)).status, 'computed');
  const second = await cachedCompute(store, key(), compute, reviveV2);
  assert.equal(second.status, 'computed', 'the obsolete entry was invalidated and replaced');
  assert.equal(store.aiCacheCalls.invalidate, 1);
  assert.equal((await cachedCompute(store, key(), compute, reviveV2)).status, 'hit');
  assert.equal(calls, 2, 'no repeated recomputation');
});

test('completing is allowed only for the pending row and only with a JSON object', async () => {
  const store = new MemoryStore();
  const b = await store.aiCacheBegin(key(), 60);
  assert.equal(b.state, 'claimed');
  const id = (b as { id: string }).id;
  await assert.rejects(store.aiCacheComplete(id, null as never, [], {}), /non-null JSON object/);
  assert.equal(store.aiCache.get([...store.aiCache.keys()][0])!.status, 'pending', 'rejected completion leaves it pending');
  assert.equal(await store.aiCacheComplete(id, { ok: 1 }, [], {}), true);
  assert.equal(await store.aiCacheComplete(id, { ok: 2 }, [], {}), false, 'first stored result wins');
  assert.deepEqual([...store.aiCache.values()][0].result, { ok: 1 });
});
