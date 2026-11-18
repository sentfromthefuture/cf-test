import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleBlueprintModelOutput } from '../assemble-model.ts';
import type { PreparedEvidence } from '../evidence.ts';
import type { PassAOutput, PassBOutput, PassCOutput } from '../contract.ts';
import { clone, validBlueprint, validModelOutput } from './helpers.ts';

const full = validModelOutput();
const evidence = {
  index: validBlueprint().evidence_index,
} as unknown as PreparedEvidence;
const split = () => ({
  A: Object.fromEntries(['schema_version','opportunity','market_evidence','personas','product','mvp','journeys','workflows','commercial'].map(k => [k, (full as any)[k]])) as PassAOutput,
  B: Object.fromEntries(['architecture','database'].map(k => [k, (full as any)[k]])) as PassBOutput,
  C: Object.fromEntries(['implementation','testing','risks'].map(k => [k, (full as any)[k]])) as PassCOutput,
});

test('three pass sections assemble into one A2-valid model-owned blueprint', () => {
  const result = assembleBlueprintModelOutput(split(), evidence);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.value.schema_version, full.schema_version);
    assert.equal('meta' in result.value, false);
    assert.equal('evidence_index' in result.value, false);
    assert.equal('verification' in result.value, false);
  }
});

test('assembly rejects missing passes without attempting to repair them', () => {
  const result = assembleBlueprintModelOutput({ A: split().A, B: split().B }, evidence);
  assert.deepEqual(result, { ok: false, error: { code: 'missing_pass', pass: 'C' } });
});

test('assembly rejects unresolved evidence refs against the backend evidence index', () => {
  const passes = split();
  const mutated = clone(passes.A) as any;
  mutated.opportunity.problem_statement.evidence_refs = ['E24'];
  const result = assembleBlueprintModelOutput({ ...passes, A: mutated }, evidence);
  assert.equal(result.ok, false);
  if (!result.ok && result.error.code === 'invalid_model_output') {
    assert.ok(result.error.validation_codes.includes('evidence_ref_unresolved'));
  }
});
