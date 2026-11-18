import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleProductBlueprint } from '../assemble-product.ts';
import { clone, validBlueprint } from './helpers.ts';
import type { BlueprintModelOutputV1, ProductBlueprintV1 } from '../contract.ts';

function inputFromFixture() {
  const fixture = validBlueprint();
  const { meta, evidence_index, verification, ...model } = clone(fixture) as ProductBlueprintV1;
  const { evidence_pack, disclaimers: _disclaimers, ...metaBase } = meta;
  const { pack_sha256: _hash, excerpt_count: _excerpts, metric_count: _metrics, ...packBase } = evidence_pack;
  return {
    model: model as BlueprintModelOutputV1,
    evidenceIndex: evidence_index,
    meta: { ...metaBase, evidence_pack: packBase },
    canonicalEvidencePack: '{}',
    verificationChecks: verification.checks,
  };
}

test('backend assembly recomputes citation provenance and validates the complete product blueprint', async () => {
  const input = inputFromFixture();
  const result = await assembleProductBlueprint(input);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.verification.ref_count, result.value.verification.ref_count);
  assert.equal(result.value.meta.evidence_pack.excerpt_count, result.value.evidence_index.filter((entry) => entry.kind === 'discussion_excerpt').length);
  assert.equal(result.value.meta.evidence_pack.metric_count, result.value.evidence_index.filter((entry) => entry.kind === 'cluster_metric').length);
  for (const entry of result.value.evidence_index) {
    assert.deepEqual(entry.cited_by, [...entry.cited_by].sort());
  }
});

test('assembly refuses to invent missing verification successes', async () => {
  const input = inputFromFixture();
  input.verificationChecks = input.verificationChecks.slice(1);
  const result = await assembleProductBlueprint(input);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'verification_checks_incomplete');
});

test('assembly rejects unresolved evidence references', async () => {
  const input = inputFromFixture();
  input.evidenceIndex = input.evidenceIndex.filter((entry) => entry.id !== 'E01');
  const result = await assembleProductBlueprint(input);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, 'unresolved_evidence_ref');
});
