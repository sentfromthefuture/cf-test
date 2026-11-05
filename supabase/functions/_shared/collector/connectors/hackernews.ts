import { Connector, ConnectorContext, FetchResult, RawRecordInput } from '../types.ts';
import { cleanStatement, hasWtpPattern, problemSignalScore } from '../heuristics.ts';
import { guessLanguage, hashAuthor, htmlToText, isoOrNull, num, sha256Hex, truncate } from '../util.ts';

// Official Hacker News API (Firebase): https://github.com/HackerNews/API
// No authentication, no published rate limit; we stay polite with small concurrency.
// Cycle: plan (read story lists, drop known ids) -> stories (fetch items) -> comments (top-level comments of promising stories).

const BASE = 'https://hacker-news.firebaseio.com/v0';
const SOURCE = 'hackernews';
const MAX_REJECTED = 3000;

interface HnItem {
  id: number;
  type?: string;
  by?: string;
  time?: number;
  title?: string;
  text?: string;
  url?: string;
  score?: number;
  descendants?: number;
  kids?: number[];
  parent?: number;
  deleted?: boolean;
  dead?: boolean;
}

interface HnCursor {
  phase?: 'plan' | 'stories' | 'comments';
  pending?: number[];
  rejected?: number[];
  commentQueue?: Array<{ story: number; title: string; kids: number[] }>;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

const itemUrl = (id: number) => `https://news.ycombinator.com/item?id=${id}`;

export async function normaliseStory(item: HnItem, env: Record<string, string | undefined>): Promise<RawRecordInput | null> {
  if (!item || item.deleted || item.dead || item.type !== 'story' || !item.title) return null;
  const text = item.text ? htmlToText(item.text) : '';
  const host = item.url ? safeHost(item.url) : null;
  const isShow = /^show hn/i.test(item.title);
  return {
    source_id: SOURCE,
    source_record_id: String(item.id),
    discussion_key: `${SOURCE}:${item.id}`,
    kind: 'story',
    url: itemUrl(item.id),
    title: truncate(item.title, 300),
    excerpt: text ? truncate(text, 1200) : null,
    author_ref: await hashAuthor(env, SOURCE, item.by),
    parent_source_record_id: null,
    published_at: isoOrNull(item.time),
    updated_at_source: null,
    engagement: { score: num(item.score), comments: num(item.descendants) },
    categories: [/^ask hn/i.test(item.title) ? 'ask-hn' : isShow ? 'show-hn' : 'story', ...(host ? [`domain:${host}`] : [])],
    language: guessLanguage(`${item.title} ${text}`),
    license: 'Hacker News user content (author-owned); API by Y Combinator; excerpt stored with link back',
    attribution: `Hacker News item ${item.id}`,
    content_hash: await sha256Hex(`${item.title}\n${text}`),
  };
}

export async function normaliseComment(item: HnItem, story: { story: number; title: string }, env: Record<string, string | undefined>): Promise<RawRecordInput | null> {
  if (!item || item.deleted || item.dead || item.type !== 'comment' || !item.text) return null;
  const text = htmlToText(item.text);
  return {
    source_id: SOURCE,
    source_record_id: String(item.id),
    discussion_key: `${SOURCE}:${story.story}`, // comments belong to their story's discussion: they are not independent demand
    kind: 'comment',
    url: itemUrl(item.id),
    title: truncate(story.title, 300),
    excerpt: truncate(text, 1200),
    author_ref: await hashAuthor(env, SOURCE, item.by),
    parent_source_record_id: String(story.story),
    published_at: isoOrNull(item.time),
    updated_at_source: null,
    engagement: { replies: Array.isArray(item.kids) ? item.kids.length : 0 },
    categories: [`comment-on:${story.story}`],
    language: guessLanguage(text),
    license: 'Hacker News user content (author-owned); API by Y Combinator; excerpt stored with link back',
    attribution: `Hacker News comment ${item.id}`,
    content_hash: await sha256Hex(text),
  };
}

function safeHost(u: string): string | null {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

export const hackerNewsConnector: Connector = {
  id: SOURCE,
  name: 'Hacker News',
  checkConfig: () => ({ ok: true, missing: [], notes: ['No credentials needed (public Firebase API)'] }),

  async fetchBatch(ctx: ConnectorContext): Promise<FetchResult> {
    const cfg = ctx.config;
    const cur: HnCursor = { phase: 'plan', pending: [], rejected: [], commentQueue: [], ...(ctx.cursor as HnCursor) };
    const batchSize = Math.min(Math.max(Number(cfg.batch_size) || 24, 1), 60);
    const concurrency = Math.min(Math.max(Number(cfg.concurrency) || 6, 1), 10);
    const minScore = Number(cfg.min_score) || 5;
    const listLimit = Math.min(Math.max(Number(cfg.list_limit) || 150, 10), 500);
    const lists: string[] = (Array.isArray(cfg.lists) ? cfg.lists : ['askstories']).filter((l: string) => /^(ask|top|show|best|new)stories$/.test(l));
    const minDesc = Number(cfg.comment_story_min_descendants) || 8;
    const perStory = Math.min(Math.max(Number(cfg.comments_per_story) || 12, 1), 40);

    // ---- phase 1: plan
    if (cur.phase === 'plan') {
      const ids = new Set<number>();
      for (const list of lists) {
        const { data } = await ctx.http.getJson<number[]>(`${BASE}/${list}.json`);
        if (!Array.isArray(data)) continue; // malformed list: ignore this list, keep the rest
        for (const id of data.slice(0, listLimit)) if (Number.isInteger(id)) ids.add(id);
      }
      const all = [...ids];
      const known = await ctx.existingIds(SOURCE, all.map(String));
      const rejected = new Set(cur.rejected ?? []);
      const pending = all.filter((id) => !known.has(String(id)) && !rejected.has(id)).slice(0, 400);
      return { records: [], cursor: { phase: pending.length ? 'stories' : 'comments', pending, rejected: cur.rejected, commentQueue: [] }, done: pending.length === 0, inspected: all.length };
    }

    // ---- phase 2: stories
    if (cur.phase === 'stories') {
      const take = (cur.pending ?? []).slice(0, batchSize);
      const rest = (cur.pending ?? []).slice(batchSize);
      const items = await mapLimit(take, concurrency, async (id) => (await ctx.http.getJson<HnItem | null>(`${BASE}/item/${id}.json`)).data);
      const records: RawRecordInput[] = [];
      const rejected = [...(cur.rejected ?? [])];
      const queue = [...(cur.commentQueue ?? [])];
      for (let i = 0; i < take.length; i++) {
        const item = items[i];
        const rec = item ? await normaliseStory(item, ctx.env) : null;
        if (!item || !rec) {
          rejected.push(take[i]);
          continue;
        }
        const text = `${item.title ?? ''}\n${rec.excerpt ?? ''}`;
        const signal = problemSignalScore(text);
        const isAsk = rec.categories.includes('ask-hn');
        const isShowWithTraction = rec.categories.includes('show-hn') && num(item.score) >= minScore; // launches = evidence of existing solutions
        if (!(isAsk || isShowWithTraction || signal >= 1)) {
          rejected.push(item.id);
          continue;
        }
        records.push(rec);
        if (Array.isArray(item.kids) && item.kids.length && num(item.descendants) >= minDesc && (isAsk || signal >= 1 || num(item.score) >= minScore * 3)) {
          queue.push({ story: item.id, title: item.title ?? '', kids: item.kids.slice(0, perStory) });
        }
      }
      return {
        records,
        cursor: { phase: rest.length ? 'stories' : 'comments', pending: rest, rejected: rejected.slice(-MAX_REJECTED), commentQueue: queue },
        done: false,
        inspected: take.length,
      };
    }

    // ---- phase 3: comments
    const queue = [...(cur.commentQueue ?? [])];
    const jobs: Array<{ id: number; story: { story: number; title: string } }> = [];
    while (queue.length && jobs.length < batchSize) {
      const head = queue[0];
      const id = head.kids.shift();
      if (id === undefined) {
        queue.shift();
        continue;
      }
      jobs.push({ id, story: { story: head.story, title: head.title } });
      if (head.kids.length === 0) queue.shift();
    }
    const items = await mapLimit(jobs, concurrency, async (j) => (await ctx.http.getJson<HnItem | null>(`${BASE}/item/${j.id}.json`)).data);
    const records: RawRecordInput[] = [];
    for (let i = 0; i < jobs.length; i++) {
      const item = items[i];
      if (!item || item.parent !== jobs[i].story.story) continue; // top-level comments only
      const rec = await normaliseComment(item, jobs[i].story, ctx.env);
      if (!rec || !rec.excerpt || rec.excerpt.length < 80) continue;
      if (problemSignalScore(rec.excerpt) >= 1 || hasWtpPattern(rec.excerpt)) records.push(rec);
    }
    const done = queue.length === 0;
    return { records, cursor: { phase: done ? 'plan' : 'comments', pending: [], rejected: cur.rejected, commentQueue: queue }, done, inspected: jobs.length };
  },
};

export { cleanStatement };
