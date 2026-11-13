// LFM3 (OpenRouter chat completions): what a response can look like, which of them are usable, and how each unusable one is reported.
// Payloads are SYNTHETIC. They follow OpenRouter's documented chat-completions schema (choices[].finish_reason / native_finish_reason /
// error / message.{content,reasoning}, usage.completion_tokens_details.reasoning_tokens) - they are NOT captured production responses, and
// no request is ever made. They prove parsing, classification, diagnostics and accounting, not model quality or live availability.
import test from 'node:test';
import assert from 'node:assert/strict';
import { describeChatCompletion, extractJsonObject, LFM3_DEFAULT_MODEL, OpenRouterConfig, openRouterConfigFromEnv, requestClusterSummary, splitInlineReasoning, SUMMARY_CONFIG_VERSION, SUMMARY_MAX_TOKENS, summaryValidationProblem, validateSummary } from '../ai.ts';
import { AiCallError, AiFailureReason, describeAiFailure, emptyAiUsage, meteredCall } from '../ai-common.ts';
import { summariseClusterCached } from '../summaries.ts';
import { HttpError, Logger } from '../types.ts';
import { MemoryStore } from './helpers.ts';
import { scriptedHttp } from './ai-test-utils.ts';

const KEY = 'sk-or-v1-test-key-not-real';
const STATEMENTS = ['Need offline invoicing, Xero is too expensive', 'Invoice app that works without internet'];
const good = {
  title: 'Offline invoicing for small shops', problem_description: 'Shop owners cannot invoice when the connection drops.', target_persona: 'Small shop owners',
  existing_solutions: ['Xero'], why_current_solutions_fall_short: 'Too expensive for tiny shops.', proposed_solution: 'An offline-first invoicing app that syncs later.',
  suggested_features: ['offline mode', 'sync', 'PDF export'], monetization_hypothesis: 'Hypothesis: low monthly fee.', development_feasibility: 4, caveats: 'Only two statements.',
};

/** A full chat-completions body in the documented shape. `message` is merged over { role, refusal: null }. */
const orBody = (message: Record<string, unknown>, o: { finish?: unknown; native?: unknown; usage?: object | null; choice?: object; top?: object } = {}) => ({
  id: 'gen-test-1', object: 'chat.completion', created: 1_762_000_000, provider: 'Liquid', model: 'liquid/lfm-3-1.7b-20261106:free',
  choices: [{ index: 0, logprobs: null, finish_reason: o.finish ?? 'stop', native_finish_reason: o.native ?? o.finish ?? 'stop', message: { role: 'assistant', refusal: null, ...message }, ...(o.choice ?? {}) }],
  ...(o.usage === null ? {} : { usage: o.usage ?? { prompt_tokens: 310, completion_tokens: 140, total_tokens: 450, cost: 0, completion_tokens_details: { reasoning_tokens: 40 } } }),
  ...(o.top ?? {}),
});

const cfgFor = (http: ReturnType<typeof scriptedHttp>['http'], over: Partial<OpenRouterConfig> = {}): OpenRouterConfig =>
  ({ apiKey: KEY, model: LFM3_DEFAULT_MODEL, configVersion: SUMMARY_CONFIG_VERSION, http, ...over });

test('LFM3 cache identity uses the current summary configuration version', () => {
  const cfg = openRouterConfigFromEnv({ OPENROUTER_ENABLED: 'true', OPENROUTER_API_KEY: KEY }, scriptedHttp(() => ({})).http);
  assert.ok(cfg);
  assert.equal(SUMMARY_CONFIG_VERSION, 'summary-v2');
  assert.equal(cfg.configVersion, 'summary-v2');
});
const callWith = (body: unknown, log?: Logger) => requestClusterSummary(cfgFor(scriptedHttp(() => body).http), STATEMENTS, { log });
const errOf = (p: Promise<unknown>) => p.then(() => { throw new Error('expected a failure but the call succeeded'); }, (e) => e as AiCallError);
function capture() {
  const entries: Array<{ level: string; msg: string; extra?: Record<string, unknown> }> = [];
  const log: Logger = { info: (msg, extra) => entries.push({ level: 'info', msg, extra }), warn: (msg, extra) => entries.push({ level: 'warn', msg, extra }), error: (msg, extra) => entries.push({ level: 'error', msg, extra }) };
  return { entries, log };
}

// ------------------------------------------------------------------ the documented success shape
test('a documented-shape response is accepted: content is the answer, reasoning is ignored, usage is kept as reported', async () => {
  const s = await callWith(orBody({ content: JSON.stringify(good), reasoning: 'The statements agree that offline use matters...' }));
  assert.equal(s.title, good.title);
  assert.equal(s.model, LFM3_DEFAULT_MODEL, 'the configured slug is what is recorded');
  assert.deepEqual({ p: s.usage!.prompt_tokens, c: s.usage!.completion_tokens, t: s.usage!.total_tokens, cost: s.usage!.reported_cost_usd, provider: s.usage!.provider }, { p: 310, c: 140, t: 450, cost: 0, provider: 'openrouter' });

  // content delivered as an array of text parts is also a documented shape
  const parts = await callWith(orBody({ content: [{ type: 'text', text: JSON.stringify(good).slice(0, 40) }, { type: 'text', text: JSON.stringify(good).slice(40) }] }));
  assert.equal(parts.title, good.title);

  // reasoning wrapped in <think> inside the content, and a fenced answer, still parse
  assert.equal((await callWith(orBody({ content: `<think>hm {not json}</think>\n\`\`\`json\n${JSON.stringify(good)}\n\`\`\`` }))).title, good.title);
});

test('the answer is never taken from the reasoning field: validation is not weakened to make a response pass', async () => {
  // Valid JSON, but only in `reasoning` - the model never wrote an answer.
  const e = await errOf(callWith(orBody({ content: '', reasoning: JSON.stringify(good) })));
  assert.equal(e.kind, 'invalid_response');
  assert.equal(e.detail?.reason, 'empty_content');
  assert.equal((await errOf(callWith(orBody({ content: null, reasoning: JSON.stringify(good) })))).detail?.reason, 'empty_content');
});

// ------------------------------------------------------------------ every unusable response names its reason
test('each way a response can be unusable gets its own reason, with the facts that explain it', async () => {
  const j = JSON.stringify(good);
  const full = { usage: { prompt_tokens: 300, completion_tokens: SUMMARY_MAX_TOKENS, total_tokens: 300 + SUMMARY_MAX_TOKENS, cost: 0 } };
  const cases: Array<[string, unknown, AiFailureReason, Record<string, unknown>]> = [
    ['no body fields', {}, 'no_choices', { choices: 0 }],
    ['empty choices', { choices: [] }, 'no_choices', { choices: 0 }],
    ['body is JSON null', null, 'no_choices', { choices: 0 }],
    ['choices[0] is not an object', { choices: ['x'] }, 'no_choices', {}],
    ['empty string content', orBody({ content: '' }), 'empty_content', { contentType: 'string', contentChars: 0, finishReason: 'stop' }],
    ['whitespace-only content', orBody({ content: '  \n ' }), 'empty_content', { contentType: 'string', contentChars: 4 }],
    ['null content', orBody({ content: null }), 'empty_content', { contentType: 'null' }],
    ['content missing', orBody({}), 'empty_content', { contentType: 'missing' }],
    ['null content but reasoning present', orBody({ content: null, reasoning: 'thinking '.repeat(50) }), 'empty_content', { reasoningChars: 450 }],
    ['reasoning ate the whole budget', orBody({ content: null, reasoning: 'x'.repeat(900) }, { finish: 'length', ...full }), 'reasoning_exhausted_budget', { finishReason: 'length', completionTokens: SUMMARY_MAX_TOKENS, maxTokens: SUMMARY_MAX_TOKENS, reasoningChars: 900 }],
    ['empty content, finish_reason=length', orBody({ content: '' }, { finish: 'length' }), 'reasoning_exhausted_budget', { finishReason: 'length' }],
    ['JSON cut off by max_tokens', orBody({ content: j.slice(0, 120) }, { finish: 'length' }), 'truncated_json', { finishReason: 'length', contentChars: 120 }],
    ['prose only', orBody({ content: 'I cannot help with that.' }), 'no_json', { contentType: 'string' }],
    ['unclosed JSON but finish_reason=stop', orBody({ content: '{"title": "cut off' }), 'no_json', {}],
    ['JSON array', orBody({ content: '[1,2,3]' }), 'not_an_object', {}],
    ['JSON string', orBody({ content: '"just a string"' }), 'not_an_object', {}],
    ['JSON number', orBody({ content: '42' }), 'not_an_object', {}],
  ];
  for (const [name, body, reason, facts] of cases) {
    const e = await errOf(callWith(body));
    assert.equal(e.kind, 'invalid_response', name);
    assert.equal(e.detail?.reason, reason, name);
    for (const [k, v] of Object.entries(facts)) assert.equal((e.detail as unknown as Record<string, unknown>)[k], v, `${name}: ${k}`);
  }
  // HTTP 200 with a body that is not JSON (the client throws this before the adapter sees a body)
  const net = scriptedHttp(() => { throw new HttpError('malformed JSON response', 200); });
  const e = await errOf(requestClusterSummary(cfgFor(net.http), STATEMENTS));
  assert.deepEqual({ kind: e.kind, reason: e.detail?.reason, http: e.detail?.httpStatus, calls: net.calls.length }, { kind: 'invalid_response', reason: 'response_not_json', http: 200, calls: 1 });
});

test('summary validation is still strict, and the report names the failing field', async () => {
  const bad: Array<[string, Record<string, unknown>, string]> = [
    ['missing title', { ...good, title: undefined }, 'title'],
    ['title is a number', { ...good, title: 7 }, 'title'],
    ['missing problem_description', { ...good, problem_description: undefined }, 'problem_description'],
    ['missing proposed_solution', { ...good, proposed_solution: undefined }, 'proposed_solution'],
    ['feasibility is a string', { ...good, development_feasibility: '4' }, 'development_feasibility'],
    ['feasibility is a fraction', { ...good, development_feasibility: 3.5 }, 'development_feasibility'],
    ['feasibility above range', { ...good, development_feasibility: 9 }, 'development_feasibility'],
    ['feasibility below range', { ...good, development_feasibility: 0 }, 'development_feasibility'],
    ['feasibility missing', { ...good, development_feasibility: undefined }, 'development_feasibility'],
    ['empty object', {}, 'title'],
  ];
  for (const [name, summary, field] of bad) {
    const e = await errOf(callWith(orBody({ content: JSON.stringify(summary) })));
    assert.equal(e.kind, 'invalid_response', name);
    assert.deepEqual({ reason: e.detail?.reason, field: e.detail?.field }, { reason: 'schema_invalid', field }, name);
  }
});

test('the diagnostic and the real validation can never disagree', () => {
  const corpus: unknown[] = [good, {}, [], null, undefined, 'x', 7, { ...good, title: 1 }, { ...good, development_feasibility: 5 }, { ...good, development_feasibility: 1 }, { ...good, development_feasibility: 6 },
    { ...good, development_feasibility: NaN }, { ...good, development_feasibility: null }, { ...good, proposed_solution: null }, { title: 'a', problem_description: 'b', proposed_solution: 'c', development_feasibility: 3 }];
  for (const raw of corpus) {
    assert.equal(validateSummary(raw, STATEMENTS, 'm') === null, summaryValidationProblem(raw) !== null, JSON.stringify(raw));
  }
});

// ------------------------------------------------------------------ failures that are about the service, not about the cluster
test('a per-choice error, finish_reason=error and content_filter are classified as what they are, not as a bad summary', async () => {
  const rl = await errOf(callWith(orBody({ content: null }, { finish: 'error', choice: { error: { code: 429, message: 'Rate limit exceeded' } } })));
  assert.deepEqual({ kind: rl.kind, status: rl.status, reason: rl.detail?.reason, systemic: rl.systemic }, { kind: 'rate_limited', status: 429, reason: 'provider_error', systemic: true });
  const up = await errOf(callWith(orBody({ content: '' }, { choice: { error: { code: 502, message: 'upstream failed' } } })));
  assert.deepEqual({ kind: up.kind, reason: up.detail?.reason, systemic: up.systemic }, { kind: 'unavailable', reason: 'provider_error', systemic: true });
  const odd = await errOf(callWith(orBody({ content: '' }, { choice: { error: 'not an object' } })));
  assert.equal(odd.systemic, true, 'an unrecognised error shape is treated cautiously, as a service problem');
  const fe = await errOf(callWith(orBody({ content: '' }, { finish: 'error' })));
  assert.deepEqual({ kind: fe.kind, reason: fe.detail?.reason, systemic: fe.systemic }, { kind: 'unavailable', reason: 'provider_error', systemic: true });
  const cf = await errOf(callWith(orBody({ content: '' }, { finish: 'content_filter' })));
  assert.deepEqual({ kind: cf.kind, reason: cf.detail?.reason, systemic: cf.systemic }, { kind: 'refused', reason: 'content_filtered', systemic: false });
  // an error object in a 200 body is still handled exactly as before
  assert.equal((await errOf(callWith({ error: { code: 429, message: 'limited' } }))).kind, 'rate_limited');
});

test('a service-level failure is never recorded against the cluster; an unusable answer is', async () => {
  for (const [name, body] of [['choice error', orBody({ content: null }, { choice: { error: { code: 503, message: 'x' } } })], ['finish_reason=error', orBody({ content: '' }, { finish: 'error' })]] as const) {
    const store = new MemoryStore();
    const e = await errOf(summariseClusterCached(cfgFor(scriptedHttp(() => body).http), store, STATEMENTS, { usage: emptyAiUsage() }));
    assert.equal(e.systemic, true, name);
    assert.equal(store.aiCache.size, 0, `${name}: the lease is released, so no cooldown is stored for the cluster`);
  }
  const store = new MemoryStore();
  await errOf(summariseClusterCached(cfgFor(scriptedHttp(() => orBody({ content: 'prose' })).http), store, STATEMENTS, { usage: emptyAiUsage() }));
  const entry = [...store.aiCache.values()][0];
  assert.deepEqual({ status: entry.status, result: entry.result, last: entry.lastFailure }, { status: 'failed', result: null, last: 'invalid_response' });
});

// ------------------------------------------------------------------ diagnostics never carry content or credentials
test('diagnostic logging carries shapes and counts only: no record text, no model output, no key, no header', async () => {
  const canaries = ['CANARY-STATEMENT-TEXT', 'CANARY-MODEL-OUTPUT', 'CANARY-REASONING-TEXT', 'CANARY-PROVIDER-MESSAGE', 'CANARY-HOSTILE'];
  const statements = ['CANARY-STATEMENT-TEXT needs offline invoicing', 'another CANARY-STATEMENT-TEXT statement'];
  const bodies = [
    orBody({ content: 'CANARY-MODEL-OUTPUT {broken', reasoning: 'CANARY-REASONING-TEXT' }, { finish: 'length' }),
    orBody({ content: JSON.stringify({ ...good, title: 'CANARY-MODEL-OUTPUT', development_feasibility: 'CANARY-MODEL-OUTPUT' }) }),
    orBody({ content: null }, { choice: { error: { code: 502, message: 'CANARY-PROVIDER-MESSAGE Bearer sk-or-v1-test-key-not-real' } } }),
    // hostile identifiers from the provider must be neutralised, not echoed
    orBody({ content: '' }, { finish: 'CANARY-HOSTILE finish\nreason', native: 'x y', top: { model: 'CANARY-HOSTILE model!', provider: 'CANARY-HOSTILE <script>' } }),
  ];
  const { entries, log } = capture();
  const seen: string[] = [];
  for (const body of bodies) {
    const e = await errOf(requestClusterSummary(cfgFor(scriptedHttp(() => body).http), statements, { log }));
    seen.push(e.message, JSON.stringify(e.detail), describeAiFailure(e), e.stack ?? '');
  }
  seen.push(JSON.stringify(entries));
  assert.equal(entries.length, bodies.length, 'one diagnostic line per unusable response');
  const blob = seen.join('\n');
  for (const c of canaries) assert.ok(!blob.includes(c), `leaked ${c}`);
  for (const c of [KEY, 'Bearer', 'authorization', 'sk-or-']) assert.ok(!blob.toLowerCase().includes(c.toLowerCase()), `leaked ${c}`);

  const first = entries[0];
  assert.equal(first.level, 'warn');
  assert.deepEqual(
    { reason: first.extra!.reason, finish: first.extra!.finishReason, type: first.extra!.contentType, chars: first.extra!.contentChars, rchars: first.extra!.reasoningChars, completion: first.extra!.completionTokens, max: first.extra!.maxTokens, model: first.extra!.model, provider: first.extra!.provider, served: first.extra!.servedModel },
    { reason: 'truncated_json', finish: 'length', type: 'string', chars: 'CANARY-MODEL-OUTPUT {broken'.length, rchars: 'CANARY-REASONING-TEXT'.length, completion: 140, max: SUMMARY_MAX_TOKENS, model: LFM3_DEFAULT_MODEL, provider: 'Liquid', served: 'liquid/lfm-3-1.7b-20261106:free' },
  );
  assert.equal(entries[1].extra!.field, 'development_feasibility', 'validation failures name the field, never its value');
  assert.equal(entries[3].extra!.finishReason, 'unrecognised');
  assert.equal(entries[3].extra!.nativeFinishReason, 'unrecognised');
  assert.equal(entries[3].extra!.servedModel, undefined);
  assert.equal(entries[3].extra!.provider, undefined);
});

test('describeChatCompletion tolerates any body and reports no text', () => {
  for (const weird of [undefined, null, 5, 'str', [], {}, { choices: 'x' }, { choices: [null] }, { choices: [{ message: 7 }] }, { choices: [{ message: { content: { a: 1 } } }], usage: { prompt_tokens: -3, completion_tokens: 'many' } }]) {
    const d = describeChatCompletion(weird, 1600, 200);
    assert.equal(d.maxTokens, 1600);
    assert.equal(d.httpStatus, 200);
    assert.ok(Object.values(d).every((v) => typeof v === 'number' || typeof v === 'string'), JSON.stringify(weird));
    assert.equal(d.promptTokens, undefined, 'a negative or non-numeric count is dropped, not trusted');
    assert.equal(d.completionTokens, undefined);
  }
  assert.equal(describeChatCompletion({ choices: [{ message: { content: { a: 1 } } }] }, 1600).contentType, 'other');
});

// ------------------------------------------------------------------ persistence and usage accounting
test('a successful summary is persisted with its usage, and the next ask is a cache hit that costs no request', async () => {
  const store = new MemoryStore();
  const net = scriptedHttp(() => orBody({ content: JSON.stringify(good), reasoning: 'thinking' }));
  const usage = emptyAiUsage();
  const first = await summariseClusterCached(cfgFor(net.http), store, STATEMENTS, { usage });
  assert.equal(first.status, 'computed');
  assert.equal(first.status === 'computed' && first.stored, true);
  const entry = [...store.aiCache.values()][0];
  assert.equal(entry.status, 'succeeded');
  assert.equal((entry.result as { title?: string }).title, good.title);
  assert.deepEqual({ p: entry.usage.prompt_tokens, c: entry.usage.completion_tokens, cost: entry.usage.reported_cost_usd }, { p: 310, c: 140, cost: 0 });
  assert.ok(!JSON.stringify(entry.result).includes('thinking'), 'reasoning text is not stored');

  const again = await summariseClusterCached(cfgFor(net.http), store, STATEMENTS, { usage });
  assert.equal(again.status, 'hit');
  assert.equal(net.calls.length, 1);
  assert.deepEqual(
    { calls: usage.calls, ok: usage.successes, failed: usage.failures, hits: usage.cache_hits, misses: usage.cache_misses, inTok: usage.input_tokens, outTok: usage.output_tokens, costCalls: usage.cost_reported_calls },
    { calls: 1, ok: 1, failed: 0, hits: 1, misses: 1, inTok: 310, outTok: 140, costCalls: 1 },
  );
});

test('a response that arrived but was unusable still has its tokens counted, and nothing is stored as a result', async () => {
  const store = new MemoryStore();
  const usage = emptyAiUsage();
  const body = orBody({ content: null, reasoning: 'x'.repeat(100) }, { finish: 'length', usage: { prompt_tokens: 300, completion_tokens: SUMMARY_MAX_TOKENS, total_tokens: 300 + SUMMARY_MAX_TOKENS, cost: 0 } });
  const e = await errOf(summariseClusterCached(cfgFor(scriptedHttp(() => body).http), store, STATEMENTS, { usage }));
  assert.equal(e.detail?.reason, 'reasoning_exhausted_budget');
  assert.deepEqual(
    { calls: usage.calls, ok: usage.successes, failed: usage.failures, misses: usage.cache_misses, inTok: usage.input_tokens, outTok: usage.output_tokens, costCalls: usage.cost_reported_calls },
    { calls: 1, ok: 0, failed: 1, misses: 1, inTok: 300, outTok: SUMMARY_MAX_TOKENS, costCalls: 0 },
  );
  const entry = [...store.aiCache.values()][0];
  assert.deepEqual({ status: entry.status, result: entry.result }, { status: 'failed', result: null });
});

test('failed-call accounting adds only what the response reported', async () => {
  const noUsage = emptyAiUsage();
  await errOf(meteredCall({ usage: () => ({ requests: 1, errors: 0, rateLimited: 0 }) }, noUsage, () => callWith(orBody({ content: '' }, { usage: null })), () => ({ inputTokens: 0, outputTokens: 0, costUsd: null })));
  assert.deepEqual({ calls: noUsage.calls, failed: noUsage.failures, inTok: noUsage.input_tokens, outTok: noUsage.output_tokens }, { calls: 1, failed: 1, inTok: 0, outTok: 0 });

  // errors that carry no detail (every other engine, every HTTP failure) add no tokens
  const plain = emptyAiUsage();
  for (const make of [() => new AiCallError('x', 'invalid_response'), () => new HttpError('HTTP 500', 500), () => new Error('boom')]) {
    await errOf(meteredCall({ usage: () => ({ requests: 1, errors: 0, rateLimited: 0 }) }, plain, async () => { throw make(); }, () => ({ inputTokens: 0, outputTokens: 0, costUsd: null })));
  }
  assert.deepEqual({ calls: plain.calls, failed: plain.failures, inTok: plain.input_tokens, outTok: plain.output_tokens }, { calls: 3, failed: 3, inTok: 0, outTok: 0 });
});

test('the request is unchanged except for its completion budget: free configured slug, standard endpoint, no fallback, no new parameters', async () => {
  const net = scriptedHttp(() => orBody({ content: JSON.stringify(good) }));
  await requestClusterSummary(cfgFor(net.http), STATEMENTS);
  const c = net.calls[0];
  assert.equal(c.url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(c.body.model, 'liquid/lfm-3-1.7b:free');
  assert.equal(c.body.max_tokens, 3072);
  assert.equal(SUMMARY_MAX_TOKENS, 3072, 'changing the budget is deliberate: see the timeout-ceiling test below');
  assert.deepEqual(Object.keys(c.body).sort(), ['max_tokens', 'messages', 'model', 'provider', 'response_format', 'temperature'], 'no unverified request parameters (reasoning, top_k, repetition_penalty...) were added');
  assert.equal(c.body.temperature, 0.1);
  assert.deepEqual(c.body.response_format, { type: 'json_object' });
  assert.equal(c.body.provider.allow_fallbacks, false);
  assert.equal(c.body.messages.length, 2);
});

test('the completion budget stays inside the time ceiling (30 s client timeout, 20 s smoke-test start guard)', () => {
  // OpenRouter lists ~173 tok/s as this endpoint's median throughput and ~0.44 s to first token (checked 2026-11-13). If you raise the budget,
  // raise the HTTP timeout (runner.ts, ai-smoke.ts) and MIN_TIME_FOR_LFM3_MS first, or a slow endpoint turns "too little room" into a timeout.
  const worstCaseSeconds = (tokensPerSecond: number) => SUMMARY_MAX_TOKENS / tokensPerSecond + 0.44;
  assert.ok(worstCaseSeconds(173) <= 20, `median-speed worst case is ${worstCaseSeconds(173).toFixed(1)} s, over the 20 s smoke-test guard`);
  assert.ok(worstCaseSeconds(173 * 0.7) <= 28, `30%-slower worst case is ${worstCaseSeconds(173 * 0.7).toFixed(1)} s, too close to the 30 s timeout`);
  assert.ok(SUMMARY_MAX_TOKENS >= 2048, 'Liquid\'s own example allows 2048 new tokens for a trivial prompt; this one asks for a reasoned 10-field answer');
});

// ------------------------------------------------------------------ reasoning left inline in `content`
// Liquid documents that LFM3 wraps its chain of thought in <think>...</think>. OpenRouter normally moves it to message.reasoning, but if the
// endpoint leaves it in `content`, an answer must only ever come from AFTER the reasoning.
const draft = JSON.stringify({ ...good, title: 'DRAFT-QUOTED-IN-THINKING' });
const real = JSON.stringify({ ...good, title: 'REAL ANSWER' });

test('splitInlineReasoning: answer is only what follows the reasoning', () => {
  const t: Array<[string, string, string, string]> = [
    ['no tags', 'plain', 'plain', 'none'],
    ['closed pair', '<think>a {x}</think>{"k":1}', '{"k":1}', 'closed'],
    ['upper-case tags', '<THINK>a</THINK>{"k":1}', '{"k":1}', 'closed'],
    ['several pairs', '<think>a</think>X<think>b</think>Y', 'XY', 'closed'],
    ['closing tag only (opener was in the prompt)', 'long {"k":0} reasoning</think>\n{"k":1}', '\n{"k":1}', 'closing_only'],
    ['pair then stray closer', '<think>a</think>b</think>{"k":1}', '{"k":1}', 'closing_only'],
    ['opener never closes', 'x<think>still thinking {"k":0}', 'x<think>still thinking {"k":0}', 'unclosed'],
    ['closed pair then unfinished one', '<think>a</think>{"k":1}<think>more', '{"k":1}<think>more', 'unclosed'],
  ];
  for (const [name, input, answer, inline] of t) assert.deepEqual(splitInlineReasoning(input), { answer, inline }, name);
});

test('unfinished inline reasoning is never turned into an answer, even when it quotes a valid-looking draft', async () => {
  const unfinished = `<think>Let me draft the answer: ${draft} Now I will refine the wording and re-check every statement, `;
  const e = await errOf(callWith(orBody({ content: unfinished }, { finish: 'length' })));
  assert.deepEqual({ kind: e.kind, reason: e.detail?.reason, inline: e.detail?.inlineReasoning }, { kind: 'invalid_response', reason: 'reasoning_exhausted_budget', inline: 'unclosed' });
  assert.equal(extractJsonObject(unfinished), null);
  // the same text without a length stop is still not an answer
  const stopped = await errOf(callWith(orBody({ content: unfinished }, { finish: 'stop' })));
  assert.deepEqual({ reason: stopped.detail?.reason, inline: stopped.detail?.inlineReasoning }, { reason: 'no_json', inline: 'unclosed' });
  // nothing is stored for it
  const store = new MemoryStore();
  await errOf(summariseClusterCached(cfgFor(scriptedHttp(() => orBody({ content: unfinished }, { finish: 'length' })).http), store, STATEMENTS, { usage: emptyAiUsage() }));
  assert.deepEqual([...store.aiCache.values()].map((x) => [x.status, x.result]), [['failed', null]]);
});

test('a closing tag with no opener: the answer after it is used, the draft before it is not', async () => {
  const s = await callWith(orBody({ content: `Thinking... a draft would be ${draft} but let me check the evidence again.</think>\n${real}` }));
  assert.equal(s.title, 'REAL ANSWER');
  // answer cut off after the closer: the draft before it must not be picked up instead
  const cut = await errOf(callWith(orBody({ content: `thinking ${draft}</think>\n{"title":"REAL","problem_desc` }, { finish: 'length' })));
  assert.deepEqual({ reason: cut.detail?.reason, inline: cut.detail?.inlineReasoning }, { reason: 'truncated_json', inline: 'closing_only' });
  // an answer that still fails the strict schema is still rejected
  const bad = await errOf(callWith(orBody({ content: `thinking</think>${JSON.stringify({ ...good, development_feasibility: '4' })}` })));
  assert.deepEqual({ reason: bad.detail?.reason, field: bad.detail?.field }, { reason: 'schema_invalid', field: 'development_feasibility' });
});

test('closed reasoning around a real answer still parses, and the diagnostics record only its shape', async () => {
  assert.equal((await callWith(orBody({ content: `<think>quoted ${draft} while thinking</think>\n${real}` }))).title, 'REAL ANSWER');
  assert.equal((await callWith(orBody({ content: `<THINK>x</THINK>${real}` }))).title, 'REAL ANSWER');

  const { entries, log } = capture();
  const text = 'CANARY-INLINE-REASONING-TEXT </think>not json';
  const e = await errOf(requestClusterSummary(cfgFor(scriptedHttp(() => orBody({ content: text })).http), STATEMENTS, { log }));
  assert.equal(e.detail?.inlineReasoning, 'closing_only');
  assert.equal(entries[0].extra!.inlineReasoning, 'closing_only');
  assert.ok(![e.message, JSON.stringify(e.detail), JSON.stringify(entries)].join('\n').includes('CANARY-INLINE-REASONING-TEXT'));
  // no inline reasoning: the field is absent, not 'none'
  const plain = await errOf(callWith(orBody({ content: 'no json here' })));
  assert.equal('inlineReasoning' in (plain.detail as object), false);
});
