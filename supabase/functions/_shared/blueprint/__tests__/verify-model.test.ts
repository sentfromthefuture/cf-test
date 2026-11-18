import test from 'node:test';
import assert from 'node:assert/strict';
import { REQUIRED_VERIFICATION_CHECKS } from '../constants.ts';
import { validBlueprint, validModelOutput } from './helpers.ts';
import { verifyBlueprintModelOutput } from '../verify-model.ts';

test('verifyBlueprintModelOutput', async (t) => {
  await t.test('records every required check exactly once only when validation and grounding pass', () => {
    const blueprint = validBlueprint();
    const pack = {
      ai_labels: { industry: null, cluster_label: 'synthetic fixture' },
      excerpts: blueprint.evidence_index.filter((e) => e.kind === 'discussion_excerpt').map((e) => ({
        id: e.id, source: e.source_id, kind: 'issue', published: null, title: e.title, text: e.excerpt, wtp: e.has_wtp_quote,
      })),
      metrics: blueprint.evidence_index.filter((e) => e.kind === 'cluster_metric').map((e) => ({
        id: e.id, name: e.name, label: e.label, value: e.value, evidence_class: e.evidence_class,
      })),
    };
    const result = verifyBlueprintModelOutput(validModelOutput(), pack);
    if (!result.ok) {
      assert.fail('synthetic worked example did not pass verification: ' + JSON.stringify(result.failed));
    }
    assert.deepEqual(result.checks.map((c) => c.check), [...REQUIRED_VERIFICATION_CHECKS]);
    assert.ok(result.checks.every((c) => c.passed === true));
  });

  await t.test('does not report successful checks for invalid model output', () => {
    const result = verifyBlueprintModelOutput({ schema_version: 'wrong' }, {
      ai_labels: { industry: null, cluster_label: 'synthetic' }, excerpts: [], metrics: [],
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.ok(result.failed.length > 0);
  });
});
