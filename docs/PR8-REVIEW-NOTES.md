> **Disposable review notes for PR #8. Delete this file before merging.** (Posting these as a PR comment failed: the access token has no pull-request/issue write scope.)

## Implementation notes for review (written by Claude)

Implements `docs/safe-analysis-test-mode.md` on this branch. **Code + unit tests only: nothing was deployed, no Supabase project was contacted, no secrets/cron touched.** PR stays draft.

### Where to look first (highest-value review targets)
1. `supabase/functions/collect/index.ts`: the `analysis_test` branch. Confirm `trigger !== 'manual'` -> 403, and that nothing from the request body is read in this branch.
2. `supabase/functions/_shared/collector/analysis.ts`: `testMode` handling. Check (a) AI clients are discarded *before* use, (b) the claim is bounded **and** the reply is `.slice()`d to the remaining budget (defends against an over-returning store), (c) exactly one pass, (d) clustering/refresh/summary steps are all gated by `!testMode`.
3. `supabase/functions/_shared/collector/runner.ts`: `runAnalysisTest` deliberately takes no `env` / `connectors` / `fetchImpl`, so config cannot enable Gemini/OpenRouter/connectors. It does **not** reuse `runCollection({ analysisOnly })` (that has no cap).

### Verified (commands run)
- `bun install --frozen-lockfile`, `bun run lint` (tsc): clean
- `bun run build`: OK
- `bun run test:collector`: **76/76 pass** (53 pre-existing + 23 new in `analysis-test-mode.test.ts` and `analysis-test-fn.test.ts`)
- Mutation check: temporarily broke the cap, AI-client discard, clustering gate and the 403 check; each made tests fail. (Disabling only the summary gate does not fail a test: it's redundant by design because the AI clients are already `null`.)
- Patch applied cleanly to a fresh checkout of this branch and passed there.
- Diff audited: no changes to migrations, cron, env, workflows, billing (`functions/api/*`), `package.json` or lockfile.

### NOT verified (be skeptical here)
- **Real Deno / Supabase Edge runtime.** Tests run under Node + `tsx` with a stubbed `Deno` global. The handler wiring is exercised, the Edge bundler is not.
- **`supabase/tests/*` (SQL + e2e) were not run**: they need a Postgres. No SQL was changed, so I don't expect impact, but they are unrun.
- **Real PostgREST/RLS behaviour**: the "fake backend" tests prove which RPCs are called and with what limits, not how the real DB responds.
- `bun run collector:live-check` was not run (it would hit real services).

### Known risks / design decisions worth a second opinion
1. **It's a real write, not a dry run.** The <=10 oldest pending records get heuristic rows in `dr_problem_signals` and become `analysis_status='done'` (or `skipped`). Their signals stay unclustered until the next normal run.
2. **Clustering is skipped, not scoped.** `dr_assign_pending_clusters` / `dr_refresh_clusters` act on *all* unclustered signals / dirty clusters, so test mode reports them as 0. Scoping them would need a new SQL function + migration; I deliberately did not add one (spec: safety over impressive metrics).
3. **Pre-existing sharp edge, intentionally not changed:** the handler falls through to a full `runCollection` for any *unknown* `action`. So calling `analysis_test` against a deployment that predates this change would run **real collection**. Documented in the new docs section. **Suggested follow-up PR:** return 400 for unrecognised actions (cron sends `{}` and the client sends only `source`/`reanalyse`, so this looks safe, but it changes existing behaviour, hence separate).
4. Only the `analysis` DB lock prevents overlap with a normal run; there is no per-day limit on how often an admin can invoke the test (each call is still capped at 10).

### Suggested next steps before un-drafting
- Run `bun run test:collector` + `supabase/tests` in CI against a real Postgres.
- Decide on follow-up #3 (reject unknown actions).
- Only after explicit approval: deploy this branch's `collect` function, then one admin invocation, and check `testMode:true`, `claimed<=10`, `summaries===0`.
