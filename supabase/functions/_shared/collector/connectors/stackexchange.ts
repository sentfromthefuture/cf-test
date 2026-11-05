import { Connector, ConnectorContext, ConnectorError, FetchResult, HttpError, QuotaInfo, RateLimitError, RawRecordInput } from '../types.ts';
import { guessLanguage, hashAuthor, htmlToText, isoOrNull, num, sha256Hex, truncate } from '../util.ts';

// Official Stack Exchange API v2.3: https://api.stackexchange.com/docs
// Quota: 300 requests/day per IP without a key, 10,000/day with a (free) app key -> set STACKEXCHANGE_KEY (server-side only).
// We obey the `backoff` field, never exceed 30 req/s (we make ~1/s at most), and stop when quota is nearly exhausted.
// Content is CC BY-SA: author, link and licence are stored on every record (attribution column) and must be shown with any excerpt.

const API = 'https://api.stackexchange.com/2.3';
const SOURCE = 'stackexchange';
const HOLD_KEY = 'stackexchange';

interface SeQuestion {
  question_id: number;
  title: string;
  body?: string;
  link: string;
  score?: number;
  view_count?: number;
  answer_count?: number;
  is_answered?: boolean;
  accepted_answer_id?: number;
  tags?: string[];
  creation_date?: number;
  last_activity_date?: number;
  content_license?: string;
  owner?: { display_name?: string; link?: string; user_id?: number };
}

interface SeCursor {
  ti?: number;
  pages?: number;
  from?: Record<string, number>;
}

/** Licence by post date, per Stack Exchange's published terms (the API's content_license wins when present). */
export function seLicense(creationDateSec: number | undefined, apiLicense?: string): string {
  if (apiLicense) return apiLicense;
  if (!creationDateSec) return 'CC BY-SA (version unknown)';
  const d = creationDateSec * 1000;
  if (d >= Date.UTC(2018, 4, 2)) return 'CC BY-SA 4.0';
  if (d >= Date.UTC(2011, 3, 8)) return 'CC BY-SA 3.0';
  return 'CC BY-SA 2.5';
}

function nextMidnightUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
}

export async function normaliseQuestion(q: SeQuestion, site: string, targetId: string, env: Record<string, string | undefined>): Promise<RawRecordInput | null> {
  if (!q || typeof q.question_id !== 'number' || !q.link || !q.title) return null;
  const title = htmlToText(q.title);
  const body = q.body ? htmlToText(q.body) : '';
  const license = seLicense(q.creation_date, q.content_license);
  const author = q.owner?.display_name ? htmlToText(q.owner.display_name) : 'community user';
  return {
    source_id: SOURCE,
    source_record_id: `${site}:${q.question_id}`,
    discussion_key: `${SOURCE}:${site}:${q.question_id}`,
    kind: 'question',
    url: q.link,
    title: truncate(title, 300),
    excerpt: body ? truncate(body, 1200) : null,
    author_ref: await hashAuthor(env, SOURCE, String(q.owner?.user_id ?? q.owner?.display_name ?? '')),
    parent_source_record_id: null,
    published_at: isoOrNull(q.creation_date),
    updated_at_source: isoOrNull(q.last_activity_date),
    engagement: { score: num(q.score), views: num(q.view_count), answers: num(q.answer_count), has_accepted_answer: q.accepted_answer_id ? 1 : 0 },
    categories: [`site:${site}`, `target:${targetId}`, ...(q.tags ?? []).slice(0, 8).map((t) => `tag:${t}`)],
    language: guessLanguage(`${title} ${body}`),
    license,
    attribution: `Question by ${author}${q.owner?.link ? ` (${q.owner.link})` : ''} on ${site}.stackexchange.com - ${q.link} - licensed ${license}`,
    content_hash: await sha256Hex(`${title}\n${body}`),
  };
}

export const stackExchangeConnector: Connector = {
  id: SOURCE,
  name: 'Stack Exchange',
  checkConfig(env) {
    return {
      ok: true,
      missing: [],
      notes: env.STACKEXCHANGE_KEY
        ? ['STACKEXCHANGE_KEY set: 10,000 requests/day']
        : ['No STACKEXCHANGE_KEY: only 300 requests/day per IP (shared by every function on the same egress IP) - register a free app key at stackapps.com'],
    };
  },
  httpOptions: () => ({ minIntervalMs: { [HOLD_KEY]: 1100 } }),

  async fetchBatch(ctx: ConnectorContext): Promise<FetchResult> {
    const cfg = ctx.config;
    const targets: Array<{ id: string; site: string; mode: 'questions' | 'search'; q?: string }> = Array.isArray(cfg.targets) ? cfg.targets : [];
    if (targets.length === 0) throw new ConnectorError('no targets configured');
    const pagesize = Math.min(Math.max(Number(cfg.pagesize) || 50, 1), 100);
    const maxPages = Math.min(Math.max(Number(cfg.max_pages) || 2, 1), 10);
    const lookbackSec = (Number(cfg.lookback_days) || 14) * 86_400;

    const cur: SeCursor = { ti: 0, pages: 0, from: {}, ...(ctx.cursor as SeCursor) };
    const ti = (cur.ti ?? 0) % targets.length;
    const t = targets[ti];
    if (!/^[a-z0-9.]+$/.test(t.site)) throw new ConnectorError(`invalid site "${t.site}"`);
    const from = cur.from?.[t.id] ?? Math.floor(ctx.now().getTime() / 1000) - lookbackSec;

    const params = new URLSearchParams({ site: t.site, order: 'asc', sort: 'creation', fromdate: String(from), pagesize: String(pagesize), page: '1', filter: 'withbody' });
    if (t.mode === 'search') {
      if (!t.q) throw new ConnectorError(`target ${t.id} needs q`);
      params.set('q', t.q);
    }
    if (ctx.env.STACKEXCHANGE_KEY) params.set('key', ctx.env.STACKEXCHANGE_KEY);
    const url = `${API}/${t.mode === 'search' ? 'search/advanced' : 'questions'}?${params}`;

    let payload: { items?: SeQuestion[]; has_more?: boolean; quota_max?: number; quota_remaining?: number; backoff?: number; error_id?: number; error_name?: string };
    try {
      payload = (await ctx.http.getJson<typeof payload>(url, { minIntervalKey: HOLD_KEY })).data;
    } catch (e) {
      if (e instanceof HttpError && /throttle_violation|"error_id":\s*502/.test(e.bodySnippet)) {
        const secs = /available in (\d+) seconds/.exec(e.bodySnippet)?.[1];
        throw new RateLimitError('Stack Exchange throttled this IP/key', secs ? new Date(ctx.now().getTime() + Number(secs) * 1000) : nextMidnightUtc(ctx.now()));
      }
      throw e;
    }
    if (!payload || !Array.isArray(payload.items)) throw new ConnectorError('unexpected Stack Exchange response shape (no items array)');
    if (payload.error_id) throw new ConnectorError(`Stack Exchange error ${payload.error_id}: ${payload.error_name ?? 'unknown'}`);
    if (payload.backoff && payload.backoff > 0) ctx.http.holdUntil(HOLD_KEY, ctx.now().getTime() + payload.backoff * 1000); // mandatory per API terms

    const records: RawRecordInput[] = [];
    let maxCreated = from;
    for (const q of payload.items) {
      if (typeof q?.creation_date === 'number' && q.creation_date > maxCreated) maxCreated = q.creation_date;
      const rec = await normaliseQuestion(q, t.site, t.id, ctx.env);
      if (rec) records.push(rec);
    }

    const quota: QuotaInfo = {
      limit: typeof payload.quota_max === 'number' ? payload.quota_max : null,
      remaining: typeof payload.quota_remaining === 'number' ? payload.quota_remaining : null,
      resetAt: nextMidnightUtc(ctx.now()).toISOString(), // SE quotas reset daily at 00:00 UTC
    };

    const pages = (cur.pages ?? 0) + 1;
    const targetFinished = !payload.has_more || payload.items.length === 0 || pages >= maxPages;
    const nextFrom = { ...(cur.from ?? {}), [t.id]: payload.items.length ? maxCreated : from };
    let next: SeCursor = { ti, pages, from: nextFrom };
    let done = false;
    if (targetFinished) {
      next = { ti: ti + 1, pages: 0, from: nextFrom };
      if (next.ti! >= targets.length) {
        next.ti = 0;
        done = true;
      }
    }
    const result: FetchResult = { records, cursor: next as Record<string, unknown>, done, quota, inspected: payload.items.length };
    if (quota.remaining !== null && quota.remaining <= 2) result.rateLimitedUntil = quota.resetAt!;
    return result;
  },
};
