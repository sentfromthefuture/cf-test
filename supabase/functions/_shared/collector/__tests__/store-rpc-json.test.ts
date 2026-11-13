// Regression: dr_ai_cache_complete failed in production with HTTP 400 PGRST102 "Empty or invalid json" while dr_ai_cache_begin succeeded.
//
// Cause: Decisions citation titles/snippets are provider text truncated with `.slice(0, n)` (parseCitations -> squash). When the cut lands in the
// middle of an emoji it leaves a LONE UTF-16 surrogate; JSON.stringify writes that as the escape \ud83d. ECMAScript accepts it, PostgREST's JSON
// parser does not, so the entire request is refused. (`begin` carries only a hash and a model name, so it never hit this.)
// Whether the body is a string or a Uint8Array makes no difference. Both were checked against real PostgREST 12.2.12, 13.0.7 and 16.5.
//
// The fake below rejects exactly what real PostgREST rejected in that experiment. No database or network is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SupabaseStore, toPostgrestJson } from '../store.ts';
import { cachedCompute, type Computed } from '../ai-common.ts';
import { parseDecisionsResponse, reviveDecisionsResult, type DecisionsResult } from '../decisions.ts';
import { decisionsBody } from './ai-test-utils.ts';

const EMOJI = '😀'; // U+1F600: two UTF-16 code units, \ud83d\ude00
const LEASE = { id: '11111111-1111-1111-1111-111111111111', epoch: 3 };

/** Independent of the production code: does this value hold a high surrogate without its low, or a low without its high? */
function strHasLone(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = s.charCodeAt(i + 1);
      if (n >= 0xdc00 && n <= 0xdfff) { i++; continue; }
      return true;
    }
    if (c >= 0xdc00 && c <= 0xdfff) return true;
  }
  return false;
}
function hasLoneSurrogate(v: unknown): boolean {
  if (typeof v === 'string') return strHasLone(v);
  if (Array.isArray(v)) return v.some(hasLoneSurrogate);
  if (v && typeof v === 'object') return Object.entries(v).some(([k, x]) => strHasLone(k) || hasLoneSurrogate(x));
  return false;
}

const PGRST102 = () => new Response(JSON.stringify({ code: 'PGRST102', details: null, hint: null, message: 'Empty or invalid json' }), { status: 400 });

/** A PostgREST stand-in: refuses what PostgREST refuses (unparseable body, lone surrogate anywhere, keys included), records what it accepted. */
function postgrestLike(respond: (name: string) => unknown) {
  const accepted: Array<{ name: string; text: string; args: Record<string, any> }> = [];
  let requests = 0;
  const fetchImpl = (async (url: string, init: { method: string; body?: BodyInit | null }) => {
    requests++;
    const name = String(url).split('/rpc/')[1];
    assert.equal(init.method, 'POST');
    const text = typeof init.body === 'string' ? init.body : init.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : '';
    let args: Record<string, any>;
    try { args = JSON.parse(text); } catch { return PGRST102(); }
    if (hasLoneSurrogate(args)) return PGRST102();
    accepted.push({ name, text, args });
    return new Response(JSON.stringify(respond(name)), { status: 200 });
  }) as unknown as typeof fetch;
  return { store: new SupabaseStore('https://example.supabase.co', 'service-key-not-real', fetchImpl), accepted, requests: () => requests, fetchImpl };
}

const answerFor = (name: string) => (name === 'dr_ai_cache_begin' ? { state: 'claimed', id: LEASE.id, epoch: LEASE.epoch } : name === 'dr_ai_cache_complete' ? true : null);

/** What the real Decisions parser produces when the provider's citation text has an emoji exactly where parseCitations cuts it. */
function decisionsResultCutMidEmoji(): DecisionsResult {
  return parseDecisionsResponse(decisionsBody({
    annotations: [{ type: 'url_citation', url_citation: { url: 'https://docs.example.net/guide', title: 'T'.repeat(199) + EMOJI + ' tail', content: 'x'.repeat(239) + EMOJI + ' tail' } }],
  }));
}

test('control: the fake refuses what PostgREST refuses (lone surrogate escape -> 400 PGRST102) and accepts well-formed JSON, string or bytes', async () => {
  const { fetchImpl } = postgrestLike(() => true);
  const call = (body: BodyInit) => fetchImpl('https://x/rest/v1/rpc/dr_ai_cache_complete', { method: 'POST', body });
  const bad = JSON.stringify({ p_citations: [{ snippet: 'x' + EMOJI.slice(0, 1) }] });
  assert.ok(bad.includes('\\ud83d'), 'JSON.stringify writes the lone surrogate as a \\u escape: valid ECMAScript JSON');
  for (const body of [bad, new TextEncoder().encode(bad)]) {
    const r = await call(body);
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { code: 'PGRST102', details: null, hint: null, message: 'Empty or invalid json' });
  }
  assert.equal((await call(JSON.stringify({ p_citations: [{ snippet: 'x' + EMOJI }] }))).status, 200, 'a complete emoji is fine');
  assert.equal((await call('{"p_id":')).status, 400, 'truncated JSON is refused');
});

test('dr_ai_cache_complete: Decisions citations cut mid-emoji by parseCitations are stored instead of failing with PGRST102', async () => {
  const result = decisionsResultCutMidEmoji();
  // Where the bad data comes from: the production parser itself leaves lone surrogates in the citation (title and snippet).
  // If parseCitations is ever made surrogate-safe this precondition should be removed; the next test keeps covering the boundary.
  assert.ok(hasLoneSurrogate(result.citations), 'precondition: parseCitations cut the emoji in half');

  const { store, accepted } = postgrestLike(answerFor);
  const stored = await store.aiCacheComplete(LEASE, result as unknown as Record<string, unknown>, result.citations, result.usage as unknown as Record<string, unknown>);
  assert.equal(stored, true, 'the completion must be accepted (before the fix: rpc dr_ai_cache_complete failed (HTTP 400): Empty or invalid json)');

  const sent = accepted.find((c) => c.name === 'dr_ai_cache_complete')!;
  assert.deepEqual(Object.keys(sent.args).sort(), ['p_citations', 'p_epoch', 'p_id', 'p_result', 'p_usage']);
  assert.equal(sent.args.p_id, LEASE.id);
  assert.equal(sent.args.p_epoch, LEASE.epoch, 'the fencing epoch is still sent');
  assert.equal(hasLoneSurrogate(sent.args), false);
  const c = sent.args.p_citations[0];
  assert.equal(c.snippet, 'x'.repeat(239) + '\uFFFD', 'only the broken half-character is replaced; the rest of the text is intact');
  assert.equal(c.title, 'T'.repeat(199) + '\uFFFD');
  assert.equal(c.url, 'https://docs.example.net/guide');
  assert.deepEqual(sent.args.p_result.citations, sent.args.p_citations, 'the copy inside p_result is repaired the same way');
  assert.equal(sent.args.p_result.problemProbability, result.problemProbability, 'everything else in the result is untouched');
  assert.ok(reviveDecisionsResult(sent.args.p_result), 'what is stored still revives as a valid Decisions result');
});

test('the whole cache flow: begin claims, compute returns a cut citation, complete is stored (no "AI cache write failed", no lost answer)', async () => {
  const { store, accepted } = postgrestLike(answerFor);
  const warnings: string[] = [];
  const log = { debug() {}, info() {}, error() {}, warn: (m: string) => { warnings.push(m); } } as any;
  const outcome = await cachedCompute(
    store, { task: 'decisions', model: 'parallel/decisions-fast:free', configVersion: 'v1', hash: 'a'.repeat(64) },
    async (): Promise<Computed<DecisionsResult>> => {
      const result = decisionsResultCutMidEmoji();
      // built exactly like decisions-runner.ts does
      return { value: result, result: result as unknown as Record<string, unknown>, citations: result.citations, usage: result.usage as unknown as Record<string, unknown> };
    },
    reviveDecisionsResult,
    { log },
  );
  assert.equal(outcome.status, 'computed');
  assert.equal((outcome as { stored?: boolean }).stored, true);
  assert.equal((outcome as { notStored?: string }).notStored, undefined);
  assert.deepEqual(warnings, []);
  assert.deepEqual(accepted.map((c) => c.name), ['dr_ai_cache_begin', 'dr_ai_cache_complete']);
  assert.equal(accepted[1].args.p_epoch, LEASE.epoch);
});

test('a lone surrogate anywhere in a dr_ai_cache_complete payload (result, citations, usage, object keys; high or low) is repaired, not refused', async () => {
  const HI = '\uD83D';
  const LO = '\uDE00';
  const cases: Array<[string, Record<string, unknown>, unknown[], Record<string, unknown>]> = [
    ['high in result', { note: `a${HI}` }, [], {}],
    ['low in result', { note: `${LO}b` }, [], {}],
    ['in citations', { ok: 1 }, [{ url: 'https://e.org', title: `t${HI}`, snippet: `${LO}s` }], {}],
    ['in usage', { ok: 1 }, [], { servedBy: `m${HI}` }],
    ['in an object key', { [`k${HI}`]: 1 }, [], {}],
    ['high followed by an unrelated high then a valid emoji', { note: `${HI}${HI}${LO}` }, [], {}],
  ];
  for (const [label, result, citations, usage] of cases) {
    const { store, accepted } = postgrestLike(answerFor);
    assert.equal(await store.aiCacheComplete(LEASE, result, citations, usage), true, label);
    assert.equal(hasLoneSurrogate(accepted[0].args), false, label);
  }
});

test('payloads without a lone surrogate are sent byte for byte as JSON.stringify writes them (existing RPC behaviour is unchanged)', async () => {
  const payloads: unknown[] = [
    {},
    { p_limit: 10, p_force: null, p_trigger: 'schedule' },
    { p_result: { a: [1, 2.5, null, true], 'k"ey': 'quote " and backslash \\ and \n newline \t tab \u0001 control \u2028 separator' } },
    { p_citations: [{ title: `valid emoji ${EMOJI} and CJK 漢字 and accents é`, snippet: 'x' }] },
    { p_records: [{ text: 'the TEXT \\ud83d is not a surrogate, it is a backslash followed by letters' }] },
    { p_text: '\\\\ud83d', p_other: '\\\\\\ud83d' },
  ];
  for (const p of payloads) assert.equal(toPostgrestJson(p), JSON.stringify(p));

  const { store, accepted } = postgrestLike(() => null);
  for (const p of payloads) await store.releaseLock(JSON.stringify(p)); // any value goes through rpc() unchanged
  assert.equal(accepted.length, payloads.length);
  accepted.forEach((c, i) => assert.equal(c.text, JSON.stringify({ p_name: JSON.stringify(payloads[i]) })));
});

test('only the real lone surrogate is replaced when literal backslash-u text sits next to it', () => {
  const s = '\\ud83d' + '\uD83D' + EMOJI + '\uDE00' + '\\\\ud83d';
  const out = toPostgrestJson({ s });
  assert.deepEqual(JSON.parse(out), { s: '\\ud83d' + '\uFFFD' + EMOJI + '\uFFFD' + '\\\\ud83d' });
});

test('error handling is not masked: a genuine 400 PGRST102 still surfaces immediately, once, without retries', async () => {
  let n = 0;
  const store = new SupabaseStore('https://example.supabase.co', 'service-key-not-real', (async () => { n++; return PGRST102(); }) as unknown as typeof fetch);
  await assert.rejects(store.aiCacheComplete(LEASE, { ok: 1 }, [], {}), /rpc dr_ai_cache_complete failed \(HTTP 400\): Empty or invalid json/);
  assert.equal(n, 1, 'client errors are not retryable');
});
