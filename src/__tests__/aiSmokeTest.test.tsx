// Frontend tests for the temporary admin AI smoke test button. No network, no Supabase project, no browser: the client is a fake and the
// UI is rendered to static markup. Run with `bun run test:frontend` (or `npm run test:frontend`).
import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DataSourcesView } from '../components/DataSourcesView';
import { AiSmokeTestPanelView } from '../components/AiSmokeTestPanel';
import { AI_SMOKE_TEST_MAX_RECORDS, createSmokeController, parseAiSmokeReport, runAiSmokeTest, sanitiseText, SmokeState, SmokeTestClient, SmokeTestError } from '../lib/aiSmokeTest';

// ---- fixtures: the shape documented in docs/ai-smoke-test.md
const usage = (o: Record<string, unknown> = {}) => ({ calls: 3, successes: 3, failures: 0, rateLimited: 0, httpRequests: 3, retries: 0, cacheHits: 0, cacheMisses: 3, inputTokens: 0, outputTokens: 0, reportedCostUsd: 0, costReportedCalls: 3, tokensReported: true, consistent: true, recorded: 'ok', ...o });
const decisionsOk = (o: Record<string, unknown> = {}) => ({ status: 'passed', model: 'parallel/decisions-fast:free', attempted: 3, succeeded: 3, failed: 0, notCompleted: 0, liveCalls: 3, cacheHits: 0, stopped: null, cache: { verified: 3, unverified: 0 }, output: { table: 'dr_signal_ai', expected: 3, written: 3 }, usage: usage(), ...o });
const lfm3Ok = (o: Record<string, unknown> = {}) => ({ status: 'passed', model: 'baidu/ernie-5.5-flash-preview:free', attempted: 1, succeeded: 1, failed: 0, notCompleted: 0, liveCalls: 1, cacheHits: 0, stopped: null, cache: { verified: 1, unverified: 0 }, output: { table: null, expected: 0, written: 0 }, usage: usage({ calls: 1, successes: 1, httpRequests: 1, cacheMisses: 1, costReportedCalls: 1 }), ...o });
const failing = (extra: Record<string, unknown> = {}) => ({ status: 'failed', succeeded: 0, failed: 1, stopped: 'auth (HTTP 401)', issue: 'auth (HTTP 401)', cache: { verified: 0, unverified: 0 }, output: { table: null, expected: 0, written: 0 }, usage: usage({ successes: 0, failures: 1 }), ...extra });
const report = (o: Record<string, unknown> = {}) => ({
  testMode: true, action: 'ai_smoke_test', maxRecords: 3, overall: 'passed', ok: true,
  records: { candidatesRead: 12, eligible: 9, selected: 3, ids: ['11111111-1111-1111-1111-111111111111'] },
  decisions: decisionsOk(), lfm3: lfm3Ok(), elapsedMs: 14873, ...o,
});

// ---- fake client: records calls, never touches a network
function fakeClient(opts: { session?: { access_token?: string } | null; sessionThrows?: boolean; invoke?: () => Promise<{ data: unknown; error: unknown }> } = {}) {
  const calls = { getSession: 0, invoke: [] as Array<{ name: string; body: unknown }> };
  const client: SmokeTestClient = {
    auth: { async getSession() { calls.getSession++; if (opts.sessionThrows) throw new Error('storage unavailable'); return { data: { session: 'session' in opts ? opts.session ?? null : { access_token: 'header.payload.signature' } } }; } },
    functions: { async invoke(name, options) { calls.invoke.push({ name, body: options.body }); return opts.invoke ? opts.invoke() : { data: report(), error: null }; } },
  };
  return { client, calls };
}
const okInvoke = (data: unknown) => () => Promise.resolve({ data, error: null });
const jsonError = (status: number, body: unknown) => ({ message: 'Edge Function returned a non-2xx status code', context: new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }) });
const run = (data: unknown) => runAiSmokeTest(fakeClient({ invoke: okInvoke(data) }).client);

const noop = () => undefined;
const view = (state: SmokeState) => renderToStaticMarkup(<AiSmokeTestPanelView state={state} onRequest={noop} onConfirm={noop} onCancel={noop} />);
const dataSources = (isAdmin: boolean) => renderToStaticMarkup(<DataSourcesView sources={[]} status="ready" isAdmin={isAdmin} signedIn={isAdmin} onRefresh={noop} onOpenAuth={noop} />);

// ------------------------------------------------------------------------------------------------ visibility

test('the button is shown to administrators only', () => {
  assert.match(dataSources(true), /Run AI Smoke Test/);
  assert.doesNotMatch(dataSources(false), /Run AI Smoke Test|AI engine check/);
});

test('nothing runs on render or on creating the controller', () => {
  let called = 0;
  createSmokeController(async () => { called++; return (await run(report()))!; }, noop);
  dataSources(true);
  assert.equal(called, 0);
});

// ------------------------------------------------------------------------------------------------ session handling

test('a missing session stops before any request is sent', async () => {
  const { client, calls } = fakeClient({ session: null });
  await assert.rejects(() => runAiSmokeTest(client), (e: unknown) => e instanceof SmokeTestError && e.kind === 'session' && /session has expired/i.test(e.message));
  assert.equal(calls.invoke.length, 0);
});

test('a session without an access token counts as expired', async () => {
  const { client, calls } = fakeClient({ session: {} });
  await assert.rejects(() => runAiSmokeTest(client), (e: unknown) => e instanceof SmokeTestError && e.kind === 'session');
  assert.equal(calls.invoke.length, 0);
});

test('a failure reading the session is reported as a session problem', async () => {
  const { client, calls } = fakeClient({ sessionThrows: true });
  await assert.rejects(() => runAiSmokeTest(client), (e: unknown) => e instanceof SmokeTestError && e.kind === 'session');
  assert.equal(calls.invoke.length, 0);
});

// ------------------------------------------------------------------------------------------------ interpreting results

test('success: invokes collect once with exactly the ai_smoke_test action and shows both engines passed', async () => {
  const { client, calls } = fakeClient();
  const r = await runAiSmokeTest(client);
  assert.deepEqual(calls.invoke, [{ name: 'collect', body: { action: 'ai_smoke_test' } }]);
  assert.equal(r.overall, 'passed');
  assert.deepEqual(r.engines.map((e) => [e.label, e.passed]), [['Decisions Fast', true], ['Summaries', true]]);
  const html = view({ phase: 'done', report: r, completedAt: '2026-11-13T10:00:00.000Z' });
  assert.match(html, /Overall: both engines passed/);
  assert.match(html, /Decisions Fast/);
  assert.match(html, /Summaries/);
  assert.match(html, /dateTime="2026-11-13T10:00:00.000Z"/);
});

test('Decisions Fast fails while the summary engine succeeds (HTTP 200 is not treated as success)', async () => {
  const r = await run(report({ overall: 'partial', ok: false, decisions: decisionsOk(failing({ attempted: 3, failed: 3, liveCalls: 3 })) }));
  assert.equal(r.overall, 'partial');
  const [d, l] = r.engines;
  assert.equal(d.passed, false); assert.equal(d.tone, 'fail');
  assert.equal(l.passed, true);
  assert.ok(d.rows.some((x) => x.label === 'Provider response' && /Stopped: auth \(HTTP 401\)/.test(x.value)));
  const html = view({ phase: 'done', report: r, completedAt: '2026-11-13T10:00:00.000Z' });
  assert.match(html, /Overall: partial/);
});

test('the summary engine fails while Decisions Fast succeeds', async () => {
  const r = await run(report({ overall: 'partial', ok: false, lfm3: lfm3Ok(failing({ attempted: 1, liveCalls: 1, stopped: 'rate_limited (HTTP 429)', issue: 'rate_limited (HTTP 429)', usage: usage({ calls: 1, successes: 0, failures: 1, rateLimited: 1 }) })) }));
  const [d, l] = r.engines;
  assert.equal(d.passed, true);
  assert.equal(l.passed, false); assert.equal(l.tone, 'fail');
  assert.ok(l.rows.some((x) => x.label === 'Provider response' && /rate_limited \(HTTP 429\)/.test(x.value)));
  assert.ok(l.rows.some((x) => x.label === 'Summary generation' && x.tone === 'fail'));
});

test('both engines fail', async () => {
  const r = await run(report({ overall: 'failed', ok: false, decisions: decisionsOk(failing({ attempted: 3, failed: 3 })), lfm3: lfm3Ok(failing()) }));
  assert.equal(r.overall, 'failed');
  assert.equal(r.passed, false);
  assert.deepEqual(r.engines.map((e) => e.passed), [false, false]);
  assert.match(view({ phase: 'done', report: r, completedAt: '2026-11-13T10:00:00.000Z' }), /Overall: failed/);
});

test('a disabled engine is "not tested", never a pass', async () => {
  const r = await run(report({ overall: 'partial', ok: false, lfm3: { ...lfm3Ok(), status: 'disabled', attempted: 0, succeeded: 0, liveCalls: 0, cache: { verified: 0, unverified: 0 }, issue: 'OPENROUTER_ENABLED is not "true"', usage: usage({ calls: 0, recorded: 'nothing_to_record' }) } }));
  assert.equal(r.engines[1].passed, false);
  assert.match(r.engines[1].headline, /Not tested/);
});

test('"passed" from the backend is downgraded when persistence or usage checks disagree', async () => {
  const r = await run(report({ decisions: decisionsOk({ cache: { verified: 2, unverified: 1 } }) }));
  assert.equal(r.engines[0].passed, false);
  assert.match(r.engines[0].headline, /check disagrees/);
  assert.equal(r.overall, 'partial');
  const r2 = await run(report({ lfm3: lfm3Ok({ usage: usage({ recorded: 'failed' }) }) }));
  assert.equal(r2.engines[1].passed, false);
  assert.equal(r2.overall, 'partial');
});

test('a response that is not an ai_smoke_test report is rejected, not shown as success', async () => {
  const collection = { sources: [{ id: 'github', status: 'ok' }], analysis: null };
  await assert.rejects(() => run(collection), (e: unknown) => e instanceof SmokeTestError && e.kind === 'unrecognised');
  await assert.rejects(() => run(null), (e: unknown) => e instanceof SmokeTestError && e.kind === 'unrecognised');
  await assert.rejects(() => run({ overall: 'passed' }), (e: unknown) => e instanceof SmokeTestError && e.kind === 'unrecognised');
});

test('an unfamiliar engine status is surfaced as unrecognised, not as a pass', () => {
  const r = parseAiSmokeReport(report({ decisions: decisionsOk({ status: 'excellent' }) }));
  assert.ok(r);
  assert.equal(r.engines[0].status, 'unknown');
  assert.equal(r.engines[0].passed, false);
  assert.equal(r.overall, 'partial');
});

// ------------------------------------------------------------------------------------------------ strict identification of a report

/** A copy of the valid fixture with `key` removed (not set to undefined: a missing field and an undefined one are different on the wire). */
const without = (key: string, from: Record<string, unknown> = report()) => { const { [key]: _removed, ...rest } = from; return rest; };
const withRecords = (o: Record<string, unknown>) => report({ records: { candidatesRead: 12, eligible: 9, selected: 3, ...o } });
const withoutRecordsKey = (key: string) => report({ records: without(key, { candidatesRead: 12, eligible: 9, selected: 3 }) });
const expectRejected = async (data: unknown) => {
  assert.equal(parseAiSmokeReport(data), null);
  await assert.rejects(() => run(data), (e: unknown) => e instanceof SmokeTestError && e.kind === 'unrecognised');
};

test('the valid fixture is accepted, and the ceiling mirrors the backend\'s 3', () => {
  assert.equal(AI_SMOKE_TEST_MAX_RECORDS, 3);
  assert.ok(parseAiSmokeReport(report()));
});

test('rejected: testMode is missing, false or not the boolean true', async () => {
  await expectRejected(without('testMode'));
  for (const bad of [false, 'true', 1, null]) await expectRejected(report({ testMode: bad }));
});

test('rejected: action is missing or is not ai_smoke_test (including another action\'s test-mode report)', async () => {
  await expectRejected(without('action'));
  for (const bad of ['analysis_test', 'reanalyse', 'AI_SMOKE_TEST', '', null, ['ai_smoke_test']]) await expectRejected(report({ action: bad }));
  // an analysis_test response also carries testMode:true and a maxRecords, but not the ai_smoke_test action or engine results
  await expectRejected({ testMode: true, action: 'analysis_test', maxRecords: 10, method: 'heuristic', ran: true });
});

test('rejected: either engine result object is missing or is not an object', async () => {
  await expectRejected(without('decisions'));
  await expectRejected(without('lfm3'));
  for (const bad of [null, 'passed', 7, ['passed'], true]) {
    await expectRejected(report({ decisions: bad }));
    await expectRejected(report({ lfm3: bad }));
  }
});

test('rejected: the record count is missing', async () => {
  await expectRejected(without('records'));
  await expectRejected(report({ records: null }));
  await expectRejected(report({ records: [3] }));
  await expectRejected(withoutRecordsKey('selected'));
  await expectRejected(without('maxRecords'));
});

test('rejected: the record count is above the maximum of 3, negative, fractional or not a number', async () => {
  for (const bad of [4, 10, 1000, -1, 2.5, NaN, Infinity, '3', null, true]) await expectRejected(withRecords({ selected: bad }));
  for (const bad of [4, 10, 0, -3, 2.5, NaN, '3', null]) await expectRejected(report({ maxRecords: bad }));
  await expectRejected(report({ maxRecords: 2, records: { candidatesRead: 12, eligible: 9, selected: 3 } })); // used more than the report's own limit
});

test('accepted: every in-range record count, including none selected', async () => {
  for (const selected of [0, 1, 2, 3]) {
    const r = await run(withRecords({ selected }));
    assert.equal(r.records.selected, selected);
    assert.equal(r.maxRecords, 3);
  }
  const lower = await run(report({ maxRecords: 2, records: { candidatesRead: 12, eligible: 9, selected: 2 } }));
  assert.equal(lower.maxRecords, 2);
});

test('a rejected response ends in an "unrecognised" error state and never shows a report or a pass', async () => {
  const c = createSmokeController(() => run(report({ testMode: false })), noop);
  c.request(); await c.confirm();
  const s = c.getState();
  assert.equal(s.phase, 'error');
  assert.equal(s.phase === 'error' && s.kind, 'unrecognised');
  const html = view(s);
  assert.match(html, /Unrecognised response/);
  assert.doesNotMatch(html, /Overall:|smoke-report|both engines passed/);
});

// ------------------------------------------------------------------------------------------------ what the panel says it does

test('the panel description states what the test does and does not change', () => {
  const text = view({ phase: 'idle' }).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  assert.match(text, /at most 3 existing pending records/);
  assert.match(text, /Collects no new source data/);
  assert.match(text, /does not change pending record statuses/);
  assert.match(text, /may update the AI cache, dr_signal_ai, usage counters and a temporary lock/);
  assert.doesNotMatch(text, /changes no records|Collects nothing new/);
});

test('the confirmation step lists the same side effects before anything is sent', () => {
  const text = view({ phase: 'confirming' }).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  assert.match(text, /may update the AI cache, dr_signal_ai, usage counters and a temporary lock/);
  assert.match(text, /one attempt each, no retries/);
});

// ------------------------------------------------------------------------------------------------ confirmation, loading, duplicates

test('confirmation is required: the first tap sends nothing, cancel sends nothing', async () => {
  let called = 0;
  const states: string[] = [];
  const c = createSmokeController(async () => { called++; return (await run(report()))!; }, (s) => states.push(s.phase));
  c.request();
  assert.equal(c.getState().phase, 'confirming');
  assert.equal(called, 0);
  assert.match(view(c.getState()), /Run the AI smoke test now\?/);
  c.cancel();
  assert.equal(c.getState().phase, 'idle');
  await c.confirm(); // no pending confirmation: ignored
  assert.equal(called, 0);
  assert.deepEqual(states, ['confirming', 'idle']);
});

test('loading state disables the button, and repeated taps start only one run', async () => {
  let release: (v: unknown) => void = noop;
  let called = 0;
  const gate = new Promise((r) => { release = r; });
  const c = createSmokeController(async () => { called++; await gate; return (await run(report()))!; }, noop, () => new Date('2026-11-13T10:00:00Z'));
  c.request();
  const first = c.confirm();
  const second = c.confirm(); // double tap on "Yes, run the test"
  c.request();                // tap on the main button while running
  assert.equal(c.getState().phase, 'running');
  assert.equal(called, 1);
  const html = view(c.getState());
  assert.match(html, /<button[^>]*disabled[^>]*>/);
  assert.match(html, /aria-busy="true"/);
  assert.match(html, /Running/);
  assert.doesNotMatch(html, /Yes, run the test/);
  release(undefined);
  await Promise.all([first, second]);
  assert.equal(called, 1);
  const done = c.getState();
  assert.equal(done.phase, 'done');
  assert.equal(done.phase === 'done' && done.completedAt, '2026-11-13T10:00:00.000Z');
});

test('after a finished run, the test can be started again only through a new confirmation', async () => {
  let called = 0;
  const c = createSmokeController(async () => { called++; return (await run(report()))!; }, noop);
  c.request(); await c.confirm();
  assert.equal(called, 1);
  await c.confirm();
  assert.equal(called, 1);
  c.request();
  assert.equal(c.getState().phase, 'confirming');
  assert.equal(called, 1);
});

test('a failed run ends in an error state and can be retried after confirmation', async () => {
  const c = createSmokeController(() => runAiSmokeTest(fakeClient({ session: null }).client), noop);
  c.request(); await c.confirm();
  const s = c.getState();
  assert.equal(s.phase, 'error');
  assert.match(view(s), /Session problem/);
  c.request();
  assert.equal(c.getState().phase, 'confirming');
});

// ------------------------------------------------------------------------------------------------ sanitising

const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnopqrstuvwxyz012345';
const KEY = 'sk-or-v1-0123456789abcdef0123456789abcdef';

test('sanitiseText removes tokens, keys and long opaque strings', () => {
  const out = sanitiseText(`Bearer ${JWT} and ${KEY} apikey=abc123 ${'A'.repeat(60)} ok`);
  assert.doesNotMatch(out, /eyJ|sk-or|abc123|AAAAAAAA/);
  assert.match(out, /ok$/);
  assert.equal(sanitiseText(42), '');
  assert.ok(sanitiseText('x '.repeat(500)).length <= 240);
});

test('request errors show the function\'s message with secrets removed', async () => {
  const { client } = fakeClient({ invoke: () => Promise.resolve({ data: null, error: jsonError(500, { error: 'collect failed', detail: `Bearer ${JWT} ${KEY}` }) }) });
  const e = await runAiSmokeTest(client).then(() => null, (x: unknown) => x as SmokeTestError);
  assert.ok(e instanceof SmokeTestError);
  assert.equal(e.kind, 'request');
  assert.match(e.message, /collect failed/);
  assert.match(e.message, /HTTP 500/);
  assert.doesNotMatch(e.message, /eyJ|sk-or/);
  assert.doesNotMatch(view({ phase: 'error', kind: e.kind, message: e.message }), /eyJ|sk-or/);
});

test('401, 403, unknown-action and network errors get plain-language messages', async () => {
  const msg = async (error: unknown) => { const e = await runAiSmokeTest(fakeClient({ invoke: () => Promise.resolve({ data: null, error }) }).client).then(() => null, (x: unknown) => x as SmokeTestError); return e?.message ?? ''; };
  assert.match(await msg(jsonError(401, { error: 'unauthorized' })), /Not authorised/);
  assert.match(await msg(jsonError(403, { error: 'forbidden' })), /limited to administrators/);
  assert.match(await msg(jsonError(400, { error: 'unknown action', supported: ['reanalyse'] })), /does not recognise ai_smoke_test/);
  assert.match(await msg({ message: 'Failed to send a request to the Edge Function' }), /Could not reach the collect function/);
});

test('a thrown error or an error body inside a 200 is handled and sanitised', async () => {
  const thrown = fakeClient({ invoke: () => Promise.reject(new Error(`network down ${KEY}`)) });
  const e1 = await runAiSmokeTest(thrown.client).then(() => null, (x: unknown) => x as SmokeTestError);
  assert.ok(e1 && e1.kind === 'request' && !/sk-or/.test(e1.message));
  const e2 = await run({ error: `bad ${JWT}` }).then(() => null, (x: unknown) => x as SmokeTestError);
  assert.ok(e2 && e2.kind === 'request' && !/eyJ/.test(e2.message));
});

test('engine issue text and notes from the backend are sanitised before display', async () => {
  const r = await run(report({ overall: 'partial', ok: false, note: `see ${KEY}`, lfm3: lfm3Ok({ status: 'partial', issue: `provider said Bearer ${JWT}` }) }));
  const html = view({ phase: 'done', report: r, completedAt: '2026-11-13T10:00:00.000Z' });
  assert.doesNotMatch(html, /eyJ|sk-or/);
  assert.match(html, /redacted/);
});

test('record ids, record content and unexpected fields are never rendered', async () => {
  const r = await run(report({ records: { candidatesRead: 12, eligible: 9, selected: 3, ids: ['22222222-2222-2222-2222-222222222222'], titles: ['Private customer complaint'] }, debug: { OPENROUTER_API_KEY: KEY }, decisions: decisionsOk({ excerpt: 'raw record text' }) }));
  const html = view({ phase: 'done', report: r, completedAt: '2026-11-13T10:00:00.000Z' });
  assert.doesNotMatch(html, /22222222|Private customer|raw record text|sk-or|OPENROUTER_API_KEY/);
});
