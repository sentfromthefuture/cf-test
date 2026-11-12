// TEMPORARY admin diagnostic: runs the existing `ai_smoke_test` action of the `collect` Edge Function and turns its report into
// something a person can read on a phone. Remove together with AiSmokeTestPanel once both AI engines have been verified.
//
// Security notes (the backend remains the only authority; hiding the button is a convenience, not a boundary):
//  - It uses the app's existing Supabase client. supabase-js attaches the signed-in admin's session to the request itself.
//  - The access token is never read into a variable, logged, displayed or stored. Only its presence is checked.
//  - Everything shown is passed through sanitiseText(), and the report's record ids and any unexpected fields are never rendered.

export type EngineStatus = 'passed' | 'partial' | 'failed' | 'disabled' | 'misconfigured' | 'not_run';
export type OverallStatus = 'passed' | 'partial' | 'failed' | 'nothing_tested';
export type Tone = 'ok' | 'warn' | 'fail' | 'neutral';

export interface Row { label: string; value: string; tone: Tone }
export interface EngineView {
  key: 'decisions' | 'lfm3';
  label: string;
  /** The backend's status, or 'unknown' if it is one this page does not recognise. */
  status: EngineStatus | 'unknown';
  /** True only when the backend says passed AND every individual check below agrees. */
  passed: boolean;
  headline: string;
  tone: Tone;
  model: string | null;
  rows: Row[];
}
export interface ParsedReport {
  overall: OverallStatus;
  passed: boolean;
  maxRecords: number;
  records: { candidatesRead: number; eligible: number; selected: number };
  elapsedMs: number;
  note: string | null;
  engines: [EngineView, EngineView];
}

export type SmokeErrorKind = 'session' | 'request' | 'unrecognised';
export class SmokeTestError extends Error {
  constructor(public kind: SmokeErrorKind, message: string) { super(message); this.name = 'SmokeTestError'; }
}

/** The part of the Supabase client this feature needs. The real client from src/lib/supabase.ts satisfies it. */
export interface SmokeTestClient {
  auth: { getSession(): Promise<{ data: { session: { access_token?: string } | null } }> };
  functions: { invoke(name: string, options: { body: { action: string } }): Promise<{ data: unknown; error: unknown }> };
}

// ------------------------------------------------------------------------------------------------ sanitising

/** Plain text that is safe to show: collapsed whitespace, credentials and long opaque strings removed, length capped. */
export function sanitiseText(value: unknown, max = 240): string {
  if (typeof value !== 'string') return '';
  const s = value
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[\w-]*\.[\w-]*\.[\w-]*/g, '[redacted]')
    .replace(/\b(?:sk|pk|sb)[-_][\w-]{8,}/gi, '[redacted]')
    .replace(/\b(api[-_]?key|apikey|token|secret|password|authorization)\s*[:=]\s*\S+/gi, '$1=[redacted]')
    .replace(/[A-Za-z0-9_\-+/=]{32,}/g, '[redacted]');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// ------------------------------------------------------------------------------------------------ interpreting the report

const STATUS_LABEL: Record<EngineStatus, { text: string; tone: Tone }> = {
  passed: { text: 'Passed', tone: 'ok' },
  partial: { text: 'Partly worked', tone: 'warn' },
  failed: { text: 'Failed', tone: 'fail' },
  disabled: { text: 'Not tested: switched off', tone: 'neutral' },
  misconfigured: { text: 'Not tested: misconfigured', tone: 'fail' },
  not_run: { text: 'Not run: nothing to test with', tone: 'warn' },
};
const OVERALL_VALUES: OverallStatus[] = ['passed', 'partial', 'failed', 'nothing_tested'];

function providerRow(e: Record<string, unknown>, usage: Record<string, unknown>): Row {
  const stopped = sanitiseText(e.stopped, 120);
  const live = num(e.liveCalls);
  const hits = num(e.cacheHits);
  const limited = num(usage.rateLimited);
  if (stopped) return { label: 'Provider response', value: `Stopped: ${stopped}`, tone: 'fail' };
  if (limited > 0) return { label: 'Provider response', value: `Rate limited ${plural(limited, 'time')}`, tone: 'warn' };
  if (live > 0) return { label: 'Provider response', value: `${plural(live, 'live call')} answered, no provider error reported`, tone: num(e.failed) > 0 ? 'warn' : 'ok' };
  if (hits > 0) return { label: 'Provider response', value: 'No live call: answered from the cache', tone: 'neutral' };
  return { label: 'Provider response', value: 'No provider call was made', tone: 'neutral' };
}

function usageRow(usage: Record<string, unknown>, attempted: number): Row {
  const recorded = usage.recorded;
  const consistent = usage.consistent !== false;
  if (recorded === 'failed') return { label: 'Usage accounting', value: 'Could not be recorded', tone: 'fail' };
  if (recorded === 'ok') return consistent ? { label: 'Usage accounting', value: 'Recorded; counters agree', tone: 'ok' } : { label: 'Usage accounting', value: 'Recorded, but the counters disagree', tone: 'fail' };
  return { label: 'Usage accounting', value: attempted > 0 ? 'Nothing was recorded' : 'Nothing to record', tone: attempted > 0 ? 'warn' : 'neutral' };
}

function engineView(key: EngineView['key'], label: string, raw: unknown): EngineView | null {
  if (!isObj(raw)) return null;
  const known = typeof raw.status === 'string' && raw.status in STATUS_LABEL;
  const status = (known ? raw.status : 'unknown') as EngineStatus | 'unknown';
  const head = status === 'unknown' ? { text: 'Unrecognised result', tone: 'warn' as Tone } : STATUS_LABEL[status];

  const attempted = num(raw.attempted);
  const succeeded = num(raw.succeeded);
  const cache = isObj(raw.cache) ? raw.cache : {};
  const usage = isObj(raw.usage) ? raw.usage : {};
  const verified = num(cache.verified);
  const unverified = num(cache.unverified);
  const output = isObj(raw.output) ? raw.output : {};

  const rows: Row[] = [];
  const cacheOk = succeeded === 0 ? null : verified === succeeded && unverified === 0;
  const outputOk = output.table ? num(output.written) === num(output.expected) : null;
  const usageRowValue = usageRow(usage, attempted);

  const summary = `${num(raw.succeeded)} usable, ${num(raw.failed)} unusable, ${num(raw.notCompleted)} no answer`;
  if (key === 'decisions') {
    rows.push({ label: 'Records', value: `${attempted} sent to the model (${summary})`, tone: attempted > 0 && succeeded === attempted ? 'ok' : attempted > 0 ? 'warn' : 'neutral' });
  } else {
    rows.push({ label: 'Summary generation', value: attempted === 0 ? 'No summary was requested' : succeeded > 0 ? 'Summary generated and usable' : 'No usable summary', tone: attempted === 0 ? 'neutral' : succeeded > 0 ? 'ok' : 'fail' });
  }
  rows.push(providerRow(raw, usage));
  rows.push({
    label: key === 'decisions' ? 'Persistence' : 'Cache persistence',
    value: cacheOk === null ? 'Not checked (nothing was answered)' : `${verified} of ${succeeded} answers found again in the cache${unverified ? `, ${unverified} could not be verified` : ''}`,
    tone: cacheOk === null ? 'neutral' : cacheOk ? 'ok' : 'fail',
  });
  if (key === 'decisions' && outputOk !== null) {
    rows.push({ label: 'Results table', value: `${num(output.written)} of ${num(output.expected)} rows written`, tone: outputOk ? 'ok' : 'fail' });
  }
  rows.push(usageRowValue);

  const issue = sanitiseText(raw.issue);
  rows.push({ label: 'Error details', value: issue || 'None reported', tone: issue ? (status === 'passed' ? 'warn' : 'fail') : 'neutral' });

  // Trust the individual checks, not just the headline: a "passed" engine with a failed check is not shown as passed.
  const checksAgree = rows.every((r) => r.tone !== 'fail');
  const passed = status === 'passed' && checksAgree;
  const headline = status === 'passed' && !checksAgree ? 'Reported passed, but a check disagrees' : head.text;
  return {
    key, label, status, passed, headline,
    tone: status === 'passed' && !checksAgree ? 'warn' : head.tone,
    model: sanitiseText(raw.model, 80) || null,
    rows,
  };
}

/** Interprets the backend's report. Returns null when the response is not an ai_smoke_test report. Never renders raw fields. */
export function parseAiSmokeReport(raw: unknown): ParsedReport | null {
  if (!isObj(raw) || typeof raw.overall !== 'string' || !OVERALL_VALUES.includes(raw.overall as OverallStatus)) return null;
  const decisions = engineView('decisions', 'Decisions Fast', raw.decisions);
  const lfm3 = engineView('lfm3', 'LFM3', raw.lfm3);
  if (!decisions || !lfm3) return null;
  const records = isObj(raw.records) ? raw.records : {};
  const reported = raw.overall as OverallStatus;
  // HTTP 200 and even overall:"passed" are not taken on trust: both engines must individually pass.
  const overall: OverallStatus = reported === 'passed' && !(decisions.passed && lfm3.passed) ? 'partial' : reported;
  return {
    overall,
    passed: overall === 'passed',
    maxRecords: num(raw.maxRecords),
    records: { candidatesRead: num(records.candidatesRead), eligible: num(records.eligible), selected: num(records.selected) },
    elapsedMs: num(raw.elapsedMs),
    note: sanitiseText(raw.note) || null,
    engines: [decisions, lfm3],
  };
}

// ------------------------------------------------------------------------------------------------ invoking

/** Turns a supabase-js invoke error into a short, safe sentence. Reads the function's own JSON error body when there is one. */
export async function describeInvokeError(error: unknown): Promise<string> {
  const e = (isObj(error) ? error : {}) as { message?: unknown; context?: Response };
  const ctx = e.context;
  const status = ctx && typeof ctx.status === 'number' ? ctx.status : null;
  let detail = '';
  if (ctx && typeof ctx.json === 'function') {
    try {
      const body: unknown = await ctx.json();
      if (isObj(body) && typeof body.error === 'string') detail = sanitiseText(typeof body.detail === 'string' ? `${body.error}: ${body.detail}` : body.error);
    } catch { /* keep the generic message */ }
  }
  const message = typeof e.message === 'string' ? e.message : '';
  const suffix = status ? ` (HTTP ${status})` : '';
  if (status === 401) return `Not authorised. Sign in again with an administrator account.${suffix}`;
  if (status === 403) return `Forbidden. This test is limited to administrators.${suffix}`;
  if (status === 400 && /unknown action/i.test(detail)) return `The deployed collect function does not recognise ai_smoke_test. Deploy the version that includes it first.${suffix}`;
  if (status === null && /failed to send a request/i.test(message)) return 'Could not reach the collect function (not deployed, blocked by the browser, or offline).';
  return `${detail || sanitiseText(message) || 'The test request failed.'}${suffix}`;
}

/** Runs the smoke test once. Throws SmokeTestError. It does not retry. */
export async function runAiSmokeTest(client: SmokeTestClient): Promise<ParsedReport> {
  let hasSession = false;
  try {
    const { data } = await client.auth.getSession();
    hasSession = !!data?.session?.access_token; // presence only: the token itself is never kept
  } catch {
    throw new SmokeTestError('session', 'Could not read your session. Please sign in again.');
  }
  if (!hasSession) throw new SmokeTestError('session', 'Your session has expired. Please sign in again.');

  let result: { data: unknown; error: unknown };
  try {
    result = await client.functions.invoke('collect', { body: { action: 'ai_smoke_test' } });
  } catch (e) {
    throw new SmokeTestError('request', await describeInvokeError(e));
  }
  if (result.error) throw new SmokeTestError('request', await describeInvokeError(result.error));
  if (isObj(result.data) && typeof result.data.error === 'string') throw new SmokeTestError('request', sanitiseText(result.data.error));

  const report = parseAiSmokeReport(result.data);
  if (!report) throw new SmokeTestError('unrecognised', 'The collect function replied, but not with an AI smoke test report. Check that the deployed version includes ai_smoke_test.');
  return report;
}

// ------------------------------------------------------------------------------------------------ UI state (kept out of React so it can be tested)

export type SmokeState =
  | { phase: 'idle' }
  | { phase: 'confirming' }
  | { phase: 'running' }
  | { phase: 'done'; report: ParsedReport; completedAt: string }
  | { phase: 'error'; kind: SmokeErrorKind; message: string };

export interface SmokeController {
  getState(): SmokeState;
  /** First tap: asks for confirmation. Nothing is sent. Ignored while a test is running. */
  request(): void;
  /** Explicit confirmation: starts exactly one run. Ignored unless a confirmation is pending, so a double tap cannot start two. */
  confirm(): Promise<void>;
  cancel(): void;
}

export function createSmokeController(run: () => Promise<ParsedReport>, onChange: (s: SmokeState) => void, now: () => Date = () => new Date()): SmokeController {
  let state: SmokeState = { phase: 'idle' };
  const set = (s: SmokeState) => { state = s; onChange(s); };
  return {
    getState: () => state,
    request() { if (state.phase !== 'running') set({ phase: 'confirming' }); },
    cancel() { if (state.phase === 'confirming') set({ phase: 'idle' }); },
    async confirm() {
      if (state.phase !== 'confirming') return;
      set({ phase: 'running' }); // synchronous: a second tap sees 'running' and returns above
      try {
        const report = await run();
        set({ phase: 'done', report, completedAt: now().toISOString() });
      } catch (e) {
        set(e instanceof SmokeTestError ? { phase: 'error', kind: e.kind, message: e.message } : { phase: 'error', kind: 'request', message: sanitiseText(e instanceof Error ? e.message : '') || 'The test failed unexpectedly.' });
      }
    },
  };
}
