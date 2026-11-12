// Engine B (LFM3 via the standard chat-completions API): optional cluster summaries.
// Payloads are SYNTHETIC (shaped after OpenRouter's chat-completions schema). These tests prove parsing, validation, caching and failure
// handling - not model quality or live availability.
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractJsonObject, LFM3_DEFAULT_MODEL, openRouterConfigFromEnv, openRouterConfigProblem, OpenRouterConfig, requestClusterSummary, summariseClusterOpenRouter } from '../ai.ts';
import { AiCallError, emptyAiUsage } from '../ai-common.ts';
import { summariseClusterCached, summaryInputHash, summaryStatements } from '../summaries.ts';
import { HttpError, RateLimitError } from '../types.ts';
import { MemoryStore, silentLog } from './helpers.ts';
import { scriptedHttp } from './ai-test-utils.ts';

const STATEMENTS = ['Need offline invoicing, Xero is too expensive', 'Invoice app that works without internet'];
const good = {
  title: 'Offline invoicing for small shops', problem_description: 'Shop owners cannot invoice when the connection drops.', target_persona: 'Small shop owners',
  existing_solutions: ['Xero', 'Invented Corp'], why_current_solutions_fall_short: 'Too expensive for tiny shops.', proposed_solution: 'An offline-first invoicing app that syncs later.',
  suggested_features: ['offline mode', 'sync', 'PDF export'], monetization_hypothesis: 'Hypothesis: low monthly fee.', development_feasibility: 4, caveats: 'Only two statements.',
};
const chat = (content: unknown, finish = 'stop', usage: object = { prompt_tokens: 300, completion_tokens: 120, total_tokens: 420, cost: 0 }) =>
  ({ choices: [{ finish_reason: finish, message: { content } }], usage });
const cfgFor = (http: ReturnType<typeof scriptedHttp>['http'], over: Partial<OpenRouterConfig> = {}): OpenRouterConfig =>
  ({ apiKey: 'sk-or-v1-test-key-not-real', model: LFM3_DEFAULT_MODEL, configVersion: 'summary-v1', http, ...over });
const errKind = (p: Promise<unknown>) => p.then(() => 'no-error', (e) => (e as AiCallError).kind);

// ------------------------------------------------------------------ configuration
test('LFM3 is optional, off by default, free-only, and the old paid default is gone', () => {
  const { http } = scriptedHttp(() => ({}));
  assert.equal(openRouterConfigFromEnv({}, http), null);
  assert.equal(openRouterConfigFromEnv({ OPENROUTER_API_KEY: 'k' }, http), null);
  assert.equal(openRouterConfigFromEnv({ OPENROUTER_ENABLED: 'true' }, http), null, 'enabled without a key stays off');
  assert.equal(openRouterConfigFromEnv({ OPENROUTER_ENABLED: 'false', OPENROUTER_API_KEY: 'k' }, http), null, 'OPENROUTER_ENABLED=false (production) keeps it off');
  const c = openRouterConfigFromEnv({ OPENROUTER_ENABLED: 'true', OPENROUTER_API_KEY: 'k' }, http)!;
  assert.equal(c.model, 'liquid/lfm-3-1.7b:free');
  assert.notEqual(c.model, 'openai/gpt-4o-mini', 'the previous paid default must not come back');
  assert.equal(c.configVersion, 'summary-v1');
  for (const paid of ['openai/gpt-4o-mini', 'liquid/lfm-3-1.7b', 'liquid/lfm-3-1.7b:nitro', 'anthropic/claude-3.5-sonnet']) {
    assert.equal(openRouterConfigFromEnv({ OPENROUTER_ENABLED: 'true', OPENROUTER_API_KEY: 'k', OPENROUTER_MODEL: paid }, http), null, paid);
    assert.match(openRouterConfigProblem({ OPENROUTER_ENABLED: 'true', OPENROUTER_API_KEY: 'k', OPENROUTER_MODEL: paid })!, /not an explicit :free model/);
  }
  assert.equal(openRouterConfigProblem({}), null);
  assert.equal(openRouterConfigFromEnv({ OPENROUTER_ENABLED: 'true', OPENROUTER_API_KEY: 'k', AI_CACHE_VERSION: 'r2' }, http)!.configVersion, 'summary-v1+r2');
});

// ------------------------------------------------------------------ request
test('uses the standard chat-completions endpoint (not the Decisions API) with a free model and no routing fallback', async () => {
  const net = scriptedHttp(() => chat(JSON.stringify(good)));
  await requestClusterSummary(cfgFor(net.http), STATEMENTS);
  const c = net.calls[0];
  assert.equal(c.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.ok(!c.url.includes('/alpha/decisions'));
  assert.equal(c.body.model, 'liquid/lfm-3-1.7b:free');
  assert.equal(c.body.messages[0].role, 'system');
  assert.deepEqual(JSON.parse(c.body.messages[1].content), { statements: STATEMENTS });
  assert.equal(c.body.provider.allow_fallbacks, false);
  assert.ok(c.body.max_tokens >= 1500, 'room for a reasoning model to think and still finish the JSON');
  assert.equal(c.headers.authorization, 'Bearer sk-or-v1-test-key-not-real');
});

// ------------------------------------------------------------------ success and tolerant parsing
test('a valid summary is returned with grounded fields and provider-reported usage', async () => {
  const s = await requestClusterSummary(cfgFor(scriptedHttp(() => chat(JSON.stringify(good))).http), STATEMENTS);
  assert.equal(s.title, 'Offline invoicing for small shops');
  assert.deepEqual(s.existing_solutions, ['Xero'], 'a competitor not present in the statements is dropped');
  assert.equal(s.development_feasibility, 4);
  assert.equal(s.model, 'liquid/lfm-3-1.7b:free');
  assert.deepEqual({ p: s.usage!.prompt_tokens, c: s.usage!.completion_tokens, cost: s.usage!.reported_cost_usd }, { p: 300, c: 120, cost: 0 });
  const noCost = await requestClusterSummary(cfgFor(scriptedHttp(() => chat(JSON.stringify(good), 'stop', { prompt_tokens: 1, completion_tokens: 1 })).http), STATEMENTS);
  assert.equal(noCost.usage!.reported_cost_usd, null, 'unreported cost is null, not zero');
});

test('reasoning-model output is handled: think blocks, code fences and prose around the JSON', () => {
  const j = JSON.stringify(good);
  assert.deepEqual(extractJsonObject(j), good);
  assert.deepEqual(extractJsonObject('```json\n' + j + '\n```'), good);
  assert.deepEqual(extractJsonObject('<think>Let me think { not json }.</think>' + j), good);
  assert.deepEqual(extractJsonObject('Here is the result:\n' + j + '\nHope that helps!'), good);
  assert.equal(extractJsonObject('no json here'), null);
  assert.equal(extractJsonObject('{"title": "cut off'), null);
  assert.equal(extractJsonObject(''), null);
});

// ------------------------------------------------------------------ invalid responses
test('unusable answers are rejected as invalid_response, never returned half-built', async () => {
  const cases: Array<[string, unknown]> = [
    ['empty content', chat('')], ['null content', chat(null)], ['no choices', { choices: [] }], ['no body fields', {}], ['prose only', chat('I cannot help with that.')],
    ['truncated by max_tokens', chat('{"title":"Offline invoicing","problem_description":"Shops cann', 'length')],
    ['reasoning ate the budget', chat(null, 'length')],
    ['fails validation: feasibility 9', chat(JSON.stringify({ ...good, development_feasibility: 9 }))],
    ['fails validation: missing title', chat(JSON.stringify({ ...good, title: undefined }))],
    ['fails validation: feasibility not an integer', chat(JSON.stringify({ ...good, development_feasibility: '4' }))],
    ['JSON array instead of object', chat('[1,2,3]')],
  ];
  for (const [name, body] of cases) {
    assert.equal(await errKind(requestClusterSummary(cfgFor(scriptedHttp(() => body).http), STATEMENTS)), 'invalid_response', name);
  }
  assert.equal(await summariseClusterOpenRouter(cfgFor(scriptedHttp(() => chat('nope')).http), STATEMENTS), null, 'compatibility wrapper: unusable => null');
});

// ------------------------------------------------------------------ API failures and rate limits
test('API failures and rate limits are typed; none of them is retried inside the adapter', async () => {
  const table: Array<[() => Error, string]> = [
    [() => new HttpError('HTTP 429', 429), 'rate_limited'], [() => new RateLimitError('limited', new Date()), 'rate_limited'], [() => new HttpError('HTTP 401', 401), 'auth'],
    [() => new HttpError('HTTP 402', 402), 'quota'], [() => new HttpError('HTTP 404', 404), 'not_found'], [() => new HttpError('HTTP 500', 500), 'unavailable'],
    [() => new HttpError('HTTP 524', 524), 'timeout'], [() => new HttpError('request timeout after 30000ms', 0), 'timeout'], [() => new HttpError('HTTP 400', 400), 'bad_request'],
  ];
  for (const [make, kind] of table) {
    const net = scriptedHttp(() => { throw make(); });
    assert.equal(await errKind(requestClusterSummary(cfgFor(net.http), STATEMENTS)), kind);
    assert.equal(net.calls.length, 1);
  }
  assert.equal(await errKind(requestClusterSummary(cfgFor(scriptedHttp(() => ({ error: { code: 429, message: 'Rate limit exceeded' } })).http), STATEMENTS)), 'rate_limited', 'error reported inside a 200 body');
  await assert.rejects(summariseClusterOpenRouter(cfgFor(scriptedHttp(() => { throw new HttpError('HTTP 429', 429); }).http), STATEMENTS), AiCallError, 'wrapper still throws for service problems');
  const secret = await requestClusterSummary(cfgFor(scriptedHttp(() => { throw new HttpError('HTTP 401 Bearer sk-or-v1-test-key-not-real', 401); }).http), STATEMENTS).catch((e) => e as Error);
  assert.ok(!(secret as Error).message.includes('test-key-not-real'));
});

// ------------------------------------------------------------------ persistent caching of summaries
test('the same cluster is summarised once; equivalent statement sets share one cache entry', async () => {
  const store = new MemoryStore();
  const net = scriptedHttp(() => chat(JSON.stringify(good)));
  const usage = emptyAiUsage();
  const run = (stmts: string[], cfg = cfgFor(net.http)) => summariseClusterCached(cfg, store, stmts, { usage, log: silentLog });
  const first = await run(STATEMENTS);
  assert.equal(first.status, 'computed');
  assert.equal(net.calls.length, 1);
  assert.equal((await run(STATEMENTS)).status, 'hit');
  assert.equal((await run([...STATEMENTS].reverse())).status, 'hit', 'order does not matter');
  assert.equal((await run([STATEMENTS[0], ' ' + STATEMENTS[1] + '  ', STATEMENTS[0]])).status, 'hit', 'whitespace and duplicates do not matter');
  assert.equal(net.calls.length, 1, 'one request for four equivalent asks');
  const hit = await run(STATEMENTS);
  assert.equal(hit.status === 'hit' && hit.value.title, 'Offline invoicing for small shops');
  assert.equal(hit.status === 'hit' && hit.value.usage?.prompt_tokens, 300, 'the stored usage travels with the summary');
  assert.equal((await run([...STATEMENTS, 'A third, new statement'])).status, 'computed', 'changed evidence is a new input');
  assert.equal((await run(STATEMENTS, cfgFor(net.http, { model: 'other/model:free' }))).status, 'computed', 'a different model never reuses it');
  assert.equal((await run(STATEMENTS, cfgFor(net.http, { configVersion: 'summary-v2' }))).status, 'computed', 'a new config version never reuses it');
  assert.deepEqual({ calls: usage.calls, hits: usage.cache_hits, ok: usage.successes, tokens: usage.input_tokens, costKnown: usage.cost_reported_calls }, { calls: 4, hits: 4, ok: 4, tokens: 1200, costKnown: 4 });
  assert.match(await summaryInputHash(STATEMENTS), /^[0-9a-f]{64}$/);
  assert.deepEqual(summaryStatements(['b', 'a', 'a', '  c  ', '']), ['a', 'b', 'c']);
  assert.equal(summaryStatements(Array.from({ length: 50 }, (_, i) => `s${String(i).padStart(2, '0')}`)).length, 20);
});

test('an unusable summary is not cached as a success and is not re-sent on the next attempt', async () => {
  const store = new MemoryStore();
  const net = scriptedHttp(() => chat('prose, no JSON'));
  const usage = emptyAiUsage();
  await assert.rejects(summariseClusterCached(cfgFor(net.http), store, STATEMENTS, { usage }), (e: AiCallError) => e.kind === 'invalid_response');
  const e = [...store.aiCache.values()][0];
  assert.equal(e.status, 'failed');
  assert.equal(e.result, null);
  const again = await summariseClusterCached(cfgFor(net.http), store, STATEMENTS, { usage });
  assert.equal(again.status, 'cooldown');
  assert.equal(net.calls.length, 1, 'no repeated request for the same unchanged cluster');
  assert.equal(usage.failures, 1);
});

test('a rate limit is not cached against the cluster: it can be summarised as soon as the service recovers', async () => {
  const store = new MemoryStore();
  await assert.rejects(summariseClusterCached(cfgFor(scriptedHttp(() => { throw new HttpError('HTTP 429', 429); }).http), store, STATEMENTS, { usage: emptyAiUsage() }), (e: AiCallError) => e.kind === 'rate_limited');
  assert.equal(store.aiCache.size, 0);
  const ok = await summariseClusterCached(cfgFor(scriptedHttp(() => chat(JSON.stringify(good))).http), store, STATEMENTS, { usage: emptyAiUsage() });
  assert.equal(ok.status, 'computed');
});

test('a stored summary that fails re-validation is recomputed, not served', async () => {
  const store = new MemoryStore();
  const net = scriptedHttp(() => chat(JSON.stringify(good)));
  await summariseClusterCached(cfgFor(net.http), store, STATEMENTS, { usage: emptyAiUsage() });
  [...store.aiCache.values()][0].result = { title: 'corrupt' };
  const out = await summariseClusterCached(cfgFor(net.http), store, STATEMENTS, { usage: emptyAiUsage() });
  assert.equal(out.status, 'computed');
  assert.equal(net.calls.length, 2);
});
