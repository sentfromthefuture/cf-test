// Engine A - Decisions Fast (parallel/decisions-fast:free) through the OpenRouter DECISIONS API.
//
// This is NOT the chat-completions endpoint. Contract, taken from OpenRouter's published OpenAPI page for
// POST https://openrouter.ai/api/alpha/decisions ("Alpha: the shape may change"):
//   request   { model, state, questions: { <id>: { type: 'noul'|'choice'|'score'|'box', instructions, criteria } }, provider?, session_id?, trace?, user? }
//   response  { id?, model, provider?, answers: { <id>: noul | choice | score | box | refusal }, annotations?: url_citation[], usage: { input_tokens, output_tokens, cost?, ... } }
//     noul     { type:'noul',   noul: P(true) }                                    (no confidence field)
//     choice   { type:'choice', choice, probabilities?, confidence? }
//     score    { type:'score',  score (0..levels-1), legend?, probabilities?, confidence? }
//     refusal  { type:'refusal' }                                                  (that question only; the others can still be answered)
//   annotations are sources for the REQUEST AS A WHOLE and are not attributed to individual answers; we keep them that way.
// Parsing is strict about what we depend on (a missing/wrong-typed answer or a probability outside [0,1] rejects the whole response and
// nothing is cached) and ignores fields we do not use. Optional fields may be absent but never wrong.
//
// What this engine decides, and what it does not: it estimates whether a post describes a genuine problem and how to classify it.
// Its confidence is the model's self-assessment. It is stored on its own and is never demand evidence and never feeds ranking.
import { cleanStatement, classifySignalType, guessIndustry, INDUSTRIES, Industry } from './heuristics.ts';
import { PendingRecord, SIGNAL_TYPES, SignalOutput, wtpMatch } from './ai.ts';
import { AiCallError, aiErrorFromBody, aiInputHash, classifyAiFailure, isFreeModelSlug } from './ai-common.ts';
import { HttpClient } from './types.ts';

export const DECISIONS_ENDPOINT = 'https://openrouter.ai/api/alpha/decisions';
export const DECISIONS_DEFAULT_MODEL = 'parallel/decisions-fast:free';
/** Part of the cache identity. Bump whenever the questions, criteria wording, state shape or parsing semantics change. */
export const DECISIONS_CONFIG_VERSION = 'decisions-v1';

type SignalType = (typeof SIGNAL_TYPES)[number];

export interface DecisionsConfig {
  apiKey: string;
  model: string;
  /** DECISIONS_CONFIG_VERSION plus the optional AI_CACHE_VERSION operators can change to invalidate cached results without a deploy. */
  configVersion: string;
  http: HttpClient;
  /** Hard ceiling on LIVE requests per analysis run. Cache hits do not count. */
  maxLivePerRun: number;
  /** A post counts as a problem when P(genuine problem) >= this. */
  minProblemProbability: number;
  endpoint?: string;
}

const clampInt = (v: unknown, lo: number, hi: number, dflt: number) => {
  const n = Number(v);
  return Number.isInteger(n) && n >= lo && n <= hi ? n : dflt;
};

/** Disabled unless DECISIONS_ENABLED=true AND an OpenRouter key is present AND the model is an explicit :free slug. */
export function decisionsConfigFromEnv(env: Record<string, string | undefined>, http: HttpClient): DecisionsConfig | null {
  if (decisionsConfigProblem(env) !== null || env.DECISIONS_ENABLED !== 'true') return null;
  const minP = Number(env.DECISIONS_MIN_PROBLEM_PROBABILITY);
  const cacheVersion = (env.AI_CACHE_VERSION ?? '').trim().replace(/[^A-Za-z0-9._-]/g, '').slice(0, 24);
  return {
    apiKey: env.OPENROUTER_API_KEY!,
    model: (env.DECISIONS_MODEL || DECISIONS_DEFAULT_MODEL).trim(),
    configVersion: cacheVersion ? `${DECISIONS_CONFIG_VERSION}+${cacheVersion}` : DECISIONS_CONFIG_VERSION,
    http,
    maxLivePerRun: clampInt(env.DECISIONS_MAX_PER_RUN, 1, 100, 20),
    minProblemProbability: env.DECISIONS_MIN_PROBLEM_PROBABILITY && minP >= 0 && minP <= 1 ? minP : 0.5,
  };
}

/** Why an ENABLED engine cannot run (null when it can, or when it is simply not enabled). Never contains a secret. */
export function decisionsConfigProblem(env: Record<string, string | undefined>): string | null {
  if (env.DECISIONS_ENABLED !== 'true') return null;
  if (!env.OPENROUTER_API_KEY) return 'DECISIONS_ENABLED is true but OPENROUTER_API_KEY is not set';
  const model = (env.DECISIONS_MODEL || DECISIONS_DEFAULT_MODEL).trim();
  if (!isFreeModelSlug(model)) return `DECISIONS_MODEL "${model.slice(0, 60)}" is not an explicit :free model; paid models are not allowed`;
  return null;
}

// ------------------------------------------------------------------------------------------------ request

const squash = (s: string | null | undefined, max: number) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

/** The untrusted post goes in `state` as data. Instructions live only in `questions`, so post text cannot rewrite them. */
export function decisionsState(rec: PendingRecord) {
  return {
    source: rec.source_id,
    kind: rec.kind,
    title: squash(rec.title, 300),
    text: squash(rec.excerpt, 800),
    labels: rec.categories.filter((c) => typeof c === 'string').slice(0, 8).map((c) => squash(c, 80)),
  };
}

const SIGNAL_TYPE_CRITERIA: Record<SignalType, string> = {
  complaint: 'The author complains about something that is broken, painful, slow, expensive or frustrating.',
  feature_request: 'The author asks for a specific missing feature or capability.',
  unmet_need: 'The author is looking for a tool, alternative or way to do something and cannot find one.',
  question: 'A general question without a clear unmet need.',
  other: 'None of the above (announcement, showcase, discussion, joke).',
};
const SEVERITY_LEVELS = ['Minor annoyance', 'Noticeable friction', 'Significant recurring pain', 'Serious, costly problem', 'Blocking or business-critical'];

export const DECISIONS_QUESTIONS = {
  is_problem: {
    type: 'noul',
    instructions: 'Does this post describe a genuine, specific problem, unmet need or missing capability that a software product or service could address?',
    criteria: {
      true: 'The author describes a real difficulty, a missing capability or a request for a better tool.',
      false: 'Announcement, showcase, release note, ordinary chat, joke, or a bug report with no broader unmet need.',
    },
  },
  signal_type: { type: 'choice', instructions: 'What kind of post is this?', criteria: SIGNAL_TYPE_CRITERIA },
  industry: {
    type: 'choice',
    instructions: 'Which industry does the problem belong to?',
    criteria: Object.fromEntries(INDUSTRIES.map((i) => [i, i === 'Other' ? 'No other listed industry clearly applies.' : `The problem mainly affects ${i} work.`])),
  },
  severity: { type: 'score', instructions: 'How painful is the problem for the author?', criteria: SEVERITY_LEVELS },
} as const;

type QuestionId = keyof typeof DECISIONS_QUESTIONS;
const QUESTION_IDS = Object.keys(DECISIONS_QUESTIONS) as QuestionId[];

export function buildDecisionsRequest(model: string, rec: PendingRecord) {
  return {
    model,
    state: decisionsState(rec),
    questions: DECISIONS_QUESTIONS,
    // Never let routing fall back to another provider/endpoint.
    provider: { allow_fallbacks: false },
  };
}

/** Cache identity input: exactly what the model is shown. Whitespace-only and engagement-only changes do not invalidate it. */
export const decisionsInputHash = (rec: PendingRecord) => aiInputHash({ task: 'decisions', state: decisionsState(rec) });

// ------------------------------------------------------------------------------------------------ response

export interface DecisionsCitation { url: string; title: string | null; snippet: string | null }

export interface DecisionsResult {
  /** P(the post describes a genuine problem), from the `noul` answer. */
  problemProbability: number;
  signalType: SignalType | null;
  signalTypeProbabilities: Record<string, number> | null;
  industry: Industry | null;
  industryProbabilities: Record<string, number> | null;
  /** 1-5, from the ordered `score` answer (level index + 1, rounded). */
  severity: number | null;
  severityScore: number | null;
  confidence: { signalType: number | null; industry: number | null; severity: number | null };
  /** Most cautious of the confidences the model reported (null when it reported none). The model's own certainty - NOT evidence of demand. */
  modelConfidence: number | null;
  /** Questions the model declined to answer. A refused `is_problem` makes the whole result unusable. */
  refused: string[];
  /** Sources the provider used for the whole request, deduplicated by canonical URL. */
  citations: DecisionsCitation[];
  usage: { inputTokens: number; outputTokens: number; cachedTokens: number | null; reportedCostUsd: number | null };
  servedModel: string | null;
  provider: string | null;
  responseId: string | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const invalid = (m: string) => new AiCallError(`Decisions response invalid: ${m}`, 'invalid_response');
const EPS = 1e-6;

function prob(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < -EPS || v > 1 + EPS) throw invalid(`${what} must be a number in [0,1]`);
  return Math.min(1, Math.max(0, v));
}

/** Optional probability map: may be absent, but if present it must be a proper distribution over the allowed keys. */
function distribution(v: unknown, allowed: string[], what: string): Record<string, number> | null {
  if (v === undefined || v === null) return null;
  if (!isObj(v)) throw invalid(`${what} must be an object`);
  const out: Record<string, number> = {};
  let sum = 0;
  for (const [k, p] of Object.entries(v)) {
    if (!allowed.includes(k)) throw invalid(`${what} has unknown key "${k.slice(0, 40)}"`);
    out[k] = prob(p, `${what}.${k.slice(0, 40)}`);
    sum += out[k];
  }
  if (Object.keys(out).length === 0 || Math.abs(sum - 1) > 0.05) throw invalid(`${what} does not sum to 1 (got ${sum.toFixed(3)})`);
  return out;
}

const optionalConfidence = (v: unknown, what: string) => (v === undefined || v === null ? null : prob(v, `${what} confidence`));

/** Mirrors dr_norm_url() in 20261109000000_ai_results_cache.sql; both are tested against the same cases. */
export function normalizeUrl(u: string): string | null {
  const s = u.trim().toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\/(www\.)?/, '')
    .replace(/#.*$/, '')
    .replace(/([?&])(utm_[a-z0-9_]+|fbclid|gclid|ref|ref_src)=[^&]*/g, '$1')
    .replace(/\?&+/, '?')
    .replace(/&&+/g, '&')
    .replace(/[?&/]+$/, '');
  return s === '' ? null : s;
}

export function parseCitations(raw: unknown): DecisionsCitation[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: DecisionsCitation[] = [];
  for (const a of raw) {
    if (!isObj(a) || a.type !== 'url_citation' || !isObj(a.url_citation) || typeof a.url_citation.url !== 'string') continue;
    const url = a.url_citation.url.trim();
    let parsed: URL;
    try { parsed = new URL(url); } catch { continue; }
    if ((parsed.protocol !== 'https:' && parsed.protocol !== 'http:') || url.length > 2000) continue; // never keep javascript:, data:, file: ...
    const key = normalizeUrl(url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const title = typeof a.url_citation.title === 'string' ? squash(a.url_citation.title, 200) : '';
    const snippet = typeof a.url_citation.content === 'string' ? squash(a.url_citation.content, 240) : '';
    out.push({ url, title: title || null, snippet: snippet || null });
    if (out.length >= 25) break;
  }
  return out;
}

const nonNegInt = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v) : 0);

/** Validates and normalises a Decisions API body. Throws AiCallError('invalid_response' | 'refused' | status-mapped) - never returns a partial result. */
export function parseDecisionsResponse(raw: unknown): DecisionsResult {
  if (!isObj(raw)) throw invalid('body is not a JSON object');
  if (raw.error !== undefined && raw.error !== null) throw aiErrorFromBody(raw.error); // upstream failure reported inside a 200 body
  if (!isObj(raw.answers)) throw invalid('missing "answers"');
  const answers = raw.answers;
  const refused: string[] = [];
  const conf = { signalType: null as number | null, industry: null as number | null, severity: null as number | null };

  const answer = (id: QuestionId, type: string): Record<string, unknown> | null => {
    const a = answers[id];
    if (!isObj(a)) throw invalid(`missing answer "${id}"`);
    if (a.type === 'refusal') { refused.push(id); return null; }
    if (a.type !== type) throw invalid(`answer "${id}" has type ${JSON.stringify(a.type)}, expected "${type}"`);
    return a;
  };

  const pa = answer('is_problem', 'noul');
  if (pa === null) throw new AiCallError('Decisions declined to answer is_problem', 'refused');
  const problemProbability = prob(pa.noul, 'is_problem.noul');

  const choiceAnswer = <K extends string>(id: QuestionId, allowed: readonly K[]) => {
    const a = answer(id, 'choice');
    if (a === null) return { value: null as K | null, probs: null as Record<string, number> | null, confidence: null as number | null };
    if (typeof a.choice !== 'string' || !(allowed as readonly string[]).includes(a.choice)) throw invalid(`${id}.choice "${String(a.choice).slice(0, 40)}" is not one of the offered options`);
    return { value: a.choice as K, probs: distribution(a.probabilities, [...allowed], `${id}.probabilities`), confidence: optionalConfidence(a.confidence, id) };
  };
  const st = choiceAnswer('signal_type', SIGNAL_TYPES);
  const ind = choiceAnswer('industry', INDUSTRIES);
  conf.signalType = st.confidence;
  conf.industry = ind.confidence;

  let severity: number | null = null;
  let severityScore: number | null = null;
  const sa = answer('severity', 'score');
  if (sa !== null) {
    const max = SEVERITY_LEVELS.length - 1;
    if (typeof sa.score !== 'number' || !Number.isFinite(sa.score) || sa.score < -EPS || sa.score > max + EPS) throw invalid(`severity.score must be a number in [0,${max}]`);
    severityScore = Math.min(max, Math.max(0, sa.score));
    distribution(sa.probabilities, SEVERITY_LEVELS.map((_, i) => String(i)), 'severity.probabilities');
    if (sa.legend !== undefined && sa.legend !== null && !isObj(sa.legend)) throw invalid('severity.legend must be an object');
    conf.severity = optionalConfidence(sa.confidence, 'severity');
    severity = Math.min(5, Math.max(1, Math.round(severityScore) + 1));
  }

  const confidences = [conf.signalType, conf.industry, conf.severity].filter((c): c is number => c !== null);
  const usage = isObj(raw.usage) ? raw.usage : {};
  const details = isObj(usage.input_tokens_details) ? usage.input_tokens_details : {};
  return {
    problemProbability,
    signalType: st.value, signalTypeProbabilities: st.probs,
    industry: ind.value, industryProbabilities: ind.probs,
    severity, severityScore,
    confidence: conf,
    modelConfidence: confidences.length ? Math.min(...confidences) : null,
    refused,
    citations: parseCitations(raw.annotations),
    usage: {
      inputTokens: nonNegInt(usage.input_tokens), outputTokens: nonNegInt(usage.output_tokens),
      cachedTokens: typeof details.cached_tokens === 'number' ? nonNegInt(details.cached_tokens) : null,
      // The provider's own figure, kept as reported. Absent means unknown (null), not free.
      reportedCostUsd: typeof usage.cost === 'number' && Number.isFinite(usage.cost) && usage.cost >= 0 ? usage.cost : null,
    },
    servedModel: typeof raw.model === 'string' ? raw.model.slice(0, 120) : null,
    provider: typeof raw.provider === 'string' ? raw.provider.slice(0, 80) : null,
    responseId: typeof raw.id === 'string' ? raw.id.slice(0, 120) : null,
  };
}

/** Re-validates a result read back from the cache (JSON written by an earlier run, possibly under an older schema). */
export function reviveDecisionsResult(stored: unknown): DecisionsResult | null {
  if (!isObj(stored)) return null;
  try {
    const p = stored.problemProbability;
    if (typeof p !== 'number' || !(p >= 0 && p <= 1)) return null;
    const mc = stored.modelConfidence;
    if (mc !== null && (typeof mc !== 'number' || !(mc >= 0 && mc <= 1))) return null;
    if (stored.signalType !== null && !(SIGNAL_TYPES as readonly string[]).includes(stored.signalType as string)) return null;
    if (stored.industry !== null && !(INDUSTRIES as readonly string[]).includes(stored.industry as string)) return null;
    const sev = stored.severity;
    if (sev !== null && !(Number.isInteger(sev) && (sev as number) >= 1 && (sev as number) <= 5)) return null;
    if (!isObj(stored.usage) || !Array.isArray(stored.citations) || !Array.isArray(stored.refused) || !isObj(stored.confidence)) return null;
    return stored as unknown as DecisionsResult;
  } catch {
    return null;
  }
}

export interface DecisionsCall { result: DecisionsResult }

/** One live request. Throws AiCallError on any failure (HTTP, timeout, rate limit, malformed or unusable answer). */
export async function callDecisions(cfg: DecisionsConfig, rec: PendingRecord): Promise<DecisionsCall> {
  let data: unknown;
  try {
    ({ data } = await cfg.http.postJson<unknown>(cfg.endpoint ?? DECISIONS_ENDPOINT, buildDecisionsRequest(cfg.model, rec), {
      headers: { authorization: `Bearer ${cfg.apiKey}`, 'http-referer': 'https://demandradar.app', 'x-title': 'DemandRadar' },
      minIntervalKey: 'decisions',
    }));
  } catch (e) {
    throw classifyAiFailure(e);
  }
  return { result: parseDecisionsResponse(data) };
}

// ------------------------------------------------------------------------------------------------ mapping onto existing signal rows

/**
 * A post only counts as a problem if the model says so AND we can state the problem from the post itself (the model returns no prose).
 *
 * SEVERITY ISOLATION: the model's severity estimate is deliberately NOT written to the demand-facing row (`severity` is always null here).
 * dr_refresh_clusters averages `dr_problem_signals.severity` into the painIntensity component of composite_score, so putting an AI estimate
 * there would let the new engine move rankings. The estimate is preserved in `dr_signal_ai.answers.severity` (see decisionsToAiRow) and
 * can be wired into scoring later, but only on explicit approval. Gemini's severity path is unchanged. A null severity is the same
 * "no estimate" state keyword-analysed signals already have, which the scorer excludes rather than guesses.
 */
export function decisionsToSignal(rec: PendingRecord, r: DecisionsResult, cfg: Pick<DecisionsConfig, 'model' | 'minProblemProbability'>): SignalOutput {
  const text = `${rec.title ?? ''}\n${rec.excerpt ?? ''}`.trim();
  const statement = [cleanStatement(rec.title ?? ''), cleanStatement(text)].find((s) => s.length >= 10) ?? null;
  const isProblem = r.problemProbability >= cfg.minProblemProbability && statement !== null;
  const wtp = wtpMatch(text); // verbatim substring of the post by construction, so it is grounded
  return {
    record_id: rec.id,
    content_hash: rec.content_hash,
    analysis_method: 'llm',
    model: cfg.model,
    is_problem: isProblem,
    signal_type: r.signalType ?? classifySignalType(text),
    problem_statement: isProblem ? statement : null,
    industry: r.industry ?? guessIndustry(text),
    use_case: null,
    severity: null, // see SEVERITY ISOLATION above: kept in dr_signal_ai, never in the demand row
    wtp_evidence: !!wtp,
    wtp_quote: wtp,
    competitors: [],
    language: rec.language,
  };
}

/** Row for dr_signal_ai: the model's own numbers, kept apart from the demand data. */
export interface SignalAiRow {
  record_id: string;
  content_hash: string;
  cache_id: string | null;
  input_hash: string;
  model: string | null;
  requested_model: string;
  config_version: string;
  problem_probability: number;
  model_confidence: number | null;
  answers: Record<string, unknown>;
  citations: DecisionsCitation[];
}

export function decisionsToAiRow(rec: PendingRecord, r: DecisionsResult, cfg: Pick<DecisionsConfig, 'model' | 'configVersion'>, cacheId: string | null, inputHash: string): SignalAiRow {
  return {
    record_id: rec.id, content_hash: rec.content_hash, cache_id: cacheId, input_hash: inputHash,
    model: r.servedModel, requested_model: cfg.model, config_version: cfg.configVersion,
    problem_probability: r.problemProbability, model_confidence: r.modelConfidence,
    answers: {
      signal_type: { value: r.signalType, probabilities: r.signalTypeProbabilities, confidence: r.confidence.signalType },
      industry: { value: r.industry, probabilities: r.industryProbabilities, confidence: r.confidence.industry },
      severity: { value: r.severity, score: r.severityScore, confidence: r.confidence.severity },
      refused: r.refused,
    },
    citations: r.citations,
  };
}
