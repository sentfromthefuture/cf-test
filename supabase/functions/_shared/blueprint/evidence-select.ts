// Deterministic excerpt selection (evidence contract section 3.4). Pure: no randomness, no clock, no locale, no dependence on the order of
// the input array or of object keys. Every ordering below is a TOTAL order (it ends in the record id), so two permutations of the same
// members always produce the same result.
//
// The contract's six steps, and where each lives:
//   1. candidates: signal.is_problem = true                          -> isCandidate
//   2. one per discussion_key, highest engagement kept                -> collapseByDiscussion
//   3. up to 4 WTP candidates first                                   -> selectExcerpts (wtp pass)
//   4. fill by round-robin across source_id up to 24                  -> selectExcerpts (fill pass)
//   5. text: whitespace-normalised, 400 code points                   -> done at input time (evidence-input.ts)
//   6. ids E01.. by (source_id, published_at asc nulls last, hash)    -> assignExcerptIds
//
// Where the contract is silent this module chooses, and says so (marked CHOICE). Each CHOICE is also listed in the PR report.
import { MAX_EXCERPTS, MAX_WTP_FIRST, excerptId } from './evidence-constants.ts';
import type { ValidMember } from './evidence-input.ts';
import { compareStrings } from './evidence-text.ts';

export interface SelectedExcerpt {
  /** "E01".. */
  id: string;
  member: ValidMember;
  /** True when this excerpt was taken in the willingness-to-pay first pass. */
  from_wtp_pass: boolean;
}

export interface Selection {
  selected: SelectedExcerpt[];
  /** True when more independent discussions were eligible than the 24-excerpt cap allowed (evidence contract section 3.4, last line). */
  truncated: boolean;
  counts: {
    members_total: number;
    problem_members: number;
    excluded_no_signal: number;
    excluded_not_problem: number;
    excluded_no_usable_text: number;
    eligible_discussions: number;
    selected_wtp_first: number;
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Comparators (all total orders)
// ---------------------------------------------------------------------------------------------------------------------------------

/** Earlier first; a missing published_at sorts AFTER every dated record (the same "nulls last" the contract states for id assignment). */
function comparePublishedAsc(a: ValidMember, b: ValidMember): number {
  if (a.published_ms === b.published_ms) return 0;
  if (a.published_ms === null) return 1;
  if (b.published_ms === null) return -1;
  return a.published_ms - b.published_ms;
}

/** More recent first; a missing published_at is the least recent. */
function comparePublishedDesc(a: ValidMember, b: ValidMember): number {
  if (a.published_ms === b.published_ms) return 0;
  if (a.published_ms === null) return 1;
  if (b.published_ms === null) return -1;
  return b.published_ms - a.published_ms;
}

/**
 * Section 3.4 step 2 (collapse): the record to KEEP sorts first. Highest engagement; ties: earliest published_at, then smallest content_hash.
 * CHOICE: a missing published_at counts as latest in the tie-break (the contract does not say), and the record id is the final tie-break so the
 * order is total even for two records with the same hash.
 */
export function compareForCollapse(a: ValidMember, b: ValidMember): number {
  return (b.engagement - a.engagement) || comparePublishedAsc(a, b) || compareStrings(a.content_hash, b.content_hash) || compareStrings(a.id, b.id);
}

/**
 * Section 3.4 step 4 (within a source) and step 3 (willingness-to-pay pass): engagement, then recency, then content_hash.
 * CHOICE: the same order is used to pick WTP candidates globally (the contract gives no order for choosing 4 of more than 4), most recent first,
 * a missing published_at least recent, record id last.
 */
export function compareForFill(a: ValidMember, b: ValidMember): number {
  return (b.engagement - a.engagement) || comparePublishedDesc(a, b) || compareStrings(a.content_hash, b.content_hash) || compareStrings(a.id, b.id);
}

/** Section 3.4 step 6: source_id, published_at ascending with nulls last, content_hash. Independent of engagement. (Record id last: total order.) */
export function compareForIds(a: ValidMember, b: ValidMember): number {
  return compareStrings(a.source_id, b.source_id) || comparePublishedAsc(a, b) || compareStrings(a.content_hash, b.content_hash) || compareStrings(a.id, b.id);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------------------------------------------------------------

type Candidate = ValidMember & { signal: NonNullable<ValidMember['signal']> };

/** Section 3.4 step 1: the signal exists and is_problem = true. */
const isProblem = (m: ValidMember): m is Candidate => m.signal !== null && m.signal.is_problem;

/** Section 3.4 step 2. Discussions are compared by exact discussion_key (no case folding, no trimming). */
export function collapseByDiscussion<T extends ValidMember>(candidates: readonly T[]): T[] {
  const best = new Map<string, T>();
  for (const m of candidates) {
    const current = best.get(m.discussion_key);
    if (current === undefined || compareForCollapse(m, current) < 0) best.set(m.discussion_key, m);
  }
  // Map order is insertion order, which depends on the input order. Sort so that nothing downstream can depend on it.
  return [...best.values()].sort((a, b) => compareStrings(a.discussion_key, b.discussion_key));
}

/** Section 3.4 step 6. */
export function assignExcerptIds(chosen: readonly { member: ValidMember; from_wtp_pass: boolean }[]): SelectedExcerpt[] {
  return [...chosen]
    .sort((a, b) => compareForIds(a.member, b.member))
    .map((c, i) => ({ id: excerptId(i + 1), member: c.member, from_wtp_pass: c.from_wtp_pass }));
}

/** All six steps. `members` may be in any order and is never modified. */
export function selectExcerpts(members: readonly ValidMember[]): Selection {
  const noSignal = members.filter((m) => m.signal === null).length;
  const problems = members.filter(isProblem);
  const notProblem = members.length - noSignal - problems.length;

  // A record with no usable text cannot be shown as evidence, so it does not compete in the collapse.
  // CHOICE: the contract does not define "usable"; here it means "non-empty after whitespace normalisation".
  const usable = problems.filter((m) => m.text.length > 0);
  const eligible = collapseByDiscussion(usable);

  // Step 3: up to 4 candidates whose signal carries a grounded willingness-to-pay quote.
  const wtpPicked = eligible.filter((m) => m.signal.wtp_evidence).sort(compareForFill).slice(0, MAX_WTP_FIRST);
  const taken = new Set(wtpPicked.map((m) => m.id));

  // Step 4: round-robin across source_id over what is left, up to the cap.
  // CHOICE: sources take their turn in ascending source_id order (the contract does not say), starting fresh after the WTP pass.
  const bySource = new Map<string, Candidate[]>();
  for (const m of eligible) {
    if (taken.has(m.id)) continue;
    const list = bySource.get(m.source_id);
    if (list) list.push(m); else bySource.set(m.source_id, [m]);
  }
  const queues = [...bySource.entries()].sort((a, b) => compareStrings(a[0], b[0])).map(([, list]) => list.sort(compareForFill));
  const filled: Candidate[] = [];
  const slots = MAX_EXCERPTS - wtpPicked.length;
  for (let round = 0; filled.length < slots; round++) {
    let tookAny = false;
    for (const q of queues) {
      if (filled.length >= slots) break;
      if (round < q.length) { filled.push(q[round]); tookAny = true; }
    }
    if (!tookAny) break;
  }

  const selected = assignExcerptIds([
    ...wtpPicked.map((member) => ({ member, from_wtp_pass: true })),
    ...filled.map((member) => ({ member, from_wtp_pass: false })),
  ]);

  return {
    selected,
    // CHOICE: "candidates exceed the cap" is read as independent discussions (after the collapse), because that is what an excerpt stands for.
    truncated: eligible.length > MAX_EXCERPTS,
    counts: {
      members_total: members.length,
      problem_members: problems.length,
      excluded_no_signal: noSignal,
      excluded_not_problem: notProblem,
      excluded_no_usable_text: problems.length - usable.length,
      eligible_discussions: eligible.length,
      selected_wtp_first: wtpPicked.length,
    },
  };
}
