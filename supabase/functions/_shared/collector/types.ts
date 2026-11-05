// Shared types for the DemandRadar collection engine.
// Runtime-agnostic: uses only fetch / crypto.subtle / URL so it runs in Supabase Edge Functions (Deno), Node 20+ and Workers.

export type Env = Record<string, string | undefined>;

export interface RawRecordInput {
  source_id: string;
  source_record_id: string;
  discussion_key: string;
  kind: 'issue' | 'story' | 'comment' | 'question';
  url: string;
  title: string | null;
  excerpt: string | null;
  author_ref: string | null;
  parent_source_record_id: string | null;
  published_at: string | null;
  updated_at_source: string | null;
  engagement: Record<string, number>;
  categories: string[];
  language: string | null;
  license: string;
  attribution: string | null;
  content_hash: string;
}

export interface UsageCounters {
  requests: number;
  errors: number;
  rateLimited: number;
}

export interface QuotaInfo {
  limit: number | null;
  remaining: number | null;
  resetAt: string | null;
}

export interface FetchResult {
  records: RawRecordInput[];
  /** Opaque, JSON-serialisable cursor to resume from. */
  cursor: Record<string, unknown>;
  /** True when this cycle has nothing more to fetch. */
  done: boolean;
  quota?: QuotaInfo;
  /** Number of upstream items inspected (including ones filtered out) - for diagnostics. */
  inspected?: number;
  /** Records in this batch are valid, but upstream quota forbids further requests until this ISO time. */
  rateLimitedUntil?: string;
}

export interface Logger {
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
}

export interface HttpClient {
  getJson<T = unknown>(url: string, opts?: { headers?: Record<string, string>; minIntervalKey?: string }): Promise<{ data: T; headers: Headers; status: number }>;
  postJson<T = unknown>(url: string, body: unknown, opts?: { headers?: Record<string, string>; minIntervalKey?: string }): Promise<{ data: T; headers: Headers; status: number }>;
  /** Do not issue another request for `key` before `untilMs` (epoch ms). Used for API-mandated backoff. */
  holdUntil(key: string, untilMs: number): void;
  usage(): UsageCounters;
}

export interface ConnectorContext {
  env: Env;
  config: Record<string, any>;
  cursor: Record<string, any>;
  http: HttpClient;
  /** Returns which of the given source record ids are already stored (avoids re-fetching known items). */
  existingIds(sourceId: string, ids: string[]): Promise<Set<string>>;
  now(): Date;
  log: Logger;
  /** Milliseconds left in this invocation's time budget. */
  timeLeftMs(): number;
}

export interface Connector {
  id: string;
  name: string;
  /** Reports missing optional/required configuration so the UI never claims a connector works when it cannot. */
  checkConfig(env: Env): { ok: boolean; missing: string[]; notes: string[] };
  /** Per-connector pacing/headers for the shared HTTP client. */
  httpOptions?(env: Env): { minIntervalMs?: Record<string, number>; headers?: Record<string, string> };
  /** Fetch one page/batch. Must be safe to call repeatedly with the returned cursor. */
  fetchBatch(ctx: ConnectorContext): Promise<FetchResult>;
}

export class ConnectorError extends Error {
  constructor(message: string, public readonly retryable = false) {
    super(message);
    this.name = 'ConnectorError';
  }
}

/** Thrown when an upstream quota/rate limit forbids continuing before `resetAt`. The runner stops cleanly and reschedules. */
export class RateLimitError extends Error {
  constructor(message: string, public readonly resetAt: Date | null) {
    super(message);
    this.name = 'RateLimitError';
  }
}

export class HttpError extends Error {
  constructor(message: string, public readonly status: number, public readonly retryAfterMs: number | null = null, public readonly bodySnippet = '') {
    super(message);
    this.name = 'HttpError';
  }
}

export const consoleLogger: Logger = {
  info: (m, e) => console.log(JSON.stringify({ level: 'info', msg: m, ...e })),
  warn: (m, e) => console.warn(JSON.stringify({ level: 'warn', msg: m, ...e })),
  error: (m, e) => console.error(JSON.stringify({ level: 'error', msg: m, ...e })),
};
