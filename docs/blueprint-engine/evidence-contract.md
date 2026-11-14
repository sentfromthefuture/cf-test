# Evidence and provenance contract (Phase A, Task 1C)

**Status:** design proposal.
**Companions:** [`architecture-audit.md`](./architecture-audit.md) · [`product-blueprint-v1.md`](./product-blueprint-v1.md) · [`ernie-system-prompt.md`](./ernie-system-prompt.md) · [`reliability-and-cache-design.md`](./reliability-and-cache-design.md)

This document defines how every important statement in a `ProductBlueprint` is classified, how the model refers to supplied evidence **by id only**, and how the backend checks those references before anything is stored.

Thresholds written as numbers here (for example "at least 8 excerpts") are **proposals**, anchored to existing repository rules where one exists and otherwise marked *tunable*. They are not derived from production data, because none was inspected.

---

## 1. The four classes

| Class (`Basis`) | Meaning | What it must carry | What it may never be |
|---|---|---|---|
| `verified_evidence` | A statement that the supplied evidence itself supports: what people said, how many discussions, from how many sources. | 1–4 `evidence_refs` that resolve, with at least one *supporting-grade* item (§3.3). | A recommendation, a forecast, a market claim, anything under `commercial`, anything in `risks.risks`. |
| `ai_recommendation` | Design advice from the model: scope, architecture, ordering, positioning. It follows from reasoning, not from a datum. | `rationale` (soft requirement). Refs are optional context. | A statement about what the market, users or competitors are like. |
| `hypothesis` | A claim about the world that the evidence does **not** establish but that could be tested. | `validation`: the cheapest way to test it (soft requirement). Refs optional. | Presented as fact. |
| `unknown` | The information needed is not available. The honest answer. | `missing_information`. | Hidden or replaced by a fluent guess. |

**Decision test, applied in this order** (the prompt gives the model the same test):

1. Can I point to supplied evidence ids that *say* this? → `verified_evidence`.
2. Is it advice about what to build or how? → `ai_recommendation`.
3. Is it a belief about users, market, competitors, price or demand that I cannot point to evidence for? → `hypothesis`.
4. Do I lack what I would need even to form a hypothesis? → `unknown`.

**No basis laundering.** Citing an id never upgrades a basis. A hypothesis that cites `E02` as context stays a hypothesis.

## 2. What counts as an "important claim"

- Every field typed `Claim` in the contract is an important claim. They are listed in §5.2.
- Every other string (names, descriptions, task text, column descriptions, acceptance criteria, step text) is **descriptive design content**. Its implicit class is `ai_recommendation`, and the UI must not present it as evidence. This is stated once so nobody reads a table description as a finding.
- Numbers about measured data (discussion counts, source counts, growth) are never typed by the model. The model cites an `M##` id and the backend injects the value from the evidence index.

## 3. Evidence pack and identifiers

### 3.1 Identifiers

| Id | Kind | Assigned by | Stable? |
|---|---|---|---|
| `E01`–`E24` | One discussion excerpt (one record, one independent discussion) | backend, after deterministic selection | Same pack content → same ids |
| `M01`–`M16` | One measured cluster metric | backend, **fixed catalogue** (below) | Always the same meaning for the same id |

Ids are positional labels, not database keys. The mapping to `dr_raw_records.id` lives only in the backend and in the stored `evidence_index`. The model never sees record ids, URLs or authors.

### 3.2 Metric catalogue (fixed ids)

The ids mean the same thing for every cluster, so the system prompt can describe them statically and results stay comparable. A metric whose value is unavailable is still listed, with `value: null` and class `insufficient_data`, so the model can see that it is missing.

| Id | Name | Source (verified in the repository) | Class |
|---|---|---|---|
| M01 | `unique_discussions` | `dr_clusters.unique_discussions` | measured |
| M02 | `source_count` | `dr_clusters.source_count` | measured |
| M03 | `growth_rate_pct` | `dr_clusters.growth_rate` (null = insufficient data) | derived, or insufficient_data |
| M04 | `wtp_signal_count` | `dr_clusters.wtp_signals` | measured |
| M05 | `cluster_confidence` | `dr_clusters.confidence` (`high` = ≥ 10 discussions and ≥ 2 sources; `medium` = ≥ 4 discussions or ≥ 2 sources; else `low`, per `dr_refresh_clusters`) | derived |
| M06 | `sources` | `dr_clusters.sources` | measured |
| M07 | `recent_discussions` | `dr_clusters.recent_discussions` (last 30 days) | measured |
| M08 | `prior_discussions` | `dr_clusters.prior_discussions` (the 30 days before) | measured |
| M09 | `severity_avg` | `dr_clusters.severity_avg` | **ai_estimate** |
| M10 | `competitor_mentions` | `dr_clusters.competitors` (name → count of discussions naming it) | measured |
| M11–M16 | `score_component` ×6 | `dr_clusters.scores.components.*.value`, with the component's own `basis` carried over (`measured`, `evidence_count`, `derived`, `ai_estimate`, `insufficient_data`) | per component |

The existing component `basis` vocabulary maps to `MetricClass` as: `measured`/`evidence_count` → `measured`; `derived` → `derived`; `ai_estimate` → `ai_estimate`; `insufficient_data` → `insufficient_data`.

`development_feasibility` is an AI estimate that already influences ranking (see the audit). It appears as an `ai_estimate` metric and **cannot support a `verified_evidence` claim**.

**Rounding for cache stability.** Several measures change every day without any new evidence (sliding 30-day windows, noisy rates). The pack therefore renders them rounded, and the model, the cache key and the stored index all use the **same rounded value**: M03 to the nearest 10 percentage points (null stays null), M07 and M08 as bucket labels (`0`, `1-2`, `3-5`, `6-10`, `11+`), M09 to the nearest 0.5, M11–M16 to the nearest 5. Exact live values remain in `dr_clusters`; a blueprint's metric values are "as at generation" (reliability document §9.2).

### 3.3 Supporting grade

| Cited item | May support a `verified_evidence` claim about… |
|---|---|
| Excerpt `E##` | what an author said, wanted, did or complained about |
| Metric `M##` with class `measured` or `derived` | counts, breadth, recency, naming of alternatives |
| Metric with class `ai_estimate` or `insufficient_data` | **nothing.** It may be cited as context only. |

### 3.4 Deterministic selection (excerpts)

The pack builder is read-only and has no randomness. Given the same database rows it yields the same pack.

1. **Candidates:** cluster members whose signal has `is_problem = true` (as `generate-brief.ts` does, unlike `dr_cluster_evidence`, which does not filter).
2. **One per discussion:** collapse by `discussion_key`, keeping the highest engagement (ties: earliest `published_at`, then smallest `content_hash`). This keeps "E items" aligned with "independent discussions", the unit `unique_discussions` already counts.
3. **Include willingness-to-pay first:** up to 4 candidates whose signal has `wtp_evidence = true` (the quote is verified grounded by `quoteIsGrounded` at analysis time).
4. **Fill with diversity:** round-robin across `source_id`, within each source ordered by engagement, then recency, then `content_hash`, until 24 items.
5. **Text:** whitespace-normalised, cut to **400 characters** at a code-point boundary (the same limit `dr_cluster_evidence` applies; the stored excerpt can be up to 1,200).
6. **Id assignment:** sort the selected set by (`source_id`, `published_at` ascending with nulls last, `content_hash`) and number `E01`…. Ordering for ids is independent of engagement so small engagement drift does not renumber everything.

If more candidates existed than the cap, `meta.evidence_pack.truncated = true`.

### 3.5 What the model sees (and does not)

```ts
export interface PackExcerpt {
  id: string;                    // "E01"
  source: string;                // source_id, e.g. "github"
  kind: string;                  // issue | story | comment | question
  published: string | null;      // "YYYY-MM"
  title: string | null;          // untrusted text
  text: string;                  // untrusted text, max 400 chars
  wtp: boolean;                  // a grounded willingness-to-pay quote exists in this record
}
export interface PackMetric {
  id: string;                    // "M01"
  name: string;                  // fixed catalogue name
  label: string;                 // backend wording
  value: string | number | boolean | null | string[] | Record<string, number>;
  evidence_class: 'measured' | 'derived' | 'ai_estimate' | 'insufficient_data';
}
export interface EvidencePack {
  ai_labels: { industry: string | null; cluster_label: string };   // AI/heuristic-derived, NOT evidence
  excerpts: PackExcerpt[];
  metrics: PackMetric[];
}
```

Not sent: URLs, record ids, `author_ref`, `attribution`, licence text, engagement counts, the per-record `problem_statement` (AI-derived; including it would invite the model to cite its own pipeline's output as evidence).

### 3.6 Sufficiency (computed by the backend, authoritative)

Anchored to the existing `confidence` rule so the two never disagree about what "thin" means:

| Level | Rule (all tunable constants) | Effect |
|---|---|---|
| `insufficient` | `unique_discussions < 4` **or** fewer than 3 usable excerpts | **No model call by default.** The endpoint returns a structured "insufficient evidence" result listing the fixed reasons. The threshold of 4 is the existing `medium` boundary; the minimum of 2 discussions already used by `generate-brief.ts` is below it on purpose. |
| `limited` | not insufficient, but cluster `confidence` is not `high` **or** fewer than 8 usable excerpts | Generate, with `opportunity.verdict` restricted to `validate_first` or `insufficient_evidence`. |
| `adequate` | `confidence = high` (≥ 10 discussions across ≥ 2 sources) **and** ≥ 8 usable excerpts | Any verdict is allowed. |

Reasons are fixed backend phrases (e.g. "fewer than 10 independent discussions"), never model text. The model's own `sufficiency_self_assessment` is stored, compared and ignored for decisions.

### 3.7 Evidence index

Every item shown to the model is stored in `evidence_index` (cited or not), with the resolved record id, URL, title, excerpt, content hash, licence and attribution for excerpts, and the injected value for metrics. `cited_by` lists the JSON Pointers that cite each item. This lets a reviewer see what the model was shown and what it ignored.

## 4. The reference mechanism

- A reference is a string id in `evidence_refs` (or `metric_refs` / `excerpt_refs` for demand signals).
- The model may emit **only** ids that appeared in the pack. It is told so, and the backend does not rely on that.
- URLs never appear in model output. Any `http(s)://` or `www.` string in a model-written field fails the `no_urls` check.
- Resolution happens in the backend against the pack it built for that request, **not** against the live database. The pack is part of the cache identity (reliability §9), so a stored blueprint can always be re-verified against exactly what the model saw.

## 5. Backend verification, in order

Each step names the `VerificationCheckName` it records. Steps 1–5 are structural and are specified in the reliability document; this section covers the evidence-specific steps.

### 5.1 Steps

| # | Check | What is verified | On failure |
|---|---|---|---|
| 1 | `json_parse` | One JSON object, not truncated, reasoning removed | reject |
| 2 | `schema_shape`, `required_fields`, `enums`, `size_caps` | Contract §3, §5 | reject (strings over cap are truncated and logged as a repair) |
| 3 | `identifier_integrity` | Contract §4 | reject |
| 4 | `evidence_ref_resolution` | Every ref matches `^[EM]\d{2}$` and exists in the pack; demand-signal `metric_refs` are `M`, `excerpt_refs` are `E` | drop the ref (repair); see §7 |
| 5 | `basis_rules` | Basis allowed at that path (§5.2); `verified_evidence` has 1–4 refs and a supporting-grade item; `downgraded_from` absent in model output | downgrade (repair) |
| 6 | `name_and_number_grounding` | See §5.3 | downgrade (repair) |
| 7 | `willingness_to_pay_rule` | §6 | replace with canonical (repair) |
| 8 | `commercial_rules` | Nothing under `commercial` is `verified_evidence`; market sizing is `not_estimated` with the canonical text | downgrade or replace (repair) |
| 9 | `no_executable_sql`, `no_urls` | Pattern scan of every model-written string | reject |

The order matters: a structural failure is cheaper and clearer than reasoning about a malformed object.

### 5.2 Allowed basis by path

`✓` allowed, `–` not allowed. When a disallowed basis appears the verifier replaces it with the **fallback** and records `downgraded_basis` with `downgraded_from`.

| Path | `verified_evidence` | `ai_recommendation` | `hypothesis` | `unknown` | Fallback |
|---|---|---|---|---|---|
| `/opportunity/verdict_rationale` | – | ✓ | ✓ | – | hypothesis |
| `/opportunity/problem_statement` | ✓ | – | ✓ | ✓ | hypothesis |
| `/opportunity/affected_users` | ✓ | – | ✓ | ✓ | hypothesis |
| `/opportunity/current_alternatives/*/how_it_falls_short` | ✓ only if `kind = named_in_evidence` | – | ✓ | ✓ | hypothesis |
| `/opportunity/thesis/*` | ✓ | ✓ | ✓ | – | hypothesis |
| `/opportunity/counter_thesis/*` | ✓ | ✓ | ✓ | ✓ | hypothesis |
| `/market_evidence/demand_signals/*/interpretation` | ✓ | ✓ | ✓ | – | hypothesis |
| `/market_evidence/willingness_to_pay/summary` | ✓ only if `status = evidenced` | – | – | ✓ (required unless evidenced) | unknown |
| `/personas/*/frustrations/*` | ✓ | – | ✓ | ✓ | hypothesis |
| `/personas/*/current_workaround` | ✓ | – | ✓ | ✓ | hypothesis |
| `/product/positioning`, `/product/value_proposition`, `/product/differentiation` | – | ✓ | ✓ | – | hypothesis |
| `/mvp/features/*/justification` | ✓ | ✓ | ✓ | – | ai_recommendation |
| `/commercial/business_model` | – | ✓ | ✓ | ✓ | hypothesis |
| `/commercial/pricing_hypotheses/*/statement` | – | – | ✓ | ✓ | hypothesis |
| `/commercial/market_sizing/statement` | – | – | – | ✓ | unknown |
| `/risks/risks/*/claim` | – | ✓ | ✓ | ✓ | hypothesis |

Companion text (soft in v1): `ai_recommendation` should carry `rationale`, `hypothesis` should carry `validation`, `unknown` should carry `missing_information`. A missing companion is **accepted and counted** in the `basis_rules` detail (inventing the text in the backend would itself be fabrication). This is the first rule to tighten if live runs show good compliance.

### 5.3 Grounding checks for `verified_evidence`

All three are best-effort lexical guards. They catch invention, not every misreading (§10).

1. **Names.** For `Alternative.kind = named_in_evidence`, the name must appear in the text of at least one cited excerpt, using the existing tolerant matcher (`groundedCompetitors` in `heuristics.ts`: case-insensitive substring after normalising quotes and whitespace, 2–60 characters). Otherwise the alternative is reclassified to `suggested_category` and its claim downgraded.
2. **Numbers.** Every numeral in a `verified_evidence` claim's `text` must appear in the text of a cited excerpt or in the rendered value of a cited metric. Otherwise downgrade. (Measured numbers belong in the index, not in model prose.)
3. **Relevance floor.** When the claim cites any excerpt, at least one content-word stem of the claim (words of five or more letters, not on a short stop list, compared by their first five letters so *report* matches *reports*) must occur in the cited excerpts' titles and text. This is deliberately weak, to avoid downgrading honest paraphrases. It blocks only the cheapest failure: a real id attached to an unrelated sentence.

A fourth guard limits generalisation: a `verified_evidence` claim containing *many, most, several, often, commonly, repeatedly, everyone, always, never* or *all* must cite at least two supporting-grade items, or it is downgraded. (A single excerpt supports "one maintainer says…", not "repeatedly described"; the worked example's F3 justification was reworded for exactly this reason when the guard was run against it.)

## 6. Willingness to pay and market size

These are the two areas the product brief requires to be evidence-bound.

**Willingness to pay (`market_evidence.willingness_to_pay`).**

- `status: "evidenced"` is accepted only if the summary is `verified_evidence` and cites **at least two excerpts that both carry `wtp: true`**. Because the pack holds one excerpt per discussion, "two excerpts" means two independent discussions.
- Otherwise the verifier sets `status: "not_evidenced"` and replaces the summary with a canonical `unknown` statement (`replaced_with_canonical`).
- Even when `evidenced`, the text may say only that *some authors said they would pay*. It may not state a price, a budget, a conversion rate or a share of users. Any currency or percentage figure in a `verified_evidence` claim fails the numbers guard (§5.3), because no pack item contains one.
- One quote is deliberately **not enough**: the worked example in [`product-blueprint-v1.md`](./product-blueprint-v1.md) has `M04 = 1` and `E04` flagged, and correctly reports `not_evidenced`.

**Market size (`commercial.market_sizing`).** The pack contains no market-sizing data, so in v1 the only valid state is `status: "not_estimated"` with the exact text `Not estimated — insufficient market-sizing evidence` (the wording `generate-brief.ts` already uses) and basis `unknown`. A model-written `hypothesis` here is replaced with that canonical statement. The `hypothesis` enum value is reserved so a later version can add real sizing evidence without a breaking change.

**Pricing.** Only `hypothesis` or `unknown`, always with `how_to_validate`. `price_placeholder` is a test value, never a recommendation. There is no revenue-forecast field anywhere in the contract.

## 7. Repair or reject

Rejecting costs a whole pass (up to a minute or more on a free reasoning model). Repairs are therefore **deterministic, only ever lower trust, and always recorded**.

| Situation | Action | Recorded as |
|---|---|---|
| Unknown ref id (bad format or not in pack) | drop the ref; if the claim was `verified_evidence` and has no refs left → downgrade | `dropped_ref`, `downgraded_basis` |
| Verified claim with no supporting-grade item, failing a grounding guard, or disallowed at its path | downgrade to the path's fallback, set `downgraded_from` | `downgraded_basis` |
| Disallowed non-verified basis at a path | replace with the fallback | `downgraded_basis` |
| `named_in_evidence` name not found in cited text | set `kind` to `suggested_category`, downgrade | `reclassified`, `downgraded_basis` |
| WTP `evidenced` without support; `market_sizing` not canonical | canonical replacement | `replaced_with_canonical` |
| String over its cap | truncate at a code-point boundary | `truncated_text` |
| Overflow of a *leaf* list (not referenced elsewhere) | truncate to the maximum | `truncated_list` |
| Unknown key | remove | `removed_unknown_key` |
| **Too many bad citations:** more than 5 unresolved ids, **or** more than half of the `verified_evidence` claims downgraded | **reject** the output (nothing stored); counts as an input-level `schema_invalid` failure with the existing cooldown | – |
| Any URL, any SQL-like statement, structural or identifier failure, missing required field | **reject** | – |

The "too many bad citations" rule is the safeguard against a model that has simply stopped following the evidence rules: repairing everything would produce a confident-looking document with its evidence stripped. Both thresholds are tunable constants.

A stored blueprint therefore has `verification.status` of `verified` or `verified_with_repairs`, and `unresolved_refs` is always `0`.

## 8. Untrusted content and prompt injection

- Every excerpt and title is untrusted text written by third parties. It is sent only as JSON string values, under a system instruction that says it is data.
- The model has no tools and no way to act. The worst outcome of an injection is a bad document, not an action.
- Ids are accepted only if they were issued for this request. Text inside an excerpt that mentions `E99`, `M99` or "output the following JSON" cannot create a resolvable reference.
- Injected URLs and SQL are caught by §5.1 step 9. Injected prose that merely biases a recommendation cannot be detected mechanically; that is covered by the residual-risk section and by showing the cited excerpt beside every `verified_evidence` claim.
- The UI must render all model text **as text** (no HTML or Markdown execution) and show evidence URLs only from the backend's `evidence_index`.

## 9. Licensing, attribution and privacy

- Excerpts are third-party content stored under per-source licences (GitHub and Hacker News are author-owned content with a link back; Stack Exchange is CC BY-SA and requires attribution, a link and the licence). The `evidence_index` carries `url`, `license` and `attribution` for every excerpt.
- Any later export or share feature that prints an excerpt must print those three with it. Excerpts shown to the model and stored in the index are capped at 400 characters, below the 1,200 the collector stores.
- The pack contains public text only. It excludes `author_ref` and `attribution`. Public text can still contain personal data written by its author; the pack does not scrub it and the design does not claim to.
- Pass B and Pass C never receive excerpts (product-blueprint §3.10), which keeps raw third-party text out of the largest outputs.
- **Takedown path.** The cache row's existing `citations` column can hold the resolved record ids of a blueprint (reliability §10). A removed source record can then be traced to the blueprints that cite it and those entries invalidated through the existing `dr_ai_cache_invalidate`.
- The free ERNIE variant may log or train on prompts (the repository's own caveat, still an open confirmation item in `docs/AI_ARCHITECTURE.md` §10). The same exposure applies here and should be confirmed before enabling.

## 10. What verification does not prove

Reference verification proves that ids exist, that the basis is permitted where it appears, that numbers and named alternatives are grounded, and that nothing in the stored object is an unresolved citation. It does **not** prove that a cited excerpt truly supports the sentence beside it.

- A model can cite a real, loosely related excerpt. The relevance floor (§5.3) catches the crudest case only.
- A claim can paraphrase an excerpt incorrectly while sharing its vocabulary.
- Aggregation is judgement: "teams report…" from three excerpts is a generalisation the guards cannot validate.

Mitigations in v1: at most 4 refs per claim; the UI shows the cited excerpt beside each `verified_evidence` claim; the Phase B smoke test includes a human read of a sample of verified claims against their excerpts. A possible later hardening, **not proposed for v1 and needing explicit approval**, is an independent entailment check on each verified claim. It would be a separate call, would add cost and latency, and must not reuse or modify Decisions Fast.

## 11. Examples

### 11.1 Accepted `verified_evidence` claim

```json
{ "text": "Teams report that bug reports arrive in issue trackers, email and chat and that duplicates and lost reports are common.",
  "basis": "verified_evidence", "evidence_refs": ["E01", "E02", "E03"], "confidence": "medium" }
```

Checks: three refs resolve; excerpts are supporting-grade; no numerals; shared word stems (*repor*, *email*, *chat*, *dupli*) occur in the cited text; no generalising trigger word, or at least two supporting items cited.

### 11.2 Downgraded claim

Model output:

```json
{ "text": "About 60% of small teams would pay for this.", "basis": "verified_evidence", "evidence_refs": ["E04", "E99"] }
```

Verifier result: `E99` is not in the pack (`dropped_ref`); `60%` appears in no cited item (numbers guard). Stored claim:

```json
{ "text": "About 60% of small teams would pay for this.", "basis": "hypothesis", "evidence_refs": ["E04"], "downgraded_from": "verified_evidence" }
```

```json
"repairs": [
  { "path": "/market_evidence/demand_signals/0/interpretation/evidence_refs/1", "action": "dropped_ref", "reason": "id not in evidence pack" },
  { "path": "/market_evidence/demand_signals/0/interpretation", "action": "downgraded_basis", "reason": "numeral not found in cited evidence" }
]
```

The sentence is still wrong, and now it is visibly an unverified hypothesis. (The prompt also instructs the model not to produce such sentences; the verifier is the backstop.)

### 11.3 Rejected output

An output with seven unresolved ids, or in which four of six `verified_evidence` claims fail grounding, is rejected: nothing is cached as a success, the pass records an input-level failure with the existing growing cooldown, and the failure detail contains only fixed codes (for example `reason: schema_invalid`, `field: evidence_refs`).

## 12. Summary of guarantees

1. The model cannot cite anything that was not shown to it for this request.
2. The model cannot place a URL, a record id or a measured number in the blueprint.
3. A `verified_evidence` claim always has resolvable, supporting-grade references, or it is not stored as `verified_evidence`.
4. Willingness to pay is `evidenced` only with at least two independent flagged excerpts; market size is always `not_estimated` in v1; nothing under `commercial` is ever `verified_evidence`.
5. Every automatic change is lowering, deterministic and listed in `verification.repairs`.
6. The stored object can be re-verified later against the stored pack and index.
