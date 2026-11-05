import test from 'node:test';
import assert from 'node:assert/strict';
import { createHttpClient } from '../http.ts';
import { HttpError, RateLimitError } from '../types.ts';

const json = (body: unknown, init: ResponseInit = {}) => new Response(JSON.stringify(body), { status: 200, ...init });

function client(responses: Array<Response | Error>, o: Parameters<typeof createHttpClient>[0] = {}) {
  const sleeps: number[] = [];
  let i = 0;
  const http = createHttpClient({
    sleep: async (ms) => { sleeps.push(ms); }, random: () => 1, now: () => 1_000_000,
    fetchImpl: (async () => { const r = responses[Math.min(i++, responses.length - 1)]; if (r instanceof Error) throw r; return r.clone(); }) as typeof fetch, ...o,
  });
  return { http, sleeps, calls: () => i };
}

test('retries 5xx with exponential backoff then succeeds', async () => {
  const { http, sleeps, calls } = client([new Response('x', { status: 503 }), new Response('x', { status: 502 }), json({ ok: 1 })]);
  const r = await http.getJson<{ ok: number }>('https://x.test/a');
  assert.equal(r.data.ok, 1);
  assert.equal(calls(), 3);
  assert.deepEqual(sleeps, [500, 1000]); // base * 2^attempt (jitter pinned to 1)
  assert.equal(http.usage().requests, 3);
  assert.equal(http.usage().errors, 2);
});

test('gives up after max retries with the last error', async () => {
  const { http, calls } = client([new Response('x', { status: 500 })], { retries: 2 });
  await assert.rejects(http.getJson('https://x.test/a'), (e: any) => e instanceof HttpError && e.status === 500);
  assert.equal(calls(), 3);
});

test('4xx other than rate limits are not retried', async () => {
  const { http, calls } = client([new Response('nope', { status: 404 })]);
  await assert.rejects(http.getJson('https://x.test/a'), (e: any) => e instanceof HttpError && e.status === 404);
  assert.equal(calls(), 1);
});

test('429 honours Retry-After and is counted as rate limited', async () => {
  const { http, sleeps } = client([new Response('', { status: 429, headers: { 'retry-after': '3' } }), json({ ok: 1 })]);
  await http.getJson('https://x.test/a');
  assert.ok(sleeps[0] >= 3000);
  assert.equal(http.usage().rateLimited, 1);
});

test('GitHub-style 403 with exhausted x-ratelimit is a rate limit; long waits become RateLimitError', async () => {
  const resetAtSec = 1_000_000 / 1000 + 3600;
  const { http } = client([new Response('rate limit exceeded', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetAtSec) } })]);
  await assert.rejects(http.getJson('https://x.test/a'), (e: any) => e instanceof RateLimitError && e.resetAt!.getTime() === resetAtSec * 1000);
});

test('plain 403 (no rate-limit signal) is not retried', async () => {
  const { http, calls } = client([new Response('forbidden', { status: 403 })]);
  await assert.rejects(http.getJson('https://x.test/a'), (e: any) => e instanceof HttpError);
  assert.equal(calls(), 1);
});

test('malformed JSON is a clear non-retried error', async () => {
  const { http, calls } = client([new Response('<html>not json</html>', { status: 200 })]);
  await assert.rejects(http.getJson('https://x.test/a'), /malformed JSON/);
  assert.equal(calls(), 1);
});

test('network errors are retried, then surfaced', async () => {
  const { http, calls } = client([new Error('ECONNRESET')], { retries: 1 });
  await assert.rejects(http.getJson('https://x.test/a'), /network error: ECONNRESET/);
  assert.equal(calls(), 2);
});

test('timeouts abort the request', async () => {
  const hang = ((_u: string, init: RequestInit) => new Promise((_res, rej) => init.signal!.addEventListener('abort', () => rej(new Error('aborted'))))) as unknown as typeof fetch;
  const http = createHttpClient({ fetchImpl: hang, timeoutMs: 20, retries: 0, sleep: async () => {} });
  await assert.rejects(http.getJson('https://x.test/a'), /timeout after 20ms/);
});

test('API-mandated backoff (holdUntil) is honoured, or rescheduled when too long', async () => {
  let t = 1_000_000;
  const sleeps: number[] = [];
  const http = createHttpClient({ now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; }, fetchImpl: (async () => json({})) as typeof fetch, maxInlineWaitMs: 20_000 });
  http.holdUntil('se', t + 5000);
  await http.getJson('https://x.test/a', { minIntervalKey: 'se' });
  assert.deepEqual(sleeps, [5000]);
  http.holdUntil('se', t + 60_000);
  await assert.rejects(http.getJson('https://x.test/a', { minIntervalKey: 'se' }), RateLimitError);
});

test('minIntervalMs spaces requests that share a key', async () => {
  let t = 0;
  const sleeps: number[] = [];
  const http = createHttpClient({ now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; }, fetchImpl: (async () => json({})) as typeof fetch, minIntervalMs: { gh: 6500 } });
  await http.getJson('https://x.test/1', { minIntervalKey: 'gh' });
  t += 1000;
  await http.getJson('https://x.test/2', { minIntervalKey: 'gh' });
  assert.deepEqual(sleeps, [5500]);
});

test('POST sends a JSON body and content-type', async () => {
  let seen: RequestInit | undefined;
  const http = createHttpClient({ fetchImpl: (async (_u: string, init: RequestInit) => { seen = init; return json({ a: 1 }); }) as unknown as typeof fetch });
  await http.postJson('https://x.test/p', { hello: 'world' });
  assert.equal(seen!.method, 'POST');
  assert.equal(seen!.body, '{"hello":"world"}');
  assert.equal((seen!.headers as Record<string, string>)['content-type'], 'application/json');
});
