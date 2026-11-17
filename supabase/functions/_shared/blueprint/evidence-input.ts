// Strict validation of the evidence-preparation input.
//
// Same rules as the A2 validator (reliability document sections 4.1 and 4.4), applied to database rows instead of model output:
//  - Nothing is coerced, defaulted or silently dropped. A malformed input is rejected as a whole, listing every problem found (up to a cap).
//  - Diagnostics are content-free: `path` is built from OUR field names and array indexes, `message` is fixed text. No value, key name or
//    text from the input is ever echoed (a record's text is untrusted and may be private).
//  - It never throws. The caller wraps the whole run as well, because an exotic object (a getter that throws) must become a rejection.
//
// What is NOT an error: a record whose excerpt is empty or null (the column is nullable) is a legitimate record that simply cannot be
// shown as evidence; selection counts it as excluded. Unknown extra fields on a row are ignored and never copied (database rows carry
// columns this module must not forward, such as author_ref).
import { FORMAT } from './constants.ts';
import {
  COMPONENT_BASIS_TO_CLASS, EXCERPT_MAX_CODE_POINTS, INPUT_LIMITS, METRIC_MAPPING_KEY_MAX, METRIC_VALUE_MAX_ITEMS, SCORE_COMPONENT_KEYS,
} from './evidence-constants.ts';
import type { ScoreComponentBasis } from './evidence-constants.ts';
import type { PrepareError, PrepareErrorCode } from './evidence-types.ts';
import { codePointLength, hasDisallowedCharacters, isoToEpochMs, normaliseWhitespace, truncateCodePoints } from './evidence-text.ts';
import type { Level3 } from './contract.ts';

const LEVELS: readonly Level3[] = ['low', 'medium', 'high'];
const ANALYSIS_METHODS = ['llm', 'heuristic'] as const;
const NUMERIC_TEXT = /^-?[0-9]+(\.[0-9]+)?$/;

type Rec = Record<string, unknown>;
const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const own = (o: Rec, k: string): unknown => (Object.prototype.hasOwnProperty.call(o, k) ? o[k] : undefined);
const has = (o: Rec, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
const at = (p: string, k: string | number): string => `${p}/${String(k).replace(/~/g, '~0').replace(/\//g, '~1')}`;

// ---------------------------------------------------------------------------------------------------------------------------------
// Validated shapes (internal to the module)
// ---------------------------------------------------------------------------------------------------------------------------------

export interface ValidComponent { value: number | null; basis: ScoreComponentBasis }

export interface ValidCluster {
  id: string;
  title: string;
  industry: string | null;
  unique_discussions: number;
  source_count: number;
  sources: string[];
  recent_discussions: number;
  prior_discussions: number;
  growth_rate: number | null;
  severity_avg: number | null;
  wtp_signals: number;
  /** Own entries only, as [name, count] pairs in input order (the metric builder sorts them). */
  competitors: [string, number][];
  confidence: Level3;
  /** Indexed like SCORE_COMPONENT_KEYS; null = the component is absent. */
  components: (ValidComponent | null)[];
}

export interface ValidMember {
  id: string;
  source_id: string;
  discussion_key: string;
  kind: string;
  url: string;
  /** Whitespace-normalised; null when absent or blank. */
  title: string | null;
  /** Whitespace-normalised and cut to 400 code points. May be empty (not usable as evidence). */
  text: string;
  published_ms: number | null;
  /** Sum of the numeric values of the engagement object. Ranking only; never forwarded. */
  engagement: number;
  license: string;
  attribution: string | null;
  content_hash: string;
  signal: { is_problem: boolean; wtp_evidence: boolean; analysis_method: (typeof ANALYSIS_METHODS)[number] } | null;
}

export type InputResult =
  | { ok: true; cluster: ValidCluster; members: ValidMember[] }
  | { ok: false; errors: PrepareError[] };

// ---------------------------------------------------------------------------------------------------------------------------------
// Collector and readers
// ---------------------------------------------------------------------------------------------------------------------------------

class Errs {
  readonly list: PrepareError[] = [];
  get full(): boolean { return this.list.length >= INPUT_LIMITS.maxErrors; }
  err(code: PrepareErrorCode, path: string, message: string): void {
    if (!this.full) this.list.push({ code, path, message });
  }
}

function readText(c: Errs, path: string, v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') { c.err('invalid_type', path, 'Expected a string.'); return undefined; }
  let ok = true;
  if (hasDisallowedCharacters(v)) { c.err('string_invalid_characters', path, 'The text contains control characters or an unpaired surrogate.'); ok = false; }
  if (v.trim().length === 0) { c.err('string_blank', path, 'The text is empty or only whitespace.'); ok = false; }
  if (codePointLength(v) > max) { c.err('string_too_long', path, `The text is longer than ${max} characters.`); ok = false; }
  return ok ? v : undefined;
}

function readNullableText(c: Errs, path: string, v: unknown, max: number): string | null | undefined {
  if (v === null) return null;
  return readText(c, path, v, max);
}

function readCount(c: Errs, path: string, v: unknown): number | undefined {
  if (typeof v !== 'number') { c.err('invalid_type', path, 'Expected a number.'); return undefined; }
  if (!Number.isInteger(v) || v < 0 || v > Number.MAX_SAFE_INTEGER) { c.err('number_out_of_range', path, 'Expected a whole number of at least 0.'); return undefined; }
  return v;
}

function readFiniteOrNull(c: Errs, path: string, v: unknown): number | null | undefined {
  if (v === null) return null;
  if (typeof v !== 'number') { c.err('invalid_type', path, 'Expected a number or null.'); return undefined; }
  if (!Number.isFinite(v)) { c.err('number_out_of_range', path, 'Expected a finite number.'); return undefined; }
  return v;
}

function readBool(c: Errs, path: string, v: unknown): boolean | undefined {
  if (typeof v !== 'boolean') { c.err('invalid_type', path, 'Expected true or false.'); return undefined; }
  return v;
}

function required(c: Errs, o: Rec, path: string, keys: readonly string[]): boolean {
  let ok = true;
  for (const k of keys) if (!has(o, k)) { c.err('missing_required_field', at(path, k), 'A required field is missing.'); ok = false; }
  return ok;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Cluster
// ---------------------------------------------------------------------------------------------------------------------------------

const CLUSTER_FIELDS = ['id', 'title', 'industry', 'unique_discussions', 'source_count', 'sources', 'recent_discussions', 'prior_discussions',
  'growth_rate', 'severity_avg', 'wtp_signals', 'competitors', 'confidence'] as const;

function readCluster(c: Errs, v: unknown): ValidCluster | undefined {
  const p = '/cluster';
  if (!isRec(v)) { c.err('invalid_type', p, 'Expected an object.'); return undefined; }
  if (!required(c, v, p, CLUSTER_FIELDS)) return undefined;
  const before = c.list.length;

  const id = readText(c, at(p, 'id'), own(v, 'id'), INPUT_LIMITS.shortText);
  const title = readText(c, at(p, 'title'), own(v, 'title'), INPUT_LIMITS.longText);
  const industry = readNullableText(c, at(p, 'industry'), own(v, 'industry'), INPUT_LIMITS.shortText);
  const unique = readCount(c, at(p, 'unique_discussions'), own(v, 'unique_discussions'));
  const sourceCount = readCount(c, at(p, 'source_count'), own(v, 'source_count'));
  const recent = readCount(c, at(p, 'recent_discussions'), own(v, 'recent_discussions'));
  const prior = readCount(c, at(p, 'prior_discussions'), own(v, 'prior_discussions'));
  const growth = readFiniteOrNull(c, at(p, 'growth_rate'), own(v, 'growth_rate'));
  const severity = readFiniteOrNull(c, at(p, 'severity_avg'), own(v, 'severity_avg'));
  const wtp = readCount(c, at(p, 'wtp_signals'), own(v, 'wtp_signals'));

  const rawConfidence = own(v, 'confidence');
  let confidence: Level3 | undefined;
  if (typeof rawConfidence !== 'string') c.err('invalid_type', at(p, 'confidence'), 'Expected a string.');
  else if (!(LEVELS as readonly string[]).includes(rawConfidence)) c.err('invalid_enum', at(p, 'confidence'), 'The value is not one of the allowed values.');
  else confidence = rawConfidence as Level3;

  const sources: string[] = [];
  const rawSources = own(v, 'sources');
  if (!Array.isArray(rawSources)) c.err('invalid_type', at(p, 'sources'), 'Expected a list.');
  else if (rawSources.length > METRIC_VALUE_MAX_ITEMS) c.err('list_too_long', at(p, 'sources'), `The list allows at most ${METRIC_VALUE_MAX_ITEMS} entries.`);
  else rawSources.forEach((s, i) => { const t = readText(c, at(at(p, 'sources'), i), s, INPUT_LIMITS.shortText); if (t !== undefined) sources.push(t); });

  const competitors: [string, number][] = [];
  const rawCompetitors = own(v, 'competitors');
  if (!isRec(rawCompetitors)) c.err('invalid_type', at(p, 'competitors'), 'Expected an object.');
  else {
    const keys = Object.keys(rawCompetitors);
    if (keys.length > INPUT_LIMITS.maxMembers) c.err('list_too_long', at(p, 'competitors'), `The mapping allows at most ${INPUT_LIMITS.maxMembers} entries.`);
    else {
      let badKeys = 0;
      let badCounts = 0;
      for (const k of keys) {
        const n = rawCompetitors[k];
        const keyOk = k.trim().length > 0 && k.length <= METRIC_MAPPING_KEY_MAX && !hasDisallowedCharacters(k);
        const countOk = typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= Number.MAX_SAFE_INTEGER;
        if (!keyOk) badKeys++;
        if (!countOk) badCounts++;
        if (keyOk && countOk) competitors.push([k, n as number]);
      }
      // Counts only: a competitor name is third-party text and is never echoed.
      if (badKeys > 0) c.err('string_invalid_characters', at(p, 'competitors'), `${badKeys} name(s) are blank, too long or contain invalid characters.`);
      if (badCounts > 0) c.err('number_out_of_range', at(p, 'competitors'), `${badCounts} count(s) are not whole numbers of at least 0.`);
    }
  }

  // scores.components.<key>.{value,basis}. A cluster that was never refreshed has scores = {} : every component is then simply absent.
  const components: (ValidComponent | null)[] = SCORE_COMPONENT_KEYS.map(() => null);
  const rawScores = own(v, 'scores');
  if (rawScores !== undefined && rawScores !== null) {
    if (!isRec(rawScores)) c.err('invalid_type', at(p, 'scores'), 'Expected an object or null.');
    else {
      const rawComponents = own(rawScores, 'components');
      if (rawComponents !== undefined && rawComponents !== null) {
        if (!isRec(rawComponents)) c.err('invalid_type', at(at(p, 'scores'), 'components'), 'Expected an object or null.');
        else SCORE_COMPONENT_KEYS.forEach((key, i) => {
          const comp = own(rawComponents, key);
          if (comp === undefined || comp === null) return;
          const cp = at(at(at(p, 'scores'), 'components'), key);
          if (!isRec(comp)) { c.err('invalid_type', cp, 'Expected an object.'); return; }
          if (!required(c, comp, cp, ['value', 'basis'])) return;
          const value = readFiniteOrNull(c, at(cp, 'value'), own(comp, 'value'));
          const rawBasis = own(comp, 'basis');
          let basis: ScoreComponentBasis | undefined;
          if (typeof rawBasis !== 'string') c.err('invalid_type', at(cp, 'basis'), 'Expected a string.');
          else if (!Object.prototype.hasOwnProperty.call(COMPONENT_BASIS_TO_CLASS, rawBasis)) c.err('invalid_enum', at(cp, 'basis'), 'The value is not one of the allowed values.');
          else basis = rawBasis as ScoreComponentBasis;
          if (value === undefined || basis === undefined) return;
          // A component whose basis says "no data" cannot also carry a value.
          if (basis === 'insufficient_data' && value !== null) { c.err('inconsistent_component', cp, 'A component with basis insufficient_data must have a null value.'); return; }
          components[i] = { value, basis };
        });
      }
    }
  }

  if (c.list.length > before) return undefined;
  return {
    id: id as string, title: title as string, industry: industry as string | null, unique_discussions: unique as number,
    source_count: sourceCount as number, sources, recent_discussions: recent as number, prior_discussions: prior as number,
    growth_rate: growth as number | null, severity_avg: severity as number | null, wtp_signals: wtp as number, competitors,
    confidence: confidence as Level3, components,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------------------------------------------------------------

const RECORD_FIELDS = ['id', 'source_id', 'discussion_key', 'kind', 'url', 'title', 'excerpt', 'published_at', 'engagement', 'license', 'attribution', 'content_hash'] as const;
const SIGNAL_FIELDS = ['is_problem', 'wtp_evidence', 'analysis_method'] as const;

/** Sum of the numeric values of an engagement object, as dr_refresh_clusters does (non-numeric values are ignored). */
function engagementTotal(o: Rec): number {
  let sum = 0;
  for (const k of Object.keys(o)) {
    const v = o[k];
    if (typeof v === 'number' && Number.isFinite(v)) sum += v;
    else if (typeof v === 'string' && NUMERIC_TEXT.test(v)) sum += Number(v);
  }
  return Number.isFinite(sum) ? sum : Number.MAX_VALUE;
}

function readMember(c: Errs, p: string, v: unknown): ValidMember | undefined {
  if (!isRec(v)) { c.err('invalid_type', p, 'Expected an object.'); return undefined; }
  if (!required(c, v, p, ['record', 'signal'])) return undefined;
  const before = c.list.length;
  const rp = at(p, 'record');
  const r = own(v, 'record');
  if (!isRec(r)) { c.err('invalid_type', rp, 'Expected an object.'); return undefined; }
  if (!required(c, r, rp, RECORD_FIELDS)) return undefined;

  const id = readText(c, at(rp, 'id'), own(r, 'id'), INPUT_LIMITS.shortText);
  const sourceId = readText(c, at(rp, 'source_id'), own(r, 'source_id'), INPUT_LIMITS.shortText);
  const discussionKey = readText(c, at(rp, 'discussion_key'), own(r, 'discussion_key'), INPUT_LIMITS.discussionKey);
  const kind = readText(c, at(rp, 'kind'), own(r, 'kind'), INPUT_LIMITS.shortText);
  const license = readText(c, at(rp, 'license'), own(r, 'license'), INPUT_LIMITS.longText);

  const rawUrl = own(r, 'url');
  let url: string | undefined;
  if (typeof rawUrl !== 'string') c.err('invalid_type', at(rp, 'url'), 'Expected a string.');
  else if (rawUrl.length > INPUT_LIMITS.url || !FORMAT.httpUrl.test(rawUrl) || hasDisallowedCharacters(rawUrl)) c.err('invalid_format', at(rp, 'url'), `Expected an http(s) URL of at most ${INPUT_LIMITS.url} characters.`);
  else url = rawUrl;

  const rawHash = own(r, 'content_hash');
  let contentHash: string | undefined;
  if (typeof rawHash !== 'string') c.err('invalid_type', at(rp, 'content_hash'), 'Expected a string.');
  else if (!FORMAT.sha256Hex.test(rawHash)) c.err('invalid_format', at(rp, 'content_hash'), 'Expected a SHA-256 value written as 64 hexadecimal characters.');
  else contentHash = rawHash;

  // Title: nullable. Whitespace is normalised exactly like the excerpt; a title that is blank after that is treated as absent.
  const rawTitle = own(r, 'title');
  let title: string | null | undefined;
  if (rawTitle === null) title = null;
  else if (typeof rawTitle !== 'string') c.err('invalid_type', at(rp, 'title'), 'Expected a string or null.');
  else if (codePointLength(rawTitle) > INPUT_LIMITS.longText) c.err('string_too_long', at(rp, 'title'), `The text is longer than ${INPUT_LIMITS.longText} characters.`);
  else {
    const t = normaliseWhitespace(rawTitle);
    if (hasDisallowedCharacters(t)) c.err('string_invalid_characters', at(rp, 'title'), 'The text contains control characters or an unpaired surrogate.');
    else title = t.length === 0 ? null : t;
  }

  // Excerpt: nullable and may be blank (then the record cannot be shown as evidence). Normalised, then cut to 400 code points.
  const rawExcerpt = own(r, 'excerpt');
  let text: string | undefined;
  if (rawExcerpt === null) text = '';
  else if (typeof rawExcerpt !== 'string') c.err('invalid_type', at(rp, 'excerpt'), 'Expected a string or null.');
  else if (rawExcerpt.length > INPUT_LIMITS.maxRawExcerpt) c.err('string_too_long', at(rp, 'excerpt'), `The text is longer than ${INPUT_LIMITS.maxRawExcerpt} characters.`);
  else {
    const t = normaliseWhitespace(rawExcerpt);
    if (hasDisallowedCharacters(t)) c.err('string_invalid_characters', at(rp, 'excerpt'), 'The text contains control characters or an unpaired surrogate.');
    else text = truncateCodePoints(t, EXCERPT_MAX_CODE_POINTS);
  }

  const rawPublished = own(r, 'published_at');
  let publishedMs: number | null | undefined;
  if (rawPublished === null) publishedMs = null;
  else if (typeof rawPublished !== 'string') c.err('invalid_type', at(rp, 'published_at'), 'Expected a string or null.');
  else {
    const t = isoToEpochMs(rawPublished);
    if (t === null) c.err('invalid_format', at(rp, 'published_at'), 'Expected an ISO 8601 date and time with a time zone, for example 2026-01-31T09:30:00Z.');
    else publishedMs = t;
  }

  const rawEngagement = own(r, 'engagement');
  let engagement: number | undefined;
  if (!isRec(rawEngagement)) c.err('invalid_type', at(rp, 'engagement'), 'Expected an object.');
  else engagement = engagementTotal(rawEngagement);

  const attribution = (() => {
    const a = own(r, 'attribution');
    if (a === null) return null;
    if (typeof a !== 'string') { c.err('invalid_type', at(rp, 'attribution'), 'Expected a string or null.'); return undefined; }
    if (hasDisallowedCharacters(a)) { c.err('string_invalid_characters', at(rp, 'attribution'), 'The text contains control characters or an unpaired surrogate.'); return undefined; }
    if (codePointLength(a) > INPUT_LIMITS.longText) { c.err('string_too_long', at(rp, 'attribution'), `The text is longer than ${INPUT_LIMITS.longText} characters.`); return undefined; }
    return a.trim().length === 0 ? null : a; // a blank attribution is the same as none
  })();

  const sp = at(p, 'signal');
  const s = own(v, 'signal');
  let signal: ValidMember['signal'] | undefined;
  if (s === null) signal = null;
  else if (!isRec(s)) c.err('invalid_type', sp, 'Expected an object or null.');
  else if (required(c, s, sp, SIGNAL_FIELDS)) {
    const isProblem = readBool(c, at(sp, 'is_problem'), own(s, 'is_problem'));
    const wtpEvidence = readBool(c, at(sp, 'wtp_evidence'), own(s, 'wtp_evidence'));
    const method = own(s, 'analysis_method');
    let analysis: (typeof ANALYSIS_METHODS)[number] | undefined;
    if (typeof method !== 'string') c.err('invalid_type', at(sp, 'analysis_method'), 'Expected a string.');
    else if (!(ANALYSIS_METHODS as readonly string[]).includes(method)) c.err('invalid_enum', at(sp, 'analysis_method'), 'The value is not one of the allowed values.');
    else analysis = method as (typeof ANALYSIS_METHODS)[number];
    if (isProblem !== undefined && wtpEvidence !== undefined && analysis !== undefined) signal = { is_problem: isProblem, wtp_evidence: wtpEvidence, analysis_method: analysis };
  }

  if (c.list.length > before) return undefined;
  return {
    id: id as string, source_id: sourceId as string, discussion_key: discussionKey as string, kind: kind as string, url: url as string,
    title: title as string | null, text: text as string, published_ms: publishedMs as number | null, engagement: engagement as number,
    license: license as string, attribution: attribution as string | null, content_hash: contentHash as string, signal: signal as ValidMember['signal'],
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------------------------------------------

/** Validates the whole input. Never throws. */
export function readInput(input: unknown): InputResult {
  const c = new Errs();
  try {
    if (!isRec(input)) return { ok: false, errors: [{ code: 'invalid_type', path: '', message: 'Expected an object with a cluster and a list of members.' }] };
    if (!required(c, input, '', ['cluster', 'members'])) return { ok: false, errors: c.list };

    const rawMembers = own(input, 'members');
    if (!Array.isArray(rawMembers)) c.err('invalid_type', '/members', 'Expected a list.');
    else if (rawMembers.length > INPUT_LIMITS.maxMembers) return { ok: false, errors: [{ code: 'input_too_large', path: '/members', message: `The list allows at most ${INPUT_LIMITS.maxMembers} members.` }] };

    const cluster = readCluster(c, own(input, 'cluster'));

    const members: ValidMember[] = [];
    if (Array.isArray(rawMembers)) {
      const seen = new Set<string>();
      for (let i = 0; i < rawMembers.length && !c.full; i++) {
        if (!(i in rawMembers)) { c.err('invalid_type', at('/members', i), 'Expected an object.'); continue; } // sparse array hole
        const m = readMember(c, at('/members', i), rawMembers[i]);
        if (!m) continue;
        if (seen.has(m.id)) { c.err('duplicate_record', at(at(at('/members', i), 'record'), 'id'), 'This record appears more than once in the input.'); continue; }
        seen.add(m.id);
        members.push(m);
      }
    }

    if (c.list.length > 0 || !cluster) return { ok: false, errors: c.list };
    return { ok: true, cluster, members };
  } catch {
    return { ok: false, errors: [{ code: 'internal_error', path: '', message: 'The input could not be read.' }] };
  }
}
