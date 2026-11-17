// Evidence sufficiency (evidence contract section 3.6). Authoritative and computed by the backend from numbers only.
//
// Nothing here reads model output. The model's own `sufficiency_self_assessment` is stored and compared elsewhere and never decides anything.
//
//   insufficient: unique_discussions < 4  OR  fewer than 3 usable excerpts
//   limited:      not insufficient, but cluster confidence is not `high`  OR  fewer than 8 usable excerpts
//   adequate:     confidence = high  AND  at least 8 usable excerpts
//
// "Usable excerpt" = an excerpt that made it into the pack (non-empty after whitespace normalisation, one per independent discussion).
// `unique_discussions` and `confidence` are the stored cluster values (M01 and M05), exactly as the contract names them.
import type { Level3 } from './contract.ts';
import { SUFFICIENCY_REASON_MESSAGES, SUFFICIENCY_THRESHOLDS } from './evidence-constants.ts';
import type { SufficiencyReasonCode } from './evidence-constants.ts';
import type { SufficiencyReason, SufficiencyResult } from './evidence-types.ts';

export interface SufficiencyInput {
  unique_discussions: number;
  source_count: number;
  confidence: Level3;
  usable_excerpts: number;
}

const reason = (code: SufficiencyReasonCode): SufficiencyReason => ({ code, message: SUFFICIENCY_REASON_MESSAGES[code] });

export function evaluateSufficiency(input: SufficiencyInput): SufficiencyResult {
  const t = SUFFICIENCY_THRESHOLDS;

  // insufficient: list every failed condition, discussions first.
  const insufficient: SufficiencyReason[] = [];
  if (input.unique_discussions < t.minUniqueDiscussions) insufficient.push(reason('fewer_than_min_discussions'));
  if (input.usable_excerpts < t.minUsableExcerpts) insufficient.push(reason('fewer_than_min_excerpts'));
  if (insufficient.length > 0) return { level: 'insufficient', reasons: insufficient };

  // limited: confidence is not high, or too few excerpts for "adequate".
  const limited: SufficiencyReason[] = [];
  if (input.confidence !== 'high') {
    // The `high` rule is "at least 10 discussions across at least 2 sources". Say which part falls short; if neither does, the stored
    // confidence disagrees with its own rule (for example stale statistics) and the reason says only that it is not high.
    const before = limited.length;
    if (input.unique_discussions < t.highConfidenceDiscussions) limited.push(reason('fewer_than_high_discussions'));
    if (input.source_count < t.highConfidenceSources) limited.push(reason('fewer_than_high_sources'));
    if (limited.length === before) limited.push(reason('confidence_not_high'));
  }
  if (input.usable_excerpts < t.adequateUsableExcerpts) limited.push(reason('fewer_than_adequate_excerpts'));
  if (limited.length > 0) return { level: 'limited', reasons: limited };

  return { level: 'adequate', reasons: [] };
}
