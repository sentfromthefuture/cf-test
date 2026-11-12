// Shared plumbing for the two optional AI engines (Decisions Fast, LFM3 summaries):
//  - one error type that says whether a failure is about the SERVICE (stop calling it this run) or about the INPUT (record it, back off),
//  - canonical input hashing for cache identity,
//  - cachedCompute(): the only place that talks to the persistent cache, so "claim -> compute -> store only validated successes" is enforced once,
//  - per-engine usage counters.
// Runtime-agnostic (fetch / crypto.subtle only), like the rest of the collector.
import { HttpClient, HttpError, Logger, RateLimitError } from './types.ts';
import { safeError, sha256Hex } from './util.ts';

export type AiTask = 'decisions' | 'summary';

/** Only explicitly free model slugs are accepted anywhere in the AI layer: there is no paid model and no paid fallback. */
export const isFreeModelSlug = (m: string) => /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*:free$/i.test(m);

export type AiErrorKind =
  | 'rate_limited' | 'unavailable' | 'timeout' | 'network' | 'auth' | 'quota' | 'not_found' // about the service or its configuration
  | 'bad_request' | 'invalid_response' | 'refused';                                         // about this one input

/**
 * Why a response that DID arrive was unusable. Several different failures share the kind 'invalid_response'; this tells them apart.
 * Every code here is an enum chosen by our own code, never text taken from a model, a provider or a record.
 */
export type AiFailureReason =
  | 'response_not_json'          // HTTP 200, but the body was not JSON at all
  | 'no_choices'                 // JSON, but no usable choices[0]
  | 'empty_content'              // a choice, but its content was empty/null although generation ended normally
  | 'reasoning_exhausted_budget' // empty content with finish_reason=length: max_tokens was spent before any answer was written
  | 'truncated_json'             // content present but cut off (finish_reason=length) before the JSON object closed
  | 'no_json'                    // content present, but no JSON object could be found in it
  | 'not_an_object'              // JSON, but an array or a primitive
  | 'schema_invalid'             // a JSON object that fails the summary rules; `field` names the first failing field
  | 'provider_error'             // finish_reason=error, or an error object on the choice
  | 'content_filtered';          // finish_reason=content_filter

/**
 * Facts about an unusable response, safe to log and to show to an admin: enum codes, counts and field names only.
 * NEVER put model output, request text, headers, keys or provider messages in here.
 */
export interface AiFailureDetail {
  reason: AiFailureReason;
  httpStatus?: number;
  choices?: number;
  finishReason?: string;
  nativeFinishReason?: string;
  contentType?: 'string' | 'array' | 'null' | 'missing' | 'other';
  contentChars?: number;
  reasoningChars?: number;
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
  maxTokens?: number;
  servedModel?: string;
  provider?: string;
  /** First summary field that failed validation (a fixed name from our own schema). */
  field?: string;
}

export class AiCallError extends Error {
  constructor(message: string, public readonly kind: AiErrorKind, public readonly status: number | null = null, public readonly detail?: AiFailureDetail) {
    super(message);
    this.name = 'AiCallError';
  }
  /** Service-level problem: stop using this engine for the rest of the run and leave the work pending, so nothing is lost or marked failed. */
  get systemic(): boolean {
    return this.kind !== 'invalid_response' && this.kind !== 'refused' && this.kind !== 'bad_request';
  }
}

/** Maps anything thrown by the HTTP client or a parser to an AiCallError. Unknown errors are treated as systemic (the cautious choice). */
export function classifyAiFailure(e: unknown): AiCallError {
  if (e instanceof AiCallError) return e;
  const msg = safeError(e);
  if (e instanceof RateLimitError) return new AiCallError(msg, 'rate_limited', 429);
  if (e instanceof HttpError) {
    const s = e.status;
    if (s === 429) return new AiCallError(msg, 'rate_limited', s);
    if (s === 401 || s === 403) return new AiCallError(msg, 'auth', s);
    if (s === 402) return new AiCallError(msg, 'quota', s);
    if (s === 404) return new AiCallError(msg, 'not_found', s);
    if (s === 400 || s === 413 || s === 422) return new AiCallError(msg, 'bad_request', s);
    if (s === 408 || s === 504 || s === 524) return new AiCallError(msg, 'timeout', s);
    if (s === 0) return new AiCallError(msg, /timeout/i.test(e.message) ? 'timeout' : 'network', 0);
    if (s >= 500) return new AiCallError(msg, 'unavailable', s);
    if (/malformed JSON/i.test(e.message)) return new AiCallError(msg, 'invalid_response', s, { reason: 'response_not_json', httpStatus: s });
    return new AiCallError(msg, 'bad_request', s);
  }
  return new AiCallError(msg, 'unavailable');
}

/** One short, content-free line for the smoke-test report: the kind (and HTTP status), plus the reason and the numbers that explain it. */
export function describeAiFailure(e: AiCallError): string {
  const head = `${e.kind}${e.status ? ` (HTTP ${e.status})` : ''}`;
  const d = e.detail;
  if (!d) return head;
  const bits = [
    d.reason,
    d.field ? `field=${d.field}` : '',
    d.finishReason ? `finish_reason=${d.finishReason}` : '',
    d.completionTokens !== undefined ? `completion_tokens=${d.completionTokens}${d.maxTokens !== undefined ? `/${d.maxTokens}` : ''}` : '',
  ].filter(Boolean);
  return `${head} [${bits.join(', ')}]`;
}

/** For providers that report a failure inside a 200 body ({ error: { code, message } }): treated exactly like the HTTP error it stands for. */
export function aiErrorFromBody(error: unknown): AiCallError {
  const e = (typeof error === 'object' && error !== null ? error : {}) as { code?: unknown; message?: unknown };
  const code = typeof e.code === 'number' && Number.isInteger(e.code) ? e.code : 502;
  const msg = typeof e.message === 'string' ? e.message : 'upstream error';
  return classifyAiFailure(new HttpError(`HTTP ${code}: ${msg.slice(0, 160)}`, code));
}

/** Same value for the same logical input regardless of object key order. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

/** 64-char hex input hash. Model and config version are NOT mixed in here: they are separate columns of the cache identity. */
export const aiInputHash = (parts: unknown): Promise<string> => sha256Hex(canonicalJson(parts));

// ------------------------------------------------------------------------------------------------ persistent cache

export interface AiCacheKey {
  task: AiTask;
  model: string;
  configVersion: string;
  hash: string;
}

/** Proof of lease ownership. `epoch` is the fencing token: complete/fail/abandon act only while it is still the entry's current epoch. */
export interface AiLease { id: string; epoch: number }

export type CacheBegin =
  | { state: 'hit'; id: string; result: unknown; citations: unknown; usage: unknown }
  | { state: 'claimed'; id: string; epoch: number }
  | { state: 'busy'; id?: string }
  | { state: 'cooldown'; id?: string; retry_after?: string }
  /** The cache could not STORE recent answers (durable, engine-level, shared across invocations): no new LIVE request until `retry_after`. Never applies to a hit. */
  | { state: 'storage_backoff'; retry_after?: string };

/** What the cache needs from persistence. SupabaseStore implements it with the dr_ai_cache_* functions. */
export interface AiCacheStore {
  aiCacheBegin(key: AiCacheKey, leaseSeconds: number): Promise<CacheBegin>;
  /** Fenced: returns false (and changes nothing) unless `lease` is still the entry's current lease. */
  aiCacheComplete(lease: AiLease, result: Record<string, unknown>, citations: unknown[], usage: Record<string, unknown>): Promise<boolean>;
  /** Fenced like aiCacheComplete. */
  aiCacheFail(lease: AiLease, reason: string): Promise<void>;
  /** Fenced like aiCacheComplete: a worker that lost its lease cannot release or delete the new holder's. */
  aiCacheAbandon(lease: AiLease): Promise<void>;
  /**
   * A valid answer could not be STORED. Records a durable, bounded backoff for this input and for the engine, kept separate from
   * input-level failures, so repeated storage trouble cannot turn every scheduled run into another live request. Fenced like complete.
   */
  aiCacheFailStorage(lease: AiLease, reason: string): Promise<boolean>;
  aiCacheInvalidate(id: string): Promise<void>;
}

/** The cache store itself failed (not the model). The engine cannot reuse results, so callers stop spending requests for the run. */
export class AiCacheError extends AiCallError {
  constructor(message: string) { super(`AI cache unavailable: ${message}`, 'unavailable'); this.name = 'AiCacheError'; }
}

export interface Computed<T> {
  /** The validated value handed back to the caller. */
  value: T;
  /** What gets persisted. Must be a JSON object; only ever written after validation succeeded. */
  result: Record<string, unknown>;
  citations: unknown[];
  usage: Record<string, unknown>;
}

export type CachedOutcome<T> =
  | { status: 'hit'; value: T; cacheId: string }
  /**
   * A live answer was obtained. `stored` says whether it is now durable in the cache. When it is not, `notStored` says why:
   * 'write_failed' (the cache store errored; the lease was released) or 'lease_lost' (another worker holds a newer lease or already
   * stored its own answer). Callers that build durable records from the answer (signals + provenance) must not do so unless `stored`.
   */
  | { status: 'computed'; value: T; cacheId: string; stored: boolean; notStored?: 'write_failed' | 'lease_lost' }
  | { status: 'busy'; cacheId: string | null }
  | { status: 'cooldown'; cacheId: string | null }
  /** A cache MISS that the caller's gate refused to turn into a live request. The lease was released; nothing was recorded against the input. */
  | { status: 'deferred'; cacheId: string | null; reason: string };

/**
 * Cache-first execution of one AI request. The cache is ALWAYS consulted first; `gate` (budget, time, circuit breaker) applies only when
 * a live request would actually be needed.
 *  hit       -> the stored result is re-validated with `revive` and returned; no model call, and no gate.
 *  claimed   -> if `gate` returns a reason, the lease is released and the request is `deferred`. Otherwise `compute` runs. On success the
 *               validated result is stored. On an input-level failure (invalid/refused/rejected) a failure marker with a growing cooldown is
 *               stored (never a result). On a service-level failure the lease is simply released.
 *  busy      -> another worker is computing the same input: do not call the model.
 *  cooldown  -> this input failed recently (an unusable answer, or a cache write that failed): do not call the model yet.
 *  storage_backoff -> the cache has recently been unable to store answers (shared, durable): a miss is `deferred` without taking a lease;
 *               hits are unaffected.
 * Every write after a claim presents the lease's fencing epoch, so a worker whose lease expired and was taken over can no longer store,
 * fail or release the entry. `compute` errors are rethrown as AiCallError so the caller can decide whether to stop the engine for the run;
 * a failing cache store surfaces as AiCacheError.
 */
export async function cachedCompute<T>(
  store: AiCacheStore, key: AiCacheKey,
  compute: () => Promise<Computed<T>>,
  revive: (stored: unknown) => T | null,
  o: { leaseSeconds?: number; log?: Logger; gate?: () => string | null } = {},
): Promise<CachedOutcome<T>> {
  for (let pass = 0; pass < 2; pass++) {
    let b: CacheBegin;
    try {
      b = await store.aiCacheBegin(key, o.leaseSeconds ?? 120);
    } catch (e) {
      throw new AiCacheError(safeError(e));
    }
    if (b.state === 'hit') {
      const value = revive(b.result);
      if (value !== null) return { status: 'hit', value, cacheId: b.id };
      // A stored result that no longer validates (schema drift, manual edit): drop it and recompute exactly once.
      o.log?.warn('cached AI result failed validation; invalidating it', { task: key.task });
      try {
        await store.aiCacheInvalidate(b.id);
      } catch (e) {
        throw new AiCacheError(safeError(e));
      }
      continue;
    }
    if (b.state === 'storage_backoff') return { status: 'deferred', cacheId: null, reason: 'cache storage backoff' };
    if (b.state === 'busy') return { status: 'busy', cacheId: b.id ?? null };
    if (b.state === 'cooldown') return { status: 'cooldown', cacheId: b.id ?? null };

    const lease: AiLease = { id: b.id, epoch: b.epoch };
    const refusal = o.gate?.() ?? null;
    if (refusal !== null) {
      await store.aiCacheAbandon(lease).catch(() => undefined);
      return { status: 'deferred', cacheId: lease.id, reason: refusal };
    }

    let c: Computed<T>;
    try {
      c = await compute();
    } catch (e) {
      const err = classifyAiFailure(e);
      if (err.systemic) await store.aiCacheAbandon(lease).catch(() => undefined);
      else await store.aiCacheFail(lease, err.kind).catch(() => undefined);
      throw err;
    }
    let stored = false;
    let notStored: 'write_failed' | 'lease_lost' | undefined;
    try {
      stored = await store.aiCacheComplete(lease, c.result, c.citations, c.usage);
      if (!stored) {
        notStored = 'lease_lost';
        o.log?.warn('AI result not stored: the lease was lost to a newer holder (or the entry was already completed)', { task: key.task });
      }
    } catch (e) {
      // The answer is valid and is still returned, but it is NOT durable. Record that DURABLY (fenced), with a bounded backoff kept separate
      // from input-level failures: merely releasing the lease would leave no trace, and the next scheduled run would spend another live
      // request on the same input. If even that write fails the storage is unreachable, so `begin` will fail too and nothing is spent.
      notStored = 'write_failed';
      o.log?.warn('AI cache write failed', { task: key.task, error: safeError(e) });
      try {
        await store.aiCacheFailStorage(lease, 'write_failed');
      } catch {
        await store.aiCacheAbandon(lease).catch(() => undefined); // last resort: at least release the lease
      }
    }
    return { status: 'computed', value: c.value, cacheId: lease.id, stored, ...(notStored ? { notStored } : {}) };
  }
  return { status: 'busy', cacheId: null };
}

// ------------------------------------------------------------------------------------------------ usage

export interface AiUsageCounters {
  calls: number;               // live (non-cache) attempts
  successes: number;
  failures: number;
  rate_limited: number;
  http_requests: number;       // includes the HTTP client's retries
  cache_hits: number;
  cache_misses: number;
  input_tokens: number;
  output_tokens: number;
  reported_cost_usd: number;   // only what the provider reported; unknown cost is not counted as zero ...
  cost_reported_calls: number; // ... which is why we also count how many calls reported one
  duration_ms: number;
}

export const emptyAiUsage = (): AiUsageCounters => ({
  calls: 0, successes: 0, failures: 0, rate_limited: 0, http_requests: 0, cache_hits: 0, cache_misses: 0,
  input_tokens: 0, output_tokens: 0, reported_cost_usd: 0, cost_reported_calls: 0, duration_ms: 0,
});

export const hasAiUsage = (u: AiUsageCounters) => Object.values(u).some((v) => v > 0);

/**
 * Wraps ONE live (non-cache) call and records it: attempt, outcome, HTTP requests actually made (retries included), rate-limit responses,
 * duration, tokens and the provider's reported cost. A call counts as a cache miss because it had to go to the model.
 * HTTP/rate-limit deltas come from the shared client's counters, so they are exact for sequential calls and approximate if calls overlap.
 */
export async function meteredCall<T>(
  http: Pick<HttpClient, 'usage'>, usage: AiUsageCounters, fn: () => Promise<T>,
  measure: (v: T) => { inputTokens: number; outputTokens: number; costUsd: number | null },
  now: () => number = Date.now,
): Promise<T> {
  const before = http.usage();
  const t0 = now();
  usage.calls++;
  usage.cache_misses++;
  try {
    const v = await fn();
    const m = measure(v);
    usage.successes++;
    usage.input_tokens += Math.max(0, m.inputTokens);
    usage.output_tokens += Math.max(0, m.outputTokens);
    if (m.costUsd !== null && Number.isFinite(m.costUsd) && m.costUsd >= 0) {
      usage.reported_cost_usd += m.costUsd;
      usage.cost_reported_calls++;
    }
    return v;
  } catch (e) {
    usage.failures++;
    // A response that arrived but was unusable still consumed the provider's tokens: count what it reported (and only that).
    const spent = e instanceof AiCallError ? e.detail : undefined;
    if (spent) {
      usage.input_tokens += Math.max(0, spent.promptTokens ?? 0);
      usage.output_tokens += Math.max(0, spent.completionTokens ?? 0);
    }
    throw e;
  } finally {
    const after = http.usage();
    usage.http_requests += Math.max(0, after.requests - before.requests);
    usage.rate_limited += Math.max(0, after.rateLimited - before.rateLimited);
    usage.duration_ms += Math.max(0, now() - t0);
  }
}
