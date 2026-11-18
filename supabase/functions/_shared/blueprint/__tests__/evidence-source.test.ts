import { describe, expect, it } from 'vitest';
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

describe('buildEvidenceInputFromRows', () => {
  it('maps only the A3 evidence-input fields and keeps provenance out of model-facing preparation input', () => {
    const result = buildEvidenceInputFromRows({
      cluster, memberships: [{ cluster_id: 'cluster-1', record_id: 'record-1' }], records: [record], signals: [signal],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.input.members).toEqual([{
      record: {
        id: 'record-1', source_id: 'github', discussion_key: 'discussion-1', kind: 'issue',
        url: 'https://example.com/1', title: 'Invoice reconciliation', excerpt: 'Manual reconciliation takes too long.',
        published_at: '2026-11-01T10:00:00Z', engagement: { reactions: 4 }, license: 'CC BY 4.0',
        attribution: 'Author', content_hash: 'a'.repeat(64),
      },
      signal: { is_problem: true, wtp_evidence: false, analysis_method: 'llm' },
    }]);
    expect(JSON.stringify(result.input)).not.toContain('must-not-leak');
    expect(JSON.stringify(result.input)).not.toContain('problem_statement');
  });

  it('preserves a missing signal as null for the evidence validator to account for', () => {
    const result = buildEvidenceInputFromRows({
      cluster, memberships: [{ record_id: 'record-1' }], records: [record], signals: [],
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.input.members[0].signal).toBeNull();
  });

  it('rejects a membership whose raw record is absent instead of dropping it', () => {
    expect(buildEvidenceInputFromRows({
      cluster, memberships: [{ record_id: 'missing' }], records: [], signals: [],
    })).toEqual({ ok: false, error: 'missing_record' });
  });

  it('rejects duplicate signal rows instead of selecting one nondeterministically', () => {
    expect(buildEvidenceInputFromRows({
      cluster, memberships: [{ record_id: 'record-1' }], records: [record], signals: [signal, signal],
    })).toEqual({ ok: false, error: 'duplicate_signal' });
  });
});
