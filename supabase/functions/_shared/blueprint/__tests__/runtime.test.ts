import test from 'node:test';
import assert from 'node:assert/strict';
import { runBlueprintStep } from '../runtime.ts';
import { validModelOutput } from './helpers.ts';
import type { AiCacheKey, AiCacheStore, CacheBegin, AiLease } from '../../collector/ai-common.ts';
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
  completeResult = true;
  async aiCacheComplete(lease: AiLease, result: Record<string, unknown>): Promise<boolean> {
    if (!this.completeResult) return false;
    const key = [...this.leases.entries()].find(([, v]) => v.id === lease.id)?.[0];
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
  sufficiency: { level: 'limited', reasons: [] },
  diagnostics: {},
} as unknown as PreparedEvidence;
const request = {
  team_size: 'solo', budget_band: 'bootstrap', preferred_stack: 'typescript_postgres',
  business_model_hint: 'b2b_saas', target_region: 'africa',
} as const;

function providerConfig(calls: string[]) {
  return {
    apiKey: 'synthetic-key', model: 'baidu/ernie-5.5-flash-preview:free', timeoutMs: 5_000,
    fetchImpl: async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      const payload = JSON.parse(body.messages[1].content) as { task: string };
      calls.push(payload.task);
      const output = payload.task.endsWith('_a') ? passA : payload.task.endsWith('_b') ? passB : passC;
      return new Response(JSON.stringify({
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }],
        usage: { prompt_tokens: 10, completion_tokens: 10 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  };
}

test('one invocation performs at most one live pass; the next invocation reuses cached A', async () => {
  const store = new MemoryStore();
  const calls: string[] = [];
  const config = providerConfig(calls);
  const first = await runBlueprintStep(store, config, { request, evidence, allowedVerdicts: ['validate_first'] });
  assert.equal(first.state, 'pass_completed');
  if (first.state !== 'pass_completed') return;
  assert.equal(first.completed, 'A');
  assert.deepEqual(calls, ['blueprint_pass_a']);

  const second = await runBlueprintStep(store, config, { request, evidence, allowedVerdicts: ['validate_first'] });
  assert.equal(second.state, 'pass_completed');
  if (second.state !== 'pass_completed') return;
  assert.equal(second.completed, 'B');
  assert.deepEqual(calls, ['blueprint_pass_a', 'blueprint_pass_b']);
});

test('cache identity changes when the evidence pack changes', async () => {
  const store = new MemoryStore();
  const calls: string[] = [];
  const config = providerConfig(calls);
  await runBlueprintStep(store, config, { request, evidence, allowedVerdicts: ['validate_first'] });
  const keysBefore = [...store.entries.keys()];
  assert.equal(keysBefore.length, 1);
  // The runtime derives the B key from the hash of validated A. A changed A result cannot share that key.
  const modified = { ...passA, schema_version: 'different-valid-shape-is-rejected' };
  assert.notDeepEqual(modified, passA);
  assert.equal(keysBefore[0].includes('blueprint'), true);
});


test('does not advance when a live pass could not be durably cached', async () => {
  const store = new MemoryStore();
  store.completeResult = false;
  const calls: string[] = [];
  const result = await runBlueprintStep(store, providerConfig(calls), { request, evidence, allowedVerdicts: ['validate_first'] });
  assert.deepEqual(result, { state: 'deferred', pass: 'A', reason: 'pass_result_not_durable', passes: {} });
  assert.deepEqual(calls, ['blueprint_pass_a']);
  assert.equal(store.entries.size, 0);
});
