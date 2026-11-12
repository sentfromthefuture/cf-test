import { ANALYSIS_TEST_MAX_RECORDS, runAnalysis, AnalysisStats } from './analysis.ts';
import { geminiConfigFromEnv, openRouterConfigFromEnv, openRouterConfigProblem } from './ai.ts';
import { decisionsConfigFromEnv, decisionsConfigProblem } from './decisions.ts';
import { connectors as defaultConnectors } from './connectors/index.ts';
import { createHttpClient } from './http.ts';
import { ClaimedSource, RunStats, Store } from './store.ts';
import { Connector, ConnectorContext, consoleLogger, Env, Logger, RateLimitError } from './types.ts';
import { safeError, sleep as realSleep } from './util.ts';

export interface RunOptions {
  env: Env;
  store: Store;
  trigger: 'schedule' | 'manual';
  /** Force a single source (manual sync). */
  source?: string | null;
  connectors?: Record<string, Connector>;
  /** Wall-clock budget for the whole invocation (Edge Functions allow ~150s on the free plan). */
  budgetMs?: number;
  skipAnalysis?: boolean;
  /** Skip collection entirely and only process the analysis/clustering queue. */
  analysisOnly?: boolean;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  log?: Logger;
}

export interface SourceReport {
  id: string;
  status: 'success' | 'partial' | 'error';
  stats: RunStats;
  error: string | null;
  nextRunAt: string | null;
}

export interface RunReport {
  trigger: string;
  claimed: string[];
  sources: SourceReport[];
  analysis: AnalysisStats | null;
  elapsedMs: number;
}

const MAX_BATCHES = 40;

export async function runCollection(o: RunOptions): Promise<RunReport> {
  const now = o.now ?? (() => new Date());
  const startedAt = now().getTime();
  const budgetMs = o.budgetMs ?? 100_000;
  const timeLeftMs = () => budgetMs - (now().getTime() - startedAt);
  const log = o.log ?? consoleLogger;
  const registry = o.connectors ?? defaultConnectors;

  const claimed = o.analysisOnly ? [] : await o.store.claimDueSources({ limit: 3, force: o.source ?? null, trigger: o.trigger, lockSeconds: Math.ceil(budgetMs / 1000) + 120 });

  // One failing connector must never take the others down: each runs isolated and always reports.
  const settled = await Promise.allSettled(claimed.map((c) => runSource(c, registry[c.id], o, timeLeftMs, now, log)));
  const sources: SourceReport[] = settled.map((s, i) =>
    s.status === 'fulfilled' ? s.value : { id: claimed[i].id, status: 'error' as const, stats: emptyStats(), error: safeError(s.reason), nextRunAt: null },
  );

  let analysis: AnalysisStats | null = null;
  if (!o.skipAnalysis && timeLeftMs() > 25_000) {
    try {
      // AI calls: paced (free-tier keys allow only a few requests/minute), bounded so one tap can never outlive the function's time limit.
      const http = createHttpClient({ fetchImpl: o.fetchImpl, sleep: o.sleep, retries: 1, timeoutMs: 30_000, maxInlineWaitMs: 15_000, minIntervalMs: { gemini: Number(o.env.GEMINI_MIN_INTERVAL_MS) || 3000, openrouter: Number(o.env.OPENROUTER_MIN_INTERVAL_MS) || 1500, decisions: Number(o.env.DECISIONS_MIN_INTERVAL_MS) || 3500 } });
      // Both AI engines are off unless explicitly enabled. If one is enabled but unusable (missing key, non-free model) say so once, without any secret.
      for (const problem of [decisionsConfigProblem(o.env), openRouterConfigProblem(o.env)]) if (problem) log.warn('AI engine disabled by configuration', { reason: problem });
      analysis = await runAnalysis({ store: o.store, gemini: geminiConfigFromEnv(o.env, http), openrouter: openRouterConfigFromEnv(o.env, http), decisions: decisionsConfigFromEnv(o.env, http), maxOpenRouterSummaries: Number(o.env.OPENROUTER_MAX_SUMMARIES_PER_RUN) || 2, log, timeLeftMs, clusterThreshold: Number(o.env.CLUSTER_SIMILARITY) > 0 ? Number(o.env.CLUSTER_SIMILARITY) : undefined });
    } catch (e) {
      log.error('analysis failed', { error: safeError(e) });
      analysis = { ran: false, method: 'none', claimed: 0, skipped: 0, analysed: 0, problems: 0, failed: 0, clustered: 0, clustersRefreshed: 0, summaries: 0, note: safeError(e) };
    }
  }
  return { trigger: o.trigger, claimed: claimed.map((c) => c.id), sources, analysis, elapsedMs: now().getTime() - startedAt };
}

export interface AnalysisTestOptions {
  store: Store;
  /** Wall-clock budget for the invocation. */
  budgetMs?: number;
  now?: () => Date;
  log?: Logger;
}

export interface AnalysisTestReport {
  testMode: true;
  action: 'analysis_test';
  maxRecords: number;
  method: AnalysisStats['method'];
  ran: boolean;
  claimed: number;
  analysed: number;
  skipped: number;
  problems: number;
  failed: number;
  /** Always 0: cluster assignment/refresh are global operations, so they are not run in test mode. */
  clustered: number;
  clustersRefreshed: number;
  /** Always 0: no summaries are generated in test mode. */
  summaries: number;
  elapsedMs: number;
  note?: string;
}

/**
 * Guarded, analysis-only smoke test (docs/safe-analysis-test-mode.md): analyses at most ANALYSIS_TEST_MAX_RECORDS pending
 * records with the keyword heuristic. It deliberately takes no `env`, `connectors` or `fetchImpl`, never touches the source
 * queue (claimDueSources / upsertRecords / requeueHeuristicAnalysis), and cannot reach Gemini or OpenRouter - so none of that
 * can be switched on by configuration. Do NOT reuse runCollection({ analysisOnly }) for this: it has no record cap.
 */
export async function runAnalysisTest(o: AnalysisTestOptions): Promise<AnalysisTestReport> {
  const now = o.now ?? (() => new Date());
  const startedAt = now().getTime();
  const budgetMs = o.budgetMs ?? 100_000;
  const a = await runAnalysis({ store: o.store, gemini: null, openrouter: null, decisions: null, log: o.log ?? consoleLogger, timeLeftMs: () => budgetMs - (now().getTime() - startedAt), testMode: true });
  return {
    testMode: true, action: 'analysis_test', maxRecords: ANALYSIS_TEST_MAX_RECORDS, method: a.method, ran: a.ran,
    claimed: a.claimed, analysed: a.analysed, skipped: a.skipped, problems: a.problems, failed: a.failed,
    clustered: a.clustered, clustersRefreshed: a.clustersRefreshed, summaries: a.summaries,
    elapsedMs: now().getTime() - startedAt, ...(a.note ? { note: a.note } : {}),
  };
}

const emptyStats = (): RunStats => ({ requests: 0, fetched: 0, inserted: 0, updated: 0, duplicates: 0, errors: 0 });

async function runSource(
  claimed: ClaimedSource, connector: Connector | undefined, o: RunOptions, timeLeftMs: () => number, now: () => Date, log: Logger,
): Promise<SourceReport> {
  const stats = emptyStats();
  let cursor: Record<string, unknown> = claimed.cursor ?? {};
  let status: SourceReport['status'] = 'success';
  let error: string | null = null;
  let nextRunAt: Date | null = null;
  const http = createHttpClient({
    fetchImpl: o.fetchImpl, sleep: o.sleep ?? realSleep, now: () => now().getTime(),
    headers: { 'user-agent': 'DemandRadar-collector (market research; contact via repository owner)' },
    ...(connector?.httpOptions?.(o.env) ?? {}),
  });

  try {
    if (!connector) throw new Error(`no connector implemented for source "${claimed.id}"`);
    const cfgCheck = connector.checkConfig(o.env);
    if (!cfgCheck.ok) throw new Error(`missing configuration: ${cfgCheck.missing.join(', ')}`);
    for (const n of cfgCheck.notes) log.info(`${claimed.id}: ${n}`);

    let completed = false;
    for (let batch = 0; batch < MAX_BATCHES && timeLeftMs() > 8_000; batch++) {
      const ctx: ConnectorContext = {
        env: o.env, config: claimed.config ?? {}, cursor, http, log, now, timeLeftMs,
        existingIds: (src, ids) => o.store.existingIds(src, ids),
      };
      const res = await connector.fetchBatch(ctx);
      stats.fetched += res.records.length;
      if (res.records.length) {
        const up = await o.store.upsertRecords(res.records); // persist before advancing the cursor => safe to retry
        stats.inserted += up.inserted; stats.updated += up.updated; stats.duplicates += up.duplicates;
      }
      cursor = res.cursor;
      if (res.quota) await o.store.setQuota(claimed.id, res.quota).catch((e) => log.warn('quota write failed', { error: safeError(e) }));
      if (res.rateLimitedUntil) {
        status = 'partial';
        error = `upstream quota exhausted; resuming after ${res.rateLimitedUntil}`;
        nextRunAt = new Date(res.rateLimitedUntil);
        break;
      }
      if (res.done) { completed = true; break; }
    }
    if (!completed && status === 'success') {
      status = 'partial';
      error = 'time/batch budget reached; will resume from the saved cursor';
      nextRunAt = new Date(now().getTime() + 60_000);
    }
  } catch (e) {
    if (e instanceof RateLimitError) {
      status = 'partial';
      error = safeError(e);
      nextRunAt = e.resetAt ?? new Date(now().getTime() + 15 * 60_000);
    } else {
      status = 'error';
      error = safeError(e);
      stats.errors++;
      log.error(`connector ${claimed.id} failed`, { error });
    }
  }

  const usage = http.usage();
  stats.requests = usage.requests;
  stats.errors += usage.errors;
  // Bookkeeping must not mask the real outcome, and must never leave the source locked.
  await o.store.noteUsage(claimed.id, usage).catch((e) => log.warn('usage write failed', { error: safeError(e) }));
  await o.store.finishRun({ runId: claimed.run_id, sourceId: claimed.id, status, cursor, stats, error, nextRunAt });
  return { id: claimed.id, status, stats, error, nextRunAt: nextRunAt?.toISOString() ?? null };
}
