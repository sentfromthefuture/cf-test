import { ConnectorContext, HttpClient, consoleLogger, Logger } from '../types.ts';
import { ClaimedSource, RunStats, Store, UpsertResult } from '../store.ts';
import { PendingRecord, SignalOutput } from '../ai.ts';
import type { AiCacheKey, AiLease, AiTask, AiUsageCounters, CacheBegin } from '../ai-common.ts';
import type { SignalAiRow } from '../decisions.ts';
import { RawRecordInput } from '../types.ts';

export const silentLog: Logger = { info() {}, warn() {}, error() {} };
void consoleLogger;

/** Fake HttpClient: `route(url, body?)` returns the JSON payload (or throws). NOT a recording of any real API. */
export function fakeHttp(route: (url: string, body?: unknown) => unknown | Promise<unknown>, headers: Record<string, string> = {}) {
  const urls: string[] = [];
  const holds: Array<[string, number]> = [];
  const http: HttpClient = {
    async getJson<T>(url: string) {
      urls.push(url);
      return { data: (await route(url)) as T, headers: new Headers(headers), status: 200 };
    },
    async postJson<T>(url: string, body: unknown) {
      urls.push(url);
      return { data: (await route(url, body)) as T, headers: new Headers(headers), status: 200 };
    },
    holdUntil: (k, t) => holds.push([k, t]),
    usage: () => ({ requests: urls.length, errors: 0, rateLimited: 0 }),
  };
  return { http, urls, holds };
}

export function ctxFor(http: HttpClient, config: Record<string, any>, cursor: Record<string, any> = {}, extra: Partial<ConnectorContext> = {}): ConnectorContext {
  return { env: {}, config, cursor, http, log: silentLog, now: () => new Date('2026-11-04T12:00:00Z'), timeLeftMs: () => 60_000, existingIds: async () => new Set(), ...extra };
}

export const rec = (source: string, id: string, over: Partial<RawRecordInput> = {}): RawRecordInput => ({
  source_id: source, source_record_id: id, discussion_key: `${source}:${id}`, kind: 'issue', url: `https://example.org/${id}`,
  title: `title ${id}`, excerpt: `I wish there was a tool for ${id}. It is frustrating.`, author_ref: null, parent_source_record_id: null,
  published_at: '2026-11-01T00:00:00Z', updated_at_source: null, engagement: { score: 3 }, categories: [], language: 'en', license: 'test',
  attribution: null, content_hash: `hash-${id}`, ...over,
});

/** In-memory Store with the same upsert/dedup/queue semantics as the SQL functions (which are tested separately in Postgres). */
export class MemoryStore implements Store {
  sources = new Map<string, { id: string; config: any; cursor: any; interval_minutes: number; locked: boolean; run_id: string }>();
  records = new Map<string, RawRecordInput & { id: string; status: 'pending' | 'done' | 'skipped' | 'failed'; attempts: number }>();
  signals = new Map<string, SignalOutput>();
  finished: Array<{ sourceId: string; status: string; cursor: any; stats: RunStats; error: string | null; nextRunAt: Date | null }> = [];
  usage: Array<{ id: string; u: any }> = [];
  quotas: Array<{ id: string; q: any }> = [];
  locks = new Set<string>();
  summaries = new Map<string, any>();
  failUpsert = false;
  private n = 0;

  addSource(id: string, config: any = {}, cursor: any = {}) {
    this.sources.set(id, { id, config, cursor, interval_minutes: 60, locked: false, run_id: `run-${id}` });
  }
  async claimDueSources(o: { limit: number; force?: string | null }): Promise<ClaimedSource[]> {
    const out: ClaimedSource[] = [];
    for (const s of this.sources.values()) {
      if (s.locked || (o.force && s.id !== o.force) || out.length >= o.limit) continue;
      s.locked = true;
      out.push({ id: s.id, config: s.config, cursor: s.cursor, interval_minutes: s.interval_minutes, run_id: s.run_id });
    }
    return out;
  }
  async finishRun(o: any) {
    this.finished.push({ sourceId: o.sourceId, status: o.status, cursor: o.cursor, stats: o.stats, error: o.error, nextRunAt: o.nextRunAt });
    const s = this.sources.get(o.sourceId)!;
    s.locked = false;
    if (o.cursor) s.cursor = o.cursor;
  }
  async noteUsage(id: string, u: any) { this.usage.push({ id, u }); }
  async setQuota(id: string, q: any) { this.quotas.push({ id, q }); }
  async existingIds(sourceId: string, ids: string[]) {
    return new Set(ids.filter((i) => this.records.has(`${sourceId}|${i}`)));
  }
  async upsertRecords(rs: RawRecordInput[]): Promise<UpsertResult> {
    if (this.failUpsert) throw new Error('db down');
    const r: UpsertResult = { total: rs.length, inserted: 0, updated: 0, duplicates: 0, invalid: 0 };
    for (const x of rs) {
      const k = `${x.source_id}|${x.source_record_id}`;
      const ex = this.records.get(k);
      if (!ex) { this.records.set(k, { ...x, id: `id-${++this.n}`, status: 'pending', attempts: 0 }); r.inserted++; }
      else if (ex.content_hash !== x.content_hash) { Object.assign(ex, x, { status: 'pending', attempts: 0 }); r.updated++; }
      else r.duplicates++;
    }
    return r;
  }
  async acquireLock(name: string) { if (this.locks.has(name)) return false; this.locks.add(name); return true; }
  async releaseLock(name: string) { this.locks.delete(name); }
  async claimPending(limit: number): Promise<PendingRecord[]> {
    return [...this.records.values()].filter((r) => r.status === 'pending').slice(0, limit).map((r) => ({
      id: r.id, source_id: r.source_id, kind: r.kind, title: r.title, excerpt: r.excerpt, categories: r.categories, engagement: r.engagement, content_hash: r.content_hash, language: r.language,
    }));
  }
  private byId(id: string) { return [...this.records.values()].find((r) => r.id === id); }
  async markSkipped(ids: string[]) { ids.forEach((i) => { const r = this.byId(i); if (r) r.status = 'skipped'; }); }
  async markFailed(ids: string[]) { ids.forEach((i) => { const r = this.byId(i); if (r) { r.attempts++; r.status = r.attempts >= 3 ? 'failed' : 'pending'; } }); }
  async saveSignals(ss: SignalOutput[]) {
    let n = 0;
    for (const s of ss) { const r = this.byId(s.record_id); if (!r || r.content_hash !== s.content_hash) continue; this.signals.set(s.record_id, s); r.status = 'done'; n++; }
    return n;
  }
  assigned = 0;
  async assignPendingClusters() { this.assigned = [...this.signals.values()].filter((s) => s.is_problem).length; return this.assigned; }
  async refreshClusters() { return 1; }
  async clustersNeedingSummary() { return [] as Array<{ id: string; statements: string[] }>; }
  async saveClusterSummary(id: string, s: unknown) { this.summaries.set(id, s); }
  // ---- AI cache: in-memory mirror of the dr_ai_cache_* state machine (tested for real against Postgres in supabase/tests/30_ai_architecture.test.sql)
  clock: () => number = () => Date.now();
  aiCache = new Map<string, { id: string; epoch: number; status: 'pending' | 'succeeded' | 'failed'; leaseUntil: number | null; result: Record<string, unknown> | null; citations: unknown[]; usage: Record<string, unknown>; hits: number; failedAttempts: number; retryAfter: number | null; lastFailure: string | null }>();
  aiCacheCalls = { begin: 0, complete: 0, fail: 0, abandon: 0, invalidate: 0 };
  failAiCache = false;
  aiUsage: Array<{ engine: AiTask; usage: AiUsageCounters }> = [];
  failAiUsage = false;
  signalAi = new Map<string, SignalAiRow>();
  private cacheId = 0;
  private ck = (k: AiCacheKey) => `${k.task}|${k.hash}|${k.model}|${k.configVersion}`;
  private cacheById(id: string) { for (const [k, v] of this.aiCache) if (v.id === id) return { k, v }; return null; }
  async aiCacheBegin(key: AiCacheKey, leaseSeconds: number): Promise<CacheBegin> {
    if (this.failAiCache) throw new Error('cache down');
    this.aiCacheCalls.begin++;
    const k = this.ck(key);
    const now = this.clock();
    const lease = now + Math.min(Math.max(leaseSeconds, 10), 900) * 1000;
    const e = this.aiCache.get(k);
    if (!e) {
      const id = `cache-${++this.cacheId}`;
      this.aiCache.set(k, { id, epoch: 1, status: 'pending', leaseUntil: lease, result: null, citations: [], usage: {}, hits: 0, failedAttempts: 0, retryAfter: null, lastFailure: null });
      return { state: 'claimed', id, epoch: 1 };
    }
    if (e.status === 'succeeded') { e.hits++; return { state: 'hit', id: e.id, result: e.result, citations: e.citations, usage: e.usage }; }
    if (e.status === 'failed' && e.retryAfter !== null && e.retryAfter > now) return { state: 'cooldown', id: e.id };
    if (e.status === 'pending' && e.leaseUntil !== null && e.leaseUntil > now) return { state: 'busy', id: e.id };
    e.status = 'pending'; e.leaseUntil = lease; e.epoch++; // takeover moves the fencing epoch forward
    return { state: 'claimed', id: e.id, epoch: e.epoch };
  }
  async aiCacheComplete(lease: AiLease, result: Record<string, unknown>, citations: unknown[], usage: Record<string, unknown>) {
    if (this.failAiCache) throw new Error('cache down');
    this.aiCacheCalls.complete++;
    if (result === null || typeof result !== 'object' || Array.isArray(result)) throw new Error('a successful AI result must be a non-null JSON object');
    const f = this.cacheById(lease.id);
    if (!f || f.v.status !== 'pending' || f.v.epoch !== lease.epoch) return false;
    Object.assign(f.v, { status: 'succeeded', result, citations, usage, leaseUntil: null, retryAfter: null, lastFailure: null });
    return true;
  }
  async aiCacheFail(lease: AiLease, reason: string) {
    this.aiCacheCalls.fail++;
    const f = this.cacheById(lease.id);
    if (!f || f.v.status !== 'pending' || f.v.epoch !== lease.epoch) return;
    f.v.retryAfter = this.clock() + Math.min(168, 2 ** Math.min(f.v.failedAttempts, 8)) * 3600_000;
    Object.assign(f.v, { status: 'failed', result: null, leaseUntil: null, failedAttempts: f.v.failedAttempts + 1, lastFailure: reason });
  }
  async aiCacheAbandon(lease: AiLease) {
    this.aiCacheCalls.abandon++;
    const f = this.cacheById(lease.id);
    if (!f || f.v.status !== 'pending' || f.v.epoch !== lease.epoch) return;
    if (f.v.failedAttempts > 0) Object.assign(f.v, { status: 'failed', leaseUntil: null, retryAfter: this.clock() });
    else this.aiCache.delete(f.k);
  }
  async aiCacheInvalidate(id: string) { this.aiCacheCalls.invalidate++; const f = this.cacheById(id); if (f) this.aiCache.delete(f.k); }
  async aiNoteUsage(engine: AiTask, usage: AiUsageCounters) { if (this.failAiUsage) throw new Error('usage table down'); this.aiUsage.push({ engine, usage: { ...usage } }); }
  async saveSignalAi(rows: SignalAiRow[]) {
    let n = 0;
    for (const r of rows) { const x = this.byId(r.record_id); if (!x || x.content_hash !== r.content_hash) continue; this.signalAi.set(r.record_id, r); n++; }
    return n;
  }
  async requeueHeuristicAnalysis(_limit = 0) {
    let n = 0;
    for (const [id, sig] of this.signals) if (sig.analysis_method === 'heuristic') { const r = this.byId(id); if (r) { r.status = 'pending'; r.attempts = 0; this.signals.delete(id); n++; } }
    return n;
  }
}
