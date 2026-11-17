// Phase A3 constants: deterministic evidence preparation (docs/blueprint-engine/evidence-contract.md sections 3 and 5.3).
//
// Everything the documents already fix is imported from the A2 constants module (the single source of truth) and is NOT redefined here:
// the 400-code-point excerpt cap, the E01-E24 and M01-M16 ranges, the metric catalogue names, and the two-excerpt WTP minimum.
// This module adds only what Phase A3 needs. Each value is tagged DOCUMENTED (written in the approved documents) or
// CHOICE (the documents are silent, so Phase A3 chose a conservative, explicit value; every CHOICE is listed in the PR report).
//
// Runtime-agnostic: no Node or Deno specific API.
import { CAP, EVIDENCE_EXCERPT_MAX_ID, EVIDENCE_METRIC_MAX_ID, METRIC_CATALOGUE_NAMES, SAFEGUARDS, WTP_MIN_EXCERPTS } from './constants.ts';
import type { MetricName } from './contract.ts';

export { EVIDENCE_EXCERPT_MAX_ID, EVIDENCE_METRIC_MAX_ID, METRIC_CATALOGUE_NAMES, WTP_MIN_EXCERPTS };

// ---------------------------------------------------------------------------------------------------------------------------------
// Selection (evidence contract section 3.4)
// ---------------------------------------------------------------------------------------------------------------------------------

/** DOCUMENTED (section 3.4 step 5): excerpt text is cut to 400 Unicode code points. Same value as the A2 index cap. */
export const EXCERPT_MAX_CODE_POINTS = CAP.excerpt;

/** DOCUMENTED (section 3.4 step 4): at most 24 excerpts, so ids run E01-E24. */
export const MAX_EXCERPTS = EVIDENCE_EXCERPT_MAX_ID;

/** DOCUMENTED (section 3.4 step 3): up to 4 willingness-to-pay candidates are taken first. */
export const MAX_WTP_FIRST = 4;

/** DOCUMENTED (section 3.1): excerpt and metric ids are the letter and a zero-padded two-digit number. */
export const excerptId = (n: number): string => `E${String(n).padStart(2, '0')}`;
export const metricId = (n: number): string => `M${String(n).padStart(2, '0')}`;

// ---------------------------------------------------------------------------------------------------------------------------------
// Sufficiency (evidence contract section 3.6). "All tunable constants".
// ---------------------------------------------------------------------------------------------------------------------------------

export const SUFFICIENCY_THRESHOLDS = {
  /** DOCUMENTED: insufficient when unique_discussions is below this (the existing `medium` boundary). */
  minUniqueDiscussions: 4,
  /** DOCUMENTED: insufficient when fewer usable excerpts than this. */
  minUsableExcerpts: 3,
  /** DOCUMENTED: adequate needs at least this many usable excerpts. */
  adequateUsableExcerpts: 8,
  /** DOCUMENTED (`high` confidence rule of dr_refresh_clusters): at least this many discussions ... */
  highConfidenceDiscussions: 10,
  /** ... across at least this many sources. Used only to word the reason when stored confidence is not `high`. */
  highConfidenceSources: 2,
} as const;

/**
 * Fixed backend reason codes and messages. Never model text. The two messages in the section 7 worked example of
 * product-blueprint-v1.md ("fewer than 10 independent discussions", "fewer than 8 usable excerpts") are reproduced exactly.
 */
export const SUFFICIENCY_REASON_MESSAGES = {
  fewer_than_min_discussions: `fewer than ${SUFFICIENCY_THRESHOLDS.minUniqueDiscussions} independent discussions`,
  fewer_than_min_excerpts: `fewer than ${SUFFICIENCY_THRESHOLDS.minUsableExcerpts} usable excerpts`,
  fewer_than_high_discussions: `fewer than ${SUFFICIENCY_THRESHOLDS.highConfidenceDiscussions} independent discussions`,
  fewer_than_high_sources: `fewer than ${SUFFICIENCY_THRESHOLDS.highConfidenceSources} distinct sources`,
  confidence_not_high: 'cluster confidence is not high',
  fewer_than_adequate_excerpts: `fewer than ${SUFFICIENCY_THRESHOLDS.adequateUsableExcerpts} usable excerpts`,
} as const;
export type SufficiencyReasonCode = keyof typeof SUFFICIENCY_REASON_MESSAGES;

// ---------------------------------------------------------------------------------------------------------------------------------
// Metric catalogue (evidence contract section 3.2)
// ---------------------------------------------------------------------------------------------------------------------------------

/** DOCUMENTED (section 3.2 "Rounding for cache stability"). */
export const ROUNDING = {
  growthRatePctStep: 10,   // M03: nearest 10 percentage points
  severityStep: 0.5,       // M09: nearest 0.5
  scoreComponentStep: 5,   // M11-M16: nearest 5
} as const;

/**
 * Numeric domains of the cluster values that are rounded (review finding: out-of-range and extreme finite values must be rejected with a
 * specific error, never reach the rounding and never become a generic internal error).
 *  - severity_avg: DOCUMENTED. dr_problem_signals.severity is `smallint check (severity between 1 and 5)` and severity_avg is its mean (1 to 5).
 *  - score components: DOCUMENTED. dr_refresh_clusters clamps every component to 0-100 (`least(100, ...)`, `greatest(0, ...)`).
 *  - growth_rate (percent): CHOICE. The contract gives no range, so this is a safety bound only: far above anything the formula
 *    `(recent - prior) / greatest(prior, 1) * 100` can produce, and far below the point where rounding could overflow. The formula implies a
 *    floor of -100, which is deliberately NOT enforced here because the documents do not state it as a rule.
 */
export const VALUE_RANGES = {
  severityAvg: { min: 1, max: 5 },
  scoreComponent: { min: 0, max: 100 },
  growthRatePct: { min: -1e12, max: 1e12 },
} as const;

/**
 * Largest magnitude `roundToStep` accepts. Below 2^53 / 10, so dividing by the step and multiplying back is exact enough and can never
 * overflow to Infinity. Every validated input is far inside it.
 */
export const ROUND_MAX_ABS = 1e15;

/** DOCUMENTED (section 3.2): M07 and M08 are rendered as these bucket labels. */
export const COUNT_BUCKETS = ['0', '1-2', '3-5', '6-10', '11+'] as const;
export type CountBucket = (typeof COUNT_BUCKETS)[number];

/**
 * Backend wording for each metric (`label`). The five labels M01-M05 are the ones written in the worked example of product-blueprint-v1.md;
 * the rest follow the same style. Each is at most 200 characters (A2 limit for backend short text).
 */
export const METRIC_LABELS: readonly string[] = [
  'Independent discussions in this cluster',                                     // M01
  'Distinct sources',                                                            // M02
  'Discussion growth, last 30 days versus the 30 before',                        // M03
  'Records with a grounded willingness-to-pay quote',                            // M04
  'Cluster confidence rating',                                                   // M05
  'Sources that have discussions in this cluster',                               // M06
  'Independent discussions published in the last 30 days (bucketed)',            // M07
  'Independent discussions published in the 30 days before that (bucketed)',     // M08
  'Average severity, an AI estimate on a 1 to 5 scale',                          // M09
  'Alternatives named in discussions, with the number of discussions naming each', // M10
  'Score component: problem frequency (0 to 100)',                               // M11
  'Score component: demand growth (0 to 100)',                                   // M12
  'Score component: pain intensity (0 to 100)',                                  // M13
  'Score component: willingness to pay (0 to 100)',                              // M14
  'Score component: competition gap (0 to 100)',                                 // M15
  'Score component: development feasibility (0 to 100)',                         // M16
];

/**
 * CHOICE: the evidence contract says "score_component x6" and "dr_clusters.scores.components.*" without fixing which component is M11..M16.
 * The order below is the order in which dr_refresh_clusters writes them (supabase/migrations/20261104000100_market_intel_functions.sql).
 */
export const SCORE_COMPONENT_KEYS = ['problemFrequency', 'demandGrowth', 'painIntensity', 'willingnessToPay', 'competitionGap', 'developmentFeasibility'] as const;
export type ScoreComponentKey = (typeof SCORE_COMPONENT_KEYS)[number];

/** DOCUMENTED (section 3.2): the component basis vocabulary and how it maps to MetricClass. */
export const COMPONENT_BASIS_TO_CLASS = {
  measured: 'measured',
  evidence_count: 'measured',
  derived: 'derived',
  ai_estimate: 'ai_estimate',
  insufficient_data: 'insufficient_data',
} as const;
export type ScoreComponentBasis = keyof typeof COMPONENT_BASIS_TO_CLASS;

/** A2 limit for a metric value that is a list or a mapping (SAFEGUARDS.metricValueListItems), reused so an index entry can never fail A2. */
export const METRIC_VALUE_MAX_ITEMS = SAFEGUARDS.metricValueListItems;
/** A2 limits on strings inside metric values: list items and mapping values are short text, mapping keys at most 100 characters. */
export const METRIC_VALUE_TEXT_MAX = SAFEGUARDS.backendShortText;
export const METRIC_MAPPING_KEY_MAX = 100;

/** Compile-time guard: the label list and the A2 catalogue describe the same 16 ids. */
export const METRIC_NAMES: readonly MetricName[] = METRIC_CATALOGUE_NAMES;

// ---------------------------------------------------------------------------------------------------------------------------------
// Input safeguards (CHOICE: the documents do not bound the input; these keep one call's work finite and keep every produced
// index entry inside the limits the A2 validator enforces, so a prepared pack can never fail A2 for length reasons)
// ---------------------------------------------------------------------------------------------------------------------------------

export const INPUT_LIMITS = {
  /** Largest number of cluster members accepted in one call. */
  maxMembers: 10_000,
  /** Raw (pre-truncation) excerpt length accepted. The collector stores at most 2,000 (supabase migration). */
  maxRawExcerpt: 10_000,
  /** Matches the A2 limit for index text fields (record id, source id, ...). */
  shortText: SAFEGUARDS.backendShortText,
  /** Matches the A2 limit for index title, licence and attribution. */
  longText: SAFEGUARDS.backendText,
  url: SAFEGUARDS.backendUrl,
  discussionKey: SAFEGUARDS.backendText,
  maxErrors: SAFEGUARDS.maxErrors,
} as const;

// ---------------------------------------------------------------------------------------------------------------------------------
// Grounding guards (evidence contract section 5.3 and 6)
// ---------------------------------------------------------------------------------------------------------------------------------

/** DOCUMENTED (section 5.3 item 1): a name must be 2 to 60 characters to be matched (same bounds as groundedCompetitors in heuristics.ts). */
export const NAME_LENGTH = { min: 2, max: 60 } as const;

/** DOCUMENTED (section 5.3 item 3): content words have at least five letters and are compared by their first five letters. */
export const RELEVANCE = { minWordLetters: 5, stemLetters: 5 } as const;

/**
 * CHOICE: section 5.3 item 3 says "not on a short stop list" and does not list it. These are common function words and verbs of five or
 * more letters. The list is deliberately short; lengthening it would make the relevance floor stricter, not weaker.
 */
export const RELEVANCE_STOP_WORDS: ReadonlySet<string> = new Set([
  'about', 'after', 'again', 'because', 'before', 'being', 'between', 'could', 'doing', 'during', 'either', 'every', 'first', 'found',
  'having', 'hence', 'however', 'itself', 'might', 'other', 'others', 'should', 'since', 'their', 'there', 'these', 'think', 'those',
  'through', 'under', 'until', 'using', 'where', 'whether', 'which', 'while', 'whose', 'would',
]);

/** DOCUMENTED (section 5.3, fourth guard): a claim containing one of these words must cite at least two supporting-grade items. */
export const GENERALISATION_WORDS = ['many', 'most', 'several', 'often', 'commonly', 'repeatedly', 'everyone', 'always', 'never', 'all'] as const;
export const GENERALISATION_MIN_SUPPORTING_ITEMS = 2;

/**
 * DOCUMENTED (section 6): willingness-to-pay text "may not state a price, a budget, a conversion rate or a share of users". The word lists
 * below feed the lexical detector in evidence-grounding.ts; see the limits documented there.
 */
export const CURRENCY_SYMBOLS = '$€£¥₹₦₩₽₺฿₴₫₵₲₪₡';
export const CURRENCY_CODES = ['USD', 'EUR', 'GBP', 'ZMW', 'ZMK', 'KES', 'NGN', 'ZAR', 'INR', 'JPY', 'CNY', 'AUD', 'CAD', 'CHF', 'BWP', 'TZS', 'UGX', 'GHS'] as const;
export const CURRENCY_WORDS = ['dollar', 'dollars', 'euro', 'euros', 'pound', 'pounds', 'kwacha', 'cent', 'cents', 'buck', 'bucks', 'rand', 'shilling', 'shillings', 'naira'] as const;
/** Number words, so "fifty dollars" and "one in five" are seen as well as "50 dollars" and "1 in 5". */
export const NUMBER_WORDS = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen',
  'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety',
  'hundred', 'thousand', 'million', 'dozen', 'couple', 'few',
] as const;
/** Groups of people a share can be stated about ("most users", "all of the teams"). "some" and "several" are deliberately absent: "some authors said they would pay" is the one thing the text may say. */
export const POPULATION_NOUNS = [
  'authors', 'users', 'people', 'teams', 'customers', 'respondents', 'developers', 'maintainers', 'businesses', 'companies', 'commenters',
  'posters', 'owners', 'managers', 'participants', 'discussions', 'posts', 'founders', 'engineers', 'readers', 'buyers',
] as const;
