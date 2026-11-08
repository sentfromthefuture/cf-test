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

---

## Update: unknown-action fallthrough fixed (follow-up commit on this branch)

Risk #3 above is addressed in `collect/index.ts` (the "Suggested follow-up" is now done on this branch rather than a separate PR):

- **Strict allowlist:** only no-action (absent/`null`), `"reanalyse"` and `"analysis_test"` are accepted. Anything else -> **400**, decided after auth and before any store/connector call. Exact, case-sensitive matching; falsy values (`""`, `0`, `false`) and `Object.prototype` names are rejected.
- **Exhaustive dispatch:** `switch` over the action union with a `never` check, so a future action cannot silently fall into `runCollection`.
- **One extension beyond the literal ask (please review; easy to drop):** a non-empty body that fails to parse, or is not a JSON object, now returns 400. Before, e.g. a truncated `{"action":"analysis_test"` was silently treated as `{}` and ran a **real collection**, and a JSON `null` body crashed with a TypeError. A genuinely empty body is still a normal collection run.
- **Tests:** `collect-actions.test.ts` (50 tests) assert 400 for ~30 unknown actions and 8 unreadable bodies with the *only* outbound call being `dr_is_admin` (admin) or none at all (schedule secret), plus regression tests that every valid request shape behaves as before (including the exact `{}` that pg_cron sends).
- **Mutation check:** re-introducing the fallthrough, falsy-as-no-action, swallowed bad bodies, and sloppy matching each made tests fail. Mutating only the unreachable `default:` branch does not (equivalent mutant; it is defence in depth).
- **Not changed (out of scope, FYI):** an invalid `source` string (not matching `^[a-z0-9_]{2,40}$`) is still treated as "no source", i.e. all due sources, rather than a 400.
- **Still true:** this cannot protect a deployment that is *already live* without the change. Deploy this branch before ever calling `analysis_test`.

---

## Update 2: `dr_claim_pending_records` verified against the real SQL

Question: can `claimPending(10)` cause the database to mark more than 10 records as claimed/processing, and can the test strand records?

**Answer: no and no, and no migration is needed.** `dr_claim_pending_records` (single definition, never overridden) is a read-only
`SELECT ... limit least(greatest(p_limit,1),200)`: it marks **0** rows, takes no row locks, and no `processing`/`claimed` status exists
(`CHECK` allows only pending/done/skipped/failed). See "Queue semantics and interruption" in `safe-analysis-test-mode.md` for the full table.

- **Proof, SQL:** new `supabase/tests/20_claim_pending.test.sql`, run on a throwaway local Postgres 16 + pgvector (repo stub + migrations 1-4; 5-6 need Supabase `auth.users`/billing tables and don't touch the queue). Passes; and it **fails** when I mutate the real function in a scratch DB copy to (a) raise the ceiling to 500, (b) UPDATE/over-claim 3x the limit, (c) add `FOR UPDATE SKIP LOCKED` (each caught behaviourally).
- **Proof, live concurrency:** with session A holding an open transaction right after `claim(10)`, session B could `SELECT ... FOR UPDATE NOWAIT` the same 10 rows instantly; A held only `AccessShareLock`; both sessions received identical rows (so it is a peek, not a reservation).
- **Stranding after interruption:** a backend hard-killed after taking the lock and reading 10 rows left all 25 records `pending`, 0 attempts, 0 signals; only the `analysis` lock row remained (~177 of 180 s), and it expires on its own (also shown with a 2 s TTL). `markFailed` is unreachable in test mode, so attempts can't be burned. Worst real-world effect: analysis paused up to 3 min.
- **TypeScript test improved:** the old "store returns extra rows" test is replaced by `analysis-test-claim-model.test.ts`, which models the real SQL (clamp, read-only) and a *hypothetical claiming DB*, snapshots storage before/after, and asserts <=10 mutated rows. A canary test shows an over-claiming DB cannot be contained by app code and that the mutation budget check flags it. Interrupted and hard-killed passes are modelled too (lock released in `finally`; TTL pinned at 180 s). 5 app-level mutations all fail the new tests.
- **Honest caveats:** (1) the SQL tests are **not run in CI** (no workflow starts Postgres); I did not add a workflow. Suggested follow-up: a CI job with a `pgvector/pgvector` service running `00_stub_supabase.sql`, the migrations, and `supabase/tests/*.test.sql`. (2) I proved behaviour on stock PostgreSQL 16 / pgvector 0.6.0, not on a real Supabase project, which I was told not to contact; Supabase's managed Postgres runs the same engine, but role/RLS behaviour (`security definer`, `service_role`) is not exercised here. (3) `claimed` in the metrics means "rows read from the queue", not "rows reserved".

