// Persistent AI-result cache behaviour (cachedCompute + the in-memory mirror of the dr_ai_cache_* state machine).
// The SQL itself is tested for real against Postgres in supabase/tests/30_ai_architecture.test.sql and 31_ai_cache_concurrency.sh;
// these tests prove the application-side rules on top of it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AiCacheError, AiCacheKey, AiCallError, aiInputHash, cachedCompute, canonicalJson, Computed } from '../ai-common.ts';
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

test('a cache write failure does not lose a valid answer, and is remembered durably instead of leaving a lock', async () => {
  class CompleteFails extends MemoryStore { async aiCacheComplete(): Promise<boolean> { throw new Error('write failed'); } }
  const store = new CompleteFails();
  const { state, compute } = counted();
  const out = await cachedCompute(store, key(), compute, revive, { log: silentLog });
  assert.equal(out.status, 'computed');
  assert.equal(out.status === 'computed' && out.stored, false);
  assert.equal(state.n, 1);
  const e = [...store.aiCache.values()][0];
  assert.deepEqual({ status: e.status, kind: e.failureKind, result: e.result, storage: e.storageFailures, input: e.failedAttempts }, { status: 'failed', kind: 'storage', result: null, storage: 1, input: 0 }, 'a durable STORAGE marker, never a result, never an input failure');
  assert.equal(e.leaseUntil, null, 'no lease is left locked');
  assert.equal(store.aiCacheCalls.failStorage, 1);
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
  const lease = { id: (b as { id: string }).id, epoch: (b as { epoch: number }).epoch };
  await assert.rejects(store.aiCacheComplete(lease, null as never, [], {}), /non-null JSON object/);
  assert.equal(store.aiCache.get([...store.aiCache.keys()][0])!.status, 'pending', 'rejected completion leaves it pending');
  assert.equal(await store.aiCacheComplete(lease, { ok: 1 }, [], {}), true);
  assert.equal(await store.aiCacheComplete(lease, { ok: 2 }, [], {}), false, 'first stored result wins');
  assert.deepEqual([...store.aiCache.values()][0].result, { ok: 1 });
});

// ------------------------------------------------------------------ cache first: the gate applies only to a miss
test('the gate is never consulted for a cache hit, busy or cooling-down entry; it only guards a miss', async () => {
  const store = new MemoryStore();
  const { state, compute } = counted();
  await cachedCompute(store, key(), compute, revive); // warm
  let consulted = 0;
  const gate = () => { consulted++; return 'budget spent'; };
  const hit = await cachedCompute(store, key(), compute, revive, { gate });
  assert.equal(hit.status, 'hit', 'a cached result is served even though the gate would refuse every live request');
  assert.equal(consulted, 0);
  assert.equal(state.n, 1);

  const miss = await cachedCompute(store, key({ hash: 'b'.repeat(64) }), compute, revive, { gate });
  assert.equal(miss.status, 'deferred');
  assert.equal(miss.status === 'deferred' && miss.reason, 'budget spent');
  assert.equal(consulted, 1, 'consulted exactly once, for the miss');
  assert.equal(state.n, 1, 'no live request was made');

  await store.aiCacheBegin(key({ hash: 'c'.repeat(64) }), 120); // another worker holds it
  assert.equal((await cachedCompute(store, key({ hash: 'c'.repeat(64) }), compute, revive, { gate })).status, 'busy');
  assert.equal(consulted, 1, 'gate not consulted for a busy entry either');
});

test('a deferred miss releases its lease and records nothing against the input', async () => {
  const store = new MemoryStore();
  const { state, compute } = counted();
  const out = await cachedCompute(store, key(), compute, revive, { gate: () => 'not enough time left in this run' });
  assert.equal(out.status, 'deferred');
  assert.equal(store.aiCache.size, 0, 'lease released; no failure marker, no cooldown');
  assert.equal(store.aiCacheCalls.fail, 0);
  assert.equal((await cachedCompute(store, key(), compute, revive)).status, 'computed', 'next run can compute immediately');
  assert.equal(state.n, 1);
  // after a REAL earlier failure, deferring keeps the history but does not extend the cooldown
  const s2 = new MemoryStore();
  let now = 1_000_000; s2.clock = () => now;
  await assert.rejects(cachedCompute(s2, key(), async () => { throw new AiCallError('bad', 'invalid_response'); }, revive), AiCallError);
  now += 61 * 60_000;
  assert.equal((await cachedCompute(s2, key(), compute, revive, { gate: () => 'budget' })).status, 'deferred');
  const e = [...s2.aiCache.values()][0];
  assert.deepEqual({ status: e.status, attempts: e.failedAttempts }, { status: 'failed', attempts: 1 }, 'history kept, attempts not inflated');
  assert.equal((await cachedCompute(s2, key(), compute, revive)).status, 'computed', 'and it is retryable right away');
});

// ------------------------------------------------------------------ lease fencing
test('FENCING: a worker whose lease expired cannot store a result over the worker that took over', async () => {
  const store = new MemoryStore();
  let now = 7_000_000; store.clock = () => now;
  let releaseA!: () => void;
  const gateA = new Promise<void>((r) => (releaseA = r));
  const computeA = async (): Promise<Computed<Record<string, unknown>>> => { await gateA; return { value: { ok: 1, by: 'A' }, result: { ok: 1, by: 'A' }, citations: [], usage: {} }; };
  const computeB = async (): Promise<Computed<Record<string, unknown>>> => ({ value: { ok: 1, by: 'B' }, result: { ok: 1, by: 'B' }, citations: [], usage: {} });

  const a = cachedCompute(store, key(), computeA, revive, { log: silentLog });          // A is slow
  await new Promise((r) => setTimeout(r, 5));
  assert.equal([...store.aiCache.values()][0].epoch, 1, 'A holds epoch 1');
  now += 121_000;                                                                       // A's lease expires
  const b = await cachedCompute(store, key(), computeB, revive, { log: silentLog });    // B takes over and finishes
  assert.equal(b.status, 'computed');
  assert.equal([...store.aiCache.values()][0].epoch, 2, 'the takeover moved the epoch forward');

  releaseA();                                                                           // A finally finishes
  const aOut = await a;
  assert.equal(aOut.status, 'computed', 'A still returns the (valid) answer it computed');
  assert.equal(aOut.status === 'computed' && aOut.stored, false, 'but it was NOT stored: A no longer holds the lease');
  const entry = [...store.aiCache.values()][0];
  assert.equal(entry.status, 'succeeded');
  assert.deepEqual(entry.result, { ok: 1, by: 'B' }, 'the current holder\'s result is the one that stays');
});

test('FENCING: a stale worker failing or giving up cannot disturb the new holder\'s lease', async () => {
  for (const failure of [new AiCallError('bad answer', 'invalid_response'), new AiCallError('rate limited', 'rate_limited', 429)]) {
    const store = new MemoryStore();
    let now = 9_000_000; store.clock = () => now;
    let failA!: () => void;
    const gateA = new Promise<void>((_r, rej) => (failA = () => rej(failure)));
    const a = cachedCompute(store, key(), async () => { await gateA; throw new Error('unreachable'); }, revive, { log: silentLog }).catch((e) => e as AiCallError);
    await new Promise((r) => setTimeout(r, 5));
    now += 121_000;
    const bLease = await store.aiCacheBegin(key(), 120); // B takes over and is still working
    assert.equal(bLease.state, 'claimed');

    failA();
    const err = await a;
    assert.ok(err instanceof AiCallError && err.kind === failure.kind, 'A still sees its own failure');
    const entry = [...store.aiCache.values()][0];
    assert.equal(entry.status, 'pending', `${failure.kind}: B's lease survives A's late failure`);
    assert.equal(entry.epoch, (bLease as { epoch: number }).epoch);
    assert.equal(entry.failedAttempts, 0, 'no failure was recorded against the input by the stale worker');
    assert.equal((await store.aiCacheBegin(key(), 120)).state, 'busy', 'a third worker still waits for B');
    assert.equal(await store.aiCacheComplete({ id: entry.id, epoch: (bLease as { epoch: number }).epoch }, { ok: 1, by: 'B' }, [], {}), true, 'B can still complete');
  }
});

test('FENCING: leases carry an increasing epoch, including takeover of a failed entry', async () => {
  const store = new MemoryStore();
  let now = 3_000_000; store.clock = () => now;
  const first = await store.aiCacheBegin(key(), 120) as { epoch: number };
  now += 121_000;
  const second = await store.aiCacheBegin(key(), 120) as { epoch: number };
  assert.ok(second.epoch > first.epoch);
  await store.aiCacheFail({ id: (second as any).id, epoch: second.epoch }, 'invalid_response');
  now += 61 * 60_000;
  const third = await store.aiCacheBegin(key(), 120) as { epoch: number };
  assert.ok(third.epoch > second.epoch, 'retry after a cooldown is also a new lease');
  assert.equal(await store.aiCacheComplete({ id: (second as any).id, epoch: first.epoch }, { ok: 1 }, [], {}), false, 'an epoch from two leases ago is refused');
  assert.equal(await store.aiCacheComplete({ id: (second as any).id, epoch: second.epoch }, { ok: 1 }, [], {}), false, 'and so is the previous one');
  assert.equal(await store.aiCacheComplete({ id: (second as any).id, epoch: third.epoch }, { ok: 1 }, [], {}), true);
});

test('a failing cache store surfaces as AiCacheError, never as a model failure', async () => {
  const store = new MemoryStore();
  store.failAiCache = true;
  const { state, compute } = counted();
  await assert.rejects(cachedCompute(store, key(), compute, revive), (e: AiCallError) => e instanceof AiCacheError && e.systemic);
  assert.equal(state.n, 0, 'no model call without a working cache');
});

test('a valid answer that could not be made durable says so, and why', async () => {
  class WriteFails extends MemoryStore { async aiCacheComplete(): Promise<boolean> { throw new Error('write failed'); } }
  const { compute } = counted();
  const w = await cachedCompute(new WriteFails(), key(), compute, revive, { log: silentLog });
  assert.equal(w.status, 'computed');
  assert.deepEqual(w.status === 'computed' && { stored: w.stored, why: w.notStored }, { stored: false, why: 'write_failed' });

  class LeaseLost extends MemoryStore { async aiCacheComplete(): Promise<boolean> { return false; } }
  const l = await cachedCompute(new LeaseLost(), key(), compute, revive, { log: silentLog });
  assert.deepEqual(l.status === 'computed' && { stored: l.stored, why: l.notStored }, { stored: false, why: 'lease_lost' });

  const ok = await cachedCompute(new MemoryStore(), key(), compute, revive);
  assert.deepEqual(ok.status === 'computed' && { stored: ok.stored, why: ok.notStored }, { stored: true, why: undefined }, 'a durable answer carries no reason');
});

test('invalidate can remove only a stored result, never a pending lease or a failure record', async () => {
  const store = new MemoryStore();
  const b = await store.aiCacheBegin(key(), 120) as { id: string; epoch: number };
  await store.aiCacheInvalidate(b.id);
  assert.equal(store.aiCache.size, 1, 'a pending lease survives invalidate');
  await store.aiCacheFail({ id: b.id, epoch: b.epoch }, 'invalid_response');
  await store.aiCacheInvalidate(b.id);
  assert.equal([...store.aiCache.values()][0].status, 'failed', 'a failure record (with its cooldown) survives invalidate');
  const store2 = new MemoryStore();
  const c = await store2.aiCacheBegin(key(), 120) as { id: string; epoch: number };
  await store2.aiCacheComplete({ id: c.id, epoch: c.epoch }, { ok: 1 }, [], {});
  await store2.aiCacheInvalidate(c.id);
  assert.equal(store2.aiCache.size, 0, 'a stored result can be invalidated');
});

// ------------------------------------------------------------------ durable, bounded backoff for cache-STORAGE failures
class WriteFails extends MemoryStore { broken = true; async aiCacheComplete(l: any, r: any, c: any, u: any): Promise<boolean> { if (this.broken) throw new Error('write failed'); return super.aiCacheComplete(l, r, c, u); } }

test('STORAGE BACKOFF: a failed write blocks a re-request of that input, and any new live request, until the window passes', async () => {
  const store = new WriteFails();
  let now = 1_000_000; store.clock = () => now;
  const { state, compute } = counted();
  await cachedCompute(store, key(), compute, revive, { log: silentLog });
  assert.equal(state.n, 1);
  const again = await cachedCompute(store, key(), compute, revive);
  assert.equal(again.status, 'cooldown', 'the same input waits (it is cooling down)');
  const other = await cachedCompute(store, key({ hash: 'b'.repeat(64) }), compute, revive);
  assert.equal(other.status, 'deferred');
  assert.equal(other.status === 'deferred' && other.reason, 'cache storage backoff', 'a different input that would need a live call waits for the engine-level backoff');
  assert.equal(state.n, 1, 'no further live request');
  assert.equal(store.aiCache.size, 1, 'and no lease was taken for the other input');
  now += 4 * 60_000;
  assert.equal((await cachedCompute(store, key({ hash: 'b'.repeat(64) }), compute, revive)).status, 'deferred', 'still inside the 5-minute window');
  now += 2 * 60_000;
  store.broken = false;
  assert.equal((await cachedCompute(store, key({ hash: 'b'.repeat(64) }), compute, revive)).status, 'computed', 'window passed: a probe request is allowed');
});

test('STORAGE BACKOFF: the cache is still served during the backoff (cache first)', async () => {
  const store = new WriteFails();
  store.broken = false;
  const { state, compute } = counted();
  await cachedCompute(store, key(), compute, revive); // stored fine
  store.broken = true;
  await cachedCompute(store, key({ hash: 'c'.repeat(64) }), compute, revive, { log: silentLog }); // this write fails -> engine backoff
  const hit = await cachedCompute(store, key(), compute, revive);
  assert.equal(hit.status, 'hit', 'a stored answer is served even while the engine is backing off');
  assert.equal(state.n, 2);
  assert.equal((await cachedCompute(store, key({ hash: 'd'.repeat(64) }), compute, revive)).status, 'deferred');
});

test('STORAGE BACKOFF: it is per model and per task, and it escalates then caps', async () => {
  const store = new WriteFails();
  let now = 5_000_000; store.clock = () => now;
  const { compute } = counted();
  await cachedCompute(store, key(), compute, revive, { log: silentLog });
  assert.equal((await cachedCompute(store, key({ hash: 'b'.repeat(64), model: 'other:free' }), compute, revive, { log: silentLog })).status, 'computed', 'another model is unaffected');
  assert.equal((await cachedCompute(store, key({ hash: 'b'.repeat(64), task: 'summary' }), compute, revive, { log: silentLog })).status, 'computed', 'another task is unaffected');
  const windows: number[] = [];
  for (let i = 0; i < 12; i++) {
    const h = store.aiHealth.get('decisions|parallel/decisions-fast:free')!;
    windows.push(Math.round((h.unhealthyUntil! - now) / 60_000));
    now = h.unhealthyUntil! + 1000;
    await cachedCompute(store, key({ hash: String(i).padStart(64, 'e') }), compute, revive, { log: silentLog });
  }
  assert.deepEqual(windows.slice(0, 5), [5, 10, 20, 40, 80], 'each consecutive storage failure doubles the engine backoff');
  assert.ok(Math.max(...windows) <= 360, 'and it is capped at 6 hours');
  assert.equal(windows[windows.length - 1], 360);
});

test('STORAGE BACKOFF: it is separate from input-level failures (own counters, own breaker, never penalises the record)', async () => {
  const store = new WriteFails();
  store.broken = false;
  const { compute } = counted();
  await assert.rejects(cachedCompute(store, key(), async () => { throw new AiCallError('bad', 'invalid_response'); }, revive), AiCallError);
  assert.equal(store.aiHealth.size, 0, 'an unusable answer never trips the storage breaker');
  const e1 = [...store.aiCache.values()][0];
  assert.deepEqual({ kind: e1.failureKind, input: e1.failedAttempts, storage: e1.storageFailures }, { kind: 'input', input: 1, storage: 0 });
  store.broken = true;
  await cachedCompute(store, key({ hash: 'b'.repeat(64) }), compute, revive, { log: silentLog });
  const e2 = [...store.aiCache.values()].find((x) => x.failureKind === 'storage')!;
  assert.deepEqual({ input: e2.failedAttempts, storage: e2.storageFailures }, { input: 0, storage: 1 });
});

test('STORAGE BACKOFF: recovery. One successful write ends the backoff and releases storage cooldowns, but not input-level ones', async () => {
  const store = new WriteFails();
  let now = 9_000_000; store.clock = () => now;
  const { compute } = counted();
  store.broken = false;
  await assert.rejects(cachedCompute(store, key({ hash: '1'.repeat(64) }), async () => { throw new AiCallError('bad', 'invalid_response'); }, revive), AiCallError); // input-level cooldown 1h
  store.broken = true;
  await cachedCompute(store, key({ hash: '2'.repeat(64) }), compute, revive, { log: silentLog }); // storage cooldown 15m, engine 5m
  now += 6 * 60_000;
  store.broken = false; // storage heals
  assert.equal((await cachedCompute(store, key({ hash: '2'.repeat(64) }), compute, revive)).status, 'cooldown', 'before the probe the storage-failed input still waits');
  assert.equal((await cachedCompute(store, key({ hash: '3'.repeat(64) }), compute, revive)).status, 'computed', 'a probe (a different input) is stored');
  assert.equal(store.aiHealth.get('decisions|parallel/decisions-fast:free')!.unhealthyUntil, null, 'engine backoff cleared');
  assert.equal((await cachedCompute(store, key({ hash: '2'.repeat(64) }), compute, revive)).status, 'computed', 'the storage-failed input is retryable immediately, not after its 15 minutes');
  assert.equal((await cachedCompute(store, key({ hash: '1'.repeat(64) }), compute, revive)).status, 'cooldown', 'the input-level cooldown is NOT released by a storage recovery');
});

test('STORAGE BACKOFF: fenced. A stale holder cannot record a storage failure against a newer lease', async () => {
  const store = new MemoryStore();
  let now = 2_000_000; store.clock = () => now;
  const a = await store.aiCacheBegin(key(), 120) as { id: string; epoch: number };
  now += 121_000;
  const b = await store.aiCacheBegin(key(), 120) as { id: string; epoch: number };
  assert.equal(await store.aiCacheFailStorage({ id: a.id, epoch: a.epoch }, 'write_failed'), false, 'the stale holder is refused');
  const e = [...store.aiCache.values()][0];
  assert.deepEqual({ status: e.status, epoch: e.epoch, storage: e.storageFailures }, { status: 'pending', epoch: b.epoch, storage: 0 }, 'the new lease is untouched');
  assert.equal(store.aiHealth.size, 0, 'and no engine-level trace is left');
  assert.equal(await store.aiCacheComplete({ id: b.id, epoch: b.epoch }, { ok: 1 }, [], {}), true);
  assert.equal(await store.aiCacheFailStorage({ id: b.id, epoch: b.epoch }, 'late'), false, 'a stored result is never overwritten by a failure marker');
});

test('STORAGE BACKOFF: if even the failure cannot be recorded, the lease is released and the call still returns normally', async () => {
  class Unreachable extends MemoryStore { failAiCacheStorageRecordingX = true; async aiCacheComplete(): Promise<boolean> { throw new Error('write failed'); } async aiCacheFailStorage(): Promise<boolean> { throw new Error('cannot record'); } }
  const store = new Unreachable();
  const { compute } = counted();
  const out = await cachedCompute(store, key(), compute, revive, { log: silentLog });
  assert.equal(out.status === 'computed' && out.notStored, 'write_failed');
  assert.equal(store.aiCache.size, 0, 'the lease was released (abandon) as a last resort');
  assert.equal(store.aiCacheCalls.abandon, 1);
});
