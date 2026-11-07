# Safe analysis-only test mode — implementation brief

## Objective

Add a narrowly scoped, admin-only collector test action that processes at most **10 pending raw records** and reports useful metrics, without collecting new source data, bulk re-queueing records, or generating paid AI summaries.

This is a code-only change. Do not deploy it, run it against production, alter database rows, change Edge Function secrets, or reactivate pg_cron as part of implementation or testing.

## Current architecture observations

- `supabase/functions/collect/index.ts` accepts either the shared schedule secret or an authenticated admin JWT.
- The existing `reanalyse` action is admin-only but requeues up to 5,000 records; do not call or reuse it for this feature.
- `runCollection({ analysisOnly: true })` skips source collection, but the current analysis loop has no hard record cap.
- `runAnalysis` currently continues through pending batches, clustering, refresh, and summary generation. A per-run OpenRouter summary count is not a cumulative spending cap.
- Existing production safeguards must remain unchanged: scheduled cron is paused and `OPENROUTER_ENABLED=false`.

## Required implementation

1. Add a distinct action, e.g. `analysis_test`, handled only when `trigger === 'manual'`. Schedule-secret callers must receive 403 for this action.
2. Require the existing `isAdminUser` check. Do not trust a body flag or client-supplied user ID as proof of admin status.
3. Ensure this action never calls `claimDueSources`, any connector, `requeueHeuristicAnalysis`, or any source collection path.
4. Add a hard, code-enforced maximum of 10 claimed pending records for this invocation. Do not accept a caller-provided limit above 10; ideally do not accept a limit at all.
5. Make the test path deterministic and isolated:
   - OpenRouter summaries disabled regardless of environment configuration.
   - Gemini classification/embedding disabled for this test path unless the implementation can prove a bounded, explicit, separately opted-in mode. Default and required behavior for this PR: heuristic-only, no external LLM calls.
   - No cluster summary generation and no OpenRouter/Gemini summary fallback.
   - Do not requeue failed, skipped, or already-processed records.
6. Return explicit metrics: claimed, analysed, skipped, problems, failed, clustered, clusters refreshed, summaries (must be 0), elapsed time, and a clear test-mode marker.
7. Preserve existing normal scheduled/manual collection behavior and existing `reanalyse` semantics. Do not weaken auth or modify cron/secrets.
8. Add unit tests for:
   - Non-admin manual caller rejected.
   - Schedule-secret caller rejected for the test action.
   - Test action claims no more than 10 records even when more are pending.
   - Test action makes zero source-claim/connector calls.
   - Test action makes zero Gemini/OpenRouter calls and generates zero summaries.
   - Existing normal collection path remains behaviorally unchanged.
9. Add concise developer documentation describing the action, guardrails, metrics, and how to invoke it only after an explicitly approved controlled test.

## Design guidance

Prefer a dedicated test-mode option in the analysis dependency contract (for example `maxRecords: 10`, `allowSummaries: false`, and an explicit heuristic-only switch) rather than environment-variable tricks. Ensure the cap is enforced inside the analysis loop, not merely in the HTTP handler. If the current store claim API can over-claim, pass a bounded remaining count to `claimPending`.

Be careful with clustering: if clustering/refresh mutates many unrelated production rows, do not run broad clustering in the test action. Either scope cluster assignment/refresh to the test batch or report those metrics as zero and document that this smoke test verifies bounded analysis only. Safety takes priority over producing impressive metrics.

## Verification

- Run the repository's relevant Deno/unit tests, type checks, and lint checks.
- Add tests proving the safety properties above, not only happy-path response shape.
- Inspect the final diff for accidental changes to scheduled collection, billing, secrets, cron, or migrations.
- Do not deploy or invoke the new action against the connected production Supabase project.
- Report exact commands run and results; distinguish tests not run from tests that passed.

## Acceptance criteria

A reviewer can establish from code and tests that the action is admin-only, analysis-only, hard-capped at 10 records, heuristic-only, summary-free, and cannot trigger source collection or reanalysis/requeue. No production deployment or data mutation is performed by this task.

---

# Developer reference: the `analysis_test` action (as implemented)

> **Status:** code and unit tests only. It has **not** been deployed or invoked against any Supabase project. Do not run it
> until a controlled test has been explicitly approved (see "Invoking it" below).

## What it does

`POST /functions/v1/collect` with body `{"action":"analysis_test"}` analyses **at most 10** pending raw records using the
keyword heuristic and returns metrics. Entry points: `collect/index.ts` (auth + routing) -> `runAnalysisTest` in
`_shared/collector/runner.ts` -> `runAnalysis({ testMode: true })` in `_shared/collector/analysis.ts`.

## Guardrails and where each one is enforced

| Guarantee | Enforced by |
|---|---|
| Admin JWT only; schedule secret gets **403** | `collect/index.ts`: `trigger !== 'manual'` check. `trigger` comes only from the secret header or the server-side `dr_is_admin` RPC; no body field is read for auth. |
| Request body cannot steer it | The branch ignores `source`, `skipAnalysis` and any limit-like field; there is no limit parameter at all. |
| Never touches sources / connectors / requeue | `runAnalysisTest` takes no `env`, `connectors` or `fetchImpl` and never calls `claimDueSources`, `upsertRecords`, `requeueHeuristicAnalysis`, etc. It does **not** go through `runCollection`. |
| Hard cap of 10 records | Inside the analysis loop: `ANALYSIS_TEST_MAX_RECORDS`; the claim asks for `<= 10`, the reply is truncated to the remaining budget (so an over-returning store cannot exceed it), and test mode makes exactly one pass. |
| Heuristic-only, no Gemini/OpenRouter | `runAnalysis` discards `gemini`/`openrouter` at the top when `testMode` is set, so environment keys cannot enable them. |
| No cluster summaries | Summary step is skipped in test mode (and is unreachable anyway because the AI clients are discarded). |
| No global clustering | `dr_assign_pending_clusters` and `dr_refresh_clusters` act on **all** unclustered signals / dirty clusters, not just the test batch, so test mode skips both and reports `0`. |
| Does not requeue failed/skipped/done records | Only `claimPending` rows (status `pending`) are read; nothing resets other rows. |
| Normal collection and `reanalyse` unchanged | Separate code path; regression tests cover both. |

## Response

```json
{
  "testMode": true, "action": "analysis_test", "maxRecords": 10, "method": "heuristic", "ran": true,
  "claimed": 10, "analysed": 9, "skipped": 1, "problems": 7, "failed": 0,
  "clustered": 0, "clustersRefreshed": 0, "summaries": 0, "elapsedMs": 412
}
```

`clustered`, `clustersRefreshed` and `summaries` are always `0` by design. An optional `note` appears if another analysis
pass holds the lock (`ran: false`).

## What it still writes (be aware)

It is a bounded **write** to the database, not a dry run. For each analysed record it saves a heuristic row in
`dr_problem_signals` and flips that raw record to `analysis_status = 'done'`; skipped records are marked `skipped`. It also
takes and releases the `analysis` lock. Signals it creates have no cluster, so the next normal analysis run will cluster
them. The 10 records are the oldest pending ones (`order by collected_at`).

## Invoking it (only after explicit approval of a controlled test)

1. Deploy this branch's `collect` function to the target project (never as a side effect of merging without sign-off).
2. As a signed-in admin, call the function with the admin JWT: `supabase.functions.invoke('collect', { body: { action: 'analysis_test' } })`.
3. Check `testMode: true`, `claimed <= 10` and `summaries === 0` in the response.

**Do not call `analysis_test` against a deployment that predates this branch** (for example, the current `main`). Those
versions do not know the action and treat any unknown `action` as a normal collection run (real connectors) because the
handler falls through to `runCollection`. This branch fixes that for deployments that include it (see below); it cannot
protect an older deployment that is already live.

## Tests

`bun run test:collector` (see `analysis-test-mode.test.ts` and `analysis-test-fn.test.ts`). They use in-memory/fake backends
only; no network and no real Supabase project.

## Accepted requests (strict allowlist)

`collect/index.ts` accepts exactly three kinds of request, checked **after** authentication (so unauthenticated callers learn
nothing about which actions exist) and **before** any store, connector or database call:

| Request body | Result |
|---|---|
| no `action` (absent or `null`), including `{}` and a genuinely empty body | normal collection run (what cron and the manual-sync button send) |
| `"action": "reanalyse"` | admin-only re-analysis (schedule secret -> 403) |
| `"action": "analysis_test"` | admin-only guarded smoke test (schedule secret -> 403) |
| any other `action` (typo, wrong case, stray whitespace, `""`, `0`, `false`, an object, `"constructor"`, ...) | **400** `{"error":"unknown action","supported":[...]}`; nothing is collected or claimed |
| a non-empty body that is not valid JSON, or is JSON but not an object (e.g. a truncated `{"action":"analysis_test"`, `null`, an array) | **400**; nothing is collected or claimed |

Matching is exact and case-sensitive. The dispatch is an exhaustive `switch` over the allowed actions, so adding a new
action without handling it is a compile-time error, and the fallback fails closed with a 400 rather than running a collection.
Tests: `collect-actions.test.ts`.
