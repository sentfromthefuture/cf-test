import { RawRecordInput } from './types.ts';
import { SignalOutput, PendingRecord } from './ai.ts';
import type { AiCacheKey, AiCacheStore, AiLease, AiTask, AiUsageCounters, CacheBegin } from './ai-common.ts';
import type { SignalAiRow } from './decisions.ts';
import { sleep } from './util.ts';

export interface ClaimedSource {
  id: string;
  config: Record<string, any>;
  cursor: Record<string, any>;
  interval_minutes: number;
  run_id: string;
}

export interface RunStats {
  requests: number;
  fetched: number;
  inserted: number;
  updated: number;
  duplicates: number;
  errors: number;
  details?: Record<string, unknown>;
}

export interface UpsertResult {
  total: number;
  inserted: number;
  updated: number;
  duplicates: number;
  invalid: number;
}

/** Everything the engine needs from persistence. SupabaseStore is the production implementation. */
export interface Store extends AiCacheStore {
  claimDueSources(o: { limit: number; force?: string | null; trigger: 'schedule' | 'manual'; lockSeconds: number }): Promise<ClaimedSource[]>;
  finishRun(o: { runId: string; sourceId: string; status: 'success' | 'partial' | 'error'; cursor: Record<string, unknown> | null; stats: RunStats; error: string | null; nextRunAt: Date | null }): Promise<void>;
  noteUsage(sourceId: string, usage: { requests: number; errors: number; rateLimited: number }): Promise<void>;
  setQuota(sourceId: string, q: { limit: number | null; remaining: number | null; resetAt: string | null }): Promise<void>;
  existingIds(sourceId: string, ids: string[]): Promise<Set<string>>;
  upsertRecords(records: RawRecordInput[]): Promise<UpsertResult>;
  acquireLock(name: string, seconds: number): Promise<boolean>;
  releaseLock(name: string): Promise<void>;
  /**
   * Despite the name this does NOT claim anything: dr_claim_pending_records is a read-only SELECT (no UPDATE, no row locks, no
   * 'processing' status exists). It returns the oldest pending rows, clamped to least(greatest(limit, 1), 200); a limit below 1 yields 1.
   * Two concurrent callers receive the same rows, so overlap is prevented only by the 'analysis' job lock. Rows change state solely via
   * markSkipped / saveSignals / markFailed. Proof: supabase/tests/20_claim_pending.test.sql.
   */
  claimPending(limit: number): Promise<PendingRecord[]>;
  markSkipped(ids: string[]): Promise<void>;
  markFailed(ids: string[]): Promise<void>;
  saveSignals(signals: SignalOutput[]): Promise<number>;
  assignPendingClusters(limit: number, threshold: number, trgmThreshold: number): Promise<number>;
  refreshClusters(limit: number): Promise<number>;
  clustersNeedingSummary(limit: number): Promise<Array<{ id: string; statements: string[] }>>;
  saveClusterSummary(id: string, summary: unknown): Promise<void>;
  requeueHeuristicAnalysis(limit: number): Promise<number>;
  /** Adds one run's counters for an AI engine to today's dr_ai_usage row. Best-effort telemetry: callers must not let a failure here affect processing. */
  aiNoteUsage(engine: AiTask, usage: AiUsageCounters): Promise<void>;
  /** Stores the model's own outputs (probability, confidence, citations) in dr_signal_ai, apart from the demand data. */
  saveSignalAi(rows: SignalAiRow[]): Promise<number>;
}

/**
 * JSON.stringify for a PostgREST request body.
 *
 * A UTF-16 string can hold a LONE surrogate, e.g. an emoji cut in half by `.slice(0, n)`. JSON.stringify writes it as the escape `\ud83d`,
 * which is valid ECMAScript JSON but is rejected by PostgREST's parser: the whole request fails with HTTP 400 PGRST102 "Empty or invalid
 * json" (reproduced against PostgREST 12.2.12, 13.0.7 and 16.5; it makes no difference whether the body is a string or a Uint8Array).
 * Any model- or web-supplied text that is truncated before it is stored can trigger it, e.g. Decisions citation titles and snippets.
 *
 * Lone surrogates are replaced with U+FFFD, exactly what a UTF-8 encoder does. Every other payload is returned unchanged, byte for byte.
 * The scan walks the serialized text escape by escape so that an escaped backslash followed by the text "ud83d" is never mistaken for one.
 */
const SURROGATE_ESCAPES = /\\u(d[89ab][0-9a-f]{2})\\u(d[c-f][0-9a-f]{2})|\\u(d[89a-f][0-9a-f]{2})|\\[^u]/gi;
export function toPostgrestJson(args: unknown): string {
  const json = JSON.stringify(args);
  if (!/\\ud[89a-f]/i.test(json)) return json;
  return json.replace(SURROGATE_ESCAPES, (m, _hi, _lo, lone) => (lone === undefined ? m : '\\ufffd'));
}

/** PostgREST RPC client using the service-role key (server-side only; never shipped to the browser). */
export class SupabaseStore implements Store {
  constructor(private url: string, private serviceKey: string, private fetchImpl: typeof fetch = fetch) {}

  private async rpc<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    let lastErr: Error | null = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const ctl = new AbortController();
        const timer = setTimeout(() => ctl.abort(), 25_000);
        let res: Response;
        try {
          res = await this.fetchImpl(`${this.url.replace(/\/$/, '')}/rest/v1/rpc/${name}`, {
            method: 'POST',
            headers: { apikey: this.serviceKey, authorization: `Bearer ${this.serviceKey}`, 'content-type': 'application/json' },
            body: toPostgrestJson(args),
            signal: ctl.signal,
          });
        } finally {
          clearTimeout(timer);
        }
        if (res.ok) {
          const text = await res.text();
          return (text ? JSON.parse(text) : null) as T;
        }
        const body = await res.text().catch(() => '');
        let msg = body.slice(0, 200);
        try {
          msg = JSON.parse(body).message ?? msg;
        } catch { /* keep raw snippet */ }
        lastErr = new Error(`rpc ${name} failed (HTTP ${res.status}): ${msg}`);
        if (res.status < 500 && res.status !== 429) throw lastErr; // client errors are not retryable
      } catch (e) {
        lastErr = e as Error;
        if (/HTTP 4\d\d/.test(lastErr.message) && !/HTTP 429/.test(lastErr.message)) throw lastErr;
      }
      await sleep(400 * 2 ** attempt);
    }
    throw lastErr ?? new Error(`rpc ${name} failed`);
  }

  async claimDueSources(o: { limit: number; force?: string | null; trigger: 'schedule' | 'manual'; lockSeconds: number }) {
    return (await this.rpc<ClaimedSource[]>('dr_claim_due_sources', { p_limit: o.limit, p_force: o.force ?? null, p_lock_seconds: o.lockSeconds, p_trigger: o.trigger })) ?? [];
  }
  async finishRun(o: { runId: string; sourceId: string; status: 'success' | 'partial' | 'error'; cursor: Record<string, unknown> | null; stats: RunStats; error: string | null; nextRunAt: Date | null }) {
    await this.rpc('dr_finish_run', { p_run: o.runId, p_source: o.sourceId, p_status: o.status, p_cursor: o.cursor, p_stats: o.stats, p_error: o.error, p_next_run_at: o.nextRunAt?.toISOString() ?? null });
  }
  async noteUsage(sourceId: string, u: { requests: number; errors: number; rateLimited: number }) {
    await this.rpc('dr_note_usage', { p_source: sourceId, p_requests: u.requests, p_errors: u.errors, p_rate_limited: u.rateLimited });
  }
  async setQuota(sourceId: string, q: { limit: number | null; remaining: number | null; resetAt: string | null }) {
    await this.rpc('dr_set_quota', { p_source: sourceId, p_limit: q.limit, p_remaining: q.remaining, p_reset: q.resetAt });
  }
  async existingIds(sourceId: string, ids: string[]) {
    const out = new Set<string>();
    for (let i = 0; i < ids.length; i += 500) {
      const found = await this.rpc<string[]>('dr_existing_ids', { p_source: sourceId, p_ids: ids.slice(i, i + 500) });
      for (const f of found ?? []) out.add(f);
    }
    return out;
  }
  async upsertRecords(records: RawRecordInput[]): Promise<UpsertResult> {
    const agg: UpsertResult = { total: 0, inserted: 0, updated: 0, duplicates: 0, invalid: 0 };
    for (let i = 0; i < records.length; i += 100) {
      const r = await this.rpc<UpsertResult>('dr_upsert_records', { p_records: records.slice(i, i + 100) });
      agg.total += r.total; agg.inserted += r.inserted; agg.updated += r.updated; agg.duplicates += r.duplicates; agg.invalid += r.invalid;
    }
    return agg;
  }
  async acquireLock(name: string, seconds: number) {
    return (await this.rpc<boolean>('dr_acquire_lock', { p_name: name, p_seconds: seconds })) === true;
  }
  async releaseLock(name: string) {
    await this.rpc('dr_release_lock', { p_name: name });
  }
  async claimPending(limit: number) {
    return (await this.rpc<PendingRecord[]>('dr_claim_pending_records', { p_limit: limit })) ?? [];
  }
  async markSkipped(ids: string[]) {
    if (ids.length) await this.rpc('dr_mark_skipped', { p_ids: ids });
  }
  async markFailed(ids: string[]) {
    if (ids.length) await this.rpc('dr_mark_analysis_failed', { p_ids: ids });
  }
  async saveSignals(signals: SignalOutput[]) {
    return signals.length ? (await this.rpc<number>('dr_save_signals', { p_signals: signals })) ?? 0 : 0;
  }
  async assignPendingClusters(limit: number, threshold: number, trgmThreshold: number) {
    return (await this.rpc<number>('dr_assign_pending_clusters', { p_limit: limit, p_threshold: threshold, p_trgm_threshold: trgmThreshold })) ?? 0;
  }
  async refreshClusters(limit: number) {
    return (await this.rpc<number>('dr_refresh_clusters', { p_limit: limit })) ?? 0;
  }
  async clustersNeedingSummary(limit: number) {
    return (await this.rpc<Array<{ id: string; statements: string[] }>>('dr_clusters_needing_summary', { p_limit: limit, p_min_members: 2 })) ?? [];
  }
  async saveClusterSummary(id: string, summary: unknown) {
    await this.rpc('dr_save_cluster_summary', { p_cluster: id, p_summary: summary });
  }
  async requeueHeuristicAnalysis(limit: number) {
    return (await this.rpc<number>('dr_requeue_heuristic_analysis', { p_limit: limit })) ?? 0;
  }

  // ---- AI cache / telemetry (see supabase/migrations/20261109000000_ai_results_cache.sql)
  async aiCacheBegin(key: AiCacheKey, leaseSeconds: number): Promise<CacheBegin> {
    const r = await this.rpc<CacheBegin>('dr_ai_cache_begin', { p_task: key.task, p_hash: key.hash, p_model: key.model, p_version: key.configVersion, p_lease_seconds: leaseSeconds });
    if (!r || typeof r !== 'object' || !['hit', 'claimed', 'busy', 'cooldown', 'storage_backoff'].includes((r as { state?: string }).state ?? '')) throw new Error('dr_ai_cache_begin returned an unexpected value');
    if (r.state === 'claimed' && !(typeof r.id === 'string' && typeof r.epoch === 'number' && Number.isFinite(r.epoch))) throw new Error('dr_ai_cache_begin returned a lease without a fencing epoch');
    return r;
  }
  async aiCacheComplete(lease: AiLease, result: Record<string, unknown>, citations: unknown[], usage: Record<string, unknown>): Promise<boolean> {
    return (await this.rpc<boolean>('dr_ai_cache_complete', { p_id: lease.id, p_epoch: lease.epoch, p_result: result, p_citations: citations, p_usage: usage })) === true;
  }
  async aiCacheFail(lease: AiLease, reason: string) { await this.rpc('dr_ai_cache_fail', { p_id: lease.id, p_epoch: lease.epoch, p_reason: reason }); }
  async aiCacheAbandon(lease: AiLease) { await this.rpc('dr_ai_cache_abandon', { p_id: lease.id, p_epoch: lease.epoch }); }
  async aiCacheFailStorage(lease: AiLease, reason: string): Promise<boolean> {
    return (await this.rpc<boolean>('dr_ai_cache_fail_storage', { p_id: lease.id, p_epoch: lease.epoch, p_reason: reason })) === true;
  }
  async aiCacheInvalidate(id: string) { await this.rpc('dr_ai_cache_invalidate', { p_id: id }); }
  async aiNoteUsage(engine: AiTask, usage: AiUsageCounters) { await this.rpc('dr_ai_note_usage', { p_engine: engine, p_counters: usage }); }
  async saveSignalAi(rows: SignalAiRow[]): Promise<number> {
    let n = 0;
    for (let i = 0; i < rows.length; i += 100) n += (await this.rpc<number>('dr_save_signal_ai', { p_rows: rows.slice(i, i + 100) })) ?? 0;
    return n;
  }
}
