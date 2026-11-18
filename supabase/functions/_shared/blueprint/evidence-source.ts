// B7: strict adapter from the existing market-intelligence rows to the A3 evidence-input contract.
// This is a pure mapper: it does not fetch data, coerce values, repair malformed rows, or call a provider.
export interface EvidenceSourceRows {
  cluster: Record<string, unknown>;
  memberships: readonly Record<string, unknown>[];
  records: readonly Record<string, unknown>[];
  signals: readonly Record<string, unknown>[];
}

export type EvidenceSourceError =
  | 'invalid_cluster'
  | 'invalid_membership'
  | 'missing_record'
  | 'duplicate_record'
  | 'duplicate_signal';

export type EvidenceSourceResult =
  | { ok: true; input: { cluster: Record<string, unknown>; members: Record<string, unknown>[] } }
  | { ok: false; error: EvidenceSourceError };

const requiredString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

/**
 * Produces exactly the row shape accepted by readInput() in evidence-input.ts.
 * A missing problem-signal row is represented as null (the evidence contract permits this);
 * a missing raw record or ambiguous duplicate is rejected rather than silently omitted.
 */
export function buildEvidenceInputFromRows(rows: EvidenceSourceRows): EvidenceSourceResult {
  const c = rows.cluster;
  if (!requiredString(c.id) || !requiredString(c.title)) return { ok: false, error: 'invalid_cluster' };

  const records = new Map<string, Record<string, unknown>>();
  for (const record of rows.records) {
    if (!requiredString(record.id) || records.has(record.id)) return { ok: false, error: 'duplicate_record' };
    records.set(record.id, record);
  }

  const signals = new Map<string, Record<string, unknown>>();
  for (const signal of rows.signals) {
    if (!requiredString(signal.record_id)) return { ok: false, error: 'duplicate_signal' };
    if (signals.has(signal.record_id)) return { ok: false, error: 'duplicate_signal' };
    signals.set(signal.record_id, signal);
  }

  const seen = new Set<string>();
  const members: Record<string, unknown>[] = [];
  for (const membership of rows.memberships) {
    const recordId = membership.record_id;
    if (!requiredString(recordId) || seen.has(recordId)) return { ok: false, error: 'invalid_membership' };
    seen.add(recordId);
    const record = records.get(recordId);
    if (!record) return { ok: false, error: 'missing_record' };

    const signal = signals.get(recordId) ?? null;
    members.push({
      record: {
        id: record.id,
        source_id: record.source_id,
        discussion_key: record.discussion_key,
        kind: record.kind,
        url: record.url,
        title: record.title,
        excerpt: record.excerpt,
        published_at: record.published_at,
        engagement: record.engagement,
        license: record.license,
        attribution: record.attribution,
        content_hash: record.content_hash,
      },
      signal: signal === null ? null : {
        is_problem: signal.is_problem,
        wtp_evidence: signal.wtp_evidence,
        analysis_method: signal.analysis_method,
      },
    });
  }

  return {
    ok: true,
    input: {
      cluster: {
        id: c.id,
        title: c.title,
        industry: c.industry,
        unique_discussions: c.unique_discussions,
        source_count: c.source_count,
        sources: c.sources,
        recent_discussions: c.recent_discussions,
        prior_discussions: c.prior_discussions,
        growth_rate: c.growth_rate,
        severity_avg: c.severity_avg,
        wtp_signals: c.wtp_signals,
        competitors: c.competitors,
        scores: c.scores,
        confidence: c.confidence,
      },
      members,
    },
  };
}
