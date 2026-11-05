// Live smoke test against the REAL public APIs, with no database: fetches one batch per connector and prints what came back.
//   npx tsx supabase/functions/_shared/collector/live-check.ts [github|hackernews|stackexchange]
// Honours GITHUB_TOKEN / STACKEXCHANGE_KEY from the environment. Prints nothing secret.
import { connectors, defaultConfigs } from './connectors/index.ts';
import { createHttpClient } from './http.ts';
import { consoleLogger } from './types.ts';
import { safeError } from './util.ts';

const only = process.argv[2];
const env = process.env as Record<string, string | undefined>;
let failures = 0;

for (const [id, connector] of Object.entries(connectors)) {
  if (only && only !== id) continue;
  const http = createHttpClient({ headers: { 'user-agent': 'DemandRadar-collector live-check' }, ...(connector.httpOptions?.(env) ?? {}), retries: 1, timeoutMs: 15_000 });
  const seen = new Set<string>();
  let cursor: Record<string, unknown> = {};
  let total = 0;
  const kinds: Record<string, number> = {};
  try {
    for (let i = 0; i < (id === 'hackernews' ? 3 : 1); i++) {
      const res = await connector.fetchBatch({
        env, config: defaultConfigs[id] as Record<string, any>, cursor, http, log: consoleLogger, now: () => new Date(),
        timeLeftMs: () => 60_000, existingIds: async () => new Set<string>(),
      });
      cursor = res.cursor;
      for (const r of res.records) { total++; kinds[r.kind] = (kinds[r.kind] ?? 0) + 1; seen.add(r.source_record_id); }
      if (i === 0) {
        console.log(`\n[${id}] first batch: ${res.records.length} records (inspected ${res.inspected ?? '?'}), quota=${JSON.stringify(res.quota ?? null)}`);
        for (const r of res.records.slice(0, 3)) console.log(`  - ${r.kind} ${r.url}\n    "${(r.title ?? '').slice(0, 90)}" engagement=${JSON.stringify(r.engagement)} license="${r.license.slice(0, 40)}"`);
      }
    }
    console.log(`[${id}] OK  total=${total} unique=${seen.size} kinds=${JSON.stringify(kinds)} usage=${JSON.stringify(http.usage())}`);
  } catch (e) {
    failures++;
    console.log(`[${id}] FAILED: ${safeError(e)} usage=${JSON.stringify(http.usage())}`);
  }
}
process.exit(failures ? 1 : 0);
