import { embedTexts, GeminiConfig, heuristicAnalyse, llmAnalyse, PendingRecord, SignalOutput, summariseCluster, worthAnalysing } from './ai.ts';
import { HttpError, Logger, RateLimitError } from './types.ts';
import { safeError } from './util.ts';
import { Store } from './store.ts';

export interface AnalysisStats {
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
}

export interface AnalysisDeps {
  store: Store;
  gemini: GeminiConfig | null;
  log: Logger;
  timeLeftMs: () => number;
  clusterThreshold?: number;
  trgmThreshold?: number;
}

/**
 * Processes the pending queue: skip obvious non-problems -> classify (LLM, or labelled heuristic fallback) ->
 * embed problem statements -> assign clusters -> recompute measured stats/scores -> summarise promising clusters.
 * Guarded by a DB lock so overlapping invocations never analyse the same records twice, and records whose
 * content has not changed are never re-queued (see dr_upsert_records), so unchanged data costs no AI calls.
 */
export async function runAnalysis(d: AnalysisDeps): Promise<AnalysisStats> {
  const stats: AnalysisStats = { ran: false, method: d.gemini ? 'llm' : 'heuristic', claimed: 0, skipped: 0, analysed: 0, problems: 0, failed: 0, clustered: 0, clustersRefreshed: 0, summaries: 0 };
  if (!(await d.store.acquireLock('analysis', 180))) {
    stats.note = 'another analysis pass is still running or was interrupted (its lock frees itself within 3 minutes)';
    return stats;
  }
  stats.ran = true;
  // After a quota / rate-limit error the AI is paused for 15 minutes so the scheduler does not keep hitting an exhausted key.
  const quotaHit = (e: unknown) => e instanceof RateLimitError || (e instanceof HttpError && e.status === 429);
  const startCooldown = async () => {
    await d.store.releaseLock('llm-cooldown').catch(() => undefined);
    await d.store.acquireLock('llm-cooldown', 900).catch(() => undefined);
  };
  let paused = false;
  if (d.gemini) {
    const free = await d.store.acquireLock('llm-cooldown', 1);
    if (free) await d.store.releaseLock('llm-cooldown').catch(() => undefined);
    else {
      paused = true;
      stats.note = 'AI analysis is paused for a few minutes after a quota/rate-limit error; it resumes automatically';
    }
  }
  try {
    const llmBatch = 12;
    // Each AI batch can take up to ~35s (call + one retry), so only start one if there is clearly time to finish it.
    while (!paused && d.timeLeftMs() > (d.gemini ? 45_000 : 25_000)) {
      const pending = await d.store.claimPending(d.gemini ? 36 : 100);
      if (pending.length === 0) break;
      stats.claimed += pending.length;
      const skip = pending.filter((r) => !worthAnalysing(r));
      const todo = pending.filter((r) => worthAnalysing(r));
      await d.store.markSkipped(skip.map((r) => r.id));
      stats.skipped += skip.length;

      const signals: SignalOutput[] = [];
      let llmDown = false;
      if (!d.gemini) {
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
              if (quotaHit(outcome.reason)) await startCooldown();
              stats.failed += group[k].length;
              stats.note = `LLM errors: ${safeError(outcome.reason)}`;
              llmDown = true;
            }
          }
        }
        // embeddings only for genuine problems
        const probs = signals.filter((s) => s.is_problem && s.problem_statement);
        if (probs.length) {
          try {
            const embs = await embedTexts(d.gemini, probs.map((s) => s.problem_statement!));
            probs.forEach((s, i) => (s.embedding = embs[i]));
          } catch (e) {
            d.log.warn('embedding failed - falling back to lexical clustering for this batch', { error: safeError(e) });
            if (quotaHit(e)) { await startCooldown(); llmDown = true; }
            stats.note = `embedding errors: ${safeError(e)}`;
          }
        }
      }
      stats.analysed += await d.store.saveSignals(signals);
      stats.problems += signals.filter((s) => s.is_problem).length;
      if (llmDown) break; // do not hammer a failing model
      if (stats.failed > 0 && stats.analysed === 0) break;
    }

    for (let i = 0; i < 20 && d.timeLeftMs() > 15_000; i++) {
      const n = await d.store.assignPendingClusters(500, d.clusterThreshold ?? 0.8, d.trgmThreshold ?? 0.5);
      stats.clustered += n;
      if (n < 500) break;
    }
    for (let i = 0; i < 20 && d.timeLeftMs() > 8_000; i++) {
      const n = await d.store.refreshClusters(200);
      stats.clustersRefreshed += n;
      if (n < 200) break;
    }

    if (d.gemini && !paused && !stats.note?.startsWith('LLM errors') && d.timeLeftMs() > 20_000) {
      const need = await d.store.clustersNeedingSummary(2);
      for (const c of need) {
        if (d.timeLeftMs() < 12_000) break;
        try {
          const summary = await summariseCluster(d.gemini, c.statements);
          if (summary) {
            await d.store.saveClusterSummary(c.id, summary);
            stats.summaries++;
          }
        } catch (e) {
          d.log.warn('cluster summary failed', { error: safeError(e) });
          if (quotaHit(e)) {
            await startCooldown();
            stats.note = `AI quota/rate limit reached while summarising: ${safeError(e)}`;
            break;
          }
        }
      }
      if (stats.summaries) stats.clustersRefreshed += await d.store.refreshClusters(50);
    }
  } finally {
    await d.store.releaseLock('analysis').catch(() => undefined);
  }
  return stats;
}
