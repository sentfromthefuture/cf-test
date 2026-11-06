import { ConnectorContext, HttpClient, consoleLogger, Logger } from '../types.ts';
import { ClaimedSource, RunStats, Store, UpsertResult } from '../store.ts';
import { PendingRecord, SignalOutput } from '../ai.ts';
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
  async requeueHeuristicAnalysis(_limit = 0) {
    let n = 0;
    for (const [id, sig] of this.signals) if (sig.analysis_method === 'heuristic') { const r = this.byId(id); if (r) { r.status = 'pending'; r.attempts = 0; this.signals.delete(id); n++; } }
    return n;
  }
}
