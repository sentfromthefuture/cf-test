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
