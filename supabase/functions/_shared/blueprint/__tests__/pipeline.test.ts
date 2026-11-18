import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBlueprintPassPayload } from '../pipeline.ts';
import { clone, validModelOutput } from './helpers.ts';
import type { PreparedEvidence } from '../evidence.ts';
import type { PassAOutput, PassBOutput, BlueprintRequestParams } from '../contract.ts';

const model = validModelOutput();
const passAOnly = () => Object.fromEntries(['schema_version','opportunity','market_evidence','personas','product','mvp','journeys','workflows','commercial'].map(k => [k, (model as any)[k]]));
const passBOnly = () => Object.fromEntries(['architecture','database'].map(k => [k, (model as any)[k]]));
const request: BlueprintRequestParams = {
  team_size: 'solo', budget_band: 'bootstrap', preferred_stack: 'typescript_postgres',
  business_model_hint: 'b2b_saas', target_region: 'africa',
};
const evidence = {
  pack: { ai_labels: { industry: 'Synthetic', cluster_label: 'Synthetic cluster' }, excerpts: [], metrics: [] },
  sufficiency: { level: 'limited', reasons: [] },
} as unknown as PreparedEvidence;

test('Pass A payload contains only request, allowed verdicts and model-facing evidence pack', () => {
  const payload = buildBlueprintPassPayload({ pass: 'A', request, evidence, allowedVerdicts: ['validate_first'] }) as any;
  assert.equal(payload.task, 'blueprint_pass_a');
  assert.deepEqual(payload.request.allowed_verdicts, ['validate_first']);
  assert.deepEqual(payload.evidence_pack, evidence.pack);
  assert.equal('index' in payload, false);
});

test('Pass B handoff is a fresh allowlisted DTO, not raw Pass A output', () => {
  const passA = clone(passAOnly()) as unknown as PassAOutput;
  const payload = buildBlueprintPassPayload({ pass: 'B', request, evidence, passA }) as any;
  assert.equal(payload.task, 'blueprint_pass_b');
  assert.equal(Object.keys(payload).sort().join(','), 'contract,features,personas,product,request,task,workflows');
  assert.equal('evidence_pack' in payload, false);
  assert.ok(payload.features.length > 0);
  assert.equal(typeof payload.product.positioning, 'string');
});

test('Pass C handoff uses component/table IDs and evidence-gap descriptions only', () => {
  const passA = clone(passAOnly()) as unknown as PassAOutput;
  const passB = clone(passBOnly()) as unknown as PassBOutput;
  const payload = buildBlueprintPassPayload({ pass: 'C', request, evidence, passA, passB }) as any;
  assert.equal(payload.task, 'blueprint_pass_c');
  assert.ok(payload.components.length > 0);
  assert.ok(payload.tables.length > 0);
  assert.ok(payload.evidence_gaps.every((v: unknown) => typeof v === 'string'));
  assert.equal('evidence_pack' in payload, false);
});

test('later passes require their upstream output', () => {
  assert.throws(() => buildBlueprintPassPayload({ pass: 'B', request, evidence }), /missing_upstream_pass/);
  assert.throws(() => buildBlueprintPassPayload({ pass: 'C', request, evidence, passA: clone(passAOnly()) as unknown as PassAOutput }), /missing_upstream_pass/);
});
