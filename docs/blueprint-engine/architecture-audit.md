# ERNIE Blueprint Engine – Phase A, Task 1A: Existing architecture audit

**Status:** documentation only. Nothing in this document changes code, schema, configuration, secrets, cron or deployments.
**Audited commit:** `76780ee8bd8916367cc2369d9866fc5b1abf2c49` (`origin/main`, merge of PR #16 "Replace LFM3 summary engine with Baidu ERNIE 5.5 Flash Preview", 2026-11-13).
**Companion documents:** [`product-blueprint-v1.md`](./product-blueprint-v1.md) · [`evidence-contract.md`](./evidence-contract.md) · [`ernie-system-prompt.md`](./ernie-system-prompt.md) · [`reliability-and-cache-design.md`](./reliability-and-cache-design.md)

## How to read this document

Every statement is tagged so a reviewer can tell what was checked from what was assumed.

| Tag | Meaning |
|---|---|
| **[V]** | **Verified** by reading the repository at the audited commit. A file, function or constant is named so it can be re-checked. |
| **[A]** | **Assumption / unverified.** Comes from a comment, from documentation inside the repository, or from outside knowledge. Nothing was run against production or a live provider. |
| **[H]** | The task handover says this, and the repository **disagrees or is silent**. Listed in §2. |

No request was made to OpenRouter, Parallel, Baidu, Gemini or Supabase while preparing this audit. The production environment (secrets, which migrations were applied, whether cron is paused) **was not inspected**; what the repository's own docs say about it is tagged **[A]**.

---

## 1. One-page summary

1. **[V]** The AI layer has three AI call paths today, all optional and off by default: Decisions Fast (per-record classification), ERNIE summaries (per-cluster narrative) and Gemini (embeddings, optional classification, optional summaries). A fourth, separate AI path is the PRD generator `functions/api/generate-brief.ts` (Gemini, user-triggered). The blueprint engine would be a **fifth**, independent path.
2. **[V]** Decisions Fast and ERNIE share **one HTTP client** with a **30 s timeout and 1 retry** (`runner.ts`), one cache table (`dr_ai_cache`), one usage table (`dr_ai_usage`) and one cache-version override (`AI_CACHE_VERSION`). The blueprint engine must not inherit any of these implicitly.
3. **[V]** The cache and usage tables are **hard-limited to two task names** by inline `CHECK` constraints (`task in ('decisions','summary')`, `engine in ('decisions','summary')`). Adding `blueprint` is a small additive change but **does require a database migration** in a later phase. No SQL function needs to change (§3.4).
4. **[V]** The ERNIE summary request shape, its response parser and failure taxonomy are reusable building blocks (`extractJsonObject`, `splitInlineReasoning`, `describeChatCompletion`, `classifyAiFailure`, `cachedCompute`, `meteredCall`), but `requestClusterSummary` itself is hard-wired to the summary prompt, a 3,072-token budget and `validateSummary`. The blueprint engine should **import the reusable pieces and write its own request function**, leaving `ai.ts` untouched.
5. **[V]** Evidence has **no stable, model-citable identifier** in the two paths that feed existing AI features today (`fetchEvidence` drops `record_id`; `loadResearchContext` in `generate-brief.ts` never emits it). `dr_cluster_evidence` does return `record_id`, so the database side is ready; the identifier has to be introduced by the blueprint engine's own evidence-pack builder.
6. **[V]** Entitlement is enforced **only** in the Cloudflare Pages Function `generate-brief.ts` (plan + daily quota + reservation). Frontend gating (`canExport`, `canOpenOpportunity`) is a UI convenience. A new blueprint endpoint needs its own server-side check.
7. **[V]** The existing PRD path does **not persist** its output and produces a different, flatter shape. It does not conflict with a `ProductBlueprint` contract as long as the two stay separate.
8. **[A]** Free ERNIE output speed is quoted as **~90 tok/s** in one repository comment and **~173 tok/s median** in another. Neither figure is a representative benchmark result. No representative performance benchmark was run for this proposal. The three-pass architecture remains, but pass timeouts, output-token budgets, the overall generation deadline, user-facing wait time and synchronous Edge Function viability are not final until the validation gate in [`reliability-and-cache-design.md`](./reliability-and-cache-design.md) §16 is passed.

---

## 2. Handover versus repository

The handover is useful but several statements do not match the code. None of these blocks the design, but each changes it.

| # | Handover says | Repository says | Effect on the design |
|---|---|---|---|
| H1 | Decisions Fast does "initial opportunity scoring". **[H]** | **[V]** Decisions Fast answers four typed questions per **record** (`is_problem`, `signal_type`, `industry`, `severity`; `decisions.ts`). Opportunity scoring is deterministic SQL (`dr_refresh_clusters`). Decisions severity is deliberately **kept out** of `dr_problem_signals.severity` and therefore out of `composite_score` (docs/AI_ARCHITECTURE.md §3). | The blueprint engine must not read Decisions output as a "score". It may read measured cluster metrics (§3.6) and must label AI-derived numbers as AI estimates. |
| H2 | "AI provider: OpenRouter". **[H]** | **[V]** OpenRouter serves Decisions Fast and ERNIE summaries. **Gemini** still serves embeddings, optional classification, optional summaries (`ai.ts`) and the **PRD generator** (`generate-brief.ts`, key read from Cloudflare env). | The blueprint engine uses OpenRouter only. Gemini stays where it is. |
| H3 | ERNIE already does "cluster summaries" and "opportunity synthesis". **[H]** | **[V]** ERNIE produces cluster summaries (`requestClusterSummary`). No separate "opportunity synthesis" step exists; the summary *is* the synthesis. **[A]** Per `docs/AI_ARCHITECTURE.md`, production keeps `OPENROUTER_ENABLED=false`, so ERNIE summaries are **not running in production** (not verified against the live environment). | "Existing summary contract" means exactly the `ClusterSummary` shape in `ai.ts`. It is not touched. |
| H4 | There are "AI cache and usage migrations" (plural). **[H]** | **[V]** One migration: `20261109000000_ai_results_cache.sql` (`dr_ai_cache`, `dr_ai_health`, `dr_ai_usage`, `dr_signal_ai`, `dr_cluster_profile`, cache functions). | One file to extend later, not several. |
| H5 | (not stated) | **[V]** Gemini default model differs between code paths: `gemini-3.5-flash` in `ai.ts` versus `gemini-3.8-flash` in `generate-brief.ts`. | Not a blueprint concern. Noted so nobody copies the wrong default. Not changed. |
| H6 | (not stated) | **[A]** `ai.ts` says OpenRouter lists ~90 tok/s for ERNIE. `docs/ai-smoke-test.md` says ~173 tok/s median. | The two figures are used as a pessimistic and an optimistic bound. Measurement is a Phase B gate. |

---

## 3. Task 1A audit (items 1–10)

### 3.1 Current summary-generation flow

**[V]** Source: `analysis.ts` (`runAnalysis`), `summaries.ts`, `ai.ts`, `store.ts`, `dr_clusters_needing_summary` / `dr_save_cluster_summary` in `20261104000100_market_intel_functions.sql`.

```
runAnalysis (inside the collect function, analysis lock held)
  ... classify records -> save signals -> assign clusters -> refreshClusters(200) ...
  if (!testMode && (openrouter || gemini) && timeLeftMs > 20_000):
      need = clustersNeedingSummary(openrouter ? clamp(OPENROUTER_MAX_SUMMARIES_PER_RUN, 1..5, default 2) : 2)
             -> dr_clusters_needing_summary(p_min_members = 2)
                SQL filter: summary_dirty AND (members_count >= 2 OR (source_count >= 2 AND members_count >= 2)),
                ordered by composite_score desc, statements = up to 20 distinct problem_statement values
      for each cluster (stop if timeLeftMs < 12_000):
          openrouter configured -> summariseClusterCached(cfg, store, statements)   // Engine B, ERNIE
          else gemini           -> summariseCluster(gemini, statements)             // legacy path
          saveClusterSummary -> dr_save_cluster_summary  (sets summary, summary_dirty=false, stats_dirty=true)
      refreshClusters(50)
```

- Summaries run **inside the collection run**, after clustering and scoring, behind the global `analysis` job lock. They are never user-triggered. **[V]**
- A summary failure is contained: logged, counted, the loop stops for the run on a service-level error, core analysis has already been saved. **[V]**
- The summary text is written to `dr_clusters.summary` and **one field of it, `development_feasibility`, feeds `composite_score`** through `dr_refresh_clusters` (measured effect up to ±11 points; documented in `docs/AI_ARCHITECTURE.md` §10 item 8b). **[V]** This is the single most important reason the blueprint engine must have **no write path into `dr_clusters`**.

### 3.2 Decisions Fast integration

**[V]** Source: `decisions.ts`, `decisions-runner.ts`, `analysis.ts`.

- Endpoint `POST https://openrouter.ai/api/alpha/decisions` (dedicated, marked *alpha* upstream). Model default `parallel/decisions-fast:free`. `DECISIONS_CONFIG_VERSION = 'decisions-v1'`.
- Per **record**, not per cluster. Four typed questions; the post is passed as data in `state`, never as an instruction.
- Enabled only by the literal `DECISIONS_ENABLED=true`; free-slug-only (`isFreeModelSlug`); per-run cap `DECISIONS_MAX_PER_RUN` (default 20, max 100); pacing key `decisions` (3,500 ms default).
- Cache-first through `cachedCompute` with `task: 'decisions'`; usage counted under `engine: 'decisions'`.
- Output goes to `dr_problem_signals` (deterministic mapping) and `dr_signal_ai` (model numbers, kept apart from demand data).
- Uses the **shared HTTP client** (30 s timeout, 1 retry). The adapter itself never retries. **[V]**

The blueprint engine has no reason to call Decisions Fast and **must not**. It also must not alter its questions, parser, cache identity or runner.

### 3.3 ERNIE integration

**[V]** Source: `ai.ts` (Engine B section), `ai-common.ts`, `summaries.ts`.

| Aspect | Current implementation |
|---|---|
| Model | `SUMMARY_DEFAULT_MODEL = 'baidu/ernie-5.5-flash-preview:free'`, overridable by `OPENROUTER_MODEL` (must be an explicit `:free` slug) |
| Switch | `OPENROUTER_ENABLED === 'true'` **and** `OPENROUTER_API_KEY` present (`openRouterConfigFromEnv`) |
| Endpoint | `POST https://openrouter.ai/api/v1/chat/completions` |
| Request | `temperature 0.1`, `max_tokens = SUMMARY_MAX_TOKENS (3072)`, `response_format {type:'json_object'}`, `provider {allow_fallbacks:false}`, two messages (system `SUMMARY_SYSTEM`, user `JSON.stringify({statements})`) |
| Headers | `authorization: Bearer …`, `http-referer`, `x-title`; pacing key `openrouter` (1,500 ms) |
| Parsing | `splitInlineReasoning` → `extractJsonObject` → `validateSummary`; never accepts JSON found inside unfinished `<think>` reasoning |
| Failure taxonomy | `AiCallError{kind}` + `AiFailureDetail{reason,…}` with reasons such as `reasoning_exhausted_budget`, `truncated_json`, `empty_content`, `schema_invalid` (content-free, enum-only diagnostics) |
| Cache identity | `(task='summary', input_hash, model, config_version)`; `SUMMARY_CONFIG_VERSION = 'summary-v2'` (+ optional `AI_CACHE_VERSION`) |
| Budget note | The comment above `SUMMARY_MAX_TOKENS` records that ERNIE **always reasons first**, that reasoning tokens **count against `max_tokens`**, and that raising the budget is blocked by the shared 30 s timeout. A related budget-vs-timeout test is kept as a `node:test` TODO (the single `todo` in the 335-test baseline), and `docs/AI_ARCHITECTURE.md` §10 item 16 records the question as unresolved and unverified live. |

**Reusable by a new engine without editing `ai.ts`** (all exported): `splitInlineReasoning`, `extractJsonObject`, `describeChatCompletion`; from `ai-common.ts`: `AiCallError`, `classifyAiFailure`, `aiErrorFromBody`, `isFreeModelSlug`, `canonicalJson`, `aiInputHash`, `cachedCompute`, `meteredCall`, `emptyAiUsage`.
**Not reusable as-is:** `requestClusterSummary` (hard-coded prompt, budget, validator), `validateSummary`, `summaryValidationProblem`, `openRouterConfigFromEnv` (gated by `OPENROUTER_ENABLED`, which must remain the summary switch).

### 3.4 Existing cache architecture

**[V]** Source: `20261109000000_ai_results_cache.sql`, `ai-common.ts` (`cachedCompute`), `store.ts`.

- **Table `dr_ai_cache`**, one row per `(task, input_hash, model, config_version)` (`dr_ai_cache_identity` unique). `input_hash` must match `^[0-9a-f]{64}$`.
- **States:** `pending` (leased), `succeeded` (validated result; a table `CHECK` forbids a success without a JSON-object result), `failed` (no result; cooldown `2^min(attempts,8)` hours capped at 168 h = 1 h, 2 h, 4 h … 7 days).
- **Lease fencing:** `lease_epoch` increments with each lease; `complete`/`fail`/`abandon`/`fail_storage` require the current epoch. Lease length is clamped to **10–900 s** inside `dr_ai_cache_begin` (default requested by the TypeScript caller: 120 s). **[V]**
- **Storage backoff:** `dr_ai_health` keyed by `(task, model)`, 5 min doubling to 6 h; never blocks a cache hit. **[V]** Because it is keyed by task and model, a `blueprint` task would have **its own** health row and could not trip the `decisions` or `summary` breaker.
- **Task restriction (the key finding):** three inline column checks limit the allowed names.

  | Table | Column | Current check | Auto-generated constraint name **[A]** |
  |---|---|---|---|
  | `dr_ai_cache` | `task` | `in ('decisions','summary')` | `dr_ai_cache_task_check` |
  | `dr_ai_health` | `task` | `in ('decisions','summary')` | `dr_ai_health_task_check` |
  | `dr_ai_usage` | `engine` | `in ('decisions','summary')` | `dr_ai_usage_engine_check` |

  The names follow PostgreSQL's default `<table>_<column>_check` pattern for inline checks. They were **not read from a live database**; confirm with a read-only `pg_constraint` query before any migration (query in the reliability document).
- **No SQL function** (`dr_ai_cache_begin`, `_complete`, `_fail`, `_abandon`, `_fail_storage`, `_invalidate`, `_prune`, `dr_ai_note_usage`) contains a task-specific branch. They pass the task through; only the table checks reject unknown values. Hence a widened check is sufficient for all of them. **[V]**
- **TypeScript:** `export type AiTask = 'decisions' | 'summary'` (`ai-common.ts`) is used by `AiCacheKey.task`, `Store.aiNoteUsage(engine)`, `flushAiUsage` and `ai-smoke.ts`. No exhaustive `never` check on `AiTask` exists, so widening the union cannot create a compile error elsewhere. **[V]** (`collect/index.ts` has a `never` check, but on the request `Action`, not on `AiTask`.)
- **Global override:** `AI_CACHE_VERSION` is appended to **both** engines' config versions. Bumping it invalidates both caches. **[V]** A blueprint engine that reused it would be invalidated by an unrelated operator action.
- **Failure on unknown task today:** inserting `task='blueprint'` raises a check violation inside `dr_ai_cache_begin`; `SupabaseStore` rethrows and `cachedCompute` converts it to `AiCacheError`, whose documented behaviour is "refuse to spend requests". The system **fails closed** if code ships before the migration. **[V]**

### 3.5 Usage accounting

**[V]** Source: `meteredCall`, `AiUsageCounters`, `flushAiUsage`, `dr_ai_usage`, `dr_ai_note_usage`.

- Global, per-engine, per-UTC-day counters: `calls, successes, failures, rate_limited, http_requests, cache_hits, cache_misses, input_tokens, output_tokens, reported_cost_usd, cost_reported_calls, duration_ms`. Cost is *provider-reported only*; a missing cost is unknown, not zero.
- Written once at the end of a run via `flushAiUsage` (best-effort; failure never affects processing).
- **No per-user and no per-cluster accounting.** There is no `reasoning_tokens` counter; reasoning tokens are only visible in `AiFailureDetail` for failed responses. **[V]**
- Separate, unrelated per-user accounting exists for PRD briefs: tables `ai_usage` (user, day, count) and `ai_usage_reservations`, functions `reserve_brief`, `commit_brief`, `release_brief` (`20261106000200_brief_reservations.sql`). A reservation expires after **20 minutes** and takes an advisory lock per user and day. **[V]** This is the pattern to copy, not the tables to share.

### 3.6 Evidence retrieval

**[V]** There are three independent read paths and they disagree on shape and limits.

| Path | Caller | Auth | Limits and ordering | Has `record_id`? |
|---|---|---|---|---|
| `dr_cluster_evidence(p_cluster, p_limit)` SQL function | Browser (`fetchEvidence`, limit 20) | `auth.uid()` required (anonymous gets error `28000`) | ≤ 50 rows; a `row_number()` rank by summed engagement then recency is computed, but the `LIMIT` is in the same subquery with **no `ORDER BY` of its own**, so "top N" relies on the planner emitting window output in rank order (usual, not guaranteed by SQL **[A]**); excerpt cut to **400 chars**; inner-joins `dr_problem_signals` (no `is_problem` filter) | **Yes** in the returned JSON, **dropped** by `fetchEvidence` |
| `loadResearchContext` in `generate-brief.ts` | PRD generator (service key) | Pages Function after user auth | ≤ 100 clusters scanned, 8 kept; members `limit 80` **without `order`**, signals `limit 80`, evidence capped at **30**; filter `unique_discussions >= 2` | **No** (URL only) |
| `dr_cluster_profile(p_cluster)` | Nothing yet (service role only) | service role | Six separate measures with a `basis` sentence each | n/a |

Facts that matter for the blueprint:

- A stored record has: `source_id, url, title, excerpt (≤1,200 chars stored), published_at, engagement, categories, language, license, attribution, content_hash, discussion_key`. Author identity is a salted hash; no usernames are stored. **[V]** (`dr_raw_records`; connectors truncate to 1,200.)
- `discussion_key` collapses a thread into one "independent discussion". `dr_clusters.unique_discussions` is built from it. **[V]**
- Stack Exchange content is CC BY-SA and requires attribution and licence to travel with any excerpt (`connectors/stackexchange.ts` comment; `license`/`attribution` columns). **[V]**
- `dr_clusters` already carries the measured numbers a blueprint needs: `unique_discussions, source_count, sources, recent/prior_discussions, growth_rate, wtp_signals, competitors (name → count), severity_avg (AI estimate), confidence (low|medium|high), scores.components[*].basis`. **[V]** Component `basis` values are `measured | ai_estimate | evidence_count | derived | insufficient_data`.
- `generate-brief.ts` evidence selection is **order-dependent and unbalanced** (no `order` on the members query, a single `limit 80` across up to eight clusters). It is adequate for a loose brief and **not** for a reproducible, cache-keyed evidence pack. **[V]**

### 3.7 Existing subscription and entitlement checks

**[V]** Source: `functions/api/generate-brief.ts`, `20261106000200_brief_reservations.sql`, `src/lib/access.ts`, `OpportunityIntelligenceView.tsx`, `supabase/functions/collect/index.ts`.

- **Server-side (the only real enforcement):** `generate-brief.ts` verifies the Supabase JWT via `/auth/v1/user`, reads `subscriptions` with the service key, treats a subscription as live when `status='active'` **or** (`status='cancelled'` and `current_period_end` is in the future), looks up `DAILY_LIMITS = { Pro: 5, Business: 20 }`, then `reserve_brief` → generate → `commit_brief` (or `release_brief` on failure).
- **Client-side (convenience only):** `canOpenOpportunity` (Free: top 3 dossiers), `canExport` (Pro and Business), Business-only raw dump and white-label export. Nothing server-side stops a client from calling `dr_cluster_evidence` for any cluster once signed in. **[V]**
- **Admin:** the `collect` function authenticates a cron secret (`x-collector-secret`) or an admin JWT checked through `dr_is_admin`; `verify_jwt = false` for that function in `supabase/config.toml`. **[V]**
- **Product decision not in the repository:** which plans may generate blueprints, and how many per day. Open question Q1.

### 3.8 Existing Dossier data structures

**[V]** "Dossier" is a UI term (nav label "Dossiers", `OpportunityIntelligenceView`). There is **no database entity named dossier**. The dossier is a view of an `Opportunity` built by `clusterToOpportunity(ClusterRow)` in `src/lib/liveData.ts`.

- `ClusterRow` mirrors `dr_clusters`, including `summary` (the `ClusterSummary` shape) and `scores.components`.
- `Opportunity` (`src/types.ts`) adds display fields (`opportunityLevel`, `willingnessToPay` label derived from `wtp_signals`, `estACV: 'Not estimated'`, `competitors` built from named mentions with `pricing: 'Not collected'`) and `live?: LiveMeta`.
- `evidence: EvidenceQuote[]` starts empty and is fetched lazily for signed-in users (`App.tsx` calls `fetchEvidence`). `EvidenceQuote` has `source, author, quote, upvotes, url?, license?, attribution?, analysisMethod?` and **no record identifier**.
- The existing UI already distinguishes provenance classes (`BASIS_LABEL`: Measured, Evidence count, Derived from mentions, AI estimate, Insufficient data). This vocabulary is the natural anchor for the blueprint evidence classes (see the evidence contract).

### 3.9 Existing PRD generation

**[V]** Two things in the repository are called "PRD":

1. **Client-side markdown export** in `OpportunityIntelligenceView.tsx` (`handleCopyPRD`, `handleDownloadPRD`): templated text from the already-loaded `Opportunity`. No AI call.
2. **`POST /api/generate-brief`** (`functions/api/generate-brief.ts`): Gemini, Pro/Business, daily quota with reservation, research context from `dr_clusters` plus 30 evidence rows, prompt requires hypotheses to be labelled and forbids invented competitors, TAM and revenue, response shape `{productName, tagline, opportunityScore, marketSizeTAM, estMonthlyRevenueYear1, problemStatement, targetICP, scoreBreakdown, competitorMatrix, mvpScope, pricingTiers, architectureSpec, gtmStrategy}` plus `researchBasis` and `researchStatus`. The JSON is **returned, not stored**, and is **not validated** beyond `JSON.parse`.

The blueprint engine does **not** replace, modify or deprecate either. Its contract is intentionally richer and is not a superset of the brief's field names. The brief's honesty rules ("Not estimated — insufficient market-sizing evidence", hypotheses labelled, no contacting authors as sales leads) are **carried over** into the blueprint's evidence and commercial rules.

### 3.10 Potential integration risks

| ID | Risk | Evidence | Severity | Where it is addressed |
|---|---|---|---|---|
| R1 | Blueprint output cannot fit the shared 30 s timeout; raising the shared timeout would also change Decisions Fast and ERNIE summaries. | **[V]** `runner.ts` client: `timeoutMs: 30_000, retries: 1`; **[A]** throughput figures | High | Reliability §2: engine-specific client; shared client untouched. |
| R2 | Cache and usage tables reject `blueprint`. | **[V]** three checks | Medium (fails closed) | Reliability §11: additive widening migration (design only). |
| R3 | `AI_CACHE_VERSION` is global; reusing it couples cache lifetimes. | **[V]** | Medium | Dedicated `BLUEPRINT_CACHE_VERSION`. |
| R4 | No citable evidence ids; existing evidence selection is not reproducible (unordered `limit` in the brief, an unordered-`LIMIT` rank in `dr_cluster_evidence`). | **[V]** | High | Evidence contract §3: backend-built pack with deterministic ordering and `E##`/`M##` ids. |
| R5 | Unclear runtime: the browser-facing entitlement logic lives in a Cloudflare Pages Function, the cache code and the OpenRouter secret live in Supabase Edge Functions. | **[V]** | High | Reliability §1: options and recommendation; decision requested. |
| R6 | One OpenRouter key and one free-tier quota are shared by Decisions Fast, ERNIE summaries and the new engine. Blueprint traffic could starve ingestion. | **[V]** single `OPENROUTER_API_KEY`; **[A]** free-tier limits | Medium | Separate pacing key, daily live-call cap, never run inside the collection run. |
| R7 | A blueprint written into `dr_clusters.summary` (or anything the scorer reads) would move rankings, as `development_feasibility` already can. | **[V]** | High | Contract and design: **no write path** to `dr_clusters`, `dr_problem_signals`, `dr_signal_ai`. |
| R8 | ERNIE reasoning consumes `max_tokens`; a long structured output plus thinking is far more likely to exhaust the budget than a 400-token summary. | **[V]** comment in `ai.ts`; **[A]** upstream behaviour | High | Sectioned passes, per-pass budget, measurement gate. |
| R9 | Prompt injection through third-party discussion text and free text from earlier model passes. | The current design needs an explicit cross-pass trust boundary; schema-valid text is still untrusted. | High | Evidence contract §8; system prompt §§1, 3–4; reliability §4. |
| R10 | Licence and attribution obligations when excerpts appear in a product document. | **[V]** `license`, `attribution` columns | Medium | Evidence index carries both; excerpts capped; model never writes URLs. |
| R11 | Third-party discussion content could be sent to a free preview provider before its privacy terms are reviewed; the preview model may also be retired. | Provider data handling, retention, logging and training/privacy terms have not been reviewed against authoritative evidence; no privacy verification is claimed. The repository notes a retired model slug may return 404 and stop the engine. | High — release blocker for discussion content; availability risk on retirement | Do not send third-party discussion content until review; reliability §7 treats a retired provider as unavailable. |
| R12 | Cache-busting by users: free-text parameters make every request unique and spend a live free-tier call. | Design analysis | High | v1 parameters are enumerated only; per-user quota; global daily cap. |
| R13 | Merging code under `supabase/functions/**` triggers `deploy-collector.yml` automatically on push to `main`. | **[V]** workflow `paths` filter | Medium (process) | Phase B PRs must state that merge deploys; this docs-only PR does **not** match the filter. |
| R14 | CI has no documentation or SQL checks. | **[V]** `validate.yml`: `bun run lint`, `build`, `test:collector`, `test:frontend` | Low | Reported honestly; ad hoc doc checks are listed in the PR and are not CI. |
| R15 | Lone UTF-16 surrogates in model text, once truncated, make PostgREST reject the whole body (HTTP 400 PGRST102). | **[V]** `toPostgrestJson` | Medium | Already handled for all RPC bodies; Phase B must add a blueprint-specific regression test and use code-point-safe truncation. |

---

## 4. Separation diagram

```
 EXISTING (unchanged by this work)
 =====================================================================================================
  collectors            +--------------------+        +------------------------+
  GitHub/HN/StackEx --> | dr_raw_records     | -----> | worthAnalysing gate    |
                        +--------------------+        +-----------+------------+
                                                                  |
              +---------------------------------------------------+------------------------+
              |                                                                            |
   ENGINE A  v   task='decisions'                                                          |
  +-----------------------------+   per record      +----------------------+               |
  | Decisions Fast              | ----------------> | dr_problem_signals   |               |
  | parallel/decisions-fast:free|                   | dr_signal_ai         |               |
  +-----------------------------+                   +----------+-----------+               |
                                                               v                           |
                                          clusters -> dr_refresh_clusters (SQL scoring) <--+ Gemini: embeddings
                                                               |
   ENGINE B   task='summary'                                   v   per cluster, inside the collect run
  +-----------------------------+                   +----------------------+
  | ERNIE summaries (optional)  | ----------------> | dr_clusters.summary  |  (feeds one score field)
  | baidu/ernie-5.5-flash-...   |                   +----------------------+
  +-----------------------------+
          both engines: shared HTTP client (30 s, 1 retry), shared dr_ai_cache / dr_ai_usage, AI_CACHE_VERSION

 NEW (Phase B and later, independent)
 =====================================================================================================
  signed-in user
        |
        v
  +-------------------+   +------------------------+   +--------------------------------------+
  | blueprint endpoint| ->| entitlement + quota    | ->| evidence-pack builder (READ-ONLY)    |
  | (own function)    |   | (own reservation)      |   | dr_clusters + records, E## / M## ids |
  +-------------------+   +------------------------+   +-------------------+------------------+
                                                                          v
   ENGINE C   task='blueprint'                    +-----------------------------------------+
  +-----------------------------+  own HTTP       | own prompt, own contract, own validator |
  | ERNIE blueprint passes      | <-- client ---- | own pacing key, own token budgets       |
  | baidu/ernie-5.5-flash-...   |   (long timeout)+-------------------+---------------------+
  +--------------+--------------+                                     |
                 v                                                    v
   validate schema -> verify evidence refs -> assemble ProductBlueprint v1
                 |
                 v
   dr_ai_cache (task='blueprint')   dr_ai_usage (engine='blueprint')   <-- same tables, new value only
   NO write path to: dr_clusters, dr_problem_signals, dr_signal_ai, composite_score, summary
   NO call to: Decisions Fast, the summary engine, the PRD generator
```

---

## 5. What this audit could not verify

- The production environment: whether `20261109000000_ai_results_cache.sql` has been applied, which secrets exist, whether `OPENROUTER_ENABLED` and `DECISIONS_ENABLED` are set, whether cron is paused. Repository docs say production keeps both engines off and cron paused. **[A]**
- Live ERNIE behaviour: tokens per second, how many reasoning tokens a ~6k-token structured answer needs, whether `response_format: json_object` is honoured by the serving provider, rate limits of the free tier.
- The applicable free ERNIE provider data handling, retention, logging and training/privacy terms were not reviewed against authoritative evidence; no privacy verification is claimed. This remains a release blocker before third-party discussion content may be sent (R11).
- Supabase Edge Function wall-clock and background-task limits for this project's plan (`runner.ts` comments "~150s on the free plan"; not confirmed).
- Whether a Cloudflare Pages Function can import the collector's TypeScript modules at build time. The collector code is written to be runtime-agnostic (`fetch`/`crypto.subtle`), which makes it plausible, not proven.
- Constraint names (§3.4) and the real row counts in `dr_ai_cache`.
