// Types for Phase A3 evidence preparation.
//
// Three groups:
//  1. INPUT types: the cluster, member-record and signal rows the backend will read in a later phase. They mirror the verified columns of
//     dr_clusters, dr_raw_records and dr_problem_signals. Fields this module must never forward (author_ref, problem_statement, wtp_quote,
//     engagement as a number, ...) are not part of these types; if a caller passes them they are ignored and never copied anywhere.
//  2. The MODEL-FACING pack (evidence contract section 3.5). It has no record ids, URLs, author identifiers, attribution, licence text,
//     engagement counts or per-record problem statements. The type itself has nowhere to put them.
//  3. RESULT types. The backend evidence index reuses the A2 contract types (DiscussionEvidence, MetricEvidence) unchanged.
import type { EvidenceIndexEntry, EvidencePackSummary, EvidenceSufficiency, Level3, MetricClass, MetricEvidence, MetricName } from './contract.ts';
import type { ScoreComponentBasis, SufficiencyReasonCode } from './evidence-constants.ts';

// ---------------------------------------------------------------------------------------------------------------------------------
// 1. Inputs
// ---------------------------------------------------------------------------------------------------------------------------------

export interface ScoreComponentInput {
  /** The component's own value (0 to 100 in dr_refresh_clusters). null = no value. */
  value: number | null;
  basis: ScoreComponentBasis;
}

/** The columns of dr_clusters this module reads. Anything else on the row is ignored. */
export interface ClusterInput {
  id: string;
  /** dr_clusters.title: the cluster label. AI/heuristic derived, not evidence. */
  title: string;
  industry: string | null;
  unique_discussions: number;
  source_count: number;
  sources: string[];
  recent_discussions: number;
  prior_discussions: number;
  /** dr_clusters.growth_rate in percent. null = insufficient data. */
  growth_rate: number | null;
  /** dr_clusters.severity_avg (1 to 5), an AI estimate. null = no estimate. */
  severity_avg: number | null;
  wtp_signals: number;
  /** name -> number of discussions naming it. */
  competitors: Record<string, number>;
  confidence: Level3;
  /** dr_clusters.scores. Only `components.<key>.value` and `.basis` are read. May be absent on a cluster that was never refreshed. */
  scores?: { components?: Partial<Record<string, ScoreComponentInput>> } | null;
}

/** The columns of dr_raw_records this module reads. Notably NOT author_ref. */
export interface RawRecordInput {
  /** dr_raw_records.id. Stays in the backend index; never in the model-facing pack. */
  id: string;
  source_id: string;
  discussion_key: string;
  kind: string;
  url: string;
  title: string | null;
  excerpt: string | null;
  /** ISO 8601 with a zone designator (what PostgREST returns for timestamptz). */
  published_at: string | null;
  /** jsonb of counters. Used for ranking only; never forwarded. Non-numeric values are ignored, as dr_refresh_clusters ignores them. */
  engagement: Record<string, unknown>;
  license: string;
  attribution: string | null;
  /** SHA-256 hex written by the connector. */
  content_hash: string;
}

/** The columns of dr_problem_signals this module reads. Notably NOT problem_statement, wtp_quote or embedding. */
export interface ProblemSignalInput {
  is_problem: boolean;
  wtp_evidence: boolean;
  analysis_method: 'llm' | 'heuristic';
}

export interface ClusterMemberInput {
  record: RawRecordInput;
  /** null = the record has no signal row yet (it is not a candidate). */
  signal: ProblemSignalInput | null;
}

export interface EvidencePrepInput {
  cluster: ClusterInput;
  members: ClusterMemberInput[];
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 2. Model-facing pack (evidence contract section 3.5)
// ---------------------------------------------------------------------------------------------------------------------------------

export interface PackExcerpt {
  id: string;                    // "E01"
  source: string;                // source_id, e.g. "github"
  kind: string;                  // issue | story | comment | question
  published: string | null;      // "YYYY-MM" (UTC)
  title: string | null;          // untrusted text
  text: string;                  // untrusted text, at most 400 code points
  wtp: boolean;                  // a grounded willingness-to-pay quote exists in this record
}

export interface PackMetric {
  id: string;                    // "M01"
  name: MetricName;              // fixed catalogue name
  label: string;                 // backend wording
  value: MetricEvidence['value'];
  evidence_class: MetricClass;
}

export interface EvidencePack {
  /** AI/heuristic-derived labels. Context, NOT evidence. */
  ai_labels: { industry: string | null; cluster_label: string };
  excerpts: PackExcerpt[];
  metrics: PackMetric[];
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 3. Results
// ---------------------------------------------------------------------------------------------------------------------------------

export interface SufficiencyReason { code: SufficiencyReasonCode; message: string }

export interface SufficiencyResult {
  level: EvidenceSufficiency;
  reasons: SufficiencyReason[];
}

/** Counts only. Never contains record text, ids or URLs, so it is safe to log. */
export interface PrepareDiagnostics {
  members_total: number;
  /** Members with a signal row whose is_problem is true. */
  problem_members: number;
  excluded_no_signal: number;
  excluded_not_problem: number;
  /** is_problem members whose excerpt is empty after whitespace normalisation: they cannot be shown as evidence. */
  excluded_no_usable_text: number;
  /** Independent discussions among the eligible candidates, after collapsing by discussion_key. */
  eligible_discussions: number;
  /** How many of the selected excerpts came from the willingness-to-pay first pass. */
  selected_wtp_first: number;
  selected_total: number;
  /** Metric values that were shortened to fit the A2 limits (currently only M10 can be). */
  metrics_value_truncated: string[];
}

export interface PreparedEvidence {
  /** What the model is shown. Contains no backend identifiers. */
  pack: EvidencePack;
  /** Backend only. One entry per pack item (E01.. then M01..M16), with every provenance field the model never sees. cited_by is empty. */
  index: EvidenceIndexEntry[];
  /** The pack in canonical JSON (sorted keys, no whitespace). The input of the later cache-key phase, which will hash it. */
  canonical_pack_json: string;
  /** The A2 `meta.evidence_pack` object without `pack_sha256`, which the later cache phase computes from `canonical_pack_json`. */
  summary: Omit<EvidencePackSummary, 'pack_sha256'>;
  sufficiency: SufficiencyResult;
  diagnostics: PrepareDiagnostics;
}

export type PrepareErrorCode =
  | 'input_too_large' | 'invalid_type' | 'missing_required_field' | 'invalid_format' | 'invalid_enum' | 'number_out_of_range'
  | 'string_blank' | 'string_too_long' | 'string_invalid_characters' | 'list_too_long' | 'duplicate_record' | 'inconsistent_component'
  | 'internal_error';

/** Content-free: `path` is built from OUR field names and array indexes, `message` is fixed text. No input value is ever echoed. */
export interface PrepareError { code: PrepareErrorCode; path: string; message: string }

export type PrepareResult =
  | { ok: true; value: PreparedEvidence }
  | { ok: false; errors: PrepareError[] };
