# DemandRadar – Market-Intelligence Collection Engine

**Status: partially complete. Pushed as a checkpoint so the work can be finished later.**
This file is the source of truth for what is done, what was verified, and what is left.

---

## 1. What was found in the original app

- Frontend: React + Vite + Tailwind. Backend: Cloudflare Pages Functions (`functions/api/*`) plus an Express dev server (`server.ts`). Supabase for auth and subscriptions. There were **no Supabase migrations** in the repo.
- **Every dashboard number was hardcoded or simulated**: "48,920 discussions", "529 scans/min", "10 autonomous bots", a fake bot swarm (Reddit/Facebook/X/G2 scouts that did not exist), "99.4% signal-to-noise", fixed opportunity data with invented evidence quotes.
- All of that has been replaced with database queries, or is clearly labelled **Demo data** (see §3).

## 2. What is DONE

### Database (`supabase/migrations/`, two files)
| Item | Notes |
|---|---|
| `dr_sources` | Registry: enable/disable, interval, cursor, status, last/next run, quota, error, licence note. Skipped sources are stored here **with their documented reasons**. |
| `dr_raw_records` | Raw collected records. `unique(source_id, source_record_id)`, content hash, licence + attribution per record, hashed author reference (no usernames), excerpt only (≤ 2000 chars). Indexed for millions of rows. |
| `dr_problem_signals`, `dr_clusters`, `dr_cluster_members` | Processed layer, separate from raw. pgvector (768-d) + HNSW index; pg_trgm fallback. |
| `dr_collection_runs`, `dr_api_usage`, `dr_job_locks`, `dr_admins` | Run history, per-day API usage, locks so jobs never overlap, admin list. |
| RLS | Enabled on every table with **no policies**. Browser access only through `SECURITY DEFINER` read functions (`dr_public_sources`, `dr_overview`, `dr_activity`, `dr_recent_signals`, `dr_clusters_list`, `dr_cluster_timeline`; evidence needs sign-in; admin actions check `dr_admins`). Collector functions are `service_role` only. |
| Idempotent upsert | `dr_upsert_records`: retry-safe, de-duplicates inside a batch, rejects non-http(s) URLs, re-queues analysis only when content actually changed. |
| Explainable scoring | `dr_refresh_clusters`: every component carries a `basis` (`measured`, `evidence_count`, `derived`, `ai_estimate`, `insufficient_data`). Missing data is excluded from the composite instead of being faked. Growth = unique discussions in last 30 days vs the 30 before; needs ≥ 5. |

### Collection engine (`supabase/functions/_shared/collector/`, runtime-agnostic TypeScript)
- Connector interface; **GitHub** (REST issue search), **Hacker News** (Firebase API: stories + top-level comments), **Stack Exchange** (API v2.3, CC BY-SA attribution stored, `backoff` obeyed, quota tracked).
- HTTP client: timeouts, exponential backoff with jitter, `Retry-After`/rate-limit headers, long waits become a reschedule instead of a sleep, malformed-JSON handling, usage counters.
- Runner: atomic claim of due sources, per-source isolation (one failing connector never stops the others), cursor saved only after data is stored (safe to retry), partial runs resume, error backoff.
- Analysis: cheap pre-filter, then LLM classification (Gemini, if `GEMINI_API_KEY` set) or a **clearly labelled keyword fallback**; LLM output is validated (willingness-to-pay quotes and competitor names must literally appear in the source text); embeddings; clustering; AI cluster summary. Untrusted text is passed as data with an anti-injection system prompt. Unchanged records are never re-analysed.
- Edge Function `supabase/functions/collect` (scheduler secret or admin JWT), `supabase/config.toml`, `supabase/cron.sql` (scheduler SQL).

### Dashboard
- `src/lib/liveData.ts` (typed RPC layer, cluster → Opportunity mapping, fails soft).
- New **Data Sources** tab (status, records, last/next sync, API usage, quota, errors, licence notes, admin enable/disable/interval/manual sync, and the skipped sources with reasons).
- New **Research Activity** tab (KPIs, collection per day, source distribution, recent discoveries, emerging clusters).
- Dashboard, navbar, footer and Trend Analytics now use live counts; Trend Analytics shows only measurable panels in live mode.
- Opportunities come from clusters with **≥ 2 independent discussions**. Single mentions are never presented as opportunities.
- Removed: the fake bot swarm (`BotSwarmModal`, `INITIAL_BOTS`, `BotScout`, `/api/bots` in both server.ts and Pages Functions) and other fabricated claims in copy.

## 3. Demo data (still present, labelled)
`src/data/mockData.ts` opportunities and the Trend Analytics sample charts remain as a **fallback only**. An amber **Demo data** banner shows on Dashboard / Explorer / Intelligence / Trends whenever live clusters are unavailable, and the navbar badge says `DEMO` or `NO DATA YET`.

## 4. Verification actually performed (and what it does NOT prove)

| Check | Result |
|---|---|
| SQL migrations on Postgres 16 + pgvector 0.6 | Applied cleanly. `supabase/tests/10_market_intel.test.sql` (assert-based): dedup, retry safety, change-triggered re-analysis, embedding + trigram clustering, cross-platform counting, growth windows, score basis labels, locking, backoff, RLS/grants. **Passes.** It caught one real bug (variable/column clash) which was fixed. |
| Engine unit tests (`npm run test:collector`) | **46 pass**: retry/backoff/timeouts/rate limits, connector pagination + watermarks, noise filtering, runner isolation, rate-limit and DB-failure handling, LLM-output validation. Strict `tsc` clean. |
| **GitHub live** | Real API called: 712 real issues collected, quota read from response headers. |
| **End-to-end** (`supabase/tests/e2e.ts`) | Real runner → `SupabaseStore` → PostgREST 12.2.3 → migrated Postgres → dashboard RPCs as an anonymous user. Inserted rows match `records_total`; a **replay** of the same window re-fetched 713, inserted 0, 711 duplicates, 2 engagement updates; anon denied on collector functions and raw tables. |
| Build | `tsc --noEmit` and `vite build` pass. |

**NOT verified (be honest about these):**
- **Hacker News and Stack Exchange connectors were never run against the real APIs.** The build sandbox could not reach those hosts. Their tests use *synthetic* fixtures written from the documented schemas. Run `npm run collector:live-check` from any machine with normal internet.
- **Gemini was never called** (no key, host blocked): classification quality, prompts, embeddings and the cluster-similarity threshold (0.80) are **untested and uncalibrated**.
- The **Edge Function has not been deployed or run under Deno**; **pg_cron/pg_net scheduling has not been run**; the migrations have **not been applied to the real Supabase project**.
- The UI was **type-checked and built but not opened in a browser** (no visual QA).
- Without an AI key the keyword fallback flags almost every labelled feature request as a "problem" and clusters rarely merge (on real GitHub data: ~700 problems → ~700 clusters). That is expected and labelled, but real clustering needs the embedding path.

## 5. Sources

| Source | Status | Notes |
|---|---|---|
| GitHub | Implemented, **live-verified** | Official REST search. Unauthenticated = 10 search req/min; set `GITHUB_TOKEN` for 30/min. Discussions are GraphQL-only (token required) → not implemented. |
| Hacker News | Implemented, **not live-verified** | Official Firebase API, no key. |
| Stack Exchange | Implemented, **not live-verified** | 300 req/day per IP without a key (shared with other functions on the same egress IP); **set `STACKEXCHANGE_KEY`** (free, 10,000/day). Answers are not collected, only question metadata. |
| Google Trends | **Skipped** | No permitted public API. Official Trends API is an alpha for approved testers; unofficial libraries scrape internal endpoints. Needs: apply for the alpha. |
| Reddit | **Skipped** | Data API needs prior approval and a commercial agreement for commercial use. Needs: written approval/contract, then OAuth secrets. No scraping. |
| Product Hunt | **Skipped** | API terms forbid commercial use without permission. Needs: written permission. |
| Kaggle | **Skipped (not built)** | Official API exists but datasets aren't problem discussions and licences vary. Needs: token + licence allow-list; better as a market-sizing enrichment later. |
| Gov open data | **Skipped (not built)** | Legit APIs exist (CKAN, World Bank). Statistical data, not problems; planned as an enrichment layer. |

Each skipped source has its reason, restriction, official-API status and integration requirements stored in `dr_sources` and shown in the Data Sources tab.

## 6. How to activate (Supabase dashboard + GitHub only; no laptop needed where noted)

1. **Migrations** – Supabase dashboard → SQL editor: run, in order, `supabase/migrations/20261104000000_market_intel_schema.sql`, `20261104000100_market_intel_functions.sql`, `20261106000000_reanalyse.sql` (adds the admin “Re-analyse” action), `20261106000100_reanalyse_fix.sql` (must also be run; fixes re-analyse so keyword signals are removed instead of re-clustered). (Or `supabase db push`.)
2. **Function secrets** – Edge Functions → Secrets. Nothing is required for a manual sync: the function automatically receives `SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` from Supabase (names starting with `SUPABASE_` are reserved, so do **not** try to set them). Add these only when needed: `COLLECTOR_SECRET` (long random string; required only for the scheduled cron), and optionally `GITHUB_TOKEN` (read-only, public data), `STACKEXCHANGE_KEY`, `GEMINI_API_KEY` (+ `GEMINI_MODEL`, default `gemini-3.5-flash`; Google retired `gemini-2.5-flash`, which returns HTTP 404 — model ids change, override here when they do; `GEMINI_EMBEDDING_MODEL`, default `gemini-embedding-001`, listed as legacy with `gemini-embedding-2` as its successor), `CLUSTER_SIMILARITY` (0-1, default 0.80: lower = more aggressive grouping), `AUTHOR_HASH_SALT`. Never put these in frontend env vars.
3. **Deploy the function** – automatic: `.github/workflows/deploy-collector.yml` deploys `collect` on every push to `main` that touches `supabase/functions/**` (and on demand from the Actions tab). Needs repo secrets `SUPABASE_ACCESS_TOKEN` and `SUPABASE_PROJECT_REF`. Uses Supabase CLI 3.0.0 with `--yes --remote=<ref>`.
4. **Make yourself admin** – SQL editor: `insert into public.dr_admins (user_id) select id from auth.users where email = '<your email>';`
5. **Schedule** – edit and run `supabase/cron.sql` in the SQL editor.
6. Open the **Data Sources** tab → “Sync all due sources” to test before relying on cron.

## 7. NOT DONE / next steps (rough priority)

1. **Licence/attribution display (compliance)**: the live evidence data already carries `url`, `license`, `attribution`, but `OpportunityIntelligenceView`'s Evidence tab still renders only quote/author/upvotes. Stack Exchange content is CC BY-SA, so author, link and licence **must** be shown next to any excerpt before this is public. Also show per-component score basis labels (data exists in `opportunity.live.basis`) in that view.
2. Run the live checks for Hacker News and Stack Exchange; fix anything real APIs reveal.
3. Add a Gemini key, then **calibrate** the cluster threshold on real data and review classification quality. Records analysed by the keyword fallback are re-processed via the admin **Re-analyse / process queue** button (Data Sources tab).
4. Browser QA of the new tabs and the demo/live switch on mobile.
5. Cluster merge pass (two clusters for one problem can arise concurrently, or from keyword vs embedding paths).
6. Server-side plan enforcement for evidence (currently any signed-in user can read excerpts; the app's plan gating is client-side as before).
7. Wire the existing AI brief/PRD generator (`functions/api/generate-brief.ts`) to live cluster evidence.
8. Retention/purge job for stored excerpts; refresh engagement for already-stored HN items; GitHub Discussions (GraphQL); Stack Exchange answers; open-data enrichment layer.
9. CI: run `npm run test:collector`, the SQL tests and `tsc` on every push. Note `npm install` needs `--legacy-peer-deps` (pre-existing peer conflict; repo uses `bun.lock`).

## 8. Security and licensing notes
- No API key or privileged credential exists in frontend code. Collector secrets live only in Edge Function secrets / Vault; error messages are redacted before they are stored.
- Stored: titles + ≤ 1200-char excerpts + link-back + licence/attribution + hashed author reference. Not stored: usernames, locations, emails.
- Platform content is owned by its authors; "publicly visible" is not "free to reuse". Review the GitHub, Hacker News/Y Combinator and Stack Exchange API terms before commercial redistribution of excerpts, and keep excerpts short and attributed.
- Never trust collected text: it is escaped by React, never rendered as HTML, and passed to the LLM only as data.
- **Security note:** a GitHub access token was pasted into a chat session while this work was done. Revoke it in GitHub → Settings → Developer settings and create a new one.

## 9. Useful commands
```bash
npm run test:collector                    # engine unit tests
npm run collector:live-check [github|hackernews|stackexchange]   # real APIs, no database
npx tsc --noEmit && npx vite build
psql -d <test db> -f supabase/tests/00_stub_supabase.sql   # then migrations, then 10_market_intel.test.sql (plain Postgres + pgvector only)
```

## 10. AI engines (Decisions Fast + optional summaries) – development branch, disabled by default

A two-engine AI layer (record classification with `parallel/decisions-fast:free` through OpenRouter's Decisions API, optional summaries with `baidu/ernie-5.5-flash-preview:free`) with a persistent Supabase result cache,
usage counters and a read-only per-cluster evidence profile. **Nothing is enabled by default and production settings (`OPENROUTER_ENABLED=false`, paused cron) are unchanged.**
Architecture, configuration, safeguards, tests, limitations and the step-by-step review/deploy runbook: [`docs/AI_ARCHITECTURE.md`](AI_ARCHITECTURE.md).
It adds one **optional, additive** migration, `supabase/migrations/20261109000000_ai_results_cache.sql`, to run (SQL editor) *before* enabling either engine; it is not needed for the existing features.
