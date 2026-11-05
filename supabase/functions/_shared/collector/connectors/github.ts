import { Connector, ConnectorContext, ConnectorError, FetchResult, QuotaInfo, RawRecordInput } from '../types.ts';
import { guessLanguage, hashAuthor, isoOrNull, markdownToText, num, sha256Hex, truncate } from '../util.ts';

// Official GitHub REST API: GET /search/issues  (https://docs.github.com/en/rest/search/search#search-issues-and-pull-requests)
// Unauthenticated: 10 search requests/min. With GITHUB_TOKEN (server-side secret): 30/min.
// Search returns at most 1000 results per query, so we page newest-updated first and advance a per-query `since` watermark.

const API = 'https://api.github.com';
const SOURCE = 'github';

interface GhIssue {
  id: number;
  number: number;
  html_url: string;
  title: string;
  body?: string | null;
  state?: string;
  comments?: number;
  created_at?: string;
  updated_at?: string;
  user?: { login?: string; type?: string } | null;
  labels?: Array<{ name?: string } | string>;
  reactions?: { total_count?: number; '+1'?: number; heart?: number };
  repository_url?: string;
  pull_request?: unknown;
}

interface GhCursor {
  qi?: number;
  page?: number;
  newest?: string | null;
  since?: Record<string, string>;
}

export async function normaliseIssue(item: GhIssue, env: Record<string, string | undefined>, queryId: string): Promise<RawRecordInput | null> {
  if (!item || typeof item.id !== 'number' || !item.html_url || !item.title) return null;
  if (item.pull_request) return null; // pull requests are code review, not demand signals
  if (item.user?.type === 'Bot') return null;
  const repo = item.repository_url?.replace(`${API}/repos/`, '') ?? null;
  const excerpt = item.body ? truncate(markdownToText(item.body), 1200) : null;
  const labels = (item.labels ?? []).map((l) => (typeof l === 'string' ? l : l?.name)).filter((x): x is string => !!x).slice(0, 10);
  const text = `${item.title}\n${excerpt ?? ''}`;
  return {
    source_id: SOURCE,
    source_record_id: String(item.id),
    discussion_key: `${SOURCE}:${item.id}`,
    kind: 'issue',
    url: item.html_url,
    title: truncate(item.title, 300),
    excerpt,
    author_ref: await hashAuthor(env, SOURCE, item.user?.login),
    parent_source_record_id: null,
    published_at: isoOrNull(item.created_at),
    updated_at_source: isoOrNull(item.updated_at),
    engagement: { comments: num(item.comments), reactions: num(item.reactions?.total_count), thumbs_up: num(item.reactions?.['+1']) },
    categories: [...labels.map((l) => `label:${l}`), ...(repo ? [`repo:${repo}`] : []), `query:${queryId}`],
    language: guessLanguage(text),
    license: 'GitHub user content (author-owned); repository licence varies; excerpt stored for analysis with link back',
    attribution: `GitHub issue ${repo ?? ''}#${item.number}`.trim(),
    content_hash: await sha256Hex(text),
  };
}

export const githubConnector: Connector = {
  id: SOURCE,
  name: 'GitHub',
  checkConfig(env) {
    return {
      ok: true,
      missing: [],
      notes: env.GITHUB_TOKEN ? ['GITHUB_TOKEN set: 30 search requests/min'] : ['No GITHUB_TOKEN: unauthenticated search is limited to 10 requests/min - set GITHUB_TOKEN (read-only, public data) for headroom'],
    };
  },

  httpOptions: (env) => ({ minIntervalMs: { 'github-search': env.GITHUB_TOKEN ? 2100 : 6500 } }),

  async fetchBatch(ctx: ConnectorContext): Promise<FetchResult> {
    const cfg = ctx.config;
    const queries: Array<{ id: string; q: string }> = Array.isArray(cfg.queries) ? cfg.queries : [];
    if (queries.length === 0) throw new ConnectorError('no queries configured');
    const perPage = Math.min(Math.max(Number(cfg.per_page) || 100, 1), 100);
    const maxPages = Math.min(Math.max(Number(cfg.max_pages) || 3, 1), 10);
    const lookbackMs = (Number(cfg.lookback_days) || 30) * 86_400_000;

    const cur: GhCursor = { qi: 0, page: 1, newest: null, since: {}, ...(ctx.cursor as GhCursor) };
    const qi = (cur.qi ?? 0) % queries.length;
    const query = queries[qi];
    const page = cur.page ?? 1;
    const since = cur.since?.[query.id] ?? new Date(ctx.now().getTime() - lookbackMs).toISOString().replace(/\.\d{3}Z$/, 'Z');

    const q = `${query.q} updated:>=${since}`;
    const url = `${API}/search/issues?q=${encodeURIComponent(q)}&sort=updated&order=desc&per_page=${perPage}&page=${page}`;
    const headers: Record<string, string> = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'DemandRadar-collector' };
    if (ctx.env.GITHUB_TOKEN) headers.authorization = `Bearer ${ctx.env.GITHUB_TOKEN}`;

    const { data, headers: rh } = await ctx.http.getJson<{ total_count?: number; incomplete_results?: boolean; items?: GhIssue[] }>(url, { headers, minIntervalKey: 'github-search' });
    if (!data || !Array.isArray(data.items)) throw new ConnectorError('unexpected GitHub response shape (no items array)');

    const records: RawRecordInput[] = [];
    let newest = cur.newest ?? null;
    for (const item of data.items) {
      const rec = await normaliseIssue(item, ctx.env, query.id);
      if (item.updated_at && (!newest || item.updated_at > newest)) newest = item.updated_at;
      if (rec) records.push(rec);
    }

    const limit = Number(rh.get('x-ratelimit-limit'));
    const remaining = Number(rh.get('x-ratelimit-remaining'));
    const reset = Number(rh.get('x-ratelimit-reset'));
    const quota: QuotaInfo = {
      limit: Number.isFinite(limit) && rh.has('x-ratelimit-limit') ? limit : null,
      remaining: Number.isFinite(remaining) && rh.has('x-ratelimit-remaining') ? remaining : null,
      resetAt: Number.isFinite(reset) && rh.has('x-ratelimit-reset') ? new Date(reset * 1000).toISOString() : null,
    };

    const queryFinished = data.items.length < perPage || page >= maxPages || page * perPage >= 1000;
    const nextCursor: GhCursor = { qi, page: page + 1, newest, since: { ...(cur.since ?? {}) } };
    let done = false;
    if (queryFinished) {
      if (newest) nextCursor.since![query.id] = newest; // watermark only advances once the whole query has been paged
      nextCursor.qi = qi + 1;
      nextCursor.page = 1;
      nextCursor.newest = null;
      if (nextCursor.qi >= queries.length) {
        nextCursor.qi = 0;
        done = true;
      }
    }
    return { records, cursor: nextCursor as Record<string, unknown>, done, quota, inspected: data.items.length };
  },
};
