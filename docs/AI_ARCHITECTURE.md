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

One honest caveat: the Decisions **severity** answer (1–5) is stored in `dr_problem_signals.severity` exactly like Gemini's severity, so it feeds the existing `painIntensity`
component (20 % weight, already labelled `ai_estimate`). Model *confidence* feeds nothing. If you would rather keep every AI-derived number out of the score, set severity to
`null` for Decisions results – a one-line change in `decisionsToSignal`.

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
* **Concurrency**: `dr_ai_cache_begin` is one atomic statement sequence with a row lock. Proof: `supabase/tests/31_ai_cache_concurrency.sh` races 12 database sessions on one key – exactly 1 is told to compute.
  (The analysis job lock already prevents overlapping runs; the lease also covers manual and future callers.)

## 5. Reliability, monitoring, cost control

| Situation | Behaviour |
|---|---|
| HTTP 429 / 5xx / 524 / timeout / network / 401 / 402 / 403 / 404 | Engine switched off for the rest of the run. Records stay pending. Nothing marked failed. No other model or endpoint is tried. |
| Unusable answer for one record | That record counts one attempt (3 attempts → `failed`), the input is cooled down; neighbours are unaffected. |
| 3 unusable answers in a row | Engine stops for the run (probable API contract change). |
| Live-request budget | `DECISIONS_MAX_PER_RUN` (default 20, max 100) live requests per run; **cache hits are free**; leftovers resume next run. |
| Time budget | No new request starts with < 40 s left in the function's budget. |
| Retries | The shared HTTP client retries once (`retries: 1`, 30 s timeout) and honours `Retry-After`; the adapter never retries; nothing loops. |
| Pacing | `DECISIONS_MIN_INTERVAL_MS` (3500) / `OPENROUTER_MIN_INTERVAL_MS` (1500) between calls. |
| Cache unavailable | The engine refuses to spend requests (a request whose result cannot be reused is not made). |
| Storing model outputs fails | Affected records stay pending; their answers are cached, so the retry costs nothing. |
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
| `__tests__/decisions.test.ts` | endpoint and request construction, typed parsing, probability validation, missing/malformed fields, refusals, citations, API errors / timeouts / rate limits, config (disabled by default, free-only), signal mapping, AI confidence kept out of demand data |
| `__tests__/ai-cache.test.ts` | persistence, reuse, hash consistency, model/config/task invalidation, concurrent duplicates, lease expiry, failures never stored as successes, cooldown growth, cache-write failure, corrupt entry |
| `__tests__/decisions-runner.test.ts` | per-run budget, cache hits are free, circuit breaker, no fallback, cooldown, 3-in-a-row stop, busy records, time guard, metering |
| `__tests__/lfm3.test.ts` | config (paid default gone), request shape, reasoning-model output, invalid / truncated answers, API failures, summary caching |
| `__tests__/analysis-ai.test.ts` | end to end through `runAnalysis`: caching across runs, separation, defaults off, test mode, every failure mode, **LFM3 failure never blocks core analysis** |
| `supabase/tests/30_ai_architecture.test.sql` | cache state machine, invalidation identity, usage counters, `dr_save_signal_ai`, independent-report de-duplication, persistence, trend, external evidence, AI/demand separation, lock-down |
| `supabase/tests/31_ai_cache_concurrency.sh` | 12 concurrent sessions, exactly one claim |

Run: `bun run lint && bun run build && bun run test:collector`. SQL (plain Postgres 16 + pgvector + pg_trgm, **disposable database only**): apply `00_stub_supabase.sql`, the migrations, then each `supabase/tests/*.test.sql`,
and `bash supabase/tests/31_ai_cache_concurrency.sh <db>`.

## 9. Review and (eventual) deployment – nothing below has been done

**Review (no production impact, phone-friendly):** open the draft PR in the GitHub app → *Files changed*; check the *Validate DemandRadar* check is green; read this file.

**Deploy – only after you approve, in this order:**
1. Merge the PR. **Merging deploys the `collect` function automatically** (`.github/workflows/deploy-collector.yml` runs on pushes to `main` that touch `supabase/functions/**`). With both engines off this changes no behaviour, and no new database function is called.
2. Supabase dashboard → SQL editor: run `supabase/migrations/20261109000000_ai_results_cache.sql`. It only creates new objects, is safe to run twice, and touches no existing table, column or function.
   *(Running it before step 1 is equally safe and is the preferred order.)*
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
8. **Severity from Decisions feeds the existing `painIntensity` component** like Gemini's (see §3). Decide whether to keep it.
9. **Privacy of free variants** (§7) needs your confirmation.
10. **Testing environment.** SQL tests ran on local PostgreSQL 16 + pgvector 0.6 + pg_trgm, not on Supabase's exact build. Two older billing migrations (`brief_reservations`, `dodo_webhook_ordering`) were not applied locally because they need Supabase-managed `auth.users` / existing billing tables; they are unrelated and unchanged.
11. **CI does not run the SQL tests** (and no workflow was modified). Adding a Postgres job is a sensible follow-up.
12. **`reanalyse` and a per-run cap interact badly** (see deploy step 5). A follow-up could make `reanalyse` skip requeueing when Decisions is enabled, or requeue in capped slices.
13. **No UI** shows `dr_cluster_profile`, `dr_ai_usage` or citations yet.
