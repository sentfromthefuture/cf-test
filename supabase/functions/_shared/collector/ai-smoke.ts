// The `ai_smoke_test` action: a bounded, admin-only diagnostic that proves BOTH optional AI engines (Decisions Fast, LFM3) work end to end
// against a tiny sample of EXISTING pending records, before normal automated processing is enabled. See docs/ai-smoke-test.md.
//
// This is a diagnostic, not a collection run. What it deliberately does NOT do (each point is covered by ai-smoke.test.ts):
//  - fetch source data, claim/finish sources, upsert or requeue records (it never touches connectors or the source queue);
//  - change any record's analysis status: it never calls markSkipped / markFailed / saveSignals, so the records stay exactly as pending as
//    they were. The store type below is narrower than `Store` on purpose, so those methods are not even reachable from this file;
//  - cluster, summarise real clusters, or write dr_clusters;
//  - read or change feature flags: an engine that is not already enabled and valid in the environment is reported as such, never forced on;
//  - retry: it builds its own HTTP client with retries = 0 and the Decisions runner stops at the first service-level failure;
//  - take any caller input: the action reads nothing from the request body (no limit, no model, no record ids).
// Worst case it makes 3 Decisions requests + 1 LFM3 request, each a free model, each at most once.
//
// What it DOES write, all through the existing production code paths: dr_ai_cache rows (the cache), dr_signal_ai rows (the model-output
// table, at most 3, upserted by record_id), dr_ai_usage counters, and a short-lived 'ai_smoke_test' row in dr_job_locks.
import { ClusterSummary, OpenRouterConfig, openRouterConfigFromEnv, openRouterConfigProblem, PendingRecord, validateSummary, worthAnalysing } from './ai.ts';
import { AiCacheKey, AiCacheStore, AiTask, AiUsageCounters, CachedOutcome, CacheBegin, classifyAiFailure, emptyAiUsage, hasAiUsage } from './ai-common.ts';
import { DecisionsConfig, decisionsConfigFromEnv, decisionsConfigProblem, reviveDecisionsResult, SignalAiRow } from './decisions.ts';
import { classifyWithDecisions, DecisionsBatchResult, newDecisionsRunState } from './decisions-runner.ts';
import { cleanStatement } from './heuristics.ts';
import { createHttpClient } from './http.ts';
import type { Store } from './store.ts';
import { summariseClusterCached, summaryInputHash, summaryStatements } from './summaries.ts';
import { consoleLogger, Env, HttpClient, Logger } from './types.ts';
import { safeError } from './util.ts';

/** Hard ceiling on records used. Not configurable by callers, request bodies or environment variables. */
export const AI_SMOKE_TEST_MAX_RECORDS = 3;
/**
 * How many of the OLDEST pending rows are read (never changed) to find eligible ones. Many pending rows are obvious non-problems that
 * production would skip, so looking at only 3 could leave nothing to test. Only AI_SMOKE_TEST_MAX_RECORDS of the eligible ones are used.
 */
export const AI_SMOKE_TEST_CANDIDATE_WINDOW = 12;

const LOCK_NAME = 'ai_smoke_test';
const LOCK_SECONDS = 180;
/** The LFM3 request can take up to its 30s timeout; do not start it with less than this left. */
const MIN_TIME_FOR_LFM3_MS = 20_000;

/** Everything this module may use from persistence. Narrower than Store: nothing that changes record status, sources or clusters. */
export type AiSmokeStore = AiCacheStore & Pick<Store, 'acquireLock' | 'releaseLock' | 'claimPending' | 'aiNoteUsage' | 'saveSignalAi'>;

export type EngineStatus =
  | 'passed'        // every selected input was answered, durable in the cache, and every check below passed
  | 'partial'       // something worked but not everything (some inputs failed, or a persistence/usage check failed)
  | 'failed'        // no usable answer at all
  | 'disabled'      // not enabled in the environment (the feature flag is not "true"); nothing was tested
  | 'misconfigured' // enabled but unusable (missing key, non-free model); nothing was tested
  | 'not_run';      // enabled and valid, but there was nothing to test it with (no eligible records, no time)

export interface UsageReport {
  calls: number; successes: number; failures: number; rateLimited: number;
  httpRequests: number;
  /** httpRequests - calls. Always 0 here: the smoke test's HTTP client does not retry. */
  retries: number;
  cacheHits: number; cacheMisses: number;
  inputTokens: number; outputTokens: number;
  /** null when no call reported a cost: an unknown cost is not zero. */
  reportedCostUsd: number | null;
  costReportedCalls: number;
  /** null when there was no live success to look at. false means a live success carried no token counts. */
  tokensReported: boolean | null;
  /** The counters agree with each other (attempts = outcomes, misses = attempts, requests >= attempts). */
  consistent: boolean;
  /** Whether this run's counters were added to dr_ai_usage (via dr_ai_note_usage). */
  recorded: 'ok' | 'failed' | 'nothing_to_record';
}

export interface EngineReport {
  status: EngineStatus;
  /** The configured model slug (not a secret); null when the engine was not usable. */
  model: string | null;
  configVersion: string | null;
  /** Static description of what one "input" is for this engine. */
  basis: string;
  /** Inputs sent through the engine. */
  attempted: number;
  /** Inputs with a usable answer that is durable in the cache. */
  succeeded: number;
  /** Inputs whose answer was unusable (invalid, refused, rejected). */
  failed: number;
  /** Inputs that got no answer for another reason (service outage, busy, cooling down, budget, cache problem). */
  notCompleted: number;
  liveCalls: number;
  cacheHits: number;
  /** Why the engine stopped early (a failure KIND and HTTP status only; never a provider message or secret). */
  stopped: string | null;
  /** Re-reads each answered input through the cache's own read path: `verified` = found, same entry, passes validation. */
  cache: { verified: number; unverified: number };
  /** The model-output table. LFM3 has none here: see `basis`. */
  output: { table: 'dr_signal_ai' | null; expected: number; written: number };
  usage: UsageReport;
  /** Why the status is not `passed`. Safe to show: contains no secrets and no record content. */
  issue?: string;
}

export interface AiSmokeTestReport {
  testMode: true;
  action: 'ai_smoke_test';
  maxRecords: number;
  /** passed = BOTH engines passed. failed = nothing usable from any tested engine. nothing_tested = no engine could be exercised. partial = anything else. */
  overall: 'passed' | 'partial' | 'failed' | 'nothing_tested';
  ok: boolean;
  /** Counts and opaque ids only: no titles, excerpts or any other record content. */
  records: { candidatesRead: number; eligible: number; selected: number; ids: string[] };
  decisions: EngineReport;
  lfm3: EngineReport;
  elapsedMs: number;
  note?: string;
}

export interface AiSmokeTestOptions {
  store: AiSmokeStore;
  /** Read for configuration only (feature flags, key presence, model slugs). Nothing from it is ever copied into the report. */
  env: Env;
  /** Tests inject a scripted client. Production leaves it unset and gets a client with retries = 0. */
  http?: HttpClient;
  fetchImpl?: typeof fetch;
  budgetMs?: number;
  now?: () => Date;
  log?: Logger;
}

// ------------------------------------------------------------------------------------------------ configuration (no I/O)

type Readiness = { ready: true } | { ready: false; status: 'disabled' | 'misconfigured'; issue: string };

function decisionsReadiness(env: Env): Readiness {
  if (env.DECISIONS_ENABLED !== 'true') return { ready: false, status: 'disabled', issue: 'DECISIONS_ENABLED is not "true"' };
  const problem = decisionsConfigProblem(env);
  return problem ? { ready: false, status: 'misconfigured', issue: safeError(problem) } : { ready: true };
}

function lfm3Readiness(env: Env): Readiness {
  if (env.OPENROUTER_ENABLED !== 'true') return { ready: false, status: 'disabled', issue: 'OPENROUTER_ENABLED is not "true"' };
  const problem = openRouterConfigProblem(env);
  return problem ? { ready: false, status: 'misconfigured', issue: safeError(problem) } : { ready: true };
}

const DECISIONS_BASIS = 'each selected record is classified individually';
const LFM3_BASIS = 'one cluster summary over the selected records\' statements (a synthetic cluster: nothing is written to dr_clusters)';

const zeroUsage = (): UsageReport => ({
  calls: 0, successes: 0, failures: 0, rateLimited: 0, httpRequests: 0, retries: 0, cacheHits: 0, cacheMisses: 0, inputTokens: 0, outputTokens: 0,
  reportedCostUsd: null, costReportedCalls: 0, tokensReported: null, consistent: true, recorded: 'nothing_to_record',
});

const emptyEngine = (status: EngineStatus, basis: string, issue?: string, model: string | null = null, configVersion: string | null = null): EngineReport => ({
  status, model, configVersion, basis, attempted: 0, succeeded: 0, failed: 0, notCompleted: 0, liveCalls: 0, cacheHits: 0, stopped: null,
  cache: { verified: 0, unverified: 0 }, output: { table: null, expected: 0, written: 0 }, usage: zeroUsage(), ...(issue ? { issue } : {}),
});

// ------------------------------------------------------------------------------------------------ shared checks

/** A failure described by KIND and HTTP status only. Provider messages can echo request content, so they are not put in the report. */
function failureLabel(e: unknown): string {
  const err = classifyAiFailure(e);
  return `${err.kind}${err.status ? ` (HTTP ${err.status})` : ''}`;
}

/**
 * Re-reads one cache entry through the cache's own read path (dr_ai_cache_begin) and checks it is the entry the answer was stored under and
 * that it still passes validation. A confirmed entry costs nothing but bumps its hit counter by one (the same as any cache hit).
 * If the entry is unexpectedly missing, begin() hands this caller a fresh lease; it is released straight away, which deletes that empty row.
 */
async function verifyCacheEntry(store: AiCacheStore, key: AiCacheKey, expectedId: string | null, revive: (stored: unknown) => unknown | null): Promise<boolean> {
  let b: CacheBegin;
  try {
    b = await store.aiCacheBegin(key, 30);
  } catch {
    return false;
  }
  if (b.state === 'claimed') {
    await store.aiCacheAbandon({ id: b.id, epoch: b.epoch }).catch(() => undefined);
    return false;
  }
  if (b.state !== 'hit') return false;
  return (expectedId === null || b.id === expectedId) && revive(b.result) !== null;
}

/** Adds this run's counters to dr_ai_usage through the production RPC and cross-checks the counters against each other. */
async function accountUsage(store: AiSmokeStore, engine: AiTask, u: AiUsageCounters, liveCalls: number, log: Logger): Promise<UsageReport> {
  let recorded: UsageReport['recorded'] = 'nothing_to_record';
  if (hasAiUsage(u)) {
    try {
      await store.aiNoteUsage(engine, u);
      recorded = 'ok';
    } catch (e) {
      recorded = 'failed';
      log.warn('AI smoke test: usage could not be recorded', { engine, error: safeError(e) });
    }
  }
  return {
    calls: u.calls, successes: u.successes, failures: u.failures, rateLimited: u.rate_limited,
    httpRequests: u.http_requests, retries: Math.max(0, u.http_requests - u.calls),
    cacheHits: u.cache_hits, cacheMisses: u.cache_misses, inputTokens: u.input_tokens, outputTokens: u.output_tokens,
    reportedCostUsd: u.cost_reported_calls > 0 ? u.reported_cost_usd : null, costReportedCalls: u.cost_reported_calls,
    tokensReported: u.successes > 0 ? u.input_tokens + u.output_tokens > 0 : null,
    consistent: u.calls === u.successes + u.failures && u.cache_misses === u.calls && u.http_requests >= u.calls && u.calls === liveCalls,
    recorded,
  };
}

function settle(rep: EngineReport, problems: string[]): EngineReport {
  const u = rep.usage;
  if (u.recorded === 'failed') problems.push('usage could not be recorded in dr_ai_usage');
  if (!u.consistent) problems.push('usage counters are inconsistent');
  if (rep.cache.unverified > 0) problems.push(`${rep.cache.unverified} cache entr${rep.cache.unverified === 1 ? 'y' : 'ies'} could not be verified`);
  rep.status = rep.succeeded === 0 ? 'failed' : problems.length === 0 && rep.succeeded === rep.attempted ? 'passed' : 'partial';
  if (problems.length) rep.issue = problems.join('; ');
  return rep;
}

// ------------------------------------------------------------------------------------------------ Engine A: Decisions Fast

async function testDecisions(a: { cfg: DecisionsConfig; store: AiSmokeStore; records: PendingRecord[]; log: Logger; timeLeftMs: () => number; nowMs: () => number }): Promise<EngineReport> {
  // The configured per-run live-request limit applies, but never above the smoke-test ceiling.
  const cfg: DecisionsConfig = { ...a.cfg, maxLivePerRun: Math.min(a.cfg.maxLivePerRun, AI_SMOKE_TEST_MAX_RECORDS) };
  const state = newDecisionsRunState();
  const rep = emptyEngine('failed', DECISIONS_BASIS, undefined, cfg.model, cfg.configVersion);
  rep.attempted = a.records.length;
  const problems: string[] = [];

  let out: DecisionsBatchResult | null = null;
  try {
    // The production batch function: cache first, bounded live requests, circuit breaker, durable-before-signal. Its signals and failedIds are
    // deliberately ignored below: nothing is saved as analysed and nothing is marked failed.
    out = await classifyWithDecisions({ cfg, store: a.store, records: a.records, state, log: a.log, timeLeftMs: a.timeLeftMs, now: a.nowMs });
  } catch (e) {
    problems.push(`unexpected error: ${(e as Error)?.name ?? 'unknown'}`);
    a.log.error('AI smoke test: Decisions run threw', { error: safeError(e) });
  }

  const rows: SignalAiRow[] = out?.aiRows ?? [];
  rep.succeeded = rows.length;
  rep.failed = out?.failedIds.length ?? 0;
  rep.notCompleted = out?.leftPending ?? 0;
  rep.liveCalls = state.liveCalls;
  rep.cacheHits = state.cacheHits;
  rep.stopped = state.stopped;
  if (state.stopped) problems.push(`engine stopped: ${state.stopped}`);
  if (rep.failed) problems.push(`${rep.failed} unusable response${rep.failed === 1 ? '' : 's'}`);
  if (rep.notCompleted) {
    const parts = [['busy', state.busy], ['cooling down', state.cooldown], ['deferred', state.deferred], ['answer not stored', state.unstored]].filter(([, n]) => (n as number) > 0).map(([l, n]) => `${l} ${n}`);
    problems.push(`${rep.notCompleted} record${rep.notCompleted === 1 ? '' : 's'} got no answer${parts.length ? ` (${parts.join(', ')})` : ''}`);
  }

  // 1. The answer must be in the cache: read each one back through the cache's own path.
  const verified: SignalAiRow[] = [];
  for (const row of rows) {
    const ok = await verifyCacheEntry(a.store, { task: 'decisions', model: cfg.model, configVersion: cfg.configVersion, hash: row.input_hash }, row.cache_id, reviveDecisionsResult);
    if (ok) verified.push(row); else rep.cache.unverified++;
  }
  rep.cache.verified = verified.length;

  // 2. ...and in the model-output table, exactly as production writes it (the model's own numbers, apart from the demand data).
  rep.output = { table: 'dr_signal_ai', expected: verified.length, written: 0 };
  if (verified.length) {
    try {
      rep.output.written = await a.store.saveSignalAi(verified);
    } catch (e) {
      problems.push('dr_signal_ai write failed');
      a.log.warn('AI smoke test: saving AI outputs failed', { error: safeError(e) });
    }
    if (rep.output.written !== rep.output.expected && !problems.includes('dr_signal_ai write failed')) problems.push(`dr_signal_ai stored ${rep.output.written} of ${rep.output.expected} rows`);
  }

  // 3. ...and the usage must be accounted for.
  rep.usage = await accountUsage(a.store, 'decisions', state.usage, state.liveCalls, a.log);
  return settle(rep, problems);
}

// ------------------------------------------------------------------------------------------------ Engine B: LFM3 summary

/** Same rule production uses to state a problem from a post (decisionsToSignal): title first, else the text, at least 10 characters. */
function statementOf(rec: PendingRecord): string | null {
  const text = `${rec.title ?? ''}\n${rec.excerpt ?? ''}`.trim();
  return [cleanStatement(rec.title ?? ''), cleanStatement(text)].find((s) => s.length >= 10) ?? null;
}

async function testLfm3(a: { cfg: OpenRouterConfig; store: AiSmokeStore; records: PendingRecord[]; log: Logger; timeLeftMs: () => number; nowMs: () => number }): Promise<EngineReport> {
  const { cfg } = a;
  const rep = emptyEngine('not_run', LFM3_BASIS, undefined, cfg.model, cfg.configVersion);
  const statements = summaryStatements(a.records.map(statementOf).filter((s): s is string => s !== null));
  if (statements.length === 0) return { ...rep, issue: 'the selected records have no usable problem statement' };
  if (a.timeLeftMs() < MIN_TIME_FOR_LFM3_MS) return { ...rep, issue: 'not enough time left in this invocation to start a summary request' };
  rep.attempted = 1;
  const problems: string[] = [];

  const usage = emptyAiUsage();
  let outcome: CachedOutcome<ClusterSummary> | null = null;
  try {
    // The production cache-first summary function. One request at most; no retry.
    outcome = await summariseClusterCached(cfg, a.store, statements, { usage, log: a.log, now: a.nowMs });
  } catch (e) {
    rep.failed = 1;
    rep.stopped = classifyAiFailure(e).systemic ? failureLabel(e) : null;
    problems.push(`summary request failed: ${failureLabel(e)}`);
    a.log.warn('AI smoke test: LFM3 summary failed', { error: safeError(e) });
  }

  let answered = false;
  let cacheId: string | null = null;
  if (outcome) {
    switch (outcome.status) {
      case 'hit': answered = true; cacheId = outcome.cacheId; break;
      case 'computed':
        if (outcome.stored) { answered = true; cacheId = outcome.cacheId; }
        else problems.push(`a valid summary was returned but not stored (${outcome.notStored ?? 'unknown'})`);
        break;
      case 'busy': problems.push('another worker holds this cache entry (busy)'); break;
      case 'cooldown': problems.push('this input failed recently and is cooling down; no request was made'); break;
      case 'deferred': problems.push(`no request was made (${outcome.reason})`); break;
    }
    if (!answered) rep.notCompleted = 1;
  }
  rep.succeeded = answered ? 1 : 0;
  rep.liveCalls = usage.calls;
  rep.cacheHits = usage.cache_hits;

  if (answered) {
    const hash = await summaryInputHash(statements);
    const ok = await verifyCacheEntry(a.store, { task: 'summary', model: cfg.model, configVersion: cfg.configVersion, hash }, cacheId, (stored) => validateSummary(stored, statements, cfg.model));
    rep.cache = { verified: ok ? 1 : 0, unverified: ok ? 0 : 1 };
  }
  // No output table: summaries are written to real clusters only by normal analysis, and this input is synthetic.
  rep.usage = await accountUsage(a.store, 'summary', usage, usage.calls, a.log);
  return settle(rep, problems);
}

// ------------------------------------------------------------------------------------------------ orchestration

export async function runAiSmokeTest(o: AiSmokeTestOptions): Promise<AiSmokeTestReport> {
  const clock = o.now ?? (() => new Date());
  const nowMs = () => clock().getTime();
  const startedAt = nowMs();
  const budgetMs = o.budgetMs ?? 110_000;
  const timeLeftMs = () => budgetMs - (nowMs() - startedAt);
  const log = o.log ?? consoleLogger;
  const { store, env } = o;

  const dReady = decisionsReadiness(env);
  const lReady = lfm3Readiness(env);
  let decisions = emptyEngine(dReady.ready ? 'not_run' : dReady.status, DECISIONS_BASIS, dReady.ready ? undefined : dReady.issue);
  let lfm3 = emptyEngine(lReady.ready ? 'not_run' : lReady.status, LFM3_BASIS, lReady.ready ? undefined : lReady.issue);
  const records: AiSmokeTestReport['records'] = { candidatesRead: 0, eligible: 0, selected: 0, ids: [] };
  let note: string | undefined;

  const finish = (): AiSmokeTestReport => {
    const tested = [decisions, lfm3].filter((e) => e.status === 'passed' || e.status === 'partial' || e.status === 'failed');
    const overall: AiSmokeTestReport['overall'] =
      tested.length === 0 ? 'nothing_tested'
      : decisions.status === 'passed' && lfm3.status === 'passed' ? 'passed'
      : tested.every((e) => e.status === 'failed') ? 'failed'
      : 'partial';
    return {
      testMode: true, action: 'ai_smoke_test', maxRecords: AI_SMOKE_TEST_MAX_RECORDS, overall, ok: overall === 'passed',
      records, decisions, lfm3, elapsedMs: nowMs() - startedAt, ...(note ? { note } : {}),
    };
  };

  // Nothing enabled and valid: no database access and no network access at all.
  if (!dReady.ready && !lReady.ready) {
    note = 'neither engine is enabled and valid in this environment, so nothing was tested (no database or network access was made)';
    return finish();
  }

  // One smoke test at a time: a double click cannot start a second one. (Repeated inputs are also protected by the cache's own leases.)
  if (!(await store.acquireLock(LOCK_NAME, LOCK_SECONDS))) {
    note = 'another ai_smoke_test is still running or was interrupted (its lock frees itself within 3 minutes)';
    return finish();
  }
  try {
    // Read-only selection: the oldest pending rows, filtered by the same cheap gate production applies. Each slice is a hard cap even if the
    // store over-returns.
    const candidates = (await store.claimPending(AI_SMOKE_TEST_CANDIDATE_WINDOW)).slice(0, AI_SMOKE_TEST_CANDIDATE_WINDOW);
    const eligible = candidates.filter(worthAnalysing);
    const selected = eligible.slice(0, AI_SMOKE_TEST_MAX_RECORDS);
    records.candidatesRead = candidates.length;
    records.eligible = eligible.length;
    records.selected = selected.length;
    records.ids = selected.map((r) => r.id);
    if (selected.length === 0) {
      note = 'no eligible pending records were found, so nothing was sent to any AI engine';
      return finish();
    }

    // Both engines share one client that never retries. Pacing between requests follows the production settings.
    const http = o.http ?? createHttpClient({
      fetchImpl: o.fetchImpl, retries: 0, timeoutMs: 30_000, maxInlineWaitMs: 15_000,
      minIntervalMs: { openrouter: Number(env.OPENROUTER_MIN_INTERVAL_MS) || 1500, decisions: Number(env.DECISIONS_MIN_INTERVAL_MS) || 3500 },
    });

    // The engines run one after the other and independently: neither one's result, failure or breaker state can affect the other.
    const dCfg = dReady.ready ? decisionsConfigFromEnv(env, http) : null;
    if (dCfg) decisions = await testDecisions({ cfg: dCfg, store, records: selected, log, timeLeftMs, nowMs });
    const lCfg = lReady.ready ? openRouterConfigFromEnv(env, http) : null;
    if (lCfg) lfm3 = await testLfm3({ cfg: lCfg, store, records: selected, log, timeLeftMs, nowMs });
    return finish();
  } finally {
    await store.releaseLock(LOCK_NAME).catch(() => undefined);
  }
}
