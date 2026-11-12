// Engine B (LFM3) - cached, optional cluster summaries. Nothing in core analysis depends on this module succeeding.
import { ClusterSummary, OpenRouterConfig, requestClusterSummary, validateSummary } from './ai.ts';
import { AiCacheStore, aiInputHash, AiUsageCounters, CachedOutcome, cachedCompute, meteredCall } from './ai-common.ts';
import { Logger } from './types.ts';

/** The statements the model sees: whitespace-normalised, de-duplicated, sorted, max 20. Equivalent sets therefore share one cache entry. */
export function summaryStatements(statements: string[]): string[] {
  return [...new Set(statements.map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean))].sort().slice(0, 20);
}

export const summaryInputHash = (statements: string[]) => aiInputHash({ task: 'summary', statements: summaryStatements(statements) });

/**
 * Cache-first summary. A hit costs no request. A live call is stored only after the summary passed validation;
 * an unusable answer leaves a cooldown marker (never a result), so the same unchanged cluster is not re-sent on every run.
 * Throws AiCallError on failure - the caller treats every failure as "no summary this time" and carries on.
 */
export async function summariseClusterCached(
  cfg: OpenRouterConfig, store: AiCacheStore, statements: string[],
  o: { usage: AiUsageCounters; log?: Logger; now?: () => number },
): Promise<CachedOutcome<ClusterSummary>> {
  const stmts = summaryStatements(statements);
  const hash = await summaryInputHash(stmts);
  const outcome = await cachedCompute<ClusterSummary>(
    store, { task: 'summary', model: cfg.model, configVersion: cfg.configVersion, hash },
    async () => {
      const summary = await meteredCall(cfg.http, o.usage, () => requestClusterSummary(cfg, stmts, { log: o.log }),
        (s) => ({ inputTokens: s.usage?.prompt_tokens ?? 0, outputTokens: s.usage?.completion_tokens ?? 0, costUsd: s.usage?.reported_cost_usd ?? null }), o.now);
      return { value: summary, result: summary as unknown as Record<string, unknown>, citations: [], usage: { ...(summary.usage ?? {}) } };
    },
    (stored) => {
      const v = validateSummary(stored, stmts, cfg.model);
      if (!v) return null;
      const u = (stored as { usage?: ClusterSummary['usage'] }).usage;
      return u ? { ...v, usage: u } : v;
    },
    { log: o.log },
  );
  if (outcome.status === 'hit') o.usage.cache_hits++;
  return outcome;
}
