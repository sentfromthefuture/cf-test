import { Connector } from '../types.ts';
import { githubConnector } from './github.ts';
import { hackerNewsConnector } from './hackernews.ts';
import { stackExchangeConnector } from './stackexchange.ts';

/**
 * Connector registry. To add a source: implement `Connector`, register it here, and insert a row into dr_sources.
 * Sources that are not legitimately accessible (Reddit, Product Hunt, Google Trends, ...) intentionally have NO connector:
 * they exist only as documented, non-runnable rows in dr_sources.
 */
export const connectors: Record<string, Connector> = {
  [githubConnector.id]: githubConnector,
  [hackerNewsConnector.id]: hackerNewsConnector,
  [stackExchangeConnector.id]: stackExchangeConnector,
};

/** Mirrors the seed rows in supabase/migrations (a test keeps the two in sync). Used by the live-check script. */
export const defaultConfigs: Record<string, Record<string, unknown>> = {
  github: {
    per_page: 100, max_pages: 3, lookback_days: 30,
    queries: [
      { id: 'feature-requests', q: 'is:issue is:open label:"feature request" reactions:>=3' },
      { id: 'enhancements', q: 'is:issue is:open label:enhancement comments:>=8' },
      { id: 'wish', q: 'is:issue is:open "wish there was" in:title,body' },
      { id: 'alternatives', q: 'is:issue "looking for an alternative" in:title,body comments:>=2' },
    ],
  },
  hackernews: { lists: ['askstories', 'topstories', 'showstories'], list_limit: 150, min_score: 5, comment_story_min_descendants: 8, comments_per_story: 12, concurrency: 6, batch_size: 24 },
  stackexchange: {
    pagesize: 50, max_pages: 2, lookback_days: 14,
    targets: [
      { id: 'softwarerecs', site: 'softwarerecs', mode: 'questions' },
      { id: 'webapps', site: 'webapps', mode: 'questions' },
      { id: 'softwareengineering-tools', site: 'softwareengineering', mode: 'search', q: 'is there a tool' },
      { id: 'serverfault-tools', site: 'serverfault', mode: 'search', q: 'is there a tool' },
      { id: 'stackoverflow-alternatives', site: 'stackoverflow', mode: 'search', q: 'alternative to' },
    ],
  },
};
