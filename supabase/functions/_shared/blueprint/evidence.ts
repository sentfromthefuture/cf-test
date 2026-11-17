// Phase A3 entry point: deterministic, read-only evidence preparation for the ERNIE Product Blueprint engine.
//
//   prepareEvidencePack(input) -> { pack, index, canonical_pack_json, summary, sufficiency, diagnostics }
//
// It is a PURE function of its input: no database, no network, no provider, no clock, no randomness, no locale. It reads typed rows that a
// later phase will load; it never loads them itself. It does not call a model, build a prompt, touch the cache or usage tables, or hash
// anything (hashing `canonical_pack_json` is the cache phase's job).
//
// Privacy boundary. The returned `pack` is the ONLY object that may ever be shown to a model. It is built from fields chosen one by one below;
// it has no record ids, URLs, author identifiers, attribution, licence text, engagement counts or per-record problem statements, and the input
// types do not even carry the last two. Everything the backend needs to trace an excerpt back to its source lives in `index` (the A2
// DiscussionEvidence / MetricEvidence entries, unchanged), which must stay on the backend.
//
// What this module does not prove: see evidence-grounding.ts for the limits of the lexical guards. Selection is deterministic; it is not a
// judgement that the chosen excerpts are the best evidence.
import type { DiscussionEvidence, EvidenceIndexEntry, MetricEvidence } from './contract.ts';
import { MAX_EXCERPTS } from './evidence-constants.ts';
import { canonicalJson } from './evidence-canonical.ts';
import { readInput } from './evidence-input.ts';
import { buildMetricCatalogue, copyMetricValue } from './evidence-metrics.ts';
import { selectExcerpts } from './evidence-select.ts';
import { evaluateSufficiency } from './evidence-sufficiency.ts';
import { epochToIso, epochToMonth, normaliseWhitespace } from './evidence-text.ts';
import type { EvidencePack, PackExcerpt, PrepareResult, PreparedEvidence } from './evidence-types.ts';

export type * from './evidence-types.ts';
export { canonicalJson } from './evidence-canonical.ts';
export { evaluateSufficiency } from './evidence-sufficiency.ts';
export type { SufficiencyInput } from './evidence-sufficiency.ts';
export { bucketCount, roundToStep } from './evidence-metrics.ts';
export { SUFFICIENCY_REASON_MESSAGES, SUFFICIENCY_THRESHOLDS } from './evidence-constants.ts';
export {
  buildGroundingContext, checkGeneralisation, checkNameGrounding, checkNumericGrounding, checkRelevanceFloor, checkSupportingGrade,
  checkWtpEvidence, containsGeneralisation, contentStems, extractNumerals, isSupportingGrade, normaliseForMatch, renderMetricValue,
  findPriceOrShareStatements, statesPriceOrShare,
} from './evidence-grounding.ts';
export type { GroundingContext, GroundingItem, GuardReason, GuardResult, PriceOrShareKind, WtpRuleInput, WtpRuleResult } from './evidence-grounding.ts';

/**
 * Builds the evidence pack, the backend evidence index, the sufficiency verdict and the canonical pack from cluster rows and member rows.
 * Never throws: a malformed input comes back as `{ ok: false, errors }` with content-free errors.
 *
 * The result does not depend on the order of `members`, on the order of object keys, or on the machine's locale or clock.
 */
export function prepareEvidencePack(input: unknown): PrepareResult {
  try {
    const read = readInput(input);
    if (!read.ok) return { ok: false, errors: read.errors };
    const { cluster, members } = read;

    const selection = selectExcerpts(members);
    const catalogue = buildMetricCatalogue(cluster);

    // The model-facing pack: fields are listed one by one so nothing else can leak in.
    const excerpts: PackExcerpt[] = selection.selected.map(({ id, member: m }) => ({
      id,
      source: m.source_id,
      kind: m.kind,
      published: m.published_ms === null ? null : epochToMonth(m.published_ms),
      title: m.title,
      text: m.text,
      wtp: (m.signal as NonNullable<typeof m.signal>).wtp_evidence,
    }));
    const pack: EvidencePack = {
      ai_labels: { industry: cluster.industry === null ? null : normaliseWhitespace(cluster.industry), cluster_label: normaliseWhitespace(cluster.title) },
      excerpts,
      metrics: catalogue.metrics,
    };

    // The backend evidence index: exactly what the model saw, plus the provenance it never sees. Metric values are copied, not shared.
    const index: EvidenceIndexEntry[] = [
      ...selection.selected.map(({ id, member: m }): DiscussionEvidence => {
        const signal = m.signal as NonNullable<typeof m.signal>;
        return {
          id, kind: 'discussion_excerpt', record_id: m.id, source_id: m.source_id, url: m.url, title: m.title, excerpt: m.text,
          content_sha256: m.content_hash, published_at: m.published_ms === null ? null : epochToIso(m.published_ms), license: m.license,
          attribution: m.attribution, analysis_method: signal.analysis_method, has_wtp_quote: signal.wtp_evidence, cited_by: [],
        };
      }),
      ...catalogue.metrics.map((metric): MetricEvidence => ({
        id: metric.id, kind: 'cluster_metric', cluster_id: cluster.id, name: metric.name, label: metric.label,
        value: copyMetricValue(metric.value), evidence_class: metric.evidence_class, cited_by: [],
      })),
    ];

    const sufficiency = evaluateSufficiency({
      unique_discussions: cluster.unique_discussions,
      source_count: cluster.source_count,
      confidence: cluster.confidence,
      usable_excerpts: excerpts.length,
    });

    const value: PreparedEvidence = {
      pack,
      index,
      canonical_pack_json: canonicalJson(pack),
      summary: {
        excerpt_count: excerpts.length,
        metric_count: pack.metrics.length,
        truncated: selection.truncated,
        sufficiency: sufficiency.level,
        sufficiency_reasons: sufficiency.reasons.map((r) => r.message),
      },
      sufficiency,
      diagnostics: {
        members_total: selection.counts.members_total,
        problem_members: selection.counts.problem_members,
        excluded_no_signal: selection.counts.excluded_no_signal,
        excluded_not_problem: selection.counts.excluded_not_problem,
        excluded_no_usable_text: selection.counts.excluded_no_usable_text,
        eligible_discussions: selection.counts.eligible_discussions,
        selected_wtp_first: selection.counts.selected_wtp_first,
        selected_total: excerpts.length,
        metrics_value_truncated: catalogue.value_truncated,
      },
    };
    if (excerpts.length > MAX_EXCERPTS) throw new RangeError('excerpt cap exceeded'); // cannot happen; guards the invariant the A2 validator relies on
    return { ok: true, value };
  } catch {
    return { ok: false, errors: [{ code: 'internal_error', path: '', message: 'The evidence could not be prepared.' }] };
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Provenance helpers (evidence index)
// ---------------------------------------------------------------------------------------------------------------------------------

/** Resolves an id (E## or M##) against the pack's index. Resolution is against the pack built for the request, never the live database. */
export function indexById(index: readonly EvidenceIndexEntry[]): Map<string, EvidenceIndexEntry> {
  return new Map(index.map((e) => [e.id, e]));
}

/**
 * The `{ record_id, content_sha256 }` list for the cache row's `citations` column (reliability document sections 9.4 and 10): which records a
 * blueprint was shown, so a takedown can find and invalidate it. `ids` limits it to the cited excerpts; without it, every excerpt in the pack.
 * Sorted by record id, so the list does not depend on the order of the index.
 */
export function citationsFromIndex(index: readonly EvidenceIndexEntry[], ids?: readonly string[]): { record_id: string; content_sha256: string }[] {
  const wanted = ids === undefined ? null : new Set(ids);
  return index
    .filter((e): e is DiscussionEvidence => e.kind === 'discussion_excerpt' && (wanted === null || wanted.has(e.id)))
    .map((e) => ({ record_id: e.record_id, content_sha256: e.content_sha256 }))
    .sort((a, b) => (a.record_id < b.record_id ? -1 : a.record_id > b.record_id ? 1 : 0));
}
