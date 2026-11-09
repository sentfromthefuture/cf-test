import { ClusterSummary, embedTexts, GeminiConfig, heuristicAnalyse, llmAnalyse, OpenRouterConfig, PendingRecord, SignalOutput, summariseCluster, worthAnalysing } from './ai.ts';
import { AiTask, AiUsageCounters, classifyAiFailure, emptyAiUsage, hasAiUsage } from './ai-common.ts';
import { DecisionsConfig, SignalAiRow } from './decisions.ts';
import { classifyWithDecisions, DecisionsBatchResult, newDecisionsRunState } from './decisions-runner.ts';
import { summariseClusterCached } from './summaries.ts';
import { Logger } from './types.ts';
import { safeError } from './util.ts';
import { Store } from './store.ts';

/** Hard ceiling for the admin-only `analysis_test` smoke test. Not configurable by callers or environment. */
export const ANALYSIS_TEST_MAX_RECORDS = 10;

export interface AnalysisStats {
  /** Present (true) only for the guarded analysis-only test path. */
  testMode?: true;
  ran: boolean;
  method: 'llm' | 'heuristic' | 'none';
  claimed: number;
  skipped: number;
  analysed: number;
  problems: number;
  failed: number;
  clustered: number;
  clustersRefreshed: number;
  summaries: number;
  note?: string;
  /** Present only when the Decisions engine is configured. Counts live requests vs cache hits so repeated work is visible. */
  decisions?: { liveCalls: number; cacheHits: number; busy: number; cooldown: number; invalid: number; deferred: number; stopped: string | null };
  /** Present only when the optional LFM3 summary engine is configured. A failure here never affects core analysis. */
  summaryAi?: { liveCalls: number; cacheHits: number; failures: number; stopped: string | null };
}

export interface AnalysisDeps {
  store: Store;
  gemini: GeminiConfig | null;
  /** Engine B (LFM3): optional cluster summaries only. */
  openrouter?: OpenRouterConfig | null;
  maxOpenRouterSummaries?: number;
  /** Engine A (Decisions Fast): optional record classification. null/undefined = disabled (the default). */
  decisions?: DecisionsConfig | null;
  log: Logger;
  timeLeftMs: () => number;
  clusterThreshold?: number;
  trgmThreshold?: number;
  /**
   * Guarded smoke-test mode (see docs/safe-analysis-test-mode.md). When true, runAnalysis itself enforces - regardless of
   * any other dependency passed in - that it: claims at most ANALYSIS_TEST_MAX_RECORDS pending records in a single pass,
   * is heuristic-only (gemini/openrouter/decisions are ignored, so no external LLM call is possible), never generates cluster
   * summaries, and never runs cluster assignment/refresh (those RPCs are global, not scoped to the test batch).
   */
  testMode?: boolean;
}

/**
 * Processes the pending queue: skip obvious non-problems -> classify (LLM, or labelled heuristic fallback) ->
 * embed problem statements -> assign clusters -> recompute measured stats/scores -> summarise promising clusters.
 * Guarded by a DB lock so overlapping invocations never analyse the same records twice, and records whose
 * content has not changed are never re-queued (see dr_upsert_records), so unchanged data costs no AI calls.
 */
export async function runAnalysis(input: AnalysisDeps): Promise<AnalysisStats> {
  const testMode = input.testMode === true;
  // In test mode the AI clients are dropped here, before anything can use them, so no code path below can reach Gemini/OpenRouter/Decisions.
  const d: AnalysisDeps = testMode ? { ...input, gemini: null, openrouter: null, decisions: null } : input;
  let remaining = testMode ? ANALYSIS_TEST_MAX_RECORDS : Infinity;
  const stats: AnalysisStats = { ...(testMode ? { testMode: true as const } : {}), ran: false, method: d.gemini || d.decisions ? 'llm' : 'heuristic', claimed: 0, skipped: 0, analysed: 0, problems: 0, failed: 0, clustered: 0, clustersRefreshed: 0, summaries: 0 };
  if (!(await d.store.acquireLock('analysis', 180))) {
    stats.note = 'another analysis pass is still running or was interrupted (its lock frees itself within 3 minutes)';
    return stats;
  }
  stats.ran = true;
  const decisionsRun = newDecisionsRunState();
  const summaryUsage: AiUsageCounters = emptyAiUsage();
  let summaryFailures = 0;
  let summaryStopped: string | null = null;
  try {
    const llmBatch = 12;
    // Each AI batch can take up to ~35s (call + one retry), so only start one if there is clearly time to finish it.
    while (d.timeLeftMs() > (d.gemini || d.decisions ? 45_000 : 25_000)) {
      // dr_claim_pending_records treats a limit below 1 as 1, so never ask when nothing is left of the test cap.
      if (testMode && remaining <= 0) break;
      // Test mode: ask for no more than what is left of the cap AND truncate the reply, so a store that over-returns cannot exceed it.
      const want = testMode ? remaining : d.decisions ? Math.max(1, Math.min(24, d.decisions.maxLivePerRun)) : d.gemini ? 36 : 100;
      const pending = testMode ? (await d.store.claimPending(want)).slice(0, remaining) : await d.store.claimPending(want);
      if (pending.length === 0) break;
      if (testMode) remaining -= pending.length;
      stats.claimed += pending.length;
      const skip = pending.filter((r) => !worthAnalysing(r));
      const todo = pending.filter((r) => worthAnalysing(r));
      await d.store.markSkipped(skip.map((r) => r.id));
      stats.skipped += skip.length;

      let signals: SignalOutput[] = [];
      const aiRows: SignalAiRow[] = [];
      let llmDown = false;
      let decisionsOut: DecisionsBatchResult | null = null;
      if (d.decisions) {
        // Engine A. Cache first, bounded live requests, stops for the run on a service-level failure and leaves records pending.
        // No other model is ever tried in its place.
        decisionsOut = await classifyWithDecisions({ cfg: d.decisions, store: d.store, records: todo, state: decisionsRun, log: d.log, timeLeftMs: d.timeLeftMs });
        signals.push(...decisionsOut.signals);
        aiRows.push(...decisionsOut.aiRows);
        if (decisionsOut.failedIds.length) {
          await d.store.markFailed(decisionsOut.failedIds);
          stats.failed += decisionsOut.failedIds.length;
        }
      } else if (!d.gemini) {
        signals.push(...todo.map(heuristicAnalyse));
      } else {
        // Up to 3 AI calls in flight at once (calls are also paced by the HTTP client). A systemic error stops the whole run.
        const chunks: PendingRecord[][] = [];
        for (let i = 0; i < todo.length; i += llmBatch) chunks.push(todo.slice(i, i + llmBatch));
        for (let g = 0; g < chunks.length && !llmDown; g += 3) {
          const group = chunks.slice(g, g + 3);
          const settled = await Promise.allSettled(group.map((c) => llmAnalyse(d.gemini!, c)));
          for (let k = 0; k < group.length; k++) {
            const outcome = settled[k];
            if (outcome.status === 'fulfilled') {
              const failedIds: string[] = [];
              outcome.value.forEach((sig, j) => (sig ? signals.push(sig) : failedIds.push(group[k][j].id)));
              if (failedIds.length) {
                await d.store.markFailed(failedIds);
                stats.failed += failedIds.length;
              }
            } else {
              // Systemic failure (retired model, bad key, quota, outage): leave records pending untouched so nothing is lost
              // or permanently marked failed; report it and stop hammering the API this run.
              d.log.warn('llm batch failed', { error: safeError(outcome.reason) });
              stats.failed += group[k].length;
              stats.note = `LLM errors: ${safeError(outcome.reason)}`;
              llmDown = true;
            }
          }
        }
      }
      // Embeddings (Gemini, unchanged) only for genuine problems, whichever engine classified them. Without Gemini, clustering falls back to lexical similarity.
      if (d.gemini) {
        const probs = signals.filter((s) => s.is_problem && s.problem_statement);
        if (probs.length) {
          try {
            const embs = await embedTexts(d.gemini, probs.map((s) => s.problem_statement!));
            probs.forEach((s, i) => (s.embedding = embs[i]));
          } catch (e) {
            d.log.warn('embedding failed - falling back to lexical clustering for this batch', { error: safeError(e) });
            stats.note = `embedding errors: ${safeError(e)}`;
          }
        }
      }
      // The model's own numbers are stored FIRST and apart from the demand data. If that write fails, these records stay pending (their
      // answers are cached, so the retry costs nothing) instead of being marked done without their provenance.
      let aiPersistFailed = false;
      if (aiRows.length) {
        try {
          await d.store.saveSignalAi(aiRows);
        } catch (e) {
          aiPersistFailed = true;
          const held = new Set(aiRows.map((r) => r.record_id));
          signals = signals.filter((s) => !held.has(s.record_id));
          d.log.warn('saving AI outputs failed - affected records stay pending', { error: safeError(e) });
          stats.note = `AI output storage error: ${safeError(e)}`;
        }
      }
      stats.analysed += await d.store.saveSignals(signals);
      stats.problems += signals.filter((s) => s.is_problem).length;
      if (llmDown || aiPersistFailed) break; // do not hammer a failing model
      // Records the Decisions engine deliberately left pending (budget, outage, another worker, cooling down) are claimed first again.
      // Stop when the engine was switched off for this run, or when this batch made no progress at all; otherwise keep draining newer records.
      if (decisionsOut && decisionsOut.leftPending > 0 && (decisionsRun.stopped || decisionsOut.signals.length + decisionsOut.failedIds.length + skip.length === 0)) break;
      if (stats.failed > 0 && stats.analysed === 0) break;
      if (testMode) break; // exactly one bounded pass: never re-claim, so records that stay pending cannot be counted twice
    }

    // Cluster assignment/refresh operate on ALL unclustered signals / dirty clusters, not just this batch, so test mode skips them.
    for (let i = 0; !testMode && i < 20 && d.timeLeftMs() > 15_000; i++) {
      const n = await d.store.assignPendingClusters(500, d.clusterThreshold ?? 0.8, d.trgmThreshold ?? 0.5);
      stats.clustered += n;
      if (n < 500) break;
    }
    for (let i = 0; !testMode && i < 20 && d.timeLeftMs() > 8_000; i++) {
      const n = await d.store.refreshClusters(200);
      stats.clustersRefreshed += n;
      if (n < 200) break;
    }

    if (!testMode && (d.openrouter || d.gemini) && d.timeLeftMs() > 20_000) {
      const need = await d.store.clustersNeedingSummary(d.openrouter ? Math.max(1, Math.min(5, d.maxOpenRouterSummaries ?? 2)) : 2);
      for (const c of need) {
        if (d.timeLeftMs() < 12_000) break;
        try {
          let summary: ClusterSummary | null = null;
          if (d.openrouter) {
            // Engine B: cached, free-model-only, optional. A hit costs no request; a busy/cooling-down cluster is simply skipped.
            const out = await summariseClusterCached(d.openrouter, d.store, c.statements, { usage: summaryUsage, log: d.log });
            if (out.status === 'hit' || out.status === 'computed') summary = out.value;
          } else if (d.gemini) {
            summary = await summariseCluster(d.gemini, c.statements); // existing behaviour when OpenRouter is not configured
          }
          if (summary) {
            await d.store.saveClusterSummary(c.id, summary);
            stats.summaries++;
          }
        } catch (e) {
          // Summaries are optional: whatever goes wrong here, the core analysis above has already been saved and carries on.
          d.log.warn('cluster summary failed', { error: safeError(e) });
          summaryFailures++;
          if (d.openrouter && classifyAiFailure(e).systemic) {
            summaryStopped = classifyAiFailure(e).kind; // rate limit / outage / bad key: stop asking this run, no retry loop
            break;
          }
        }
      }
      if (stats.summaries) stats.clustersRefreshed += await d.store.refreshClusters(50);
    }
  } finally {
    if (d.decisions) {
      stats.decisions = { liveCalls: decisionsRun.liveCalls, cacheHits: decisionsRun.cacheHits, busy: decisionsRun.busy, cooldown: decisionsRun.cooldown, invalid: decisionsRun.invalid, deferred: decisionsRun.deferred, stopped: decisionsRun.stopped };
      if (decisionsRun.stopped && !/^(per-run request limit|not enough time)/.test(decisionsRun.stopped)) stats.note = `Decisions engine stopped: ${decisionsRun.stopped}`;
    }
    if (d.openrouter) stats.summaryAi = { liveCalls: summaryUsage.calls, cacheHits: summaryUsage.cache_hits, failures: summaryFailures, stopped: summaryStopped };
    await flushAiUsage(d, [['decisions', decisionsRun.usage], ['summary', summaryUsage]]);
    await d.store.releaseLock('analysis').catch(() => undefined);
  }
  return stats;
}

/** Best-effort telemetry: a failure to record usage must never affect analysis. */
async function flushAiUsage(d: AnalysisDeps, entries: Array<[AiTask, AiUsageCounters]>): Promise<void> {
  for (const [engine, usage] of entries) {
    if (!hasAiUsage(usage)) continue;
    try {
      await d.store.aiNoteUsage(engine, usage);
    } catch (e) {
      d.log.warn('AI usage telemetry failed', { engine, error: safeError(e) });
    }
  }
}
