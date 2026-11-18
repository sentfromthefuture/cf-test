import test from 'node:test';
import assert from 'node:assert/strict';
import { runBlueprintLifecycle } from '../lifecycle.ts';
import type { AiCacheKey, AiCacheStore, AiLease, CacheBegin } from '../../collector/ai-common.ts';
import type { BlueprintResultIdentity, BlueprintResultStore, StoredBlueprintResult } from '../result-store.ts';
import { validBlueprint, validModelOutput } from './helpers.ts';
import type { PreparedEvidence } from '../evidence.ts';

const model = validModelOutput() as unknown as Record<string, unknown>;
const passA = Object.fromEntries(['schema_version','opportunity','market_evidence','personas','product','mvp','journeys','workflows','commercial'].map(k => [k, model[k]]));
const passB = Object.fromEntries(['architecture','database'].map(k => [k, model[k]]));
const passC = Object.fromEntries(['implementation','testing','risks'].map(k => [k, model[k]]));

class MemoryStore implements AiCacheStore {
  entries = new Map<string, { id: string; result: unknown }>();
  leases = new Map<string, AiLease>();
  sequence = 0;
  key(k: AiCacheKey) { return [k.task,k.model,k.configVersion,k.hash].join(':'); }
  async aiCacheBegin(k: AiCacheKey, _leaseSeconds: number): Promise<CacheBegin> {
    const key = this.key(k);
    const found = this.entries.get(key);
    if (found) return { state: 'hit', id: found.id, result: found.result, citations: [], usage: {} };
    const lease = { id: String(++this.sequence), epoch: 1 };
    this.leases.set(key, lease);
    return { state: 'claimed', ...lease };
  }
  async aiCacheComplete(lease: AiLease, result: Record<string, unknown>): Promise<boolean> {
    const key = [...this.leases.entries()].find(([, value]) => value.id === lease.id)?.[0];
    if (!key) return false;
    this.entries.set(key, { id: lease.id, result });
    this.leases.delete(key);
    return true;
  }
  async aiCacheFail(): Promise<void> {}
  async aiCacheAbandon(): Promise<void> {}
  async aiCacheFailStorage(): Promise<boolean> { return false; }
  async aiCacheInvalidate(id: string): Promise<void> {
    for (const [key, entry] of this.entries) if (entry.id === id) this.entries.delete(key);
  }
}

const evidence = {
  pack: { ai_labels: { industry: 'Synthetic', cluster_label: 'Fixture' }, excerpts: [], metrics: [] },
  index: [], canonical_pack_json: '{"ai_labels":{"industry":"Synthetic","cluster_label":"Fixture"},"excerpts":[],"metrics":[]}',
  summary: { excerpt_count: 0, metric_count: 0, truncated: false, sufficiency: 'limited', sufficiency_reasons: [] },
  sufficiency: { level: 'limited', reasons: [] }, diagnostics: {},
} as unknown as PreparedEvidence;
const request = {
  team_size: 'solo', budget_band: 'bootstrap', preferred_stack: 'typescript_postgres',
  business_model_hint: 'b2b_saas', target_region: 'africa',
} as const;
const identity: BlueprintResultIdentity = {
  userId: '11111111-1111-4111-8111-111111111111',
  clusterId: '22222222-2222-4222-8222-222222222222',
  requestKeyHash: 'a'.repeat(64),
  requestParams: { ...request },
  model: 'baidu/ernie-5.5-flash-preview:free',
  configVersion: 'bp1.p1.s1',
};
function providerConfig(calls: string[]) {
  return {
    apiKey: 'synthetic-key', model: 'baidu/ernie-5.5-flash-preview:free', timeoutMs: 5_000,
    fetchImpl: async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      const payload = JSON.parse(body.messages[1].content) as { task: string };
      calls.push(payload.task);
      const output = payload.task.endsWith('_a') ? passA : payload.task.endsWith('_b') ? passB : passC;
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }), { status: 200 });
    },
  };
}

test('one reservation spans A/B/C retries and finalization only runs after all passes are cached', async () => {
  const cache = new MemoryStore();
  const calls: string[] = [];
  const provider = providerConfig(calls);
  let reservations = 0;
  let finalized = 0;
  const stored = { id: '33333333-3333-4333-8333-333333333333', created_at: '2026-11-18T00:00:00Z', blueprint: validBlueprint() } as StoredBlueprintResult;
  const resultStore = { get: async () => null } as unknown as BlueprintResultStore;
  const quotaRpc = { rpc: async <T>(name: string): Promise<T> => {
    assert.equal(name, 'dr_blueprint_reserve');
    reservations++;
    return { status: 'reserved', reservation_id: '44444444-4444-4444-8444-444444444444', reused: reservations > 1 } as T;
  } };
  const run = () => runBlueprintLifecycle({
    identity, dailyLimit: 1, resultStore, quotaRpc, cacheStore: cache, provider,
    runtimeInput: { request, evidence, allowedVerdicts: ['validate_first'] },
    finalize: async ({ reservationId, passes, passRecords }) => {
      finalized++;
      assert.equal(reservationId, '44444444-4444-4444-8444-444444444444');
      assert.ok(passes.A && passes.B && passes.C);
      assert.equal(passRecords.length, 3);
      assert.deepEqual(passRecords.map((record) => record.pass), ['A', 'B', 'C']);
      assert.ok(passRecords.every((record) => record.from_cache));
      return stored;
    },
  });

  assert.equal((await run()).state, 'progress'); // A
  assert.equal((await run()).state, 'progress'); // B
  assert.equal((await run()).state, 'progress'); // C
  assert.equal(finalized, 0);
  const completed = await run(); // cached A/B/C, assemble + atomic finalizer
  assert.equal(completed.state, 'completed_now');
  assert.equal(reservations, 4); // idempotent same-key reserve across invocations
  assert.equal(finalized, 1);
  assert.deepEqual(calls, ['blueprint_pass_a', 'blueprint_pass_b', 'blueprint_pass_c']);
});

test('existing completed result returns before quota or provider work', async () => {
  const cache = new MemoryStore();
  const calls: string[] = [];
  const stored = { id: '33333333-3333-4333-8333-333333333333', created_at: '2026-11-18T00:00:00Z', blueprint: validBlueprint() } as StoredBlueprintResult;
  const result = await runBlueprintLifecycle({
    identity, dailyLimit: 1,
    resultStore: { get: async () => stored } as unknown as BlueprintResultStore,
    quotaRpc: { rpc: async () => { throw new Error('quota_must_not_run'); } },
    cacheStore: cache, provider: providerConfig(calls),
    runtimeInput: { request, evidence, allowedVerdicts: ['validate_first'] },
    finalize: async () => { throw new Error('finalize_must_not_run'); },
  });
  assert.equal(result.state, 'completed');
  assert.deepEqual(calls, []);
  assert.equal(cache.entries.size, 0);
});
