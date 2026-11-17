// Grounding-check helpers required by the evidence contract (sections 3.3, 5.3 and 6).
//
// Six independent guards. Each is a small pure function over a GroundingContext, which is built from the model-facing pack (what the model
// actually saw, for this request), never from the live database:
//
//   1. isSupportingGrade / checkSupportingGrade   section 3.3   which cited items may support a verified_evidence claim
//   2. checkNameGrounding                         section 5.3.1 a named alternative must appear in a cited excerpt
//   3. checkNumericGrounding                      section 5.3.2 every numeral must appear in cited evidence
//   4. checkRelevanceFloor                        section 5.3.3 a real id must not sit beside an unrelated sentence
//   5. checkGeneralisation                        section 5.3   "many/most/..." needs two supporting items
//   6. checkWtpEvidence                           section 6     "evidenced" needs two independent flagged excerpts, and no price or share
//
// They are deliberately NOT combined into one function: which guard runs when, and what happens on failure (the documented repair), belongs to
// the later verifier phase. This module only answers "does this guard pass?" with a fixed reason code and never echoes the text it was given.
//
// WHAT THESE CHECKS ARE NOT. They are lexical. They catch invention (a name, a number or a topic that is nowhere in the cited evidence), not
// misreading. Passing every guard does NOT prove that an excerpt says what the claim says (evidence contract section 10). Known limits:
//   - Names: a case-insensitive SUBSTRING match, as in the existing groundedCompetitors, so a short name ("Go") can match inside another word.
//     Only excerpt text counts; a name present only in the competitor_mentions metric (M10) does not ground an alternative.
//   - Numbers: numerals are compared as whole tokens (60 does not match 600), but number WORDS ("three", "half") are not checked at all, and a
//     bucket label such as "3-5" (M07, M08) or a rounded value (M09, M11-M16) contains numerals that can ground a figure that is not the exact count.
//     Only supporting-grade items ground a number: an AI-estimate metric never does.
//   - Relevance: one shared word stem is enough. It blocks the cheapest failure only, and it assumes a script that separates words with spaces
//     (an unspaced script such as Chinese yields arbitrary five-character "words").
//   - Generalisation: a fixed English word list. A paraphrase of "many" is not detected.
//   - Price, budget, conversion rate and share (WTP): detected by wording, in the families listed on `findPriceOrShareStatements`: currency
//     amounts (symbols, codes, currency words, spelled-out amounts such as "fifty dollars"), percentages, billing rates ("10/month"), the words
//     price/pricing/fee, the word budget in any form, conversion wording ("conversion rate", "convert to paid", "trial-to-paid"), and shares
//     ("2 in 10", "1/3", "half of", "the majority", "most users", "a share of"). The detector fails CLOSED: it also flags harmless mentions
//     ("a third-party fee schedule is unclear"), which only costs an `evidenced` status. It does NOT detect: an amount in words with no
//     currency word ("a few hundred a month"), vague price level ("cheap", "expensive", "premium"), a pricing model without a figure
//     ("per seat"), a share in an unlisted phrasing ("a good chunk of them"), other languages, or a statement spread across two sentences.
//     It cannot prove the text says ONLY that some authors said they would pay; it catches the listed shapes of saying more.
import type { Basis, MetricClass, MetricEvidence } from './contract.ts';
import {
  CURRENCY_CODES, CURRENCY_SYMBOLS, CURRENCY_WORDS, GENERALISATION_MIN_SUPPORTING_ITEMS, GENERALISATION_WORDS, NAME_LENGTH, NUMBER_WORDS,
  POPULATION_NOUNS, RELEVANCE, RELEVANCE_STOP_WORDS, WTP_MIN_EXCERPTS,
} from './evidence-constants.ts';
import type { EvidencePack } from './evidence-types.ts';

// ---------------------------------------------------------------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------------------------------------------------------------

export type GroundingItem =
  | { kind: 'excerpt'; id: string; title: string | null; text: string; wtp: boolean }
  | { kind: 'metric'; id: string; evidence_class: MetricClass; rendered: string };

export type GroundingContext = ReadonlyMap<string, GroundingItem>;

/** The text a metric contributes to the numbers guard: its value as written in the pack. */
export function renderMetricValue(value: MetricEvidence['value']): string {
  if (value === null) return '';
  if (Array.isArray(value)) return value.join(' ');
  if (typeof value === 'object') return Object.keys(value).sort().map((k) => `${k} ${value[k]}`).join(' ');
  return String(value);
}

export function buildGroundingContext(pack: EvidencePack): GroundingContext {
  const ctx = new Map<string, GroundingItem>();
  for (const e of pack.excerpts) ctx.set(e.id, { kind: 'excerpt', id: e.id, title: e.title, text: e.text, wtp: e.wtp });
  for (const m of pack.metrics) ctx.set(m.id, { kind: 'metric', id: m.id, evidence_class: m.evidence_class, rendered: renderMetricValue(m.value) });
  return ctx;
}

export type GuardReason =
  | 'ok' | 'not_applicable'
  | 'no_supporting_grade_item'
  | 'name_length_out_of_range' | 'name_not_in_cited_excerpts'
  | 'numeral_not_in_cited_evidence'
  | 'no_content_words' | 'no_shared_content_word'
  | 'generalisation_needs_two_supporting_items'
  | 'wtp_basis_not_verified' | 'wtp_needs_two_flagged_excerpts' | 'wtp_text_states_figure';

export interface GuardResult { passed: boolean; reason: GuardReason }

const pass = (reason: GuardReason = 'ok'): GuardResult => ({ passed: true, reason });
const fail = (reason: GuardReason): GuardResult => ({ passed: false, reason });

/** Distinct ids, in first-seen order, that exist in the pack. An id the pack never issued resolves to nothing. */
function resolvable(ctx: GroundingContext, refs: readonly string[]): GroundingItem[] {
  const out: GroundingItem[] = [];
  const seen = new Set<string>();
  for (const id of refs) {
    if (typeof id !== 'string' || seen.has(id)) continue;
    seen.add(id);
    const item = ctx.get(id);
    if (item) out.push(item);
  }
  return out;
}

const supporting = (item: GroundingItem): boolean => item.kind === 'excerpt' || item.evidence_class === 'measured' || item.evidence_class === 'derived';

// ---------------------------------------------------------------------------------------------------------------------------------
// 1. Supporting grade (section 3.3)
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * An excerpt may support a claim about what an author said. A metric of class measured or derived may support counts, breadth, recency and
 * naming of alternatives. A metric of class ai_estimate or insufficient_data supports NOTHING. An unknown id supports nothing.
 */
export function isSupportingGrade(ctx: GroundingContext, id: string): boolean {
  const item = ctx.get(id);
  return item !== undefined && supporting(item);
}

/** A verified_evidence claim needs at least one supporting-grade item among its references. */
export function checkSupportingGrade(ctx: GroundingContext, refs: readonly string[]): GuardResult {
  return resolvable(ctx, refs).some(supporting) ? pass() : fail('no_supporting_grade_item');
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 2. Name grounding (section 5.3.1)
// ---------------------------------------------------------------------------------------------------------------------------------

/** The tolerant normalisation of the existing matcher (collector/heuristics.ts `norm`): lower case, straight quotes, one space. A test asserts agreement. */
export function normaliseForMatch(s: string): string {
  return s.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, ' ').trim();
}

/** For `Alternative.kind = named_in_evidence`: the name must appear in the text of at least one cited EXCERPT. */
export function checkNameGrounding(ctx: GroundingContext, name: string, refs: readonly string[]): GuardResult {
  if (typeof name !== 'string') return fail('name_length_out_of_range');
  const trimmed = name.trim();
  if (trimmed.length < NAME_LENGTH.min || trimmed.length > NAME_LENGTH.max) return fail('name_length_out_of_range');
  const needle = normaliseForMatch(trimmed);
  for (const item of resolvable(ctx, refs)) {
    if (item.kind === 'excerpt' && normaliseForMatch(item.text).includes(needle)) return pass();
  }
  return fail('name_not_in_cited_excerpts');
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 3. Numeric grounding (section 5.3.2)
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * Numerals as whole tokens: a run of decimal digits with optional internal "." or "," groups, after NFKC folding (so full-width digits count).
 * Commas are removed so "1,000" and "1000" are the same numeral. "60%" gives "60". Digits inside an identifier ("Q3", "E01") count too.
 */
export function extractNumerals(text: string): string[] {
  return (text.normalize('NFKC').match(/\p{Nd}+(?:[.,]\p{Nd}+)*/gu) ?? []).map((t) => t.replace(/,/g, ''));
}

/**
 * Every numeral in `claimText` must appear in the text of a cited excerpt or in the rendered value of a cited metric. Only SUPPORTING-GRADE
 * items count: an AI-estimate or insufficient-data metric can never ground a number (section 3.3).
 */
export function checkNumericGrounding(ctx: GroundingContext, claimText: string, refs: readonly string[]): GuardResult {
  const wanted = extractNumerals(claimText);
  if (wanted.length === 0) return pass();
  const known = new Set<string>();
  for (const item of resolvable(ctx, refs)) {
    if (!supporting(item)) continue;
    for (const n of extractNumerals(item.kind === 'excerpt' ? item.text : item.rendered)) known.add(n);
  }
  return wanted.every((n) => known.has(n)) ? pass() : fail('numeral_not_in_cited_evidence');
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 4. Relevance floor (section 5.3.3)
// ---------------------------------------------------------------------------------------------------------------------------------

/** Content-word stems: words of at least five letters that are not stop words, cut to their first five letters, lower case. */
export function contentStems(text: string): Set<string> {
  const stems = new Set<string>();
  for (const word of text.normalize('NFKC').toLowerCase().match(/\p{L}+/gu) ?? []) {
    const letters = Array.from(word);
    if (letters.length < RELEVANCE.minWordLetters || RELEVANCE_STOP_WORDS.has(word)) continue;
    stems.add(letters.slice(0, RELEVANCE.stemLetters).join(''));
  }
  return stems;
}

/**
 * When a claim cites any excerpt, at least one of its content-word stems must occur in the cited excerpts' titles and text. A claim with no
 * content word at all cannot satisfy "at least one stem occurs" and fails. A claim that cites no excerpt (metrics only) is not subject to it.
 */
export function checkRelevanceFloor(ctx: GroundingContext, claimText: string, refs: readonly string[]): GuardResult {
  const excerpts = resolvable(ctx, refs).filter((i): i is Extract<GroundingItem, { kind: 'excerpt' }> => i.kind === 'excerpt');
  if (excerpts.length === 0) return pass('not_applicable');
  const claimStems = contentStems(claimText);
  if (claimStems.size === 0) return fail('no_content_words');
  const evidenceStems = new Set<string>();
  for (const e of excerpts) for (const s of contentStems(`${e.title ?? ''} ${e.text}`)) evidenceStems.add(s);
  for (const s of claimStems) if (evidenceStems.has(s)) return pass();
  return fail('no_shared_content_word');
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 5. Generalisation guard (section 5.3, fourth guard)
// ---------------------------------------------------------------------------------------------------------------------------------

const WORD_EDGE_BEFORE = '(?<![\\p{L}\\p{N}_])';
const WORD_EDGE_AFTER = '(?![\\p{L}\\p{N}_])';
const GENERALISATION = new RegExp(`${WORD_EDGE_BEFORE}(?:${GENERALISATION_WORDS.join('|')})${WORD_EDGE_AFTER}`, 'iu');

export const containsGeneralisation = (text: string): boolean => GENERALISATION.test(text.normalize('NFKC'));

/** A claim with a generalising word must cite at least two distinct supporting-grade items. One excerpt supports "one maintainer says", not "many". */
export function checkGeneralisation(ctx: GroundingContext, claimText: string, refs: readonly string[]): GuardResult {
  if (!containsGeneralisation(claimText)) return pass();
  const n = resolvable(ctx, refs).filter(supporting).length;
  return n >= GENERALISATION_MIN_SUPPORTING_ITEMS ? pass() : fail('generalisation_needs_two_supporting_items');
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 6. Willingness to pay (section 6)
// ---------------------------------------------------------------------------------------------------------------------------------

export type PriceOrShareKind = 'currency' | 'percentage' | 'billing_rate' | 'price_word' | 'budget' | 'conversion' | 'share';

const SYMBOL = `[${CURRENCY_SYMBOLS}]`;
const CODE = `\\b(?:${CURRENCY_CODES.join('|')})\\b`;
const CURRENCY_WORD = `(?:${CURRENCY_WORDS.join('|')})`;
const NUM = `\\b(?:${NUMBER_WORDS.join('|')})\\b`;
const POPULATION = `(?:${POPULATION_NOUNS.join('|')})`;

/** Families of statements the willingness-to-pay text may not make (section 6). All are tested on NFKC-folded text, case-insensitively. */
const PRICE_OR_SHARE: readonly (readonly [PriceOrShareKind, readonly RegExp[]])[] = [
  ['currency', [
    new RegExp(`${SYMBOL}\\s?\\p{Nd}|\\p{Nd}\\s?${SYMBOL}`, 'u'),                                  // $20, 20$, €5
    new RegExp(`${CODE}\\s?\\p{Nd}|\\p{Nd}\\s?${CODE}`, 'iu'),                                     // USD 20, 20 zmw
    new RegExp(`\\p{Nd}[\\p{Nd}.,]*\\s*${CURRENCY_WORD}\\b`, 'iu'),                                // 20 dollars, 5 kwacha
    new RegExp(`${NUM}\\s+${CURRENCY_WORD}\\b`, 'iu'),                                              // fifty dollars, a few bucks
  ]],
  ['percentage', [
    /%|\bper\s?cent(?:age)?\b|\bpercent(?:age)?\b|\bpct\b/iu,                                     // 60%, percent, per cent, percentage
  ]],
  ['billing_rate', [
    /\p{Nd}[\p{Nd}.,]*\s*(?:\/|per\s+)\s*(?:mo|month|mth|yr|year|annum|seat|user|licen[cs]e|week|day|hour)\b/iu, // 10/month, 5 per seat
    /\b(?:monthly|annual|yearly|weekly|daily|one[\s-]time)\s+(?:fee|price|cost|rate|payment|subscription)s?\b/iu,    // monthly fee
  ]],
  ['price_word', [
    /\b(?:price|prices|priced|pricing|pricey|fee|fees)\b/iu,                                          // "at a reasonable price", "pricing"
  ]],
  ['budget', [
    /\bbudget(?:s|ed|ing|ary)?\b/iu,                                                                   // budget, budgeted, "budget approved"
  ]],
  ['conversion', [
    /\bconversions?\b/iu,                                                                              // conversion, conversion rate
    /\bconvert(?:s|ed|ing)?\s+(?:to|into)\s+(?:paid|paying|customers?|subscribers?|buyers?|users?|premium|pro)\b/iu,
    /\b(?:trial|free|freemium)[\s-]+to[\s-]+(?:paid|paying|premium|pro)\b/iu,                        // trial-to-paid
    /\b(?:upgrade|purchase|signup|sign[\s-]?up|close|win|take|activation|checkout|click[\s-]?through|opt[\s-]?in)[\s-]+rates?\b/iu,
  ]],
  ['share', [
    /\p{Nd}+\s*(?:in|out\s+of(?:\s+every)?|of\s+every)\s*\p{Nd}+/iu,                                            // 2 in 10, 3 out of 5, 1 of every 4
    /\p{Nd}+\s*\/\s*\p{Nd}+/u,                                                                      // 1/3
    new RegExp(`${NUM}\\s+(?:in|out\\s+of(?:\\s+every)?|of\\s+every)\\s+(?:a\\s+|an\\s+)?(?:${NUM}|\\p{Nd}+)`, 'iu'), // one in five, two out of three
    /\b(?:half|thirds?|quarters?|fifths?|tenths?)\s+of\b|\bhalf\s+(?:the|my|our|all)\b/iu,           // half of, a third of, two thirds of
    /\b(?:majority|minority)\b/iu,                                                                     // the majority, a minority
    new RegExp(`\\b(?:most|nearly\\s+all|almost\\s+all|virtually\\s+all|all)\\s+(?:of\\s+)?(?:the\\s+)?${POPULATION}\\b`, 'iu'), // most users, all of the teams
    /\b(?:share|proportion|fraction|portion|ratio)\s+of\b/iu,                                         // a share of users
  ]],
];

/**
 * The families of price, budget, conversion-rate or share statement found in the text, in a fixed order (empty if none). Content-free: it
 * names the family, never the words. Lexical only; see the limits in the header of this file.
 */
export function findPriceOrShareStatements(text: string): PriceOrShareKind[] {
  const t = text.normalize('NFKC');
  return PRICE_OR_SHARE.filter(([, patterns]) => patterns.some((re) => re.test(t))).map(([kind]) => kind);
}

/** True when the text states a price, a budget, a conversion rate or a share (or a currency amount or percentage). Lexical; see the header. */
export const statesPriceOrShare = (text: string): boolean => findPriceOrShareStatements(text).length > 0;

export interface WtpRuleInput {
  status: 'evidenced' | 'not_evidenced' | 'unknown';
  basis: Basis;
  evidence_refs: readonly string[];
  text: string;
}

export interface WtpRuleResult extends GuardResult {
  /** Distinct cited excerpts that carry wtp: true. */
  flagged_excerpts: number;
}

/**
 * `status: "evidenced"` is acceptable only if the summary is verified_evidence AND cites at least two distinct excerpts that both carry
 * wtp: true (the pack holds one excerpt per discussion, so two excerpts are two independent discussions) AND the text states no price, budget,
 * conversion rate or share (see `findPriceOrShareStatements`). One quote is deliberately not enough. For any other status the rule does not apply (the canonical `unknown`
 * replacement belongs to the verifier).
 *
 * The no-price rule is checked here on its own because evidence contract section 6 justifies it with "no pack item contains one", which is
 * not guaranteed: an excerpt can contain "$20", and the numbers guard would then let a claim repeat it.
 */
export function checkWtpEvidence(ctx: GroundingContext, input: WtpRuleInput): WtpRuleResult {
  const flagged = resolvable(ctx, input.evidence_refs).filter((i) => i.kind === 'excerpt' && i.wtp).length;
  if (input.status !== 'evidenced') return { passed: true, reason: 'not_applicable', flagged_excerpts: flagged };
  if (input.basis !== 'verified_evidence') return { passed: false, reason: 'wtp_basis_not_verified', flagged_excerpts: flagged };
  if (flagged < WTP_MIN_EXCERPTS) return { passed: false, reason: 'wtp_needs_two_flagged_excerpts', flagged_excerpts: flagged };
  if (statesPriceOrShare(input.text)) return { passed: false, reason: 'wtp_text_states_figure', flagged_excerpts: flagged };
  return { passed: true, reason: 'ok', flagged_excerpts: flagged };
}
