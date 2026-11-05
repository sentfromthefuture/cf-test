import { embedTexts, GeminiConfig, heuristicAnalyse, llmAnalyse, SignalOutput, summariseCluster, worthAnalysing } from './ai.ts';
import { Logger } from './types.ts';
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
  if (!(await d.store.acquireLock('analysis', 300))) {
    stats.note = 'another analysis job is running';
    return stats;
  }
  stats.ran = true;
  try {
    const llmBatch = 8;
    while (d.timeLeftMs() > 25_000) {
      const pending = await d.store.claimPending(d.gemini ? 24 : 100);
      if (pending.length === 0) break;
      stats.claimed += pending.length;
      const skip = pending.filter((r) => !worthAnalysing(r));
      const todo = pending.filter((r) => worthAnalysing(r));
      await d.store.markSkipped(skip.map((r) => r.id));
      stats.skipped += skip.length;

      const signals: SignalOutput[] = [];
      if (!d.gemini) {
        signals.push(...todo.map(heuristicAnalyse));
      } else {
        for (let i = 0; i < todo.length; i += llmBatch) {
          const chunk = todo.slice(i, i + llmBatch);
          try {
            const res = await llmAnalyse(d.gemini, chunk);
            const failedIds: string[] = [];
            res.forEach((s, j) => (s ? signals.push(s) : failedIds.push(chunk[j].id)));
            if (failedIds.length) {
              await d.store.markFailed(failedIds);
              stats.failed += failedIds.length;
            }
          } catch (e) {
            d.log.warn('llm batch failed', { error: safeError(e) });
            await d.store.markFailed(chunk.map((r) => r.id)); // retried on a later run, permanently failed after 3 attempts
            stats.failed += chunk.length;
            stats.note = `LLM errors: ${safeError(e)}`;
            if (d.timeLeftMs() < 40_000) break;
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
            stats.note = `embedding errors: ${safeError(e)}`;
          }
        }
      }
      stats.analysed += await d.store.saveSignals(signals);
      stats.problems += signals.filter((s) => s.is_problem).length;
      if (stats.failed > 0 && stats.analysed === 0) break; // do not hammer a failing model
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

    if (d.gemini && d.timeLeftMs() > 20_000) {
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
        }
      }
      if (stats.summaries) stats.clustersRefreshed += await d.store.refreshClusters(50);
    }
  } finally {
    await d.store.releaseLock('analysis').catch(() => undefined);
  }
  return stats;
}
