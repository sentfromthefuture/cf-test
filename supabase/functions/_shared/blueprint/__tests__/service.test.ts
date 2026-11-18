import test from 'node:test';
import assert from 'node:assert/strict';
import { runBlueprintGeneration } from '../service.ts';
import { canonicalJson } from '../evidence-canonical.ts';
import { validBlueprint, validModelOutput } from './helpers.ts';
import type { PreparedEvidence } from '../evidence-types.ts';
import type { AiCacheKey, AiCacheStore, AiLease, CacheBegin } from '../../collector/ai-common.ts';
import type { BlueprintResultStore, StoredBlueprintResult } from '../result-store.ts';

const source = validBlueprint();
const model = validModelOutput() as unknown as Record<string, unknown>;
const passAKeys = ['schema_version','opportunity','market_evidence','personas','product','mvp','journeys','workflows','commercial'];
const passBKeys = ['architecture','database'];
const passCKeys = ['implementation','testing','risks'];
const passA = Object.fromEntries(passAKeys.map((key) => [key, model[key]]));
const passB = Object.fromEntries(passBKeys.map((key) => [key, model[key]]));
const passC = Object.fromEntries(passCKeys.map((key) => [key, model[key]]));

const pack = {
  ai_labels: { industry: null, cluster_label: 'synthetic fixture' },
  excerpts: source.evidence_index.filter((e) => e.kind === 'discussion_excerpt').map((e) => ({
    id: e.id, source: e.source_id, kind: 'issue', published: null, title: e.title,
    text: e.excerpt, wtp: e.has_wtp_quote,
  })),
  metrics: source.evidence_index.filter((e) => e.kind === 'cluster_metric').map((e) => ({
    id: e.id, name: e.name, label: e.label, value: e.value, evidence_class: e.evidence_class,
  })),
};
const { pack_sha256: _oldHash, ...summary } = source.meta.evidence_pack;
void _oldHash;
const evidence = {
  pack,
  index: source.evidence_index.map((entry) => ({ ...entry, cited_by: [] })),
  canonical_pack_json: canonicalJson(pack),
  summary,
  sufficiency: { level: summary.sufficiency, reasons: [] },
  diagnostics: {},
} as unknown as PreparedEvidence;

class MemoryCache implements AiCacheStore {
  entries = new Map<string, { id: string; result: unknown; usage: unknown }>();
  leases = new Map<string, AiLease>();
  nextId = 0;
  key(k: AiCacheKey) { return [k.task, k.model, k.configVersion, k.hash].join(':'); }
  async aiCacheBegin(k: AiCacheKey, _seconds: number): Promise<CacheBegin> {
    const key = this.key(k);
    const hit = this.entries.get(key);
    if (hit) return { state: 'hit', id: hit.id, result: hit.result, citations: [], usage: hit.usage };
    const lease = { id: String(++this.nextId), epoch: 1 };
    this.leases.set(key, lease);
    return { state: 'claimed', ...lease };
  }
  async aiCacheComplete(lease: AiLease, result: Record<string, unknown>, _citations: unknown[], usage: Record<string, unknown>): Promise<boolean> {
    const key = [...this.leases.entries()].find(([, value]) => value.id === lease.id)?.[0];
    if (!key) return false;
    this.entries.set(key, { id: lease.id, result, usage });
    this.leases.delete(key);
    return true;
  }
  async aiCacheFail(lease: AiLease, _reason: string): Promise<void> {
    for (const [key, value] of this.leases) if (value.id === lease.id) this.leases.delete(key);
  }
  async aiCacheAbandon(lease: AiLease): Promise<void> { await this.aiCacheFail(lease, 'abandoned'); }
  async aiCacheFailStorage(): Promise<boolean> { return false; }
  async aiCacheInvalidate(id: string): Promise<void> {
    for (const [key, value] of this.entries) if (value.id === id) this.entries.delete(key);
  }
}

test('full synthetic A/B/C retry lifecycle verifies, assembles and atomically finalizes cached provenance', async () => {
  const cacheStore = new MemoryCache();
  const providerCalls: string[] = [];
  let reservations = 0;
  let finalizations = 0;
  let saved: StoredBlueprintResult | null = null;

  const resultStore = {
    get: async () => null,
    finalize: async (_identity: unknown, reservationId: string, blueprint: StoredBlueprintResult['blueprint']) => {
      finalizations++;
      assert.equal(reservationId, '44444444-4444-4444-8444-444444444444');
      saved = { id: '66666666-6666-4666-8666-666666666666', created_at: '2026-11-18T12:00:00.000Z', blueprint };
      return saved;
    },
  } as unknown as BlueprintResultStore;

  const quotaRpc = {
    rpc: async <T>(name: string): Promise<T> => {
      assert.equal(name, 'dr_blueprint_reserve');
      reservations++;
      return { status: 'reserved', reservation_id: '44444444-4444-4444-8444-444444444444', reused: reservations > 1 } as T;
    },
  };

  const provider = {
    apiKey: 'synthetic-only',
    model: source.meta.requested_model,
    timeoutMs: 5_000,
    fetchImpl: async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> };
      const task = (JSON.parse(body.messages[1].content) as { task: string }).task;
      providerCalls.push(task);
      const output = task === 'blueprint_pass_a' ? passA : task === 'blueprint_pass_b' ? passB : passC;
      return new Response(JSON.stringify({
        id: 'synthetic-response-' + task,
        model: source.meta.requested_model,
        provider: 'synthetic-provider',
        choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(output) } }],
        usage: { prompt_tokens: 10, completion_tokens: 20, completion_tokens_details: { reasoning_tokens: 3 }, cost: 0.002 },
      }), { status: 200 });
    },
  };

  const identity = {
    userId: '11111111-1111-4111-8111-111111111111',
    clusterId: source.meta.cluster_id,
    requestKeyHash: 'a'.repeat(64),
    requestParams: { ...source.meta.request_params },
    model: source.meta.requested_model,
    configVersion: source.meta.config_version,
  };

  const run = () => runBlueprintGeneration({
    identity,
    dailyLimit: 1,
    request: source.meta.request_params,
    evidence,
    allowedVerdicts: ['validate_first'],
    resultStore,
    quotaRpc,
    cacheStore,
    provider,
    now: () => new Date('2026-11-18T12:00:00.000Z'),
    createId: () => '55555555-5555-4555-8555-555555555555',
  });

  assert.equal((await run()).state, 'progress'); // A stored
  assert.equal((await run()).state, 'progress'); // A hit, B stored
  assert.equal((await run()).state, 'progress'); // A/B hits, C stored
  assert.equal(finalizations, 0);
  const complete = await run(); // all three cache hits, verified assembly + atomic finalizer
  assert.equal(complete.state, 'completed_now');
  assert.equal(reservations, 4);
  assert.equal(finalizations, 1);
  assert.deepEqual(providerCalls, ['blueprint_pass_a', 'blueprint_pass_b', 'blueprint_pass_c']);
  const persisted = saved as StoredBlueprintResult | null;
  assert.ok(persisted);
  assert.deepEqual(persisted.blueprint.meta.passes.map((pass) => pass.pass), ['A', 'B', 'C']);
  assert.ok(persisted.blueprint.meta.passes.every((pass) => pass.from_cache));
  assert.ok(persisted.blueprint.meta.passes.every((pass) => pass.provider === 'synthetic-provider'));
  assert.ok(persisted.blueprint.meta.passes.every((pass) => pass.prompt_tokens === 10 && pass.completion_tokens === 20));
  assert.ok(persisted.blueprint.meta.passes.every((pass) => pass.reasoning_tokens === 3 && pass.reported_cost_usd === 0.002));
});
