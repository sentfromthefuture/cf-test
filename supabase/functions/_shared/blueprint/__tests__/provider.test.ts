import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BlueprintProviderError,
  blueprintProviderConfigProblem,
  callBlueprintProvider,
} from '../provider.ts';

const config = {
  apiKey: 'synthetic-test-key',
  model: 'baidu/ernie-5.5-flash-preview:free',
  timeoutMs: 5_000,
};

test('provider config rejects paid model slugs and unsafe timeouts', () => {
  assert.equal(blueprintProviderConfigProblem(config), null);
  assert.equal(blueprintProviderConfigProblem({ ...config, model: 'openai/gpt-4o' }), 'BLUEPRINT_MODEL must be an explicit :free model');
  assert.equal(blueprintProviderConfigProblem({ ...config, timeoutMs: 100 }), 'BLUEPRINT_PASS_TIMEOUT_MS is outside the supported safety bounds');
});

test('one pass sends JSON-only non-fallback request and parses object content', async () => {
  let sent: Record<string, unknown> | null = null;
  const result = await callBlueprintProvider({
    ...config,
    fetchImpl: async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        id: 'synthetic-response',
        model: config.model,
        provider: 'synthetic',
        choices: [{ finish_reason: 'stop', message: { content: '{"schema_version":"product-blueprint.v1"}' } }],
        usage: { prompt_tokens: 12, completion_tokens: 8, completion_tokens_details: { reasoning_tokens: 3 }, cost: 0 },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  }, {
    systemPrompt: 'Static synthetic prompt',
    userPayload: { task: 'synthetic', text: 'untrusted sample text' },
    maxTokens: 1_000,
  });

  assert.deepEqual(result.output, { schema_version: 'product-blueprint.v1' });
  assert.equal(result.usage.input_tokens, 12);
  assert.equal(result.usage.output_tokens, 8);
  assert.equal(result.usage.reasoning_tokens, 3);
  assert.equal(result.usage.reported_cost_usd, 0);
  assert.ok(sent);
  assert.deepEqual((sent as Record<string, unknown>).provider, { allow_fallbacks: false });
  assert.deepEqual((sent as Record<string, unknown>).response_format, { type: 'json_object' });
  assert.equal((sent as Record<string, unknown>).stream, undefined);
});

test('provider error bodies are never echoed into errors', async () => {
  await assert.rejects(
    () => callBlueprintProvider({
      ...config,
      fetchImpl: async () => new Response(JSON.stringify({ error: { message: 'private provider detail' } }), { status: 200 }),
    }, { systemPrompt: 'x', userPayload: {}, maxTokens: 100 }),
    (error: unknown) => error instanceof BlueprintProviderError && error.code === 'provider_error' && !error.message.includes('private'),
  );
});

test('truncated and non-object model responses are rejected, never repaired', async () => {
  for (const body of [
    { choices: [{ finish_reason: 'length', message: { content: '{"partial":' } }] },
    { choices: [{ finish_reason: 'stop', message: { content: '[1,2,3]' } }] },
    { choices: [{ finish_reason: 'stop', message: { content: 'not json' } }] },
  ]) {
    await assert.rejects(
      () => callBlueprintProvider({
        ...config,
        fetchImpl: async () => new Response(JSON.stringify(body), { status: 200 }),
      }, { systemPrompt: 'x', userPayload: {}, maxTokens: 100 }),
      BlueprintProviderError,
    );
  }
});

test('HTTP 429 is classified without exposing the response body', async () => {
  await assert.rejects(
    () => callBlueprintProvider({
      ...config,
      fetchImpl: async () => new Response('private rate limit detail', { status: 429 }),
    }, { systemPrompt: 'x', userPayload: {}, maxTokens: 100 }),
    (error: unknown) => error instanceof BlueprintProviderError && error.code === 'rate_limited' && error.httpStatus === 429,
  );
});
