// Runs Engine A (Decisions Fast) over a batch of pending records.
//
// Safety properties, all enforced here (and covered by decisions-runner.test.ts):
//  - CACHE FIRST: the cache is consulted for every record, always. An identical input (same model + config version + normalised text)
//    never reaches the model twice, and a cached result is reused even when the request budget is spent, the time budget is low, or the
//    circuit breaker is open. Those limits apply ONLY to a cache miss that would need a live request;
//  - bounded: at most cfg.maxLivePerRun live requests per run, plus the HTTP client's single retry per request;
//  - circuit breaker: the first service-level failure (rate limit, outage, bad key, retired model, timeout) switches LIVE requests off for the
//    rest of the run and leaves those records PENDING - nothing is marked failed, nothing falls back to another model;
//  - input-level failures (invalid/refused/rejected) count as a failed attempt for that record, are recorded with a growing cooldown
//    (never stored as results), and are not re-sent until the cooldown ends;
//  - a live answer is turned into a signal + provenance row ONLY once it is durable in the cache; otherwise the record stays pending;
//  - the model's numbers go to SignalAiRow (dr_signal_ai) and never into the demand data.
import { PendingRecord, SignalOutput } from './ai.ts';
import { AiCacheError, AiCacheStore, AiCallError, AiUsageCounters, cachedCompute, classifyAiFailure, emptyAiUsage, meteredCall } from './ai-common.ts';
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
  /** Distinct records that needed a live request this run could not make (budget, time, outage). They stay pending. */
  deferred: number;
  /** Ids counted in `deferred`; lets later batches skip them without another cache round trip. */
  deferredIds: Set<string>;
  /** Live answers that were valid but could not be made durable in the cache. Their records stay pending (see below). */
  unstored: number;
}

export const newDecisionsRunState = (): DecisionsRunState => ({
  usage: emptyAiUsage(), liveCalls: 0, consecutiveInputFailures: 0, stopped: null, cacheHits: 0, busy: 0, cooldown: 0, invalid: 0, deferred: 0, deferredIds: new Set<string>(), unstored: 0,
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

  /** Called only when the cache had no answer and a live request would be needed. Returns the reason it must not be made, or null. */
  const gate = (): string | null => {
    if (state.stopped) return state.stopped;
    if (state.liveCalls >= cfg.maxLivePerRun) return 'per-run request limit reached';
    if (o.timeLeftMs() < MIN_TIME_FOR_LIVE_CALL_MS) return 'not enough time left in this run';
    return null;
  };
  const defer = (id: string) => {
    out.leftPending++;
    if (!state.deferredIds.has(id)) { state.deferredIds.add(id); state.deferred++; }
  };

  for (let i = 0; i < o.records.length; i++) {
    const rec = o.records[i];
    if (state.deferredIds.has(rec.id)) { out.leftPending++; continue; } // already known to need a live request we may not make this run
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
        { log, gate },
      );
      if (outcome.status === 'deferred') {
        // A cache miss that needed a live request we may not make (budget, time, or the engine was switched off by a failure).
        state.stopped ??= outcome.reason;
        defer(rec.id);
        continue;
      }
      if (outcome.status === 'busy' || outcome.status === 'cooldown') {
        // Busy: another worker is on it. Cooldown: this exact input produced an unusable answer recently. Either way no request is made
        // and the record stays pending WITHOUT counting an attempt, so its retry happens after the cooldown (1h, 2h, 4h ...) instead of
        // being burned in this run. Only real failures count towards the record's three attempts.
        if (outcome.status === 'busy') state.busy++; else state.cooldown++;
        out.leftPending++;
        continue;
      }
      if (outcome.status === 'computed' && !outcome.stored) {
        // A valid live answer that is NOT durable in the cache. The signal and its provenance row link to that cache entry, so persisting
        // them now would mark the record done with provenance pointing at nothing (cache write failed) or at someone else's unfinished
        // entry (lease lost). Instead the record stays pending: next run it is served from the cache if another worker stored it, or retried.
        // If the cache WRITE itself is failing, stop spending live requests this run (an answer that cannot be kept is wasted).
        state.unstored++;
        defer(rec.id);
        if (outcome.notStored === 'write_failed') state.stopped ??= 'cache write failed';
        log.warn('Decisions answer not made durable; record stays pending', { reason: outcome.notStored });
        continue;
      }
      if (outcome.status === 'hit') { state.cacheHits++; state.usage.cache_hits++; }
      state.consecutiveInputFailures = 0;
      out.signals.push(decisionsToSignal(rec, outcome.value, cfg));
      out.aiRows.push(decisionsToAiRow(rec, outcome.value, cfg, outcome.cacheId, hash));
    } catch (e) {
      const err: AiCallError = classifyAiFailure(e);
      if (err instanceof AiCacheError) {
        // The cache itself is down: nothing can be reused or stored, so refuse to spend requests and leave everything pending.
        state.stopped = 'cache unavailable';
        for (let j = i; j < o.records.length; j++) defer(o.records[j].id);
        log.warn('Decisions engine stopped for this run: cache unavailable', { error: err.message });
        break;
      }
      if (err.systemic) {
        // Service-level: no more LIVE requests this run; this record stays pending. Remaining records are still checked against the
        // cache (hits are served), and only their misses are deferred. No fallback model, no retry loop.
        state.stopped = `${err.kind}${err.status ? ` (HTTP ${err.status})` : ''}`;
        defer(rec.id);
        log.warn('Decisions engine stopped for this run', { reason: state.stopped, error: err.message });
        continue;
      }
      state.invalid++;
      state.consecutiveInputFailures++;
      out.failedIds.push(rec.id);
      log.warn('Decisions result unusable for one record', { kind: err.kind, error: err.message });
      if (state.consecutiveInputFailures >= MAX_CONSECUTIVE_INPUT_FAILURES) {
        // Several unusable answers in a row smell like a contract change, not bad luck: stop spending requests (cache hits still served).
        state.stopped = 'repeated unusable responses (possible API change)';
      }
    }
  }
  return out;
}
