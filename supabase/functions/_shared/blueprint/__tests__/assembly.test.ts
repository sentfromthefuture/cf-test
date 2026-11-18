import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleProductBlueprint, sha256Hex } from '../assembly.ts';
import { canonicalJson } from '../evidence-canonical.ts';
import { validBlueprint, validModelOutput } from './helpers.ts';
import type { PreparedEvidence } from '../evidence-types.ts';
import type { BlueprintPasses, StoredPassOutput } from '../runtime.ts';
import type { BlueprintResultIdentity } from '../result-store.ts';
import type { PassRecord } from '../contract.ts';

const source = validBlueprint();
const model = validModelOutput();
const passAKeys = ['schema_version','opportunity','market_evidence','personas','product','mvp','journeys','workflows','commercial'];
const passBKeys = ['architecture','database'];
const passCKeys = ['implementation','testing','risks'];

function splitPasses(value: Record<string, unknown> = model as unknown as Record<string, unknown>): BlueprintPasses {
  return {
    A: Object.fromEntries(passAKeys.map((key) => [key, value[key]])) as unknown as StoredPassOutput & BlueprintPasses['A'],
    B: Object.fromEntries(passBKeys.map((key) => [key, value[key]])) as unknown as BlueprintPasses['B'],
    C: Object.fromEntries(passCKeys.map((key) => [key, value[key]])) as unknown as BlueprintPasses['C'],
  };
}

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

const identity: BlueprintResultIdentity = {
  userId: '11111111-1111-4111-8111-111111111111',
  clusterId: source.meta.cluster_id,
  requestKeyHash: 'a'.repeat(64),
  requestParams: { ...source.meta.request_params },
  model: source.meta.requested_model,
  configVersion: source.meta.config_version,
};
const passRecords = source.meta.passes as PassRecord[];

test('sha256Hex returns the standard SHA-256 digest', async () => {
  assert.equal(
    await sha256Hex('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});

test('assembles verified model passes with backend-owned provenance and evidence index', async () => {
  const result = await assembleProductBlueprint({
    identity,
    request: source.meta.request_params,
    evidence,
    passes: splitPasses(),
    passRecords,
    now: () => new Date('2026-11-18T12:00:00.000Z'),
    createId: () => '55555555-5555-4555-8555-555555555555',
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  const blueprint = result.blueprint;
  assert.equal(blueprint.meta.blueprint_id, '55555555-5555-4555-8555-555555555555');
  assert.equal(blueprint.meta.generated_at, '2026-11-18T12:00:00.000Z');
  assert.equal(blueprint.meta.generation_mode, 'sectioned');
  assert.equal(blueprint.meta.evidence_pack.pack_sha256, await sha256Hex(evidence.canonical_pack_json));
  assert.equal(blueprint.verification.status, 'verified');
  assert.equal(blueprint.verification.unresolved_refs, 0);
  assert.equal(blueprint.verification.ref_count, source.verification.ref_count);
  assert.deepEqual(blueprint.meta.passes.map((p) => p.pass), ['A', 'B', 'C']);
  assert.ok(blueprint.evidence_index.some((entry) => entry.cited_by.length > 0));
  assert.ok(blueprint.evidence_index.every((entry) => Array.isArray(entry.cited_by)));
});

test('rejects missing passes and invalid merged model output', async () => {
  const missing = await assembleProductBlueprint({
    identity, request: source.meta.request_params, evidence,
    passes: { A: splitPasses().A }, passRecords,
  });
  assert.deepEqual(missing, { ok: false, reason: 'missing_pass' });

  const invalidModel = { ...(model as unknown as Record<string, unknown>), schema_version: 'wrong' };
  const invalid = await assembleProductBlueprint({
    identity, request: source.meta.request_params, evidence,
    passes: splitPasses(invalidModel), passRecords,
  });
  assert.deepEqual(invalid, { ok: false, reason: 'verification_failed' });
});
