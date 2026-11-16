# ProductBlueprint v1: contract and validator (Phase A2)

TypeScript contract and strict, deterministic runtime validation for the ERNIE Product Blueprint engine. Source of truth:
`docs/blueprint-engine/` (mainly `product-blueprint-v1.md`, plus `evidence-contract.md` and `reliability-and-cache-design.md`).

This module contains **no** provider calls, prompts, evidence collection, database access, migrations, cache or usage code, endpoints or UI.
It is pure functions over plain data and runs unchanged in Node and Deno.

## Files

| File | Role |
|---|---|
| `constants.ts` | Single source of truth: enums, id patterns, counts, caps, and the named **safeguards** (see below) |
| `contract.ts` | `BlueprintModelOutputV1` (model-owned) and `ProductBlueprintV1` (assembled, backend-owned), kept distinct |
| `validate.ts` | Public API: `validateBlueprintModelOutput()` and `validateProductBlueprint()` |
| `validate-core.ts` | Error type, defensive input snapshot, field readers |
| `validate-model.ts` | Shape of the model-owned document (types, enums, bounds, nested structures) |
| `validate-integrity.ts` | Identifier uniqueness, references, cycles, database-design integrity |
| `validate-evidence.ts` | Claim and reference enumeration, basis-by-path rules, willingness-to-pay and market-sizing rules |
| `validate-backend.ts` | `meta`, `evidence_index`, `verification` and their consistency with the model-owned document |
| `content-policy.ts` | Lexical URL / SQL-like / executable-content detection |
| `__tests__/` | `npm run test:blueprint` (`bun run test:blueprint`); synthetic fixtures only |

## Policy

* **Rejection only.** An invalid input is rejected as a whole. Nothing is repaired, coerced, defaulted, truncated, downgraded or silently
  stripped, and no unexpected field is removed. `value` is returned only when `ok` is `true`.
* **Tiers, first failing tier decides:** shape (T1-T4) -> identifiers and references (T5) -> evidence and basis rules (T6) -> content policy (T7).
  Every error of the deciding tier is reported (capped at 100; `truncated` says so).
* **Content-free errors.** An error is `{ code, path, message }`: a fixed code, a JSON Pointer built from schema keys and array indexes, and a
  fixed message. No error contains text from the input: not a value, not a key name, not an identifier. An unexpected key is reported at its
  parent object with a count only.
* **Never throws.** The input is first copied once into plain JSON (cycles, depth, width and non-JSON values handled); anything else
  unexpected becomes `validator_internal_error`. The input object is never modified.
* **No retries, regeneration or provider fallback.** Not part of this phase.

## What "evidence validation" means here

It is **structural**. It checks id formats and ranges (`E01-E24`, `M01-M16`), that a list takes the right kind of id, the basis each path allows
(evidence contract section 5.2), reference counts, and, for an assembled blueprint, that every cited id exists in `evidence_index`, that
`cited_by`, `claim_counts` and `ref_count` match a recomputation, and that a `verified_evidence` claim cites a supporting-grade item.
It does **not** prove that a cited excerpt says what a claim says, that a name or number appears in the evidence, or that any evidence exists.
Grounding guards (evidence contract section 5.3) need the evidence pack and are a later phase. The validator never invents evidence records,
URLs or citations. Pass `knownEvidenceIds` to `validateBlueprintModelOutput` to check ids against what the model was actually shown.

## Database design stays descriptive

Column types come from a closed list; defaults, check rules, partial-index conditions and RLS rules are plain-language fields. Every model-written
string, including all of those, is scanned. Defaults, check rules, partial conditions and policy rules are additionally rejected if they look like
an expression (operators, casts, function calls, comments).

**Lexical detection is not a complete security guarantee.** It matches statement-shaped text in a normalised copy of the string (full-width letters
folded, invisible characters removed, whitespace collapsed). It misses paraphrase, splitting, encoding and anything it has no pattern for, and it can
reject innocent prose that looks like a statement. `__tests__/content-policy.test.ts` pins both the false-positive guards and the known misses.
Nothing in a blueprint may ever be executed as SQL; the structural design (closed enums, prose fields) is the actual protection.

## Safeguards (documented silence, conservative choice)

All live in `SAFEGUARDS` in `constants.ts`. Where a document gives a limit, the document wins.

* SG1 strings must not be blank. SG2 no NUL/control characters (tab, LF, CR allowed) and no lone surrogates.
* SG3 constraint, index and policy names: `^[a-z_][a-z0-9_]*$`, at most 63 characters.
* SG4 list sizes the documents leave open: FK / unique / index column lists 1-8, foreign keys 0-16, unique constraints 0-8, check constraints 0-16,
  feature-id lists 0-7, persona-id lists 0-3, `talks_to` 0-9, task `depends_on` 0-29, feature `depends_on` 0-6, `critical_path` 1-30,
  phase `task_ids` 1-30, demand-signal `metric_refs` / `excerpt_refs` 0-8 each. A repeated entry inside any id list is rejected.
* SG5 backend-owned text caps (200 / 400 / 1000 characters, URL 2048), metric value lists at most 64 entries, `cited_by` at most 100, repairs at most 500.
* SG6 `varchar(n)` 1..10485760, `numeric(p,s)` p 1..1000 and s <= p (PostgreSQL's own limits).
* SG7 whole-input bounds: depth 16, 50,000 nodes, 262,144 bytes (the documented stored-result cap), 100 reported errors.
* SG8 counters and durations are non-negative whole numbers.
* Strings are measured in Unicode code points.

## Interpretations (each is a one-line change in the named place)

1. `should` is capped at 2 (section 5 table, prompt rule A8) although the section 3.3 type comment is silent. Together with at most 7 features and
   at most 5 `must`, this means at least `features - 2` must be `must`.
2. Willingness to pay "evidenced": section 3.2 says one flagged excerpt, evidence contract section 6 and prompt rule A4 say two. Two is enforced
   (`WTP_MIN_EXCERPTS`). Model level: two distinct `E##` refs and basis `verified_evidence`. Assembled level: two cited excerpts with `has_wtp_quote`.
3. Market sizing: the type allows `status: "hypothesis"`, but evidence contract section 6 makes `not_estimated` the only valid v1 state, so
   `hypothesis` is rejected and the statement must equal `NOT_ESTIMATED_TEXT`.
4. Foreign-key index coverage is judged on the **referencing** table. A primary key, unique constraint or btree index (hash for a single-column key)
   counts only when the foreign-key columns are its **leading** columns, in any order. A partial index never counts. The documented "exception" (an
   index `purpose` naming the exception) is implemented as: an index purpose on that table that contains the foreign-key constraint name.
5. A journey's step numbers must be exactly 1..n without repeats; array order is not constrained.
6. A decision "names one of the options" when its text contains an option name (case-sensitive).
7. `generation_mode` and `meta.passes` must agree: `single_pass` has one record named `single`; `sectioned` has `A`, `B`, `C` once each.
8. `estimated_build_weeks` may be fractional (the documents say `number`).
9. `schema_version` being "the first key" is not enforced: key order in JSON is not semantic.
10. **Verification record (Phase A2 policy).** The documented type allows `status: "verified_with_repairs"` and a non-empty `repairs`. Phase A2 is
    rejection-only, so the validator accepts only `status: "verified"` with `repairs: []`. This narrows the documented type on purpose; it is a policy,
    not a documented rule. For the same reason `downgraded_from` is rejected too; see item 14.
11. **Required checks.** Evidence contract section 5.1 says each step "names the `VerificationCheckName` it records", and the nine steps record all 13
    names with no condition. A stored blueprint must therefore carry each of the 13 exactly once with `passed: true`. The validator checks the stored
    record only: it does not run checks, adds none, and cannot confirm that the backend ran them (grounding needs the evidence pack).
12. **Disclaimers.** `meta.disclaimers` is "fixed backend text". Every entry must equal one of the three strings in `FIXED_DISCLAIMERS` (the wording in the
    section 7 example), without repeats, and the section 8 estimate label (`ESTIMATE_DISCLAIMER`) must be present. The other two strings are fixed by the
    example only; the documents do not say they are mandatory, so they are optional.
13. **Metric cluster.** Every `cluster_metric` must have `cluster_id` equal to `meta.cluster_id`. The documents do not state this equality literally; it
    follows from the documented design (a blueprint is requested for one `cluster_id` and M01-M16 are that cluster's `dr_clusters` values).
14. **`downgraded_from` (Phase A2 policy, narrower than the documented contract).**
    * *Literal contract:* `product-blueprint-v1.md` section 3.1 types `downgraded_from?: Basis` on a `Claim` as optional, "BACKEND ONLY. Present when the
      verifier lowered the basis; the model must not write it." Evidence contract sections 5.2 and 7 record every downgrade as a `downgraded_basis`
      repair, and its stored-claim example shows the field next to that repair. So the documents allow the field on a stored claim, always together with a repair.
    * *Phase A2 policy:* the phase is rejection-only, nothing is downgraded or repaired, and the validator requires `verification.status === "verified"` with
      `verification.repairs` empty. A claim carrying `downgraded_from` would contradict that record, so `validateProductBlueprint` rejects the field on any
      claim, whatever its value, with `downgraded_from_not_allowed` at `<claim>/downgraded_from`. Nothing is stripped or repaired.
    * *Unchanged:* `validateBlueprintModelOutput` still rejects it with `downgraded_from_forbidden`, and `contract.ts` keeps the documented optional field. A later
      phase that implements repairs would relax this rule together with items 10 and 11.

## Checks that go beyond the literal wording of the documents

These were added as integrity safeguards; each is a one-line change if a reviewer disagrees:
foreign-key `references_columns` must have as many entries as `columns` (rule 9 only says they "exist in that table"); index names are unique across the
design and constraint and policy names are unique within a table; foreign-key coverage ignores partial indexes and counts only btree (or single-column hash)
indexes; a repeated entry in any id list is rejected.

## Documented but not enforced here

Grounding guards (names, numbers, generalising words), any rule for `insufficient` sufficiency (the documents define none), and the following database
rules, which the approved documents do **not** state and which were therefore not invented:
* a foreign key's `references_columns` must be a primary key or a unique key of the referenced table (rule 9 requires only that the columns exist);
* `on_delete: "set null"` requires the foreign-key columns to be nullable (no document says so; the worked example happens to satisfy it).

Both are real PostgreSQL requirements and good candidates for a documentation amendment. Two tests marked `KNOWN GAP` pin the current behaviour so a future
decision is deliberate. Type compatibility between foreign-key and referenced columns is likewise not enforced.

## Worked example

`product-blueprint-v1.md` section 7 is accepted unmodified by both validators; its stated counts (24 claims, 6/7/8/3 by basis, 20 references) match an
independent recomputation. `__tests__/worked-example.test.ts` fails if the example or any enumeration in the document drifts from `constants.ts`.
