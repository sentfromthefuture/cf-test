import { HttpClient, HttpError, RateLimitError, UsageCounters } from './types.ts';
import { sleep as realSleep } from './util.ts';

export interface HttpClientOptions {
  timeoutMs?: number;
  retries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  /** Longest we are willing to sleep inside one invocation; longer waits become RateLimitError so the runner reschedules. */
  maxInlineWaitMs?: number;
  headers?: Record<string, string>;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  /** Minimum spacing between requests that share a minIntervalKey (polite pacing, e.g. GitHub search 10/min unauthenticated). */
  minIntervalMs?: Record<string, number>;
}

function parseRetryAfter(h: Headers, nowMs: number): number | null {
  const ra = h.get('retry-after');
  if (ra) {
    const s = Number(ra);
    if (Number.isFinite(s)) return Math.max(0, s * 1000);
    const d = Date.parse(ra);
    if (!Number.isNaN(d)) return Math.max(0, d - nowMs);
  }
  const reset = h.get('x-ratelimit-reset');
  const remaining = h.get('x-ratelimit-remaining');
  if (reset && remaining === '0') {
    const t = Number(reset) * 1000;
    if (Number.isFinite(t)) return Math.max(0, t - nowMs);
  }
  return null;
}

/** HTTP client with timeouts, exponential backoff + jitter, Retry-After handling and usage counters. */
export function createHttpClient(opts: HttpClientOptions = {}): HttpClient {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const retries = opts.retries ?? 4;
  const base = opts.baseDelayMs ?? 500;
  const maxDelay = opts.maxDelayMs ?? 30_000;
  const maxInline = opts.maxInlineWaitMs ?? 20_000;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? realSleep;
  const now = opts.now ?? Date.now;
  const random = opts.random ?? Math.random;
  const usage: UsageCounters = { requests: 0, errors: 0, rateLimited: 0 };
  const holds = new Map<string, number>();
  const lastCall = new Map<string, number>();

  async function pace(key: string | undefined) {
    if (!key) return;
    const hold = holds.get(key);
    if (hold && hold > now()) {
      const wait = hold - now();
      if (wait > maxInline) throw new RateLimitError(`upstream asked us to back off for ${Math.ceil(wait / 1000)}s`, new Date(hold));
      await sleep(wait);
    }
    const gap = opts.minIntervalMs?.[key];
    const last = lastCall.get(key);
    if (gap && last !== undefined && now() - last < gap) await sleep(gap - (now() - last));
    lastCall.set(key, now());
  }

  return {
    usage: () => ({ ...usage }),
    holdUntil(key, untilMs) {
      holds.set(key, Math.max(holds.get(key) ?? 0, untilMs));
    },
    getJson: <T>(url: string, o: { headers?: Record<string, string>; minIntervalKey?: string } = {}) => request<T>('GET', url, undefined, o),
    postJson: <T>(url: string, body: unknown, o: { headers?: Record<string, string>; minIntervalKey?: string } = {}) => request<T>('POST', url, body, o),
  };

  async function request<T>(method: 'GET' | 'POST', url: string, body: unknown, o: { headers?: Record<string, string>; minIntervalKey?: string }) {
    {
      let attempt = 0;
      for (;;) {
        await pace(o.minIntervalKey);
        usage.requests++;
        let res: Response | null = null;
        let failure: HttpError | null = null;
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), timeoutMs);
        try {
          res = await fetchImpl(url, {
            method,
            headers: { accept: 'application/json', ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...opts.headers, ...o.headers },
            body: method === 'POST' ? JSON.stringify(body) : undefined,
            signal: ctl.signal,
          });
        } catch (e) {
          failure = new HttpError(ctl.signal.aborted ? `timeout after ${timeoutMs}ms` : `network error: ${(e as Error).message}`, 0);
        } finally {
          clearTimeout(timer);
        }

        if (res && res.ok) {
          let data: T;
          try {
            data = (await res.json()) as T;
          } catch {
            usage.errors++;
            throw new HttpError('malformed JSON response', res.status);
          }
          return { data, headers: res.headers, status: res.status };
        }

        let waitMs: number | null = null;
        if (res) {
          const snippet = (await res.text().catch(() => '')).slice(0, 200);
          const retryAfter = parseRetryAfter(res.headers, now());
          const limited = res.status === 429 || (res.status === 403 && retryAfter !== null) || (res.status === 403 && /rate limit|abuse/i.test(snippet));
          if (limited) usage.rateLimited++;
          failure = new HttpError(`HTTP ${res.status}`, res.status, retryAfter, snippet);
          const retryable = limited || res.status >= 500 || res.status === 408;
          if (!retryable) {
            usage.errors++;
            throw failure; // 4xx: retrying will not help
          }
          waitMs = retryAfter;
          if (limited && waitMs !== null && waitMs > maxInline) {
            usage.errors++;
            throw new RateLimitError(`rate limited by upstream (HTTP ${res.status})`, new Date(now() + waitMs));
          }
        }

        usage.errors++;
        if (attempt >= retries) throw failure!;
        const backoff = Math.min(maxDelay, base * 2 ** attempt) * (0.5 + random() / 2);
        await sleep(Math.max(waitMs ?? 0, backoff));
        attempt++;
      }
    }
  }
}
