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

export class AiCallError extends Error {
  constructor(message: string, public readonly kind: AiErrorKind, public readonly status: number | null = null) {
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
    if (/malformed JSON/i.test(e.message)) return new AiCallError(msg, 'invalid_response', s);
    return new AiCallError(msg, 'bad_request', s);
  }
  return new AiCallError(msg, 'unavailable');
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

export type CacheBegin =
  | { state: 'hit'; id: string; result: unknown; citations: unknown; usage: unknown }
  | { state: 'claimed'; id: string }
  | { state: 'busy'; id?: string }
  | { state: 'cooldown'; id?: string; retry_after?: string };

/** What the cache needs from persistence. SupabaseStore implements it with the dr_ai_cache_* functions. */
export interface AiCacheStore {
  aiCacheBegin(key: AiCacheKey, leaseSeconds: number): Promise<CacheBegin>;
  aiCacheComplete(id: string, result: Record<string, unknown>, citations: unknown[], usage: Record<string, unknown>): Promise<boolean>;
  aiCacheFail(id: string, reason: string): Promise<void>;
  aiCacheAbandon(id: string): Promise<void>;
  aiCacheInvalidate(id: string): Promise<void>;
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
  | { status: 'computed'; value: T; cacheId: string; stored: boolean }
  | { status: 'busy'; cacheId: string | null }
  | { status: 'cooldown'; cacheId: string | null };

/**
 * Cache-first execution of one AI request.
 *  hit       -> the stored result is re-validated with `revive` and returned; no model call.
 *  claimed   -> `compute` runs. On success the validated result is stored. On an input-level failure (invalid/refused/rejected)
 *               a failure marker with a growing cooldown is stored (never a result). On a service-level failure the lease is simply released.
 *  busy      -> another worker is computing the same input: do not call the model.
 *  cooldown  -> this input failed recently: do not call the model yet.
 * `compute` errors are rethrown as AiCallError so the caller can decide whether to stop the engine for the run.
 */
export async function cachedCompute<T>(
  store: AiCacheStore, key: AiCacheKey,
  compute: () => Promise<Computed<T>>,
  revive: (stored: unknown) => T | null,
  o: { leaseSeconds?: number; log?: Logger } = {},
): Promise<CachedOutcome<T>> {
  for (let pass = 0; pass < 2; pass++) {
    const b = await store.aiCacheBegin(key, o.leaseSeconds ?? 120);
    if (b.state === 'hit') {
      const value = revive(b.result);
      if (value !== null) return { status: 'hit', value, cacheId: b.id };
      // A stored result that no longer validates (schema drift, manual edit): drop it and recompute exactly once.
      o.log?.warn('cached AI result failed validation; invalidating it', { task: key.task });
      await store.aiCacheInvalidate(b.id);
      continue;
    }
    if (b.state === 'busy' || b.state === 'cooldown') return { status: b.state, cacheId: b.id ?? null };

    let c: Computed<T>;
    try {
      c = await compute();
    } catch (e) {
      const err = classifyAiFailure(e);
      if (err.systemic) await store.aiCacheAbandon(b.id).catch(() => undefined);
      else await store.aiCacheFail(b.id, err.kind).catch(() => undefined);
      throw err;
    }
    let stored = false;
    try {
      stored = await store.aiCacheComplete(b.id, c.result, c.citations, c.usage);
    } catch (e) {
      // The answer is valid and is still returned; it just is not reusable. The lease is released so the next run can store it.
      o.log?.warn('AI cache write failed', { task: key.task, error: safeError(e) });
      await store.aiCacheAbandon(b.id).catch(() => undefined);
    }
    return { status: 'computed', value: c.value, cacheId: b.id, stored };
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
    throw e;
  } finally {
    const after = http.usage();
    usage.http_requests += Math.max(0, after.requests - before.requests);
    usage.rate_limited += Math.max(0, after.rateLimited - before.rateLimited);
    usage.duration_ms += Math.max(0, now() - t0);
  }
}
