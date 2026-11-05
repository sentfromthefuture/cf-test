// NOTE: HN and Stack Exchange fixtures below are SYNTHETIC, written from the documented API schemas
// (they could not be captured from the real APIs in the build sandbox). The GitHub connector was additionally
// verified against the live API via live-check.ts. Fixtures here prove parsing/pagination logic, not API availability.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { githubConnector, normaliseIssue } from '../connectors/github.ts';
import { hackerNewsConnector } from '../connectors/hackernews.ts';
import { normaliseQuestion, seLicense, stackExchangeConnector } from '../connectors/stackexchange.ts';
import { defaultConfigs } from '../connectors/index.ts';
import { ConnectorError, HttpError, RateLimitError } from '../types.ts';
import { ctxFor, fakeHttp } from './helpers.ts';

const issue = (id: number, over: any = {}) => ({
  id, number: id, html_url: `https://github.com/o/r/issues/${id}`, title: `Feature ${id}`, body: 'Please add **this**.\n```js\ncode()\n```\n![img](http://x/y.png) see [docs](http://a/b)',
  comments: 4, created_at: '2026-10-01T00:00:00Z', updated_at: `2026-11-0${(id % 5) + 1}T00:00:00Z`, user: { login: 'alice', type: 'User' },
  labels: [{ name: 'feature request' }], reactions: { total_count: 7, '+1': 5 }, repository_url: 'https://api.github.com/repos/o/r', ...over,
});

// ---------------------------------------------------------------- GitHub
test('github: normalises issues, drops PRs and bots, hashes authors, strips markdown', async () => {
  const r = await normaliseIssue(issue(1) as any, {}, 'q1');
  assert.equal(r!.source_record_id, '1');
  assert.equal(r!.discussion_key, 'github:1');
  assert.equal(r!.engagement.reactions, 7);
  assert.ok(r!.categories.includes('repo:o/r') && r!.categories.includes('label:feature request'));
  assert.doesNotMatch(r!.excerpt!, /```|!\[|http:\/\//);
  assert.match(r!.excerpt!, /Please add this/);
  assert.notEqual(r!.author_ref, 'alice');
  assert.equal(r!.author_ref!.length, 24);
  assert.equal(await normaliseIssue(issue(2, { pull_request: {} }) as any, {}, 'q'), null);
  assert.equal(await normaliseIssue(issue(3, { user: { login: 'dependabot', type: 'Bot' } }) as any, {}, 'q'), null);
  assert.equal(await normaliseIssue({ id: 9 } as any, {}, 'q'), null);
});

test('github: paginates a query, then advances query and sets the watermark only when the query is exhausted', async () => {
  const cfg = { per_page: 2, max_pages: 5, lookback_days: 30, queries: [{ id: 'a', q: 'is:issue label:x' }, { id: 'b', q: 'is:issue label:y' }] };
  const pages: Record<string, any[]> = { '1': [issue(1), issue(2)], '2': [issue(3)] };
  const { http, urls } = fakeHttp((u) => ({ total_count: 3, items: pages[new URL(u).searchParams.get('page')!] ?? [] }), { 'x-ratelimit-limit': '10', 'x-ratelimit-remaining': '7', 'x-ratelimit-reset': '1800000000' });

  let res = await githubConnector.fetchBatch(ctxFor(http, cfg));
  assert.equal(res.records.length, 2);
  assert.equal(res.done, false);
  assert.equal((res.cursor as any).qi, 0);
  assert.equal((res.cursor as any).page, 2);
  assert.equal((res.cursor as any).since?.a, undefined, 'watermark must not move mid-query');
  assert.deepEqual(res.quota, { limit: 10, remaining: 7, resetAt: new Date(1_800_000_000_000).toISOString() });

  res = await githubConnector.fetchBatch(ctxFor(http, cfg, res.cursor));
  assert.equal(res.records.length, 1);
  assert.equal((res.cursor as any).qi, 1, 'moves to the next query');
  assert.ok((res.cursor as any).since.a, 'watermark set after query exhausted');
  assert.equal(res.done, false);

  res = await githubConnector.fetchBatch(ctxFor(http, cfg, res.cursor)); // query b page 1 (2 items = full page)
  res = await githubConnector.fetchBatch(ctxFor(http, cfg, res.cursor)); // query b page 2 (1 item) -> cycle complete
  assert.equal(res.done, true);
  assert.equal((res.cursor as any).qi, 0);
  assert.ok(urls[0].includes('updated%3A%3E%3D'), 'incremental: uses updated:>= watermark');
  assert.match(urls[2], /updated%3A%3E%3D\d{4}-\d{2}-\d{2}T/);
  const q2 = new URL(urls[2]).searchParams.get('q')!;
  assert.ok(q2.startsWith('is:issue label:y updated:>='));
});

test('github: second cycle resumes from the stored watermark', async () => {
  const cfg = { per_page: 100, queries: [{ id: 'a', q: 'is:issue' }] };
  const { http, urls } = fakeHttp(() => ({ items: [issue(1)] }));
  const res = await githubConnector.fetchBatch(ctxFor(http, cfg, { since: { a: '2026-11-03T10:00:00Z' } }));
  assert.ok(decodeURIComponent(urls[0]).includes('updated:>=2026-11-03T10:00:00Z'));
  assert.equal(res.done, true);
});

test('github: malformed payload and empty config fail loudly', async () => {
  const bad = fakeHttp(() => ({ message: 'nope' }));
  await assert.rejects(githubConnector.fetchBatch(ctxFor(bad.http, { queries: [{ id: 'a', q: 'x' }] })), ConnectorError);
  await assert.rejects(githubConnector.fetchBatch(ctxFor(bad.http, { queries: [] })), /no queries/);
});

test('github: never puts the token in the URL; sends it as a header only', async () => {
  let seenHeaders: any;
  const http = { ...fakeHttp(() => ({ items: [] })).http, getJson: async (u: string, o: any) => { seenHeaders = o.headers; assert.ok(!u.includes('secret-token')); return { data: { items: [] }, headers: new Headers(), status: 200 } as any; } };
  await githubConnector.fetchBatch(ctxFor(http as any, { queries: [{ id: 'a', q: 'x' }] }, {}, { env: { GITHUB_TOKEN: 'secret-token' } }));
  assert.equal(seenHeaders.authorization, 'Bearer secret-token');
});

// ---------------------------------------------------------------- Hacker News
const hnItems: Record<string, any> = {
  1: { id: 1, type: 'story', by: 'a', time: 1_762_000_000, title: 'Ask HN: How do you track invoices offline?', text: 'I&#x27;m frustrated with spreadsheets &amp; manual work.', score: 40, descendants: 20, kids: [11, 12, 13, 14] },
  2: { id: 2, type: 'story', by: 'b', time: 1_762_000_100, title: 'Show HN: my pretty todo app', url: 'https://www.todo.example/x', score: 3, descendants: 0 },
  3: { id: 3, type: 'story', by: 'c', time: 1_762_000_200, title: 'Big company posts quarterly earnings', url: 'https://news.example/q', score: 300, descendants: 5 },
  4: { id: 4, deleted: true },
  5: { id: 5, type: 'story', dead: true, title: 'dead story' },
  6: { id: 6, type: 'job', title: 'Hiring' },
  7: { id: 7, type: 'story', by: 'd', time: 1_762_000_250, title: 'Show HN: Offline invoice sync', url: 'https://sync.example', score: 50, descendants: 2 },
  11: { id: 11, type: 'comment', parent: 1, by: 'x', time: 1_762_000_300, text: 'We would pay $30/month for this. Current tools are a nightmare and too expensive to run for small shops.' },
  12: { id: 12, type: 'comment', parent: 1, by: 'y', time: 1_762_000_400, text: 'lol nice' },
  13: { id: 13, type: 'comment', parent: 99, by: 'z', time: 1_762_000_500, text: 'A nested reply that is frustrating but is not top level so must be ignored by the connector logic here.' },
  14: { id: 14, deleted: true },
};
const hnRoute = (u: string) => {
  if (/askstories/.test(u)) return [1, 2, 4];
  if (/topstories/.test(u)) return [3, 5, 6, 1];
  if (/showstories/.test(u)) return [2, 7];
  const m = /item\/(\d+)\.json/.exec(u);
  return m ? hnItems[m[1]] ?? null : null;
};

test('hackernews: plan -> stories -> comments; filters noise, groups comments under their story, tracks rejects', async () => {
  const cfg = { ...defaultConfigs.hackernews, lists: ['askstories', 'topstories', 'showstories'], min_score: 5, batch_size: 50 };
  const { http, urls } = fakeHttp(hnRoute);
  let cursor: Record<string, any> = {};
  const all: any[] = [];
  let guard = 0;
  for (;;) {
    const res = await hackerNewsConnector.fetchBatch(ctxFor(http, cfg, cursor));
    all.push(...res.records);
    cursor = res.cursor;
    if (res.done || ++guard > 10) break;
  }
  const ids = all.map((r) => r.source_record_id).sort();
  assert.deepEqual(ids, ['1', '11', '7'], 'ask story, its problem comment, and a Show HN with traction (competitor evidence); no generic news');
  const story = all.find((r) => r.source_record_id === '1');
  assert.equal(story.kind, 'story');
  assert.equal(story.url, 'https://news.ycombinator.com/item?id=1');
  assert.match(story.excerpt, /I'm frustrated with spreadsheets & manual work/);
  assert.ok(story.categories.includes('ask-hn'));
  const comment = all.find((r) => r.source_record_id === '11');
  assert.equal(comment.discussion_key, 'hackernews:1', 'comment shares its story discussion (not independent demand)');
  assert.equal(comment.parent_source_record_id, '1');
  assert.equal(urls.filter((u) => /item\/1\.json/.test(u)).length, 1, 'story fetched once even though listed twice');
  assert.deepEqual([...(cursor.rejected as number[])].sort(), [2, 3, 4, 5, 6], 'rejected ids remembered so they are not re-fetched every cycle');
  assert.equal(guard < 10, true);
});

test('hackernews: already-stored ids are not re-fetched', async () => {
  const { http, urls } = fakeHttp(hnRoute);
  const res = await hackerNewsConnector.fetchBatch(ctxFor(http, { lists: ['askstories'], batch_size: 10 }, {}, { existingIds: async () => new Set(['1', '2', '4']) }));
  assert.equal(res.done, true, 'nothing new -> cycle ends');
  assert.equal(urls.filter((u) => /\/item\//.test(u)).length, 0);
});

test('hackernews: malformed list is ignored, bad list names are dropped', async () => {
  const { http, urls } = fakeHttp((u) => (/askstories/.test(u) ? { not: 'a list' } : hnRoute(u)));
  const res = await hackerNewsConnector.fetchBatch(ctxFor(http, { lists: ['askstories', 'topstories', '../../evil'] }));
  assert.equal(res.inspected, 4);
  assert.ok(!urls.some((u) => u.includes('evil')));
});

// ---------------------------------------------------------------- Stack Exchange
const seQuestion = (id: number, over: any = {}) => ({
  question_id: id, title: 'Is there a tool to sync &quot;invoices&quot; offline?', body: '<p>I need <b>offline</b> sync.</p><pre><code>x</code></pre>',
  link: `https://softwarerecs.stackexchange.com/questions/${id}`, score: 3, view_count: 120, answer_count: 1, is_answered: true, accepted_answer_id: 5,
  tags: ['invoicing', 'offline'], creation_date: 1_793_700_000 + id, last_activity_date: 1_762_100_000, owner: { display_name: 'Jane &amp; Co', link: 'https://softwarerecs.stackexchange.com/users/1/jane', user_id: 1 }, ...over,
});

test('stackexchange: normalises with attribution, licence by date, decoded HTML, hashed author', async () => {
  const r = await normaliseQuestion(seQuestion(7) as any, 'softwarerecs', 't', {});
  assert.equal(r!.source_record_id, 'softwarerecs:7');
  assert.equal(r!.title, 'Is there a tool to sync "invoices" offline?');
  assert.match(r!.excerpt!, /I need offline sync/);
  assert.equal(r!.license, 'CC BY-SA 4.0');
  assert.match(r!.attribution!, /Jane & Co.*softwarerecs\.stackexchange\.com\/users\/1\/jane.*CC BY-SA 4\.0/);
  assert.notEqual(r!.author_ref, 'Jane & Co');
  assert.equal(r!.engagement.has_accepted_answer, 1);
  assert.ok(r!.categories.includes('tag:invoicing'));
  assert.equal(seLicense(Date.UTC(2015, 0, 1) / 1000), 'CC BY-SA 3.0');
  assert.equal(seLicense(Date.UTC(2009, 0, 1) / 1000), 'CC BY-SA 2.5');
  assert.equal(seLicense(1, 'CC BY-SA 4.0'), 'CC BY-SA 4.0', 'API-provided licence wins');
});

test('stackexchange: watermark advances by creation date, obeys backoff, reports quota, rotates targets', async () => {
  const cfg = { pagesize: 2, max_pages: 2, lookback_days: 7, targets: [{ id: 'a', site: 'softwarerecs', mode: 'questions' }, { id: 'b', site: 'webapps', mode: 'search', q: 'is there a tool' }] };
  const { http, urls, holds } = fakeHttp(() => ({ items: [seQuestion(1), seQuestion(2)], has_more: true, quota_max: 300, quota_remaining: 250, backoff: 4 }));
  let res = await stackExchangeConnector.fetchBatch(ctxFor(http, cfg));
  assert.equal(res.records.length, 2);
  assert.equal(res.done, false);
  assert.equal((res.cursor as any).ti, 0);
  assert.equal((res.cursor as any).from.a, 1_793_700_002, 'watermark = newest creation_date seen');
  assert.equal(res.quota!.remaining, 250);
  assert.equal(holds.length, 1);
  assert.equal(holds[0][0], 'stackexchange');
  assert.equal(holds[0][1] - new Date('2026-11-04T12:00:00Z').getTime(), 4000, 'backoff seconds honoured');

  res = await stackExchangeConnector.fetchBatch(ctxFor(http, cfg, res.cursor)); // page cap reached -> next target
  assert.equal((res.cursor as any).ti, 1);
  res = await stackExchangeConnector.fetchBatch(ctxFor(http, cfg, res.cursor));
  res = await stackExchangeConnector.fetchBatch(ctxFor(http, cfg, res.cursor));
  assert.equal(res.done, true);
  assert.match(urls[0], /\/questions\?/);
  assert.match(urls[2], /\/search\/advanced\?.*q=is\+there\+a\+tool/);
  assert.match(urls[0], /fromdate=\d+/);
  assert.match(urls[1], /fromdate=1793700002/);
});

test('stackexchange: key only in query when configured; throttle violation becomes a reschedulable RateLimitError', async () => {
  const cfg = { targets: [{ id: 'a', site: 'softwarerecs', mode: 'questions' }] };
  const keyed = fakeHttp(() => ({ items: [], has_more: false }));
  await stackExchangeConnector.fetchBatch(ctxFor(keyed.http, cfg, {}, { env: { STACKEXCHANGE_KEY: 'abc123' } }));
  assert.match(keyed.urls[0], /key=abc123/);
  const unkeyed = fakeHttp(() => ({ items: [], has_more: false }));
  await stackExchangeConnector.fetchBatch(ctxFor(unkeyed.http, cfg));
  assert.ok(!/key=/.test(unkeyed.urls[0]));

  const throttled = { ...fakeHttp(() => ({})).http, getJson: async () => { throw new HttpError('HTTP 400', 400, null, '{"error_id":502,"error_message":"too many requests from this IP, more requests available in 3600 seconds","error_name":"throttle_violation"}'); } };
  await assert.rejects(stackExchangeConnector.fetchBatch(ctxFor(throttled as any, cfg)), (e: any) => e instanceof RateLimitError && e.resetAt!.getTime() === new Date('2026-11-04T13:00:00Z').getTime());
});

test('stackexchange: low quota stops further requests (rateLimitedUntil), bad config rejected', async () => {
  const cfg = { targets: [{ id: 'a', site: 'softwarerecs', mode: 'questions' }] };
  const { http } = fakeHttp(() => ({ items: [seQuestion(1)], has_more: true, quota_max: 300, quota_remaining: 1 }));
  const res = await stackExchangeConnector.fetchBatch(ctxFor(http, cfg));
  assert.equal(res.records.length, 1, 'records fetched before the quota ran out are kept');
  assert.equal(res.rateLimitedUntil, '2026-11-05T00:00:00.000Z', 'SE quota resets at 00:00 UTC');
  await assert.rejects(stackExchangeConnector.fetchBatch(ctxFor(http, { targets: [{ id: 'x', site: '../etc', mode: 'questions' }] })), /invalid site/);
  await assert.rejects(stackExchangeConnector.fetchBatch(ctxFor(http, { targets: [{ id: 'x', site: 'webapps', mode: 'search' }] })), /needs q/);
  const bad = fakeHttp(() => ({ error_id: 400, error_name: 'bad_parameter' }));
  await assert.rejects(stackExchangeConnector.fetchBatch(ctxFor(bad.http, cfg)), ConnectorError);
});

// ---------------------------------------------------------------- config drift
test('defaultConfigs stay in sync with the SQL seed rows', () => {
  const sql = readFileSync(fileURLToPath(new URL('../../../../migrations/20261104000000_market_intel_schema.sql', import.meta.url)), 'utf8');
  const literals = [...sql.matchAll(/'(\{"[\s\S]*?\})'::jsonb/g)].map((m) => JSON.parse(m[1]));
  assert.deepEqual(literals[0], defaultConfigs.github);
  assert.deepEqual(literals[1], defaultConfigs.hackernews);
  assert.deepEqual(literals[2], defaultConfigs.stackexchange);
});
