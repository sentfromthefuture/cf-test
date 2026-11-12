# The `ai_smoke_test` action

> **Status:** code and mocked tests only. It has **not** been deployed, and it has **never been invoked** against Supabase project
> `wgoiukbgrdyjvfpqaipp` or against OpenRouter. Nothing in this change touches production configuration, secrets, cron or data.

A bounded, admin-only diagnostic that exercises **both** optional AI engines (Decisions Fast and LFM3) against a tiny sample of
**existing** pending records, so they can be verified before normal automated processing is enabled. It is not a collection run.

`POST /functions/v1/collect` with body `{"action":"ai_smoke_test"}` and an **admin JWT**.
Code: `supabase/functions/_shared/collector/ai-smoke.ts` (logic) and `supabase/functions/collect/index.ts` (auth + routing).

## Exact behaviour

1. **Authorization first.** Only an admin JWT (checked server-side with the existing `dr_is_admin` RPC) is accepted. The scheduler secret
   (`x-collector-secret`) gets **403**, so the action cannot be run by cron. No credentials or a non-admin gets **401**.
2. **Configuration is read, never changed.** An engine is tested only if it is *already* enabled and valid in the function's environment:
   `DECISIONS_ENABLED=true` / `OPENROUTER_ENABLED=true`, `OPENROUTER_API_KEY` present, and the model an explicit `:free` slug (the same
   validation production uses). Otherwise that engine is reported `disabled` or `misconfigured` and nothing is sent for it. If **neither**
   engine is usable the action returns immediately with **no database or network access at all**.
3. **One at a time.** It takes a short lock (`dr_job_locks`, name `ai_smoke_test`, 3 minutes, released in a `finally`), so a double click
   cannot start a second run.
4. **Selects at most 3 records, read-only.** It reads the 12 oldest pending rows (`dr_claim_pending_records`, a plain `SELECT`), keeps those
   that pass the production gate `worthAnalysing`, and uses the first 3. The reply is cut back to 12 and then 3 even if the database
   returned more. The same 3 are chosen on every run (oldest first), so a re-run is served from the cache.
5. **Decisions Fast, independently.** Each selected record goes through the production `classifyWithDecisions` (cache first, circuit breaker,
   answer stored before anything is built from it). At most 3 live requests, and the configured `DECISIONS_MAX_PER_RUN` still applies if it is lower.
6. **LFM3, independently.** One cluster summary over the statements of the same records, through the production `summariseClusterCached`.
   At most 1 live request. It runs whether or not Decisions succeeded.
7. **Persistence is verified, not assumed.** Every answered input is re-read through the cache's own read path and must be the same entry
   and still pass validation. Only verified Decisions answers are written to `dr_signal_ai` (the model-output table), through the production
   `saveSignalAi`; the stored row count must match.
8. **Usage is accounted.** Each engine's counters (calls, outcomes, requests, retries, cache hits, tokens, provider-reported cost) are
   cross-checked against each other and added to `dr_ai_usage` through the production `dr_ai_note_usage`.
9. **Report.** Per-engine status and counts. No secrets, no provider error text, no record titles or excerpts (only counts and opaque record ids).

### What it will not do

| Guarantee | Enforced by |
|---|---|
| Not schedulable; not public | `trigger !== 'manual'` -> 403 in `collect/index.ts`; the body is parsed only to route the action (a malformed body gets 400) and nothing from it is passed on |
| At most 3 records, at most 3 + 1 live requests | constants in `ai-smoke.ts`; slices on every read; no limit parameter exists |
| No automatic retries, no fallback model | the smoke test builds its own HTTP client with `retries: 0`; Decisions stops at the first service-level failure; no second model is ever tried |
| Never fetches source data, never requeues | it takes no connectors and never calls `claimDueSources`, `upsertRecords`, `requeueHeuristicAnalysis` |
| Never changes a record's status | its store type is `Pick<Store, ...>` of the 5 methods it needs, so `markSkipped`, `markFailed`, `saveSignals` are not reachable; a test also wraps the store and throws on any such call |
| Never writes clusters or summaries to real clusters | no `assignPendingClusters` / `refreshClusters` / `saveClusterSummary` |
| Never changes feature flags, secrets or cron | it only reads `env`; it contains no SQL |
| Free models only | the production validators (`isFreeModelSlug`) are reused |
| Does not exceed budget silently | the Decisions runner's time gate applies; LFM3 is skipped with < 20 s left |

## Response

```json
{
  "testMode": true, "action": "ai_smoke_test", "maxRecords": 3,
  "overall": "passed", "ok": true,
  "records": { "candidatesRead": 12, "eligible": 9, "selected": 3, "ids": ["<uuid>", "<uuid>", "<uuid>"] },
  "decisions": {
    "status": "passed", "model": "parallel/decisions-fast:free", "configVersion": "decisions-v1",
    "basis": "each selected record is classified individually",
    "attempted": 3, "succeeded": 3, "failed": 0, "notCompleted": 0, "liveCalls": 3, "cacheHits": 0, "stopped": null,
    "cache": { "verified": 3, "unverified": 0 },
    "output": { "table": "dr_signal_ai", "expected": 3, "written": 3 },
    "usage": { "calls": 3, "successes": 3, "failures": 0, "rateLimited": 0, "httpRequests": 3, "retries": 0, "cacheHits": 0, "cacheMisses": 3,
               "inputTokens": 0, "outputTokens": 0, "reportedCostUsd": 0, "costReportedCalls": 3, "tokensReported": true, "consistent": true, "recorded": "ok" }
  },
  "lfm3": { "status": "passed", "model": "liquid/lfm-3-1.7b:free", "...": "same shape; output.table is null" },
  "elapsedMs": 14873
}
```

(The token numbers above are placeholders; the real figures are whatever the provider reports.)

`status` per engine: `passed` (every input answered, cached, verified, usage recorded) - `partial` (something worked, something did not;
`issue` says what) - `failed` (no usable answer) - `disabled` / `misconfigured` (not tested; `issue` says why) - `not_run` (enabled but nothing to test with).
`overall`: **`passed` only when both engines passed**; `failed` when nothing usable came from any tested engine; `nothing_tested`; otherwise `partial`.
An engine you left disabled therefore yields `partial`, not `passed`: it was not verified.

## Expected database changes

**No migration is needed or added.** Everything it uses already exists (`20261109000000_ai_results_cache.sql` and the base schema), and it adds
no table, column, function or policy.

| Table | First run (all live calls succeed) | Re-run (all cache hits) |
|---|---|---|
| `dr_job_locks` | one row `ai_smoke_test` created/updated, then released | same |
| `dr_ai_cache` | **+3** `decisions` rows and **+1** `summary` row (`status = succeeded`); each `hit_count` +1 from the verification read | no new rows; `hit_count` +2 each (the hit and the verification) |
| `dr_signal_ai` | up to **3** rows upserted (`record_id` is the key) | same 3 rows re-upserted (`evaluated_at` updates) |
| `dr_ai_usage` (today, UTC) | `decisions`: calls +3, successes +3, cache_misses +3, tokens/cost as reported. `summary`: calls +1 | `cache_hits` +3 and +1; `calls` unchanged |
| **Unchanged** | `dr_raw_records` (all stay `pending`; the pending count must not move), `dr_problem_signals`, `dr_clusters`, `dr_cluster_members`, `dr_sources`, `dr_collection_runs`, `dr_api_usage`, `dr_ai_health` (unless the cache cannot store), `cron.job`, function secrets | |

A failed engine writes less: a service-level failure leaves **no** cache row (the lease is released); an unusable answer leaves one `failed`
row with a cooldown and no result.

## Deployment instructions (nothing here has been run)

> **Merging to `main` deploys.** `.github/workflows/deploy-collector.yml` deploys `collect` to the Supabase project on every push to `main`
> that changes `supabase/functions/**`. Merging this PR therefore deploys it. That is harmless on its own (the action does nothing unless an
> admin calls it, and no existing action changed), but be aware of it. Do not merge until you intend that.

1. Review and merge the PR (or deploy from the branch by hand: step 2 only).
2. Deploy: `supabase functions deploy collect --project-ref wgoiukbgrdyjvfpqaipp --no-verify-jwt` (the same flags the workflow uses; the
   function authenticates its own callers).
3. **Do not invoke `ai_smoke_test` against a deployment that predates PR #8.** Those versions treat any unknown `action` as a normal collection
   run. After step 2 the deployed code includes the strict allowlist; confirm the deployment time in the Supabase dashboard (Edge Functions ->
   `collect`) before invoking.
4. No new secrets. It uses the six that already exist. Do not print them.

## Manual test procedure

**Before you start (read-only):** the cron must be paused.

```sql
select jobid, jobname, schedule, active from cron.job where jobname = 'dr-collect';  -- expect no row, or active = false
```

**Baseline (run before and after; the first three numbers must not change):**

```sql
select analysis_status, count(*) from public.dr_raw_records group by 1 order by 1;   -- pending should be your current figure (2,043)
select count(*) as problem_signals from public.dr_problem_signals;
select count(*) as clusters from public.dr_clusters;
select (select count(*) from public.dr_signal_ai) as signal_ai, (select count(*) from public.dr_ai_cache) as cache_rows;
select engine, day, calls, successes, failures, cache_hits, input_tokens, output_tokens, reported_cost_usd
  from public.dr_ai_usage order by day desc, engine limit 4;
```

**Invoke (as a signed-in admin).** Either from the app's browser console / your own code:
`supabase.functions.invoke('collect', { body: { action: 'ai_smoke_test' } })`, or with curl, without putting the password in your shell history:

```bash
export SUPABASE_URL=https://wgoiukbgrdyjvfpqaipp.supabase.co
export SUPABASE_ANON_KEY=...        # the public anon/publishable key, not a secret
read -r -p "Admin email: " EMAIL; read -r -s -p "Password: " PASSWORD; echo
JWT=$(curl -s "$SUPABASE_URL/auth/v1/token?grant_type=password" -H "apikey: $SUPABASE_ANON_KEY" -H "content-type: application/json" \
  -d "$(jq -n --arg e "$EMAIL" --arg p "$PASSWORD" '{email:$e,password:$p}')" | jq -r .access_token)
curl -s -X POST "$SUPABASE_URL/functions/v1/collect" -H "authorization: Bearer $JWT" -H "apikey: $SUPABASE_ANON_KEY" \
  -H "content-type: application/json" -d '{"action":"ai_smoke_test"}' | jq
unset PASSWORD JWT
```

**Run 1 (live).** Expect `overall: "passed"`, `records.selected: 3`, `decisions.liveCalls: 3`, `lfm3.liveCalls: 1`, both `cache.verified` full,
`decisions.output.written: 3`, `usage.recorded: "ok"`, `usage.retries: 0`. It takes roughly 15-60 s (requests are paced 3.5 s apart; free models can be slow).

**Run 2 (immediately after).** Expect `overall: "passed"` again with **`liveCalls: 0` and `cacheHits: 3` / `1`**. This proves the cache serves
repeated input with no model cost.

**Verify in SQL (read-only):**

```sql
select task, model, config_version, status, hit_count, completed_at from public.dr_ai_cache order by created_at desc limit 6;
select record_id, requested_model, model, problem_probability, model_confidence, evaluated_at from public.dr_signal_ai order by evaluated_at desc limit 3;
select engine, calls, successes, failures, cache_hits, input_tokens, output_tokens, reported_cost_usd from public.dr_ai_usage where day = (now() at time zone 'utc')::date;
```

Then re-run the baseline queries: pending count, `dr_problem_signals` and `dr_clusters` must be identical to before.
Only after this passes, decide separately (and explicitly) whether to enable normal processing or resume cron.

### Reading a failure

| `issue` / `stopped` | Meaning | What to do |
|---|---|---|
| `... is not "true"` | flag is off | enable it deliberately, or accept that engine is untested |
| `OPENROUTER_API_KEY is not set` | enabled without a key | set the secret (never paste it anywhere) |
| `not an explicit :free model` | a paid/untagged model slug is configured | correct `DECISIONS_MODEL` / `OPENROUTER_MODEL` |
| `auth (HTTP 401/403)` | key rejected | check the key in OpenRouter |
| `rate_limited (HTTP 429)` | free-tier limit | wait and re-run; nothing was retried |
| `not_found (HTTP 404)` | endpoint or model slug not available | check the model slug; the Decisions API is documented as **alpha** |
| `unusable response` / `invalid_response` | the model answered but the answer failed strict validation | possible contract drift; do not enable that engine until understood |
| `cooling down` | that exact input failed recently; no request was made | wait out the cooldown (1 h, 2 h, 4 h ...) |
| `busy` | another worker holds the cache entry | re-run shortly |
| `cache entries could not be verified` / `dr_signal_ai ...` | the answer was not durable where expected | the AI cache migration may not be applied; check `dr_ai_cache` exists |
| `usage could not be recorded` | `dr_ai_note_usage` failed | check the AI cache migration is applied |
| `no eligible pending records` | none of the 12 oldest pending rows passed the gate | normal if they are all non-problems |

## Rollback

* **Code:** revert the PR, or redeploy the previous revision of `collect` (`git checkout f71d7cd` then the deploy command above). The action
  then returns `400 unknown action`. Nothing else depends on it.
* **Data** (optional; none of it affects demand data or rankings, and leaving the cache rows saves future AI cost):

```sql
-- the rows this test created, using the ids from the report; all three are safe to remove and are recreated by normal processing
delete from public.dr_signal_ai where record_id = any ('{<id1>,<id2>,<id3>}'::uuid[]);
delete from public.dr_job_locks where name = 'ai_smoke_test';
-- cache rows (dr_signal_ai.cache_id is ON DELETE SET NULL, so this is safe)
delete from public.dr_ai_cache where created_at >= '<time you ran the test>' and status = 'succeeded';
```

  `dr_ai_usage` is a running per-day total; it is left as it is (it truthfully records that those requests were made).
* **Configuration:** this change modified no secret, feature flag or cron job, so there is nothing to restore. The cron stays paused until you resume it.

## Limits of this test (read these)

* **LFM3 is tested on a synthetic cluster.** Summaries belong to real clusters, and writing one would change user-visible output, so the smoke
  test sends the 3 records' statements as one summary request and verifies the answer in the cache. It does **not** exercise
  `saveClusterSummary` / `dr_clusters`; that existing path is covered by the existing tests only.
* **Usage persistence is verified by the RPC succeeding plus the counters cross-checking, not by reading `dr_ai_usage` back.** There is no read
  path for that table, and adding one would need a migration. The SQL above is the read-back.
* **The cache verification read increments `hit_count`** (it is an ordinary cache read).
* **The 3 records' text (public GitHub / HN / Stack Exchange posts) is sent to OpenRouter's free models**, exactly as normal processing would.
  Free-tier providers may log prompts.
* **A pass proves the engines work on this sample on this day.** It is not a quality evaluation and does not guarantee free-tier availability later.
* The automated tests mock every external call; they prove the logic, not the live providers.

## Tests

`bun run test:collector` -> `ai-smoke.test.ts` (module, in-memory store, scripted HTTP) and `collect-ai-smoke-fn.test.ts` (real handler, fake
Supabase and OpenRouter, real HTTP client). No network, no Supabase project, no API key.
