# DemandRadar – AI architecture (Decisions Fast + optional LFM3)

**Status: implemented on a development branch, not merged, not deployed, not enabled.** Everything here is off by default.
Production keeps `OPENROUTER_ENABLED=false`, no `DECISIONS_ENABLED`, and the paused cron stays paused until a human decides otherwise.

## 1. The design in one picture

```
 raw records ──► worthAnalysing() gate (free, deterministic) ──► classification ──► dr_problem_signals ──► clusters ──► scores
                                                                       │                  (demand data)        (dr_refresh_clusters,
                                                                       │                                         UNCHANGED, measured)
        Engine A: Decisions Fast  (optional, primary when enabled) ────┤
        Engine B: Gemini          (existing, unchanged, optional)   ───┤   embeddings for clustering stay with Gemini
        Fallback: labelled keyword heuristic (existing)             ───┘
                                                                       └─► dr_signal_ai  (the model's own numbers + citations, kept APART)

 clusters ──► summaries:  Engine B: LFM3 via chat completions (optional)   ─ cached, free-only, can never block anything above
```

| | Engine A – Decisions Fast | Engine B – LFM3 |
|---|---|---|
| Model | `parallel/decisions-fast:free` | `liquid/lfm-3-1.7b:free` |
| Endpoint | `POST https://openrouter.ai/api/alpha/decisions` (dedicated Decisions API) | `POST https://openrouter.ai/api/v1/chat/completions` |
| Job | Is this a genuine problem? What kind, which industry, how painful? Probabilities, confidence, research citations | Readable cluster summary: why it matters, description, possible solution |
| Required? | No (off by default) | No (off by default) – **optional by construction** |
| If it fails | Records stay pending, nothing is marked failed, nothing else is called | Summary is skipped; analysis, clustering and scoring are already saved |
| Output stored in | `dr_problem_signals` (deterministic mapping) + `dr_signal_ai` (model numbers) | `dr_clusters.summary` (existing column) |

**There is no paid model and no paid fallback anywhere in this layer.** Only an explicit `…:free` slug is accepted for either engine (`isFreeModelSlug`),
requests set `provider.allow_fallbacks=false`, and a failing engine is simply switched off for the rest of the run. (The previous OpenRouter default was the
*paid* `openai/gpt-4o-mini`; that default is removed.) Gemini is untouched existing behaviour and is outside this rule – see §10.

## 2. The Decisions API as implemented

Source: OpenRouter's published OpenAPI page for the Decisions endpoint (marked **Alpha – the shape may change**). The adapter (`decisions.ts`) implements exactly what is documented:

* **Request**: `{ model, state, questions, provider }`. `state` is the post (source, kind, title ≤300 chars, text ≤800 chars, labels). `questions` are four typed questions:
  `is_problem` (`noul`, a yes/no probability), `signal_type` (`choice`), `industry` (`choice`, our existing industry list) and `severity` (`score`, five ordered levels).
  The post is data in `state`; instructions exist only in our `questions`, so post text cannot rewrite them.
* **Response**: `answers` keyed by question id (`noul` → probability; `choice` → choice + optional probabilities + optional confidence; `score` → 0..4 + optional
  probabilities + optional confidence; `refusal`), `annotations` (`url_citation`), `usage` (tokens, optional `cost`).
* **Parsing is strict about what we depend on** and ignores the rest. A missing or mistyped answer, a probability outside [0,1], a distribution that does not sum to ≈1, an
  unknown option, a non-object body or a refused `is_problem` rejects the whole response; **nothing is cached and no signal is created from a partial answer.**
  Optional fields may be absent but never wrong. An upstream error reported inside a `200` body is treated like the HTTP error it stands for.
* **Citations belong to the request as a whole** – the API does not attribute them to individual answers, and we do not pretend it does. They are de-duplicated by canonical URL,
  restricted to `http(s)`, capped at 25, and stored with the model outputs.
* **Model confidence** = the most cautious confidence the model reported (`null` if it reported none; the boolean `noul` answer carries none). It is the model's self-assessment.

## 3. Six measures, kept separate

| Measure | Where it lives | Feeds the demand score? |
|---|---|---|
| 1. AI / model confidence | `dr_signal_ai.model_confidence`, `dr_signal_ai.problem_probability` | **No** – never |
| 2. Independent reports | `dr_cluster_profile().independent_reports` (collapsed by identical opening text or canonical URL) | Existing `unique_discussions` already feeds `composite_score` |
| 3. Recurring complaints / frequency | `dr_cluster_profile().recurring_complaints / frequency` (all problem signals; independent reports per 30-day window) | Existing member / growth components |
| 4. Persistence over time | `dr_cluster_profile().persistence` (active weeks / weeks spanned) | **Not yet** – see §10 |
| 5. External research evidence | `dr_cluster_profile().external_research_evidence` (distinct cited URLs, excluding each post's own URL) | **No** – a citation is a source the model consulted, not proof of demand |
| 6. Opportunity / demand score | `dr_clusters.composite_score` from the **unchanged** `dr_refresh_clusters` | – |

`dr_cluster_profile(cluster_id)` is read-only, returns each measure with a `basis` sentence, combines none of them, and is `service_role` only (nothing in the UI uses it yet).
The separation is enforced and tested: the signal row built from a Decisions answer contains no confidence or probability at all, two different model confidences produce
byte-identical signal rows, and changing `dr_signal_ai` and re-running `dr_refresh_clusters` leaves `composite_score` unchanged (`30_ai_architecture.test.sql`).

**Severity isolation.** The Decisions **severity** answer (1–5) is **not** written to `dr_problem_signals.severity` (it is always `null` for Decisions-derived signals), because `dr_refresh_clusters` averages that column into the `painIntensity` component (20 % of `composite_score`). The estimate is preserved, with its score and confidence, in `dr_signal_ai.answers.severity`, and can be wired into scoring later **only on explicit approval**. A null severity is the same "no estimate" state keyword-analysed signals already have: the scorer's `avg()` ignores it, `painIntensity` shows `insufficient_data`, and the remaining weights are renormalised – it is never scored as zero. Gemini's severity path is unchanged, and a Decisions-derived signal joining a cluster of Gemini-derived ones does not change that cluster's severity average (all tested against the real scoring SQL).

*One input to disclose, unchanged by this PR – and measured:* the scorer also has a `feasibility` component (10 %) taken from a cluster summary's `development_feasibility`, whichever engine wrote it (Gemini, or LFM3 if enabled). On the real scoring SQL, the same cluster scored **53** with no summary, **58** with a summary saying feasibility 5 and **47** with feasibility 1: an 11-point swing from a field a 1.7B model writes, in either direction. Display-only separation is recommended in §10 (item 8b); scoring was deliberately not changed.

## 4. Persistent caching (Supabase)

`dr_ai_cache` – one row per `(task, input_hash, model, config_version)`:

* **Identity**: `input_hash` = SHA-256 of the canonical JSON of exactly what the model is shown (Decisions: normalised `state`; LFM3: the sorted, de-duplicated statements). Whitespace, row ids,
  engagement counts and statement order do not change it; content does. **Model** and **config version** are separate parts of the identity.
* **States**: `pending` (a worker holds a lease: duplicate concurrent processing is impossible), `succeeded` (validated result, reused indefinitely), `failed` (the *input* produced an unusable
  answer; **no result is stored**; retried only after a cooldown of 1 h, 2 h, 4 h … capped at 7 days).
* **Never a success unless validated**: `dr_ai_cache_complete` rejects a null / non-object result and only transitions a row that is still `pending`; a table CHECK forbids a `succeeded` row without a
  result and a non-`succeeded` row with one.
* **Service problems are not blamed on the input**: a rate limit, outage, timeout, bad key or retired model releases the lease (`dr_ai_cache_abandon`) so the item is retried as soon as the
  service is back, while the engine stops for the rest of the run.
* **Invalidation rules** (the whole list): (1) the input changes → new hash; (2) a different model → new identity; (3) `DECISIONS_CONFIG_VERSION` / `SUMMARY_CONFIG_VERSION` is bumped in code when
  questions, prompts or parsing change; (4) operators can set `AI_CACHE_VERSION` to a new value to invalidate both caches **without a deploy**; (5) a stored result that no longer passes validation is
  dropped and recomputed once; (6) `dr_ai_cache_prune(days)` removes results unused for a long time, dead leases and old failures. Old entries are never overwritten, only bypassed.
* **Lease fencing**: every lease carries a **fencing epoch** (`lease_epoch`, incremented each time a lease is issued, including a takeover of an expired lease or of a failed entry). `dr_ai_cache_complete`, `dr_ai_cache_fail` and `dr_ai_cache_abandon` require the epoch and act only while it is still the entry's current one, so a worker whose lease expired and was taken over can no longer store a result, mark the input failed, or release/delete the new holder's lease. It still gets its own (valid) answer back; it just is not stored. `dr_ai_cache_invalidate` stays an unfenced delete-by-id (used only to drop a stored result that no longer validates).
* **Durability rule (no provenance without a durable answer)**: a live Decisions answer becomes a signal and a `dr_signal_ai` provenance row **only once it is durable in the cache** (`outcome.stored`). If the cache write fails, or the lease was lost to a newer holder, the record **stays pending** – nothing is persisted, nothing is counted as a failed attempt – and the next run either serves it from the cache (if the other holder stored it) or retries it. A failing cache *write* also stops live spending for the run (an answer that cannot be kept is wasted); a single lost lease does not. This closes two cases found by reproduction: a write failure left a provenance row whose `cache_id` pointed at nothing (on Postgres that raises a foreign-key error and, because rows are saved in chunks, **lost every row in the chunk**), and a lost lease left provenance pointing at an unfinished entry. As defence in depth, `dr_save_signal_ai` now stores a `cache_id` whose entry has vanished as `NULL` instead of failing the call, and `dr_ai_cache_invalidate` can remove only a *succeeded* entry, never a pending lease or a failure record.
* **Storage-failure backoff (durable, across runs)**: reproduced before it was fixed – when only the cache *write* failed, `abandon` deleted the lease row, nothing was remembered, and every independent scheduled run made a fresh live request for the same input (48 runs → 48 requests; 6 of 6 records still pending). Now a failed write calls `dr_ai_cache_fail_storage` (fenced, like `complete`), which records, **in the database**, two separate backoffs kept apart from input-level failures (`storage_failures` vs `failed_attempts`; the record is never penalised): *per input* 15 min doubling to a 7-day cap (`failure_kind='storage'`), and *per engine* (`dr_ai_health`, per task+model) 5 min doubling to a 6-hour cap while any input's answer cannot be stored. While the engine backoff is open, `dr_ai_cache_begin` returns `storage_backoff` for any request that would need a **live** call – **cached results are still served**. One successful write ends the backoff and releases the storage-caused cooldowns (never the input-level ones), so recovery is immediate. Measured on the 48-hour scenario (a run every 15 min, writes always failing): **14 live requests instead of 192**, at minutes 0, 15, 30, 60, 105, 195, 360, 690, then every 6 h; after storage heals, **all 6 records complete in 1 run with exactly 6 requests**. If even recording the failure is impossible the storage is unreachable, `begin` fails too, and nothing is spent. The protection lives in Postgres, so it survives separate Edge Function invocations; no in-memory counter is involved.
* **Concurrency**: `dr_ai_cache_begin` is one atomic statement sequence with a row lock. Proof: `supabase/tests/31_ai_cache_concurrency.sh` runs three real multi-session scenarios (12 sessions each): a claim race (exactly 1 claims), a takeover race on an expired lease (exactly 1 takes over, with a newer epoch), and a burst of stale `complete`/`fail`/`abandon` calls racing the current holder (0 accepted; the holder's lease survives and its result is the one stored). (The analysis job lock already prevents overlapping runs; the lease and fencing also cover manual and future callers.)

## 5. Reliability, monitoring, cost control

| Situation | Behaviour |
|---|---|
| HTTP 429 / 5xx / 524 / timeout / network / 401 / 402 / 403 / 404 | **No further live requests** this run; that record stays pending. Nothing marked failed. No other model or endpoint is tried. **Records already in the cache are still served.** |
| Unusable answer for one record | That record counts one attempt (3 attempts → `failed`), the input is cooled down; neighbours are unaffected. |
| 3 unusable answers in a row | No further live requests this run (probable API contract change); cached results are still served. |
| Live-request budget | `DECISIONS_MAX_PER_RUN` (default 20, max 100) live requests per run. **The cache is always consulted first**: cached results are served even after the budget is spent, and the budget applies only to a cache *miss*; the rest of the misses are deferred (lease released, nothing recorded against them) and resume next run. |
| Time budget | No new live request starts with < 40 s left in the function's budget – again only for a cache miss; cached results are still served. |
| Retries | The shared HTTP client retries once (`retries: 1`, 30 s timeout) and honours `Retry-After`; the adapter never retries; nothing loops. |
| Pacing | `DECISIONS_MIN_INTERVAL_MS` (3500) / `OPENROUTER_MIN_INTERVAL_MS` (1500) between calls. |
| Cache unavailable (the store itself fails) | The engine refuses to spend requests (a request whose result cannot be reused is not made) and leaves everything pending. |
| Cache write fails after a valid answer / lease lost | The answer is **not** turned into a signal or provenance row; the record stays pending, uncounted as a failure. A failed *write* is recorded durably (see §4): this input waits 15 min → 7 d, the whole engine waits 5 min → 6 h before any new live request, cached results still served; a lost lease defers only that record. Recovery: the first successful write clears the backoff; the record is then served from the cache or retried (once). |
| Storing model outputs (`dr_signal_ai`) fails | Affected records stay pending; their answers are cached, so the retry costs nothing. |
| Summaries (LFM3) | `OPENROUTER_MAX_SUMMARIES_PER_RUN` (default 2, max 5); first service-level failure stops them for the run. |

**Telemetry** – `dr_ai_usage`, one row per engine per UTC day: live calls, successes, failures, rate-limited responses, HTTP requests (retries = `http_requests − calls`), cache hits and misses,
input/output tokens, **provider-reported** cost and `cost_reported_calls`. A missing cost is *unknown*, not zero, so coverage is tracked rather than assumed. HTTP/rate-limit counts come from the shared
client's counters: exact for sequential calls, approximate if calls overlap. Telemetry is best-effort; a failure to record it never affects processing. Per-run figures are also returned in the
analysis stats (`decisions`, `summaryAi`).

Useful read-only queries (SQL editor):
```sql
select * from dr_ai_usage order by day desc, engine;                                   -- spend/volume/cache effectiveness
select task, status, count(*), sum(hit_count) from dr_ai_cache group by 1, 2;          -- what is cached, what is cooling down
select dr_cluster_profile('<cluster uuid>');                                           -- the separate measures for one cluster
```

## 6. Configuration

All are **Supabase Edge Function secrets/environment** (Edge Functions → Secrets). None belongs in the frontend or in Cloudflare Pages. Nothing is hardcoded.

| Name | Default | Meaning |
|---|---|---|
| `OPENROUTER_API_KEY` | – (secret) | One key for both engines (existing name). Never logged; errors are redacted. |
| `DECISIONS_ENABLED` | off | Only the literal `true` enables Engine A. A key alone enables nothing. |
| `DECISIONS_MODEL` | `parallel/decisions-fast:free` | Must end in `:free` or the engine stays off (reason is logged, never a secret). |
| `DECISIONS_MAX_PER_RUN` | `20` | Live requests per analysis run (1–100). |
| `DECISIONS_MIN_PROBLEM_PROBABILITY` | `0.5` | A post is a problem when P(problem) ≥ this. |
| `DECISIONS_MIN_INTERVAL_MS` | `3500` | Pacing between Decisions requests. |
| `OPENROUTER_ENABLED` | off (**production: `false`, leave it**) | Existing flag; now gates **only** the optional LFM3 summaries. |
| `OPENROUTER_MODEL` | `liquid/lfm-3-1.7b:free` | Must end in `:free`. (Old default `openai/gpt-4o-mini` removed.) |
| `OPENROUTER_MAX_SUMMARIES_PER_RUN` / `OPENROUTER_MIN_INTERVAL_MS` | `2` / `1500` | Existing. |
| `AI_CACHE_VERSION` | – | Optional. Change it to invalidate both caches without a deploy. |

`OPENROUTER_ENABLED` and `DECISIONS_ENABLED` are independent switches, so enabling one never enables the other. The scheduled and manual `analysis_test` paths drop both engines in code
(`runAnalysis` ignores them in test mode), and `reanalyse` semantics are unchanged.

## 7. Security

* API keys are read from the function environment only; they are never returned, stored, logged, or put in cache rows. `safeError()` redacts key-shaped strings and `Bearer` tokens from every error and log line (tested).
* The new tables and functions follow the existing lock-down: RLS enabled with **no policies**, `REVOKE` from `anon`/`authenticated`, functions `SECURITY DEFINER` and executable by `service_role` only (verified on the local database).
* Post text is untrusted data: for Decisions it can only appear in `state`; for LFM3 it is JSON-encoded user content under an instruction that tells the model to treat it as data. Outputs are validated and grounded
  (e.g. LFM3 `existing_solutions` must appear in the statements; WTP quotes are verbatim substrings).
* Provider-supplied citation URLs are restricted to `http(s)`; `javascript:`, `data:` and malformed URLs are dropped. They are stored, not fetched.
* Free model variants may log or train on prompts (OpenRouter's LFM3 page says so). The inputs here are already-public posts with titles and short excerpts, no usernames or emails – but please confirm this is acceptable (§10).

## 8. Tests (what exists, what it does and does not prove)

All TypeScript tests use **synthetic payloads shaped after the published schemas**; no live request was ever made. They prove parsing, validation, caching, orchestration and safety properties – **not** model quality or live API behaviour.

| File | Covers |
|---|---|
| `__tests__/decisions.test.ts` | endpoint and request construction, typed parsing, probability validation, missing/malformed fields, refusals, citations, API errors / timeouts / rate limits, config (disabled by default, free-only), signal mapping, AI confidence **and severity** kept out of demand data (Gemini severity unchanged) |
| `__tests__/ai-cache.test.ts` | persistence, reuse, hash consistency, model/config/task invalidation, concurrent duplicates, lease expiry, cache-first gate, lease fencing (stale worker cannot store, fail or release), **durable storage-failure backoff (own counters, escalation to the cap, per model/task, fenced, recovery, serves hits)**, failures never stored as successes, cooldown growth, corrupt entry |
| `__tests__/decisions-runner.test.ts` | per-run budget, **cached results served when the budget is spent / time is low / the breaker is open**, circuit breaker, no fallback, cooldown, 3-in-a-row stop, busy records, metering |
| `__tests__/lfm3.test.ts` | config (paid default gone), request shape, reasoning-model output, invalid / truncated answers, API failures, summary caching |
| `__tests__/analysis-ai.test.ts` | end to end through `runAnalysis`: caching across runs, separation, defaults off, test mode, every failure mode, durability (cache-write failure / lost lease leave records pending and recover), **CROSS-RUN regression: 192 independent runs over 48 h with failing writes make a bounded number of requests (14), create no signals or provenance, then recover**, cache-first, severity isolation, LFM3 failure never blocks core analysis |
| `supabase/tests/30_ai_architecture.test.sql` | cache state machine, lease fencing, **durable storage-failure backoff (fenced `fail_storage`, separate counters, per-input and engine-level windows, caps, hits served during backoff, recovery that releases storage but not input cooldowns)**, invalidate removes only stored results, dangling cache link tolerated, usage counters, `dr_save_signal_ai`, independent-report de-duplication, persistence, trend, external evidence, AI/demand separation, severity isolation against the real scorer, grants verified by executing every new function as `anon`, `authenticated` and `service_role` |
| `supabase/tests/31_ai_cache_concurrency.sh` | three real multi-session scenarios (12 sessions): claim race, takeover race, stale-holder burst vs the current holder |
| `supabase/tests/e2e-ai-cache.ts` | **end to end through real PostgREST (55 checks)** (not part of CI; run it against a disposable database): the real `SupabaseStore` → real PostgREST 16.5 → Postgres. Real argument types, fencing with a genuinely expired lease (stale complete/fail/abandon cannot alter the newer lease), provenance with a vanished cache link, and the storage-failure scenario, and every new function denied to `anon` (HTTP 401) and `authenticated` (HTTP 403) with `42501`, allowed to `service_role` |
| `__tests__/store-ai-contract.test.ts` | the TypeScript→SQL contract: every RPC `SupabaseStore` makes names a real function in the migration, sends only declared parameters, omits no required one, sends a value of the declared SQL **type**, and always sends the fencing epoch |

Run: `bun run lint && bun run build && bun run test:collector`. SQL (plain Postgres 16 + pgvector + pg_trgm, **disposable database only**): apply `00_stub_supabase.sql`, the migrations, then each `supabase/tests/*.test.sql`,
and `bash supabase/tests/31_ai_cache_concurrency.sh <db>`.

## 9. Review and (eventual) deployment – nothing below has been done

**Review (no production impact, phone-friendly):** open the draft PR in the GitHub app → *Files changed*; check the *Validate DemandRadar* check is green; read this file.

**Deploy – only after you approve, in this order:**
1. Merge the PR. **Merging deploys the `collect` function automatically** (`.github/workflows/deploy-collector.yml` runs on pushes to `main` that touch `supabase/functions/**`). With both engines off this changes no behaviour, and no new database function is called.
2. Supabase dashboard → SQL editor: run `supabase/migrations/20261109000000_ai_results_cache.sql`. It only creates new objects, is safe to run twice, and touches no existing table, column or function.
   *(Running it before step 1 is equally safe and is the preferred order.)* The file is also an **upgrade** of the first revision of this migration (PR head `75a84c3`): if that revision was ever applied anywhere, this adds the `lease_epoch` column and removes only that revision's three superseded, unfenced function signatures; existing cache rows are kept (verified locally).
3. Verify with a read-only query: `select count(*) from dr_ai_cache;` returns `0`.
4. To switch on, one engine at a time, in Edge Functions → Secrets: set `OPENROUTER_API_KEY`, then `DECISIONS_ENABLED=true` (optionally lower `DECISIONS_MAX_PER_RUN` for the first run). Leave `OPENROUTER_ENABLED=false` while evaluating Engine A.
5. There is **no Decisions-only dry run**: `analysis_test` is heuristic-only by design and cannot reach any AI. The first real exercise is a normal manual sync from the Data Sources tab with `DECISIONS_MAX_PER_RUN=3` – it collects from the sources as usual (production writes) and spends at most 3 free-tier requests. Do this only when you decide to.
   **Do not use the admin `reanalyse` action while Decisions is enabled**: it removes keyword signals and requeues up to 5,000 records, and Decisions would re-process only `DECISIONS_MAX_PER_RUN` of them per run, leaving the rest without a signal for a long time.
6. Watch `dr_ai_usage` and `dr_ai_cache`. To stop instantly: delete `DECISIONS_ENABLED` (or set it to anything but `true`).
7. Only then consider LFM3 (`OPENROUTER_ENABLED=true`) and, much later, the cron.

**If enabled before step 2:** the cache calls fail, the engine stops for the run, records stay pending, nothing is spent (covered by a test).

## 10. Limitations, open items and decisions that need approval

1. **Live behaviour is unverified.** No request was made to OpenRouter, Parallel or Liquid. The Decisions API is documented as *alpha*. The strict parser plus the "3 unusable answers in a row" stop are the safety net.
2. **Model slug.** OpenRouter's docs show `parallel/decisions-fast` as free; I could not confirm a `:free`-suffixed variant exists. The code fails closed (a retired/unknown slug returns 404 → engine stops, nothing lost). Please confirm the exact slug before enabling.
3. **Free-tier limits** are shared across both engines and unknown to the code; only per-run caps exist (no daily cap). Start with a small `DECISIONS_MAX_PER_RUN` and watch for 429s.
4. **Decisions returns no prose.** The problem statement is the post's own title/first sentence (deterministic), competitors are not extracted by Decisions, and WTP quotes come from the existing grounded regex. Gemini's richer extraction is unchanged but is bypassed for classification while Decisions is enabled.
5. **No automatic fallback to Gemini** when Decisions is down (it would be an unrequested model switch). Records wait. If Gemini is also configured it still produces embeddings (and summaries when OpenRouter is off) exactly as before – and Gemini may be a paid product; that is existing behaviour and out of scope here.
6. **Persistence / independent reports are not in `composite_score`.** Changing `dr_refresh_clusters` would re-rank existing production clusters on the next refresh, so it was deliberately not touched. `dr_cluster_profile` provides the measures; folding persistence into the score is a recommended follow-up that needs your approval.
7. **`analysis_method` is `'llm'` for Decisions results** (the column only allows `llm`/`heuristic`; no schema change was made). The `model` column carries the slug and `dr_signal_ai` carries the exact served build.
8. **Severity isolation (resolved; wiring needs approval).** Decisions severity no longer reaches `dr_problem_signals` or `composite_score`; it is preserved in `dr_signal_ai`. Feeding it into scoring is a deliberate future step that needs your approval.
8b. **LFM3's `development_feasibility` CAN change ranking – audited end to end, NOT changed.** *Database:* the schema has **no triggers, no generated columns, no views and no indexes** involving summaries. `dr_save_cluster_summary` is the only writer of `dr_clusters.summary` (it also sets `stats_dirty`). Only `dr_refresh_clusters` reads a summary field into the score – exactly one key, `development_feasibility` (`v_feas_raw := nullif(summary->>'development_feasibility','')::numeric`; accepted only if between 1 and 5; `v_feas = round((raw-1)/4*100)`; weight `w_feas = 10` of 100, weights renormalised over the components that have data). The only other key SQL reads is `members_at` (decides when to re-summarise; no effect on score). Everything else in a summary – title, description, persona, existing solutions, features, monetisation, caveats, model, usage – cannot move the score (measured: a summary with every field except feasibility leaves the score at 53, `insufficient_data`). Measured mapping on one cluster: no summary 53; feasibility 1 → 47, 2 → 50, 3 → 53, 4 → 55, 5 → 58 (3 is neutral; 2.5 is accepted and scores 51; 0, 6, 9, −3 are ignored). `dr_clusters_list` ranks by `composite_score` when sorted by score. *Frontend (read-only audit):* `src/App.tsx` **recomputes** each cluster's `compositeScore` client-side as a user-weighted mean of the stored component values, skipping components whose `basis` is `insufficient_data` – so the stored `developmentFeasibility` component also drives the dashboard sort and the "opportunity level" badge (≥ 75 Critical, ≥ 60 High, ≥ 40 Medium; a ±5-point shift can cross a threshold), and `clusterToOpportunity` derives the "difficulty" label from `summary.development_feasibility` directly. *Reach:* only when `OPENROUTER_ENABLED=true` (production: `false`); Gemini summaries already behave identically. *Existing hazard (not introduced here):* the `::numeric` cast is unguarded, so a stored non-numeric `development_feasibility` makes `dr_refresh_clusters` **raise and fail the whole refresh batch** (reproduced). LFM3's TypeScript validation only ever stores integers 1–5, so it cannot trigger it, but the SQL does not enforce that. **Recommendation – display-only separation (nothing implemented; scoring and frontend need your approval), in order of preference:** (a) for LFM3-written summaries store the model's value under a display key (e.g. `ai_development_feasibility`) and leave `development_feasibility` unset: SQL then sees `null` (`insufficient_data`, renormalised), and the dashboard's recompute skips it automatically because the basis is `insufficient_data`; the one frontend change is a display fallback for the difficulty label (`s.development_feasibility ?? s.ai_development_feasibility`); (b) in the scoring SQL, read feasibility only from an explicit scored key behind an allowlist, and guard the cast (`jsonb_typeof(...) = 'number'`) – this also removes the poison-pill; (c) operationally, keep `OPENROUTER_ENABLED=false` until decided.
9. **Privacy of free variants** (§7) needs your confirmation.
10. **Testing environment.** SQL tests ran on local PostgreSQL 16 + pgvector 0.6 + pg_trgm, not on Supabase's exact build. Two older billing migrations (`brief_reservations`, `dodo_webhook_ordering`) were not applied locally because they need Supabase-managed `auth.users` / existing billing tables; they are unrelated and unchanged.
11. **CI does not run the SQL tests** (and no workflow was modified). Adding a Postgres job is a sensible follow-up.
12. **Cosmetic:** `stats.claimed` counts every claim, so a deferred record seen again in the extra pass that serves remaining cache hits is counted twice. It has no effect on processing.
13. **Service-level failures (429 / 5xx / timeouts) have no cross-run backoff.** They are bounded *within* a run (one failed request, then no more live requests), and a failed request is not a wasted answer, but each scheduled run will try again, so a long outage costs about one request per run. The durable backoff added in this round covers **cache-storage** failures only; extending it to model-side failures is a possible follow-up. **Recovery latency:** after storage heals, the first probe happens once the engine window (up to 6 h) has passed.
14. **`reanalyse` and a per-run cap interact badly** (see deploy step 5). A follow-up could make `reanalyse` skip requeueing when Decisions is enabled, or requeue in capped slices.
15. **No UI** shows `dr_cluster_profile`, `dr_ai_usage` or citations yet.

**See also:** `docs/ai-smoke-test.md` – the admin-only `ai_smoke_test` action that verifies both engines on at most 3 existing records before normal processing is enabled (it writes nothing to `dr_clusters`, so it cannot trigger the ranking effect described in 8b).
