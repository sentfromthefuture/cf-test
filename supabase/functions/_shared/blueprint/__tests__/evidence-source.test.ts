import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidenceInputFromRows } from '../evidence-source.ts';

const cluster = {
  id: 'cluster-1', title: 'Slow invoice reconciliation', industry: 'Finance',
  unique_discussions: 12, source_count: 2, sources: ['github', 'hackernews'],
  recent_discussions: 8, prior_discussions: 4, growth_rate: 100, severity_avg: 3.5,
  wtp_signals: 1, competitors: { spreadsheet: 3 }, scores: { components: {} }, confidence: 'high',
};
const record = {
  id: 'record-1', source_id: 'github', discussion_key: 'discussion-1', kind: 'issue',
  url: 'https://example.com/1', title: 'Invoice reconciliation', excerpt: 'Manual reconciliation takes too long.',
  published_at: '2026-11-01T10:00:00Z', engagement: { reactions: 4 }, license: 'CC BY 4.0',
  attribution: 'Author', content_hash: 'a'.repeat(64), author_ref: 'must-not-leak',
};
const signal = { record_id: 'record-1', is_problem: true, wtp_evidence: false, analysis_method: 'llm', problem_statement: 'Slow invoice reconciliation' };

test('buildEvidenceInputFromRows', async (t) => {
  await t.test('maps only the A3 evidence-input fields and keeps provenance out of model-facing preparation input', () => {
    const result = buildEvidenceInputFromRows({
      cluster, memberships: [{ cluster_id: 'cluster-1', record_id: 'record-1' }], records: [record], signals: [signal],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.input.members, [{
      record: {
        id: 'record-1', source_id: 'github', discussion_key: 'discussion-1', kind: 'issue',
        url: 'https://example.com/1', title: 'Invoice reconciliation', excerpt: 'Manual reconciliation takes too long.',
        published_at: '2026-11-01T10:00:00Z', engagement: { reactions: 4 }, license: 'CC BY 4.0',
        attribution: 'Author', content_hash: 'a'.repeat(64),
      },
      signal: { is_problem: true, wtp_evidence: false, analysis_method: 'llm' },
    }]);
    assert.equal(JSON.stringify(result.input).includes('must-not-leak'), false);
    assert.equal(JSON.stringify(result.input).includes('problem_statement'), false);
  });

  await t.test('preserves a missing signal as null for the evidence validator to account for', () => {
    const result = buildEvidenceInputFromRows({
      cluster, memberships: [{ record_id: 'record-1' }], records: [record], signals: [],
    });
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.input.members[0].signal, null);
  });

  await t.test('rejects a membership whose raw record is absent instead of dropping it', () => {
    assert.deepEqual(buildEvidenceInputFromRows({
      cluster, memberships: [{ record_id: 'missing' }], records: [], signals: [],
    }), { ok: false, error: 'missing_record' });
  });

  await t.test('rejects duplicate signal rows instead of selecting one nondeterministically', () => {
    assert.deepEqual(buildEvidenceInputFromRows({
      cluster, memberships: [{ record_id: 'record-1' }], records: [record], signals: [signal, signal],
    }), { ok: false, error: 'duplicate_signal' });
  });
});
