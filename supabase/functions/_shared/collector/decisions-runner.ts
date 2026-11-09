// Runs Engine A (Decisions Fast) over a batch of pending records.
//
// Safety properties, all enforced here (and covered by decisions-runner.test.ts):
//  - cache first: an identical input (same model + config version + normalised text) never reaches the model twice;
//  - bounded: at most cfg.maxLivePerRun live requests per run, plus the HTTP client's single retry per request;
//  - circuit breaker: the first service-level failure (rate limit, outage, bad key, retired model, timeout) switches the engine off for the
//    rest of the run and leaves the work PENDING - nothing is marked failed, nothing falls back to another model;
//  - input-level failures (invalid/refused/rejected) count as a failed attempt for that record, are recorded with a growing cooldown
//    (never stored as results), and are not re-sent until the cooldown ends;
//  - the model's numbers go to SignalAiRow (dr_signal_ai) and never into the demand data.
import { PendingRecord, SignalOutput } from './ai.ts';
import { AiCacheStore, AiCallError, AiUsageCounters, cachedCompute, classifyAiFailure, emptyAiUsage, meteredCall } from './ai-common.ts';
import { callDecisions, DecisionsConfig, decisionsInputHash, decisionsToAiRow, decisionsToSignal, reviveDecisionsResult, SignalAiRow } from './decisions.ts';
import { Logger } from './types.ts';

export interface DecisionsRunState {
  usage: AiUsageCounters;
  /** Live requests started in this run (cache hits are free and not counted). */
  liveCalls: number;
  consecutiveInputFailures: number;
  /** Set when the engine was switched off for the rest of the run; the reason names the failure kind, never a secret. */
  stopped: string | null;
  cacheHits: number;
  busy: number;
  cooldown: number;
  invalid: number;
  deferred: number;
}

export const newDecisionsRunState = (): DecisionsRunState => ({
  usage: emptyAiUsage(), liveCalls: 0, consecutiveInputFailures: 0, stopped: null, cacheHits: 0, busy: 0, cooldown: 0, invalid: 0, deferred: 0,
});

export interface DecisionsBatchResult {
  signals: SignalOutput[];
  aiRows: SignalAiRow[];
  /** Records whose INPUT could not be analysed (counts as a failed attempt). */
  failedIds: string[];
  /** Records deliberately left pending (budget, outage, another worker holds them, cooling down after an unusable answer). */
  leftPending: number;
}

/** Stop starting new requests when less than this much of the function's time budget remains (a request can take 30s + one retry). */
const MIN_TIME_FOR_LIVE_CALL_MS = 40_000;
const MAX_CONSECUTIVE_INPUT_FAILURES = 3;

export async function classifyWithDecisions(o: {
  cfg: DecisionsConfig; store: AiCacheStore; records: PendingRecord[]; state: DecisionsRunState; log: Logger; timeLeftMs: () => number; now?: () => number;
}): Promise<DecisionsBatchResult> {
  const { cfg, store, state, log } = o;
  const out: DecisionsBatchResult = { signals: [], aiRows: [], failedIds: [], leftPending: 0 };

  for (let i = 0; i < o.records.length; i++) {
    const rec = o.records[i];
    if (state.stopped || state.liveCalls >= cfg.maxLivePerRun || o.timeLeftMs() < MIN_TIME_FOR_LIVE_CALL_MS) {
      const rest = o.records.length - i;
      out.leftPending += rest;
      state.deferred += rest;
      if (!state.stopped) state.stopped = state.liveCalls >= cfg.maxLivePerRun ? 'per-run request limit reached' : 'not enough time left in this run';
      break;
    }
    const hash = await decisionsInputHash(rec);
    try {
      const outcome = await cachedCompute(
        store, { task: 'decisions', model: cfg.model, configVersion: cfg.configVersion, hash },
        async () => {
          state.liveCalls++;
          const { result } = await meteredCall(cfg.http, state.usage, () => callDecisions(cfg, rec),
            (c) => ({ inputTokens: c.result.usage.inputTokens, outputTokens: c.result.usage.outputTokens, costUsd: c.result.usage.reportedCostUsd }), o.now);
          return { value: result, result: result as unknown as Record<string, unknown>, citations: result.citations, usage: result.usage as unknown as Record<string, unknown> };
        },
        reviveDecisionsResult,
        { log },
      );
      if (outcome.status === 'busy' || outcome.status === 'cooldown') {
        // Busy: another worker is on it. Cooldown: this exact input produced an unusable answer recently. Either way no request is made
        // and the record stays pending WITHOUT counting an attempt, so its retry happens after the cooldown (1h, 2h, 4h ...) instead of
        // being burned in this run. Only real failures count towards the record's three attempts.
        if (outcome.status === 'busy') state.busy++; else state.cooldown++;
        out.leftPending++;
        continue;
      }
      if (outcome.status === 'hit') { state.cacheHits++; state.usage.cache_hits++; }
      state.consecutiveInputFailures = 0;
      out.signals.push(decisionsToSignal(rec, outcome.value, cfg));
      out.aiRows.push(decisionsToAiRow(rec, outcome.value, cfg, outcome.cacheId, hash));
    } catch (e) {
      const err: AiCallError = classifyAiFailure(e);
      if (err.systemic) {
        // Service-level: stop for the run, keep this record and everything after it pending. No fallback model, no retry loop.
        state.stopped = `${err.kind}${err.status ? ` (HTTP ${err.status})` : ''}`;
        const rest = o.records.length - i;
        out.leftPending += rest;
        state.deferred += rest;
        log.warn('Decisions engine stopped for this run', { reason: state.stopped, error: err.message });
        break;
      }
      state.invalid++;
      state.consecutiveInputFailures++;
      out.failedIds.push(rec.id);
      log.warn('Decisions result unusable for one record', { kind: err.kind, error: err.message });
      if (state.consecutiveInputFailures >= MAX_CONSECUTIVE_INPUT_FAILURES) {
        // Several unusable answers in a row smell like a contract change, not bad luck: stop spending requests.
        state.stopped = 'repeated unusable responses (possible API change)';
        const rest = o.records.length - i - 1;
        out.leftPending += rest;
        state.deferred += rest;
        break;
      }
    }
  }
  return out;
}
