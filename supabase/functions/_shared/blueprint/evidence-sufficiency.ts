// Evidence sufficiency (evidence contract section 3.6). Authoritative and computed by the backend from numbers only.
//
// Nothing here reads model output. The model's own `sufficiency_self_assessment` is stored and compared elsewhere and never decides anything.
//
//   insufficient: unique_discussions < 4  OR  fewer than 3 usable excerpts
//   limited:      not insufficient, but the `high` confidence rule is not met  OR  fewer than 8 usable excerpts
//   adequate:     the `high` confidence rule is met  AND  at least 8 usable excerpts
//
// The `high` confidence rule is NUMERICAL and is checked here directly: unique_discussions >= 10 AND source_count >= 2 (the rule of
// dr_refresh_clusters), and the stored confidence word must agree (`high`). The stored word is NOT trusted by itself: a row that says `high`
// but fails either number (for example because its statistics are stale) is `limited`, and the reason says which number fell short.
// Nothing is repaired or upgraded: the stored confidence is still shown to the model unchanged as M05.
//
// "Usable excerpt" = an excerpt that made it into the pack (non-empty after whitespace normalisation, one per independent discussion).
// `unique_discussions`, `source_count` and `confidence` are the stored cluster values (M01, M02 and M05).
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

  // limited: the `high` confidence rule is not met, or too few excerpts for "adequate".
  // The rule is the two numbers AND the stored word. Each shortfall is reported with its own fixed reason, numbers first. The stored word is
  // named as the reason only when both numbers are fine and the stored confidence still is not `high` (it disagrees with its own rule).
  const limited: SufficiencyReason[] = [];
  const enoughDiscussions = input.unique_discussions >= t.highConfidenceDiscussions;
  const enoughSources = input.source_count >= t.highConfidenceSources;
  if (!enoughDiscussions) limited.push(reason('fewer_than_high_discussions'));
  if (!enoughSources) limited.push(reason('fewer_than_high_sources'));
  if (enoughDiscussions && enoughSources && input.confidence !== 'high') limited.push(reason('confidence_not_high'));
  if (input.usable_excerpts < t.adequateUsableExcerpts) limited.push(reason('fewer_than_adequate_excerpts'));
  if (limited.length > 0) return { level: 'limited', reasons: limited };

  return { level: 'adequate', reasons: [] };
}
