# Blueprint engine – validation, caching and reliability design (Phase A, Task 1E)

**Status:** design only. No migration is created or run, no code or configuration changes, nothing is deployed. SQL that appears below is an **illustrative sketch inside a document**, not a migration file, and has not been executed anywhere.
**Companions:** [`architecture-audit.md`](./architecture-audit.md) · [`product-blueprint-v1.md`](./product-blueprint-v1.md) · [`evidence-contract.md`](./evidence-contract.md) · [`ernie-system-prompt.md`](./ernie-system-prompt.md)

Tags as in the audit: **[V]** verified in the repository at commit `76780ee`, **[A]** assumption or outside knowledge, **[P]** a proposal made by this document.

## 0. Decisions in one table

| # | Decision | Section |
|---|---|---|
| 1 | The engine runs as its **own Supabase Edge Function**, not inside `collect` and not as a Pages Function. **[P]**, approval requested | §1 |
| 2 | The blueprint uses **three sectioned passes A/B/C**, with one live pass per invocation as the current proposal; the client re-calls the same idempotent endpoint until it is ready. The three-pass architecture is preserved; execution mode and performance settings remain provisional until benchmarked. **[P]** | §§1, 3, 16 |
| 3 | The engine uses an **engine-specific HTTP client** with no retries; the 120 s timeout is only a planning example, not a selected value. A full-body deadline is required; the overall deadline and per-pass timeouts remain unselected until representative benchmarking. The shared client and its 30 s timeout are **not changed**. **[P]** | §§2, 16 |
| 4 | Validation is hand-written, strict, and **rejects rather than guesses**; evidence repairs only ever lower trust. | §4–§6 |
| 5 | The cache **reuses `dr_ai_cache` and `dr_ai_usage`** with a new value `blueprint`, by widening three `CHECK` constraints in a later migration. No SQL function changes. **[P]** | §11 |
| 6 | Cache identity, versions and the global cache-version override are **separate** from Decisions Fast and the summary engine. | §9, §10 |
| 7 | Per-user quota and accounting are **new and separate** from the PRD generator's. | §12 |

---

## 1. Execution topology

### 1.1 Options

| | A. Pages Function `functions/api/blueprint.ts` | **B. New Edge Function `supabase/functions/blueprint/`** | C. New action in `collect` |
|---|---|---|---|
| Reuses entitlement code | yes (`generate-brief.ts` pattern) | re-implemented, with tests | no |
| Reuses cache, HTTP, parsing modules | unproven: they live under `supabase/functions/_shared` and the Pages build has not been shown to import them **[A]** | **yes, directly** **[V]** (runtime-agnostic modules) | yes |
| Secret handling | `OPENROUTER_API_KEY` would have to be copied into Cloudflare; `docs/AI_ARCHITECTURE.md` §6 states engine configuration belongs in Edge secrets, not Pages **[V]** | existing Edge secret | existing Edge secret |
| Auth model | user JWT | user JWT (platform check can stay **on**, unlike `collect`) | `collect` accepts only the scheduler secret or an admin JWT **[V]**: wrong audience |
| Blast radius on existing engines | none | none | shared failure domain, shared `Action` allowlist |
| Deployment | Pages (unchanged) | needs a **new** function deploy step: `deploy-collector.yml` deploys `collect` only **[V]** | existing |

**Recommendation: B.** It is the only option that reuses the proven cache and parsing code without crossing build trees, keeps the secret where it already is, and leaves `collect` untouched. Cost: the entitlement check (live subscription plus quota) is re-implemented; it must be covered by tests against the same rules as `generate-brief.ts`, and a later refactor can share it.

Side effects to plan for in Phase B **[V]**: `deploy-collector.yml` triggers on pushes to `main` that touch `supabase/functions/**` and redeploys `collect`. Any shared-module change (for example widening `AiTask`) therefore redeploys `collect` with no behaviour change. A new function also needs its own `[functions.blueprint]` entry in `supabase/config.toml` and its own deploy step. **This documentation-only change touches none of those paths and deploys nothing.**

### 1.2 Request model: one live pass per invocation

Arithmetic in §3 shows that three sequential passes can exceed a single Edge invocation (assumed ~150 s on the free plan, `runner.ts` comment **[A]**) at the pessimistic throughput. The design therefore lets each invocation run **at most one live pass**:

```text
client -> POST blueprint {cluster_id, params}                       (idempotent, safe to repeat)
   1. authenticate (JWT) -> entitlement -> per-user quota -> BLUEPRINT_ENABLED
   2. build evidence pack (read-only) -> sufficiency
        insufficient -> return {state:'insufficient_evidence'}   (no model call, no quota)
   3. for pass in A, B, C:
        cache lookup (cachedCompute begin)
          hit      -> use it (free)
          busy     -> return {state:'busy', retry_after_ms}
          claimed  -> run THIS pass live, store it, return {state:'in_progress', next}
   4. all three present -> assemble + verify -> store assembled entry -> {state:'ready'}
```

Re-calling walks the passes: call 1 runs Pass A, call 2 hits A and runs B, call 3 hits A and B and runs C, call 4 returns the assembled blueprint. Cache hits cost nothing, so no read-only "peek" function is needed. A user who closes the app keeps all completed passes in the cache; resuming is cheap.

```ts
// uses PassName, ProductBlueprintV1, EvidenceSufficiency from product-blueprint-v1.md §3
export type BlueprintFailureCode =
  | 'schema_invalid' | 'evidence_refs_invalid' | 'truncated' | 'empty_response'
  | 'content_filtered' | 'rejected_by_policy';

export type BlueprintResponse =
  | { state: 'insufficient_evidence'; sufficiency: EvidenceSufficiency; reasons: string[] }
  | { state: 'in_progress'; completed: PassName[]; next: PassName }
  | { state: 'busy'; retry_after_ms: number }
  | { state: 'ready'; blueprint_id: string; blueprint: ProductBlueprintV1 }
  | { state: 'failed'; pass: PassName; code: BlueprintFailureCode; retry_after: string | null }
  | { state: 'unavailable'; retry_after_ms: number | null }      // provider or service-level problem
  | { state: 'quota_exceeded'; resets_at: string }
  | { state: 'forbidden' };                                      // plan not entitled
```

HTTP mapping: `ready`, `in_progress`, `busy`, `insufficient_evidence` → 200; `failed` → 200 with `state: failed` (a normal outcome, not a transport error); `unavailable` → 503; `quota_exceeded` → 429; `forbidden` → 403; unauthenticated → 401. These are proposals.

**Unverified synchronous-execution gate.** This flow assumes one live pass can finish within a synchronous Edge Function invocation. That has not been verified. No overall generation deadline or user-facing wait-time target is selected. Benchmark per-pass and end-to-end behaviour, including actual platform limits, before finalising those choices. If a synchronous pass cannot reliably finish within the Edge limit and acceptable wait time, use background/async generation with persisted job state and status polling; keep the same three A/B/C passes and contract.


## 2. Engine-specific HTTP client and timeout

### 2.1 Facts

- **[V]** The shared client is built once in `runner.ts` with `timeoutMs: 30_000, retries: 1`, and used by Decisions Fast and ERNIE summaries. `createHttpClient` is a factory: any module can build another instance with other options, and counters are per instance.
- **[V]** In `http.ts` the abort timer is cleared as soon as `fetch` returns the response **headers**; the body is read afterwards (`res.json()`) with no timer. The shared timeout therefore bounds *time to first byte*, not the whole transfer.
- **[V]** `SUMMARY_MAX_TOKENS = 3072` is already limited by the 30 s timeout (the comment and the single `todo` test in `summary-engine-response.test.ts`).
- **[A]** Throughput of the free ERNIE route: ~90 tok/s (`ai.ts` comment) or ~173 tok/s median (`docs/ai-smoke-test.md`). Neither was measured in this audit.

### 2.2 Is a longer timeout necessary? Yes

Pure generation time for a given number of completion tokens (reasoning tokens included), computed from the two figures above:

| Completion tokens | at 90 tok/s | at 173 tok/s |
|---:|---:|---:|
| 3,072 (today's summary budget) | 34 s | 18 s |
| 6,000 | 67 s | 35 s |
| 7,500 | 83 s | 43 s |
| 8,500 | 94 s | 49 s |
| 12,000 | 133 s | 69 s |
| 16,000 | 178 s | 92 s |

Even a single sectioned pass of 6,000 tokens exceeds 30 s at the pessimistic figure. Raising the shared timeout is **not** an option under this assignment's constraints and would also change Decisions Fast and summaries. So:

### 2.3 Design **[P]**

```ts
// sketch, not implemented
const blueprintHttp = createHttpClient({
  timeoutMs: BLUEPRINT_PASS_TIMEOUT_MS,        // provisional planning example only; finalize after the representative benchmark in §16
  retries: 0,                                  // never retry a 100 s call; a failed pass is a recorded failure
  maxInlineWaitMs: 15_000,                     // a long Retry-After becomes a rate_limited error, not a sleep
  minIntervalMs: { blueprint: BLUEPRINT_MIN_INTERVAL_MS },   // default 3_000, own pacing key
  fetchImpl: withBodyDeadline(fetch, BLUEPRINT_PASS_TIMEOUT_MS),
});
```

`withBodyDeadline` is a small wrapper around `fetch` that reads the whole response body inside the same deadline and returns a buffered `Response`. It is needed because of the header-only timer above, it needs no change to `http.ts`, and it must be tested with a fake fetch whose body stalls. **[V]** that `createHttpClient` accepts an injected `fetchImpl` (the existing tests rely on it).

Rules:

1. **No retries inside a request.** Both throughput figures, and the repository's own smoke-test notes, say a retry after reasoning exhaustion would repeat the failure while doubling the wait.
2. **Do not start a pass unless the remaining invocation time exceeds the pass timeout plus 15 s** (same guard style as `analysis.ts`). If not, return `in_progress` and let the next call run it.
3. **Separate client, separate pacing key, separate counters.** Blueprint traffic cannot make Decisions Fast or summaries wait, and per-client `usage()` deltas stay exact for `meteredCall`.
4. **Never lengthen the shared client**, never reuse its instance.

## 3. Generation strategy and token budgeting

### 3.1 Why sectioned passes

Output size is driven by list counts (contract §5). Scaling the worked example to different counts, with a chars÷4 heuristic **[A]** (compact JSON, ERNIE's tokenizer not measured):

| Output JSON tokens | Pass A | Pass B | Pass C | Total |
|---|---:|---:|---:|---:|
| As in the worked example (low end of every range) | 2.6k | 2.4k | 1.7k | 6.6k |
| Typical (mid-range counts, strings ×1.5) | 6.4k | 7.1k | 5.3k | 18.8k |
| Maximum counts (strings ×2) | 12.0k | 14.4k | 10.0k | 36.4k |

The prompt asks for the lower half of each range and compact JSON (prompt document §3.1, rules 1 and 10), so the **planning figure** is the midpoint between the first two rows: **A 4.5k, B 4.7k, C 3.5k, total 12.7k**. Adding an assumed 2.5–3k reasoning tokens per pass, a single call would need ~16k completion tokens: ~178 s at the unverified 90 tok/s assumption and ~92 s at the unverified 173 tok/s assumption. These calculations are sizing estimates, not measured performance. The three-pass A/B/C architecture is retained; benchmark results may change its budgets and execution mode, not collapse or redefine its passes.

Cost of sectioning: three calls instead of one against the free tier, plus cross-pass consistency work (handled by constrained handoff ids and integrity checks at assembly). Benefit: each pass has a modest budget and a failed pass does not discard the others. Only Pass A receives raw third-party discussion content; B and C receive constrained, backend-validated fields that remain untrusted text.

### 3.2 Plan and budgets (planning estimates only; not final configuration values)

| | Pass A (strategy and scope) | Pass B (architecture and data) | Pass C (delivery and assurance) |
|---|---:|---:|---:|
| System prompt (est.) | 1.3k | 1.7k | 1.6k |
| User message (est.) | up to ~4.2k (pack at caps ≈ 4.0k + request) | ~0.9k | ~1.3k |
| Planning figure for output JSON | 4.5k | 4.7k | 3.5k |
| Reasoning allowance (assumption) | ~2.9k | ~2.6k | ~2.5k |
| **Planning `max_tokens` (not final)** | **8,500** | **8,500** | **7,500** |
| Estimated duration at unverified 90 tok/s | 94 s | 94 s | 83 s |
| Estimated duration at unverified 173 tok/s | 49 s | 49 s | 43 s |
| Per-pass timeout (planning example, not final) | 120 s | 120 s | 120 s |

Rule that generated the table, to be considered only after real throughput is measured: `max_tokens ≤ 0.8 × timeout × measured_median_tok_per_s` (at the planning example of 120 s and the unverified 90 tok/s figure, that calculation is 8,640). This heuristic is not a benchmark result or a final setting. No representative performance benchmark has been run; per-pass timeouts, output-token budgets, the overall generation deadline, the user-facing wait target and synchronous Edge Function viability all remain undecided until §16. The context window (documented as very large in `ai.ts`, **[A]**) is not the constraint; **output time is**.

The representative benchmark is a Phase B gate (§16). It may determine budgets and whether each pass runs synchronously or through a background/async job, but this correction preserves the existing three-pass A/B/C architecture; it does not authorize splitting, collapsing or otherwise redefining those passes.

Token ceilings per assembled system prompt and per user message are asserted in tests (Phase B), so a prompt edit that bloats a pass fails CI.

## 4. Schema validation

### 4.1 Principles

- **One source of truth.** The contract's enums, counts, caps and id patterns live in one constants module. The TypeScript types, the validator and the prompt skeletons are all derived from it. A test compares them (prompt document §9). **[P]**
- **Hand-written, no new dependency.** `package.json` has no validation library **[V]**; `validateSummary` and `validateLlmResult` are hand-written and build new objects from an allowlist, which also removes prototype-key hazards. The blueprint validator follows that style.
- **Strict by default.** Unknown enum values are **not coerced** (unlike `validateLlmResult`, which maps an unknown industry to `other`). A silent coercion in a 30-field document hides model drift.

### 4.2 Tiers (run in this order; first failing tier decides)

| Tier | Check | Failure |
|---|---|---|
| T0 | Response is non-empty text; reasoning removed; one JSON object extracted | reject (§5) |
| T1 | Top-level shape: only the allowed keys for this pass; backend-owned keys (`meta`, `evidence_index`, `verification`, `downgraded_from`) are **forbidden** in model output | forbidden key → remove and record; wrong type → reject |
| T2 | Required fields present and correctly typed | reject |
| T3 | Enums exactly match (case-sensitive) | reject |
| T4 | Lists within `min..max`; strings within caps | below min → reject; leaf-list overflow → truncate (`truncated_list`); string overflow → truncate at a code-point boundary (`truncated_text`) |
| T5 | Identifier format, uniqueness, cross-references, acyclicity, database integrity (contract §4) | reject |
| T6 | Evidence references and basis rules (evidence contract §5) | repair or reject per its §7 |
| T7 | Content policy: no URL, no SQL-like statement in any model-written string | reject |

Truncation must not split a UTF-16 surrogate pair. Blueprint text is long and multilingual excerpts are paraphrased into it; a lone surrogate makes PostgREST reject the whole body (HTTP 400 `PGRST102`), which `toPostgrestJson` already scrubs for every RPC call **[V]**. A regression test with a truncated emoji and a truncated CJK string is required anyway.

Before Pass B or C, the backend must validate the preceding output against that pass's exact schema, types, enums, counts, string caps, identifier/cross-reference rules and content policy, then build a fresh DTO from the explicit handoff allowlist in `ernie-system-prompt.md` §4. It must not pass through raw model JSON or unknown fields. Validation constrains structure; it does not make any free-text field trusted or safe to treat as an instruction.

### 4.3 Required versus optional

- Every field in the contract without a `?` is **required**; arrays are required and may be empty only where the minimum is 0.
- Optional fields: `Claim.confidence`, `Claim.rationale`, `Claim.validation`, `Claim.missing_information`, `JourneyStep.system_response`, `WorkflowTransition.guard`, `NonFunctionalRequirement.target`, `ColumnDesign.default`, `ColumnDesign.contains_personal_data`, `IndexDesign.partial_condition`, `RlsDesign.notes`, `TableDesign.retention`, `TableDesign.expected_volume`, `PricingHypothesis.price_placeholder`.
- The three companion texts (`rationale`, `validation`, `missing_information`) are *soft-required*: absence is accepted and counted (evidence contract §5.2).
- Backend-owned fields are never required of the model.

### 4.4 Enum validation

Exact string equality against the constants. The validator reports the **JSON Pointer** of the failing value and a fixed rule code, never the offending model text, matching the existing `AiFailureDetail` rule that diagnostics are content-free **[V]**.

## 5. Malformed JSON handling

Reuse the existing, tested pipeline from `ai.ts` without modifying it **[V]**: `describeChatCompletion` → `splitInlineReasoning` → `extractJsonObject` (tolerates code fences and surrounding prose by brace scanning; refuses JSON found inside unfinished reasoning).

| Observation | Existing reason code reused | Cache effect |
|---|---|---|
| HTTP 200 whose body is not JSON | `response_not_json` | input-level failure |
| No `choices` | `no_choices` | input-level failure |
| Empty content | `empty_content` | input-level failure |
| No JSON object found | `no_json` | input-level failure |
| JSON is an array or scalar | `not_an_object` | input-level failure |
| Provider-reported error inside a 200 | `provider_error` | classified by status when given |
| Content filtered | `content_filtered` | input-level failure |
| Parsed but fails T1–T7 | `schema_invalid` with `field` = JSON Pointer or fixed rule code | input-level failure |

Mapping to existing codes means **no change to the shared `AiFailureReason` union** is required. The pointer segments are keys from our own schema and array indexes, so they satisfy the "fixed name from our own schema" rule for `AiFailureDetail.field`.

**Never repair by guessing:** no auto-closing of braces, no re-quoting, no extracting a sub-object from a half-valid document, no accepting a prefix of the schema.

## 6. Truncated response handling

Signals **[V]** (already modelled): `finish_reason: length` with partial content → `truncated_json`; empty content with `finish_reason: length`, or an unclosed reasoning block → `reasoning_exhausted_budget`.

Policy:

1. A truncated or budget-exhausted pass is a **failed pass**. It is never salvaged, never validated as partial, and never retried inside the same request.
2. It is recorded through the existing failure path (`dr_ai_cache_fail`), with the existing growing cooldown (1 h, 2 h, 4 h … capped at 7 days). **[V]**
3. Completed passes stay cached; only the failed pass is blocked. The response is `{ state: 'failed', pass, code: 'truncated', retry_after }`.
4. A budget or prompt change is a configuration-version change (§10): it creates a new cache identity, so the cooldown of the old identity does not delay a fixed build.
5. A user-level throttle (one live attempt per user per blueprint per 60 s, §8) stops repeated clicks from spending the free tier while a cooldown could not apply.

Rationale for using the existing cooldown rather than an immediate retry window: it keeps the behaviour consistent with the two existing engines and protects the shared free-tier quota. The cost is that a legitimately too-small budget blocks for an hour; that is what the configuration-version bump is for.

## 7. Provider errors

All classification reuses `classifyAiFailure` and `aiErrorFromBody` **[V]**. "Systemic" means the problem is not about this input: the lease is abandoned and **no failure marker** is written, so nothing is penalised.

| Kind (existing) | Typical cause | Systemic? | Blueprint behaviour | Response |
|---|---|---|---|---|
| `rate_limited` (429) | free-tier limit | yes | abandon lease; do not retry; keep `Retry-After` if present | `unavailable` + `retry_after_ms` |
| `unavailable` (5xx, 502/503/504) | provider outage | yes | abandon lease | `unavailable` |
| `timeout` (client abort, 408/524) | slow generation | yes | abandon lease; see §8 | `unavailable` |
| `network` | transport failure | yes | abandon lease | `unavailable` |
| `auth` (401/403) | invalid or revoked key | yes | abandon; **loud log**; stop live calls until config changes | `unavailable` |
| `quota` (402) | should be impossible on a `:free` slug | yes | abandon; **loud log**; treat as a possible paid-route attempt | `unavailable` |
| `not_found` (404) | preview slug retired or no endpoint | yes | abandon; loud log | `unavailable` |
| `bad_request` (400/413/422) | our request is invalid | no | record failure (cooldown); log fixed code | `failed` |
| `invalid_response` | §5, §6 | no | record failure (cooldown) | `failed` |
| `refused` | content filter | no | record failure | `failed` |

**No fallback model, ever.** `BLUEPRINT_MODEL` must be an explicit `:free` slug (`isFreeModelSlug`), requests carry `provider.allow_fallbacks: false`, and there is no alternative-model code path. A paid fallback is not introduced.

## 8. Timeout handling

1. **Client deadline** (§2.3) aborts the call and yields a `timeout` error; the pass lease is abandoned (a fresh lease is deleted, one with failure history is kept but immediately retryable **[V]** from `dr_ai_cache_abandon`).
2. **Platform kill** (invocation exceeds the Edge wall clock, e.g. a stalled DB call): the lease stays `pending` until `lease_until`. Set `leaseSeconds = pass timeout + 60` (= 180 s; the SQL clamps to 10–900 **[V]**). Other callers see `busy`, then take over with a higher `lease_epoch`; the fence prevents the stale worker from writing **[V]**.
3. **A client-side abort does not necessarily stop the provider.** A user who retries at once could start a second generation while the first still runs. The mitigations are the one-attempt-per-60 s user throttle, `BLUEPRINT_MAX_LIVE_PER_DAY`, and the pacing key. A durable service-level circuit breaker across invocations does not exist for the current engines either (`docs/AI_ARCHITECTURE.md` §10 item 13); none is added here, and the daily cap is the backstop.
4. **Do not start what cannot finish:** the guard in §2.3 rule 2.
5. **No timeout is stretched by a Retry-After:** `maxInlineWaitMs` is 15 s.

## 9. Cache identity

### 9.1 Key

The existing identity is reused unchanged **[V]**: `(task, input_hash, model, config_version)`, where `input_hash = SHA-256(canonicalJson(identity object))`.

```ts
// sketch
type PassIdentity = {
  task: 'blueprint';
  contract: 'product-blueprint.v1';
  part: 'A' | 'B' | 'C' | 'assembled';
  request: BlueprintRequestParams;                  // five enumerated values (contract §3.9)
  evidence?: CanonicalPack;                         // Pass A only (rendered exactly as shown to the model, §9.2)
  upstream?: { A?: string; B?: string; C?: string };// SHA-256 of the upstream VALIDATED RESULTS, not of their inputs
};
```

Why upstream **results**: if Pass A is regenerated (new prompt, new model), its text differs, and a Pass B built on the old text must not be served for the new one. Hashing the validated result guarantees B and C match the exact A they were built on.

Four entries therefore exist per blueprint: `A`, `B`, `C`, and `assembled`. The assembled entry is produced by a deterministic function (no model call) and is not counted in model-call accounting (§12).

### 9.2 What goes into the hash

| Included exactly | Rounded or bucketed (the model sees the same rounded value) | Excluded |
|---|---|---|
| excerpt `text`, `title`, `source`, `kind`, `published` (month), `wtp` flag; metrics M01, M02, M04, M05, M06, M10; the request parameters; pass number; contract version | M03 growth (nearest 10 points, null stays null); M07 and M08 (bucket labels `0`, `1-2`, `3-5`, `6-10`, `11+`); M09 (nearest 0.5); M11–M16 values (nearest 5) | engagement counts, record ids, URLs, attribution, licence, `first_seen_at`, `last_seen_at`, analysis timestamps |

Without rounding, sliding 30-day windows would change the hash every day with no new evidence and cause needless regeneration. Because the model sees the rounded value, the stored `evidence_index` holds **what the model saw**, and metric values in a blueprint are "as at generation". Live numbers stay in `dr_clusters`. The set of selected excerpts can change when engagement ranking changes, which does change the hash; that is a content change and is correct.

### 9.3 What is deliberately not in the key

- The user and the user's plan. A cached blueprint contains no user data; entitlement and quota are checked **before** any cache read, so a cache hit never bypasses them.
- Free-text parameters: none exist in v1. A free-text field would let a user vary one character and force a live free-tier call for every request. Parameters are enumerated (contract §3.9).

### 9.4 Stored result and takedown column

- Pass A's cache `result` also carries its evidence snapshot (the pack as shown and the resolved index entries), so assembly and re-verification never depend on the live database.
- The cache row's existing `citations` column **[V]** holds the resolved `{ record_id, content_sha256 }` list. That makes "which blueprints cite this record?" a query rather than a rebuild (§10).
- A hard size cap `BLUEPRINT_MAX_RESULT_BYTES = 262_144` applies to a stored result; the caps in the contract keep real results far below it.

## 10. Cache invalidation and configuration versioning

### 10.1 Configuration version

`BLUEPRINT_CONFIG_VERSION = "bp{N}.p{N}.s{N}"`, with an optional `+{BLUEPRINT_CACHE_VERSION}` suffix. It occupies the existing `config_version` column.

| Component | Meaning | Bump when |
|---|---|---|
| `bp` | contract, validator rules, evidence-pack selection and rounding | any field, enum, cap, integrity rule, verification rule, selection step or rounding rule changes |
| `p` | prompt texts and skeletons | any word of any prompt changes (a hash snapshot enforces this) |
| `s` | pass plan, token budgets, timeouts | a pass boundary, `max_tokens` or timeout changes |

`BLUEPRINT_CACHE_VERSION` is an operator override like `AI_CACHE_VERSION`, with the same sanitising rule **[V]** (`[A-Za-z0-9._-]`, up to 24 characters). It is **separate**: `AI_CACHE_VERSION` is appended to both existing engines **[V]** and **must not** be read by this engine, otherwise an unrelated operator action would discard blueprints (and the reverse).

### 10.2 Invalidation rules

| Trigger | Mechanism |
|---|---|
| Evidence changes (new, removed or re-ranked excerpts, changed metric buckets) | different `input_hash`: new entry, old entry untouched |
| Request parameters change | different `input_hash` |
| Model slug changes | different `model` column |
| Contract, validator, pack builder, prompts, pass plan or budgets change | new `config_version` |
| Operator forces regeneration | set `BLUEPRINT_CACHE_VERSION` |
| A stored result no longer passes validation | existing `revive` hook in `cachedCompute`: the entry is invalidated and recomputed once. For Pass A, re-validation runs against the **stored** snapshot; for B and C against the stored upstream results; for `assembled`, a full re-verification. |
| A source record is withdrawn (takedown) | find entries with a query over `citations`, then call `dr_ai_cache_invalidate`, which removes **succeeded** entries only **[V]** |
| Age | no TTL. Existing housekeeping `dr_ai_cache_prune` (unused results after 180 days) applies unchanged **[V]**. |

A "stale evidence" indicator is cheap and needs no extra storage: compare the current pack hash with `meta.evidence_pack.pack_sha256` and let the UI offer regeneration (which spends quota).

Existing entries for `decisions` and `summary` are **never** touched by any blueprint version change, because the task is part of the key.

## 11. Extending the cache's task constraints without breaking `decisions` or `summary`

### 11.1 Facts **[V]** unless marked

| Object | Constraint | Where used |
|---|---|---|
| `dr_ai_cache.task` | inline `check (task in ('decisions','summary'))` | every cache call |
| `dr_ai_health.task` | inline `check (task in ('decisions','summary'))` | storage backoff, keyed `(task, model)` |
| `dr_ai_usage.engine` | inline `check (engine in ('decisions','summary'))` | `dr_ai_note_usage` |
| Constraint names | `dr_ai_cache_task_check`, `dr_ai_health_task_check`, `dr_ai_usage_engine_check` | **[A]** PostgreSQL's default `<table>_<column>_check`; confirm before use |
| SQL functions | `dr_ai_cache_begin/_complete/_fail/_abandon/_fail_storage/_invalidate/_prune`, `dr_ai_note_usage` | contain **no** task-specific branch; they pass the value through |
| TypeScript | `export type AiTask = 'decisions' \| 'summary'` in `ai-common.ts`; used by `AiCacheKey`, `Store.aiNoteUsage`, `flushAiUsage`, `ai-smoke.ts` | no exhaustive `never` check on it, so widening cannot create a compile error elsewhere |
| Behaviour before the migration | inserting `blueprint` fails a check inside `dr_ai_cache_begin`; the store rethrows; `cachedCompute` raises `AiCacheError`, documented as "refuse to spend requests" | the system **fails closed** |

### 11.2 Options

| Option | Verdict |
|---|---|
| **A. Widen the three `CHECK`s to include `blueprint`** | **Recommended.** Additive, no function change, reuses the lease fencing and cooldown logic already reviewed. `dr_ai_health` stays per `(task, model)`, so blueprint storage trouble cannot trip the `decisions` or `summary` backoff. |
| B. Separate tables and functions for blueprints | Fully isolated, but duplicates ~250 lines of concurrency-sensitive SQL and a second TypeScript store implementation. Divergence risk outweighs the isolation gained. |
| C. Drop the checks | Removes a useful guard against typos and misrouted writes. Rejected. |
| D. Store blueprints as `task = 'summary'` with a different config version | Conflates identity and accounting, pollutes `dr_ai_usage` for the summary engine, and breaks the independence requirement. Rejected. |

### 11.3 Safety argument for option A

1. **Existing rows satisfy the wider check**, so no row can violate it. The change is additive.
2. **Deploy order is migration first, code second.** Code that ships first fails closed (§11.1), so a mis-ordered deploy cannot spend free-tier requests or corrupt data.
3. **Existing engines are unaffected** because identity includes `task`: a `blueprint` row and a `summary` row with the same `input_hash` are different rows.
4. **Rollback.** Narrowing the check again fails while `blueprint` rows exist, so rollback is: delete rows where task is `blueprint` (cache, health) and usage rows where engine is `blueprint`, then restore the narrow check. Blueprint rows are derived data and can be regenerated.
5. **Locking.** Dropping and re-adding a check takes a brief exclusive lock on small tables; adding it `NOT VALID` then validating avoids a long scan. Table sizes were not inspected. **[A]**

### 11.4 Illustrative sketch (not a migration, not reviewed, not executed)

```sql
-- ILLUSTRATIVE ONLY. Names to be confirmed against the live catalogue first.
alter table public.dr_ai_cache  drop constraint if exists dr_ai_cache_task_check;
alter table public.dr_ai_cache  add  constraint dr_ai_cache_task_check  check (task   in ('decisions','summary','blueprint')) not valid;
alter table public.dr_ai_health drop constraint if exists dr_ai_health_task_check;
alter table public.dr_ai_health add  constraint dr_ai_health_task_check check (task   in ('decisions','summary','blueprint')) not valid;
alter table public.dr_ai_usage  drop constraint if exists dr_ai_usage_engine_check;
alter table public.dr_ai_usage  add  constraint dr_ai_usage_engine_check check (engine in ('decisions','summary','blueprint')) not valid;
-- then: alter table ... validate constraint ...;
```

Read-only check to run first (also illustrative): list the real constraint names and definitions from `pg_constraint` for the three tables, and `select task, count(*) from dr_ai_cache group by task`.

### 11.5 Other changes this implies (for the implementation phase)

- `AiTask` widened to `'decisions' | 'summary' | 'blueprint'` (one line in `ai-common.ts`; the only edit to an existing shared file, called out in that PR).
- SQL tests for the new value (`dr_ai_cache_begin('blueprint', …)` claims; a `blueprint` and a `summary` entry with the same hash do not share; `dr_ai_note_usage('blueprint', …)` accepted; a `blueprint` health row is independent) and **all existing assertions unchanged**. The SQL tests are **not run in CI** **[V]** (`validate.yml` has no SQL job; `docs/AI_ARCHITECTURE.md` §10 item 11), so they must be run on a disposable database and reported.
- No new RPC is needed for caching, so `store-ai-contract.test.ts`'s check that every RPC the store calls exists in the migration is unaffected.

## 12. Separate usage accounting

### 12.1 Engine-level (global, per day)

- A `blueprint` row in the existing `dr_ai_usage`, via the existing `meteredCall` and `flushAiUsage`, with the existing counters **[V]**.
- Unit = **one model pass**. A blueprint that runs three live passes adds `calls = 3`. Pass-level cache hits add `cache_hits`. The deterministic `assembled` entry is **not** a model call and is not counted in `cache_hits` or `cache_misses`, so the hit ratio stays meaningful.
- `output_tokens` holds the provider's completion count. Whether that includes reasoning tokens is an assumption about OpenRouter's accounting **[A]**; `dr_ai_usage` has no reasoning column. Per-pass `reasoning_tokens` is kept in the cache entry's `usage` JSON and in `meta.passes[]`, so no schema change is needed.
- Cost is provider-reported only; absent means unknown, not zero **[V]**.

### 12.2 Per-user quota (new; the existing tables do not fit)

`reserve_brief` / `commit_brief` / `release_brief` and tables `ai_usage` / `ai_usage_reservations` **[V]** serve the PRD generator and key a day count per user. Reusing them would couple blueprint use to the PRD limit and the 20-minute reservation window. **[P]** A parallel, separate set, to be designed in the implementation phase:

| Proposed object | Role |
|---|---|
| table for per-user, per-day live-pass counts | the counter |
| table for in-flight reservations, expiry about 5 minutes (pass timeout 2 minutes plus margin) | crash safety |
| three functions mirroring reserve, commit, release, service-role only | the same advisory-lock pattern `reserve_brief` uses |

Charging rule: **only live passes cost quota; cache hits are free.** Reserve before the call, commit on a stored pass, release on any failure.

### 12.3 Global cap

`BLUEPRINT_MAX_LIVE_PER_DAY` (default proposal: 30 passes, i.e. about 10 blueprints) bounds free-tier spend regardless of who asks. The count comes from today's `blueprint` row in `dr_ai_usage`, read with the service key. There is no read RPC for that table today; a service-role select suffices **[A]** (the tables revoke access from `anon` and `authenticated` only **[V]**).

### 12.4 Operator queries (illustrative)

- Usage by engine and day from `dr_ai_usage` where engine is `blueprint`.
- Cache state by task from `dr_ai_cache`, grouped by `task, status`.
- Failure codes: group `last_failure` for task `blueprint`.

## 13. Configuration reference **[P]**

All names are Edge secrets, set explicitly, validated at start, and **fail closed** with a content-free message (same style as `openRouterConfigProblem`). Nothing here changes any existing variable.

| Name | Default | Notes |
|---|---|---|
| `BLUEPRINT_ENABLED` | off | only the literal `true` enables; independent of `OPENROUTER_ENABLED` and `DECISIONS_ENABLED` |
| `BLUEPRINT_MODEL` | `baidu/ernie-5.5-flash-preview:free` | must pass `isFreeModelSlug` |
| `OPENROUTER_API_KEY` | existing secret | shared with the other engines, which means a **shared free-tier quota** (audit R6) |
| `BLUEPRINT_PASS_TIMEOUT_MS` | unset until benchmark | `120000` ms is a planning example only, not a selected default; allowed bounds also require benchmark and platform validation |
| `BLUEPRINT_MIN_INTERVAL_MS` | `3000` | own pacing key `blueprint` |
| `BLUEPRINT_MAX_LIVE_PER_DAY` | `30` | global live passes per UTC day |
| `BLUEPRINT_USER_DAILY_PASSES` | not set (requires a product decision, Q1) | per-user cap |
| `BLUEPRINT_CACHE_VERSION` | unset | override, sanitised |

Code constants (not environment): `BLUEPRINT_CONTRACT_VERSION`, `BLUEPRINT_PROMPT_VERSION`, the pass plan and `max_tokens` per pass, the sufficiency thresholds, the repair thresholds.

## 14. Preserving existing behaviour

| File or system | Rule for the implementation phase |
|---|---|
| `ai.ts`, `summaries.ts`, `analysis.ts`, `runner.ts`, `http.ts`, `decisions.ts`, `decisions-runner.ts`, `heuristics.ts`, `collect/index.ts`, `generate-brief.ts` | **not modified**; helpers they export are imported, not edited |
| `ai-common.ts` | one additive change: the `AiTask` union |
| `dr_clusters`, `dr_problem_signals`, `dr_signal_ai`, scoring SQL | **no write path** from the blueprint engine |
| Existing migrations | not edited; one **new** migration widens three checks and adds the quota objects (separate PR, reviewed on a disposable database) |
| Frontend | not redesigned; any UI is a later, separately approved batch |
| Cron | stays paused; the blueprint engine is user-triggered and never scheduled |

Regression guards to add in the implementation phase: the existing 335-test suite unchanged and green; snapshot tests proving `SUMMARY_CONFIG_VERSION`, `DECISIONS_CONFIG_VERSION`, `SUMMARY_SYSTEM`, `ANALYSE_SYSTEM`, `SUMMARY_MAX_TOKENS` and the shared client's defaults are unchanged; a test that a `blueprint` cache write never alters a `summary` or `decisions` entry.

## 15. Security and logging

**Release blocker:** do not send third-party discussion content to the free ERNIE provider until the applicable data handling, retention, logging and training/privacy terms have been reviewed against authoritative provider evidence. That review has not been completed here; no privacy verification is claimed. This gate must be cleared before enabling generation or running content-bearing performance benchmarks.

- **Order of checks:** JWT → entitlement (live subscription, plan allowed) → per-user quota → global daily cap → `BLUEPRINT_ENABLED` → sufficiency → cache → model. A cache hit is returned only after the first four.
- The user id never appears in a prompt, a cache key or a stored blueprint. No free-text user input reaches the model in v1.
- **Logs are content-free,** like the existing engines **[V]**: counts, fixed codes, JSON Pointers, token numbers. Never a prompt, a model output, an excerpt or a key; errors pass through the existing redaction (`safeError`).
- The browser renders model text **as text**; evidence URLs come only from the backend's `evidence_index`.
- The platform JWT check can stay on for the new function because callers are signed-in users (unlike `collect`, which has to accept a scheduler secret).

## 16. Tests and gates for the implementation phase (not run now)

1. **Representative performance benchmark (a prerequisite before finalising runtime settings):** after the provider privacy release gate in §15 is cleared, benchmark representative cluster/evidence sizes and record each pass's full response time (including body read), completion and reasoning token counts, finish reason, JSON/schema validity, and observed user-facing wait; also measure end-to-end time across the three passes and re-calls, and verify synchronous Edge Function limits. No representative benchmark has been run and no result is asserted here. Until the privacy review is complete, use synthetic payloads only; synthetic runs do not satisfy the representative-content gate or justify final settings. Only the benchmark may determine per-pass timeouts, the overall generation deadline, output-token budgets, wait-time target and synchronous viability. If synchronous execution is unreliable within actual platform limits or the agreed wait target, use background/async generation with durable job status and polling, without changing the three-pass A/B/C contract.
2. Validator: the §7 worked example as an accepted fixture; a mutation for every rejection and repair; the lone-surrogate case; a stalled-body fake for `withBodyDeadline`.
3. Evidence: reference resolution, each grounding guard, the willingness-to-pay rule, the repair thresholds.
4. Cache: identity stability (same pack → same hash; bucketed metric drift → same hash; reordered input → same hash), upstream-result hashing, fencing and cooldown behaviour through the existing machinery, `revive` re-validation.
5. Regression: §14.
6. SQL on a disposable database: §11.5.

## 17. Open questions needing a decision

| # | Question | Needed for |
|---|---|---|
| Q1 | Which plans may generate blueprints, and what per-user daily limit? (Pro and Business as for briefs, or Business only?) | §12.2 |
| Q2 | Approve option B (new Edge Function) over a Pages Function? | §1 |
| Q3 | Edge Function wall-clock and background-task limits for this project's plan (not verified; `runner.ts` says ~150 s on the free plan). | §1.2, §3.2 |
| Q4 | Representative measured ERNIE throughput and reasoning overhead; the quoted 90 and 173 tok/s figures remain unverified assumptions. | §3, §16 |
| Q5 | Is non-streaming acceptable for v1? Streaming would expose progress and avoid long silent waits but complicates validation and metering. | §2 |
| Q6 | Sufficiency thresholds (≥ 4 discussions, ≥ 3 excerpts, "adequate" = high confidence and ≥ 8 excerpts) and the repair rejection thresholds: accept as starting values? | evidence contract §3.6, §7 |
| Q7 | Count rules: strict rejection (proposed) or tolerant truncation for more lists, given a free preview model? Decide after the spike. | §4.2 |
| Q8 | Review the free ERNIE provider's applicable data handling, retention, logging and training/privacy terms against authoritative evidence; no third-party discussion content may be sent before this is completed. No review or privacy verification is claimed here. | release blocker; content-bearing benchmarking and enabling |
| Q9 | Constraint names and row counts in the live database, and whether `20261109000000_ai_results_cache.sql` is applied there. | §11 |
| Q10 | One OpenRouter key shared by all engines means a shared free-tier quota. Acceptable, or a separate key/account for blueprints? | §13 |
