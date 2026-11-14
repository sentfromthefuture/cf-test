# ProductBlueprint v1 – contract (Phase A, Task 1B)

**Status:** design proposal. No code, schema or configuration exists for this contract yet.
**Companions:** [`architecture-audit.md`](./architecture-audit.md) · [`evidence-contract.md`](./evidence-contract.md) · [`ernie-system-prompt.md`](./ernie-system-prompt.md) · [`reliability-and-cache-design.md`](./reliability-and-cache-design.md)

`ProductBlueprint v1` is a **separate** JSON contract for a developer-ready product and technical blueprint generated from one measured problem cluster. It is **not** an extension of the existing `ClusterSummary` (`ai.ts`), the `Opportunity` type (`src/types.ts`) or the `generate-brief` response. None of those change.

---

## 1. Design rules

1. **Two types, two owners.** The model produces `BlueprintModelOutputV1`. The backend adds `meta`, `evidence_index` and `verification` and stores the result as `ProductBlueprintV1`. The model never writes URLs, record ids, timestamps, model names, token counts or verification results.
2. **Every important claim is a `Claim`** (`text`, `basis`, `evidence_refs`). The four bases are `verified_evidence`, `ai_recommendation`, `hypothesis`, `unknown`. Plain `string` fields are descriptive design content and are treated as **AI recommendation by default** (rule in the evidence contract §2).
3. **Evidence by reference only.** `evidence_refs` hold ids such as `E03` (a discussion excerpt) or `M02` (a measured cluster metric) taken from the pack the backend supplied. The backend resolves them to record ids, URLs, licences and attribution. Numbers for measured metrics are **filled in by the backend** from `M##` items, not typed by the model.
4. **Honest absence beats fluent invention.** Required fields allow `unknown`. The contract has **no revenue forecast field** and **no market-size number** field. Market sizing is either `not_estimated` or an explicitly labelled `hypothesis`. Willingness to pay is `evidenced` only when a cited excerpt carries a willingness-to-pay quote.
5. **Small MVP by construction.** Hard caps: at most 7 MVP features, at most 5 `must`, at least 2 explicit exclusions.
6. **Design, not SQL.** The database section describes tables, columns, types, keys, constraints, indexes and RLS in structured fields. Free-text fields must not contain executable statements (enforced by the validator, see the reliability document).
7. **Bounded.** Every list has a minimum and maximum, every string a cap (§5), so a response has a predictable size for token budgeting.
8. **Independent of the generation strategy.** The contract describes the **assembled** blueprint. It can be produced in one pass or in three sectioned passes (A, B, C, §6) without changing a single field.
9. **Build-time range is an AI estimate, not a delivery commitment.** The estimate must disclose assumed team size and developer experience, scope and complexity, dependencies and uncertainties, and an estimate-confidence level. The UI and every export must label the range as an AI-generated estimate, not a verified commitment.

## 2. Where each required area lives

| # | Required area | Contract path(s) | Owner |
|---|---|---|---|
| 1 | Metadata and generation information | `meta` | backend |
| 2 | Opportunity intelligence | `opportunity` | model |
| 3 | Market evidence and demand signals | `market_evidence` | model (numbers backend-filled) |
| 4 | Target personas | `personas` | model |
| 5 | Product specification | `product` | model |
| 6 | MVP features and exclusions | `mvp` | model |
| 7 | User journeys and workflows | `journeys`, `workflows` | model |
| 8 | Technical architecture | `architecture` | model |
| 9 | Database design | `database` | model |
| 10 | Developer implementation tasks | `implementation` | model |
| 11 | Testing and acceptance criteria | `testing` | model |
| 12 | Commercial strategy | `commercial` | model |
| 13 | Risks, assumptions and unknowns | `risks`, `market_evidence.evidence_gaps` | model |
| 14 | Evidence references | `evidence_refs` on every `Claim`, plus `evidence_index` | model (ids) / backend (index) |

## 3. TypeScript contract

All blocks in this section form **one module**. They are written to compile under `tsc --strict` and are type-checked together with the example in §7 before this document is committed.

### 3.1 Primitives and provenance

```ts
export const BLUEPRINT_SCHEMA_VERSION = 'product-blueprint.v1' as const;

// Identifier shapes. The regular expression is part of the contract; ids are assigned by the model (except E/M, which the backend assigns).
export type EvidenceId = string;    // /^[EM]\d{2}$/  E = discussion excerpt, M = measured cluster metric (supplied in the evidence pack)
export type PersonaId = string;     // /^P\d$/
export type FeatureId = string;     // /^F\d{1,2}$/
export type JourneyId = string;     // /^J\d$/
export type WorkflowId = string;    // /^W\d$/
export type ComponentId = string;   // /^C\d{1,2}$/
export type DecisionId = string;    // /^D\d{1,2}$/
export type TaskId = string;        // /^T\d{2}$/
export type PhaseId = string;       // /^PH\d$/
export type CriterionId = string;   // /^AC\d{2}$/
export type ExperimentId = string;  // /^X\d$/
export type RiskId = string;        // /^R\d{1,2}$/
export type AssumptionId = string;  // /^A\d{1,2}$/
export type UnknownId = string;     // /^U\d{1,2}$/
export type GapId = string;         // /^G\d$/
export type SignalId = string;      // /^S\d$/
export type PricingHypothesisId = string; // /^H\d$/
export type GoToMarketStepId = string;    // /^GT\d$/

export type Level3 = 'low' | 'medium' | 'high';

/** How much trust a statement has earned. Definitions and the decision test are in evidence-contract.md §1. */
export type Basis = 'verified_evidence' | 'ai_recommendation' | 'hypothesis' | 'unknown';

export interface Claim {
  /** The statement itself. Max 400 characters. */
  text: string;
  basis: Basis;
  /**
   * Ids from the supplied evidence pack.
   * verified_evidence: at least 1 and at most 4, all resolvable.
   * every other basis: normally empty; allowed to cite context, but a cited id never upgrades the basis.
   */
  evidence_refs: EvidenceId[];
  confidence?: Level3;
  /** ai_recommendation: why this is recommended (max 300). */
  rationale?: string;
  /** hypothesis: the cheapest way to test it (max 300). */
  validation?: string;
  /** unknown: what information is missing (max 300). */
  missing_information?: string;
  /** BACKEND ONLY. Present when the verifier lowered the basis; the model must not write it. */
  downgraded_from?: Basis;
}
```

### 3.2 Opportunity intelligence and market evidence

```ts
export type OpportunityVerdict = 'pursue_mvp' | 'validate_first' | 'insufficient_evidence' | 'not_recommended';

export interface Alternative {
  name: string;                                   // max 80
  /** named_in_evidence: the name must appear in a cited excerpt (checked). suggested_category: a kind of solution, never a company claim. */
  kind: 'named_in_evidence' | 'suggested_category';
  how_it_falls_short: Claim;
}

export interface OpportunityIntelligence {
  title: string;                                  // max 120
  one_line_summary: string;                       // max 200
  verdict: OpportunityVerdict;
  verdict_rationale: Claim;
  problem_statement: Claim;
  affected_users: Claim;
  current_alternatives: Alternative[];            // 0..6
  thesis: Claim[];                                // 1..3  why this could work
  counter_thesis: Claim[];                        // 1..3  why it might not
}

export type SignalStrength = 'weak' | 'moderate' | 'strong';

export interface DemandSignal {
  signal_id: SignalId;
  metric_refs: EvidenceId[];                      // M## ids; values are injected by the backend
  excerpt_refs: EvidenceId[];                     // E## ids
  interpretation: Claim;                          // what the signal suggests; must not restate metric numbers
  strength: SignalStrength;
}

export type WtpStatus = 'evidenced' | 'not_evidenced' | 'unknown';

export interface WillingnessToPay {
  status: WtpStatus;
  /** evidenced => basis verified_evidence citing at least one excerpt flagged has_wtp_quote. Otherwise basis must be unknown. */
  summary: Claim;
}

export interface EvidenceGap {
  gap_id: GapId;
  description: string;                            // max 400
  impact: string;                                 // max 300
  how_to_close: string;                           // max 300
}

export type EvidenceSufficiency = 'insufficient' | 'limited' | 'adequate';

export interface MarketEvidence {
  /** The model's own view. The authoritative value is computed by the backend and stored in meta.evidence_pack.sufficiency. */
  sufficiency_self_assessment: EvidenceSufficiency;
  demand_signals: DemandSignal[];                 // 1..6
  willingness_to_pay: WillingnessToPay;
  evidence_gaps: EvidenceGap[];                   // 1..6  (never empty: no evidence base is complete)
}
```

### 3.3 Personas, product, MVP

```ts
export interface Persona {
  persona_id: PersonaId;
  priority: 'primary' | 'secondary';
  name: string;                                   // archetype label, never a real person; max 80
  role: string;                                   // max 80
  context: string;                                // max 300
  goals: string[];                                // 1..4, each max 160
  frustrations: Claim[];                          // 1..4
  current_workaround: Claim;
  buying_role: 'decision_maker' | 'budget_holder' | 'end_user' | 'influencer' | 'unknown';
}

export type ProductType = 'web_app' | 'mobile_app' | 'api_service' | 'browser_extension' | 'integration' | 'internal_tool' | 'data_product' | 'other';

export interface Capability {
  name: string;                                   // max 80
  description: string;                            // max 300
  feature_ids: FeatureId[];                       // must exist in mvp.features
}

export interface SuccessMetric {
  name: string;                                   // max 80
  target: string;                                 // max 160, a proposed target, implicitly a hypothesis
  how_measured: string;                           // max 200
}

export interface ProductSpec {
  product_name: string;                           // a working name, max 80
  product_type: ProductType;
  positioning: Claim;
  value_proposition: Claim;
  differentiation: Claim;
  capabilities: Capability[];                     // 3..8
  non_goals: string[];                            // 2..8
  constraints: string[];                          // 0..8
  success_metrics: SuccessMetric[];               // 2..5
}

export type Complexity = 'S' | 'M' | 'L';

export interface MvpFeature {
  feature_id: FeatureId;
  name: string;                                   // max 80
  description: string;                            // max 300
  user_value: string;                             // max 200
  persona_ids: PersonaId[];                       // 1..3, must exist in personas
  priority: 'must' | 'should';
  complexity: Complexity;
  depends_on: FeatureId[];                        // acyclic
  justification: Claim;                           // why it is in the MVP; may cite evidence
}

export interface Exclusion {
  name: string;                                   // max 80
  reason: string;                                 // max 300
  revisit_when: string;                           // max 200
}

export interface ScopeAssessment {
  team_assumption: string;                        // max 200; state assumed team size and developer experience
  estimated_build_weeks: { min: number; max: number };   // 1 <= min <= max <= 26; AI-generated estimate, not a delivery commitment
  estimate_confidence: Level3;                    // confidence in the estimate, not delivery certainty
  complexity_notes: string;                       // max 400; cover scope/complexity, dependencies and uncertainties
}

export interface MvpScope {
  features: MvpFeature[];                         // 3..7, at most 5 priority 'must'
  exclusions: Exclusion[];                        // 2..8
  scope_assessment: ScopeAssessment;
}
```

### 3.4 Journeys and workflows

```ts
export type StepActor = 'user' | 'system' | 'admin' | 'external_service';

export interface JourneyStep {
  order: number;                                  // 1-based, contiguous
  actor: StepActor;
  action: string;                                 // max 200
  system_response?: string;                       // max 200
  feature_ids: FeatureId[];
}

export interface UserJourney {
  journey_id: JourneyId;
  name: string;                                   // max 80
  persona_id: PersonaId;
  goal: string;                                   // max 200
  trigger: string;                                // max 200
  steps: JourneyStep[];                           // 3..10
  success_outcome: string;                        // max 200
  failure_modes: string[];                        // 1..4, each max 160
}

export interface WorkflowState {
  name: string;                                   // snake_case, max 40
  description: string;                            // max 160
}

export interface WorkflowTransition {
  from: string;                                   // must be a state name
  to: string;                                     // must be a state name
  trigger: string;                                // max 120
  guard?: string;                                 // max 160
}

export interface Workflow {
  workflow_id: WorkflowId;
  name: string;                                   // max 80
  entity: string;                                 // the thing that moves through states, max 80
  states: WorkflowState[];                        // 3..8
  transitions: WorkflowTransition[];              // 2..16
  feature_ids: FeatureId[];
}
```

### 3.5 Technical architecture

```ts
export type ArchitectureStyle = 'monolith' | 'modular_monolith' | 'serverless' | 'client_heavy_with_baas' | 'service_oriented';
export type TechArea = 'frontend' | 'backend' | 'database' | 'auth' | 'hosting' | 'integration' | 'ai' | 'observability' | 'payments' | 'other';
export type Reversibility = 'easy' | 'moderate' | 'hard';

export interface TechAlternative {
  name: string;                                   // max 80
  why_not_chosen: string;                         // max 200
}

export interface TechChoice {
  area: TechArea;
  choice: string;                                 // max 80
  rationale: string;                              // max 300
  alternatives: TechAlternative[];                // 1..3
  trade_offs: string;                             // max 300, what is given up
  reversibility: Reversibility;
}

export interface ArchComponent {
  component_id: ComponentId;
  name: string;                                   // max 80
  responsibility: string;                         // max 200
  technology: string;                             // max 80
  feature_ids: FeatureId[];
  talks_to: ComponentId[];                        // must exist in components
}

export interface Integration {
  name: string;                                   // max 80
  purpose: string;                                // max 200
  direction: 'inbound' | 'outbound' | 'both';
  required_for_mvp: boolean;
  failure_handling: string;                       // max 200
}

export type NfrCategory = 'performance' | 'security' | 'privacy' | 'availability' | 'cost' | 'compliance' | 'scalability' | 'observability' | 'accessibility';

export interface NonFunctionalRequirement {
  category: NfrCategory;
  requirement: string;                            // max 200
  target?: string;                                // max 120, a proposed target
  approach: string;                               // max 300
}

export interface DecisionOption {
  name: string;                                   // max 80
  pros: string[];                                 // 1..3, each max 160
  cons: string[];                                 // 1..3, each max 160
}

export interface ArchitectureDecision {
  decision_id: DecisionId;
  title: string;                                  // max 120
  context: string;                                // max 300
  options: DecisionOption[];                      // 2..3
  decision: string;                               // max 200, must name one of the options
  consequences: string;                           // max 300
}

export interface TechnicalArchitecture {
  style: ArchitectureStyle;
  summary: string;                                // max 400
  components: ArchComponent[];                    // 3..10
  tech_choices: TechChoice[];                     // 4..10
  integrations: Integration[];                    // 0..6
  non_functional: NonFunctionalRequirement[];     // 3..9
  decisions: ArchitectureDecision[];              // 2..6, the explained trade-offs
  deployment_notes: string;                       // max 400
}
```

### 3.6 Database design (a proposal, not SQL)

```ts
/** Data types are chosen from a closed list so a design can be reviewed mechanically. */
export type PgType =
  | 'uuid' | 'text' | 'boolean' | 'smallint' | 'integer' | 'bigint' | 'real' | 'double precision'
  | 'date' | 'time' | 'timestamptz' | 'jsonb' | 'bytea' | 'inet'
  | `varchar(${number})` | `numeric(${number},${number})`
  | `${'uuid' | 'text' | 'integer' | 'bigint'}[]`;

export interface ColumnDesign {
  name: string;                                   // snake_case, max 40
  data_type: PgType;
  nullable: boolean;
  default?: string;                               // described, e.g. "generated uuid", "current time"; max 80
  description: string;                            // max 160
  contains_personal_data?: boolean;
}

export type ReferentialAction = 'cascade' | 'restrict' | 'set null' | 'no action';

export interface ForeignKeyDesign {
  name: string;
  columns: string[];                              // columns of this table
  references_table: string;                       // a table in this design, or the platform table 'auth.users'
  references_columns: string[];
  on_delete: ReferentialAction;
}

export interface UniqueDesign { name: string; columns: string[] }

/** A constraint described in plain language. It is not an expression and must not contain SQL. */
export interface CheckDesign { name: string; rule: string }

export type IndexMethod = 'btree' | 'gin' | 'gist' | 'hash' | 'brin';

export interface IndexDesign {
  name: string;
  columns: string[];
  method: IndexMethod;
  unique: boolean;
  partial_condition?: string;                     // described in words; max 120
  purpose: string;                                // the query or constraint it serves; max 160
}

export type RlsOperation = 'select' | 'insert' | 'update' | 'delete' | 'all';
export type RlsRole = 'anon' | 'authenticated' | 'service_role';

export interface RlsPolicyDesign {
  name: string;
  operation: RlsOperation;
  role: RlsRole;
  rule: string;                                   // plain language, e.g. "row visible when owner_id is the signed-in user"; max 200
}

export interface RlsDesign {
  enabled: boolean;
  policies: RlsPolicyDesign[];                    // 0..6
  notes?: string;                                 // max 300
}

export type ExpectedVolume = 'tiny' | 'small' | 'medium' | 'large';

export interface TableDesign {
  name: string;                                   // snake_case, max 40
  purpose: string;                                // max 200
  feature_ids: FeatureId[];
  columns: ColumnDesign[];                        // 3..16
  primary_key: string[];                          // 1..3, every entry is a column of this table
  foreign_keys: ForeignKeyDesign[];
  unique_constraints: UniqueDesign[];
  check_constraints: CheckDesign[];
  indexes: IndexDesign[];                         // 0..8
  rls: RlsDesign;
  retention?: string;                             // max 160
  expected_volume?: ExpectedVolume;
}

export type TenancyModel = 'single_tenant' | 'user_owned_rows' | 'organisation_scoped' | 'public_read_only';

export interface DatabaseDesign {
  engine: 'postgresql';
  tenancy_model: TenancyModel;
  tenancy_rationale: string;                      // max 300
  conventions: string[];                          // 0..6, naming, timestamps, soft delete, etc.
  tables: TableDesign[];                          // 3..8
  migration_considerations: string[];             // 0..6, ordering and data concerns, never statements
  open_questions: string[];                       // 0..6
}
```

### 3.7 Implementation, testing, commercial, risks

```ts
export type TaskType = 'backend' | 'frontend' | 'database' | 'infrastructure' | 'security' | 'integration' | 'testing' | 'documentation';
/** Rough size. XS about half a day, S about one day, M two to three days, L four to five days. Anything larger must be split. */
export type TaskSize = 'XS' | 'S' | 'M' | 'L';

export interface DevTask {
  task_id: TaskId;
  title: string;                                  // max 100
  description: string;                            // max 300
  type: TaskType;
  feature_ids: FeatureId[];
  depends_on: TaskId[];                           // acyclic
  size: TaskSize;
  deliverables: string[];                         // 1..4, each max 160
  criterion_ids: CriterionId[];                   // the acceptance criteria this task helps satisfy
}

export interface ImplementationPhase {
  phase_id: PhaseId;
  name: string;                                   // max 80
  goal: string;                                   // max 200
  task_ids: TaskId[];
  exit_criteria: string[];                        // 1..4, each max 160
}

export interface ImplementationPlan {
  team_assumption: string;                        // max 200
  phases: ImplementationPhase[];                  // 2..5
  tasks: DevTask[];                               // 8..30
  critical_path: TaskId[];                        // a chain of tasks present in tasks
}

export type TestLevel = 'unit' | 'integration' | 'end_to_end' | 'manual' | 'performance' | 'security';

export interface AcceptanceCriterion {
  criterion_id: CriterionId;
  feature_id: FeatureId;
  given: string;                                  // max 200
  when: string;                                   // max 200
  then: string;                                   // max 200, observable and testable
  test_level: TestLevel;
}

export type ExperimentMethod = 'customer_interview' | 'landing_page_test' | 'prototype_test' | 'concierge_manual_service' | 'survey' | 'data_analysis';

export interface ValidationExperiment {
  experiment_id: ExperimentId;
  tests: string[];                                // 1..4, ids of assumptions (A#) or unknowns (U#)
  method: ExperimentMethod;
  description: string;                            // max 300
  success_threshold: string;                      // max 160
  effort: TaskSize;
}

export interface TestingPlan {
  strategy: string;                               // max 400
  acceptance_criteria: AcceptanceCriterion[];     // 4..40, at least one per MVP feature
  quality_gates: string[];                        // 2..6, each max 160
  validation_experiments: ValidationExperiment[]; // 2..6
}

export type PricingModel = 'subscription' | 'usage_based' | 'one_time' | 'freemium' | 'marketplace_fee' | 'services_plus_software' | 'undecided';

export interface PricingHypothesis {
  hypothesis_id: PricingHypothesisId;
  model: PricingModel;
  /** basis must be hypothesis or unknown. verified_evidence is rejected anywhere under commercial. */
  statement: Claim;
  /** A placeholder to test, never a recommendation or a claim about what customers pay. max 80 */
  price_placeholder?: string;
  how_to_validate: string;                        // max 200
}

export interface MarketSizing {
  status: 'not_estimated' | 'hypothesis';
  /** not_estimated => statement.text is exactly NOT_ESTIMATED_TEXT and basis is unknown. */
  statement: Claim;
  assumptions: string[];                          // 0..5, required when status is hypothesis
}

export const NOT_ESTIMATED_TEXT = 'Not estimated — insufficient market-sizing evidence';

export interface GoToMarketStep {
  step_id: GoToMarketStepId;
  timeframe: string;                              // max 40, e.g. "weeks 1-2"
  action: string;                                 // max 200
  target_persona_ids: PersonaId[];
  expected_learning: string;                      // max 200
}

export interface CommercialStrategy {
  business_model: Claim;                          // never verified_evidence
  pricing_hypotheses: PricingHypothesis[];        // 0..3
  market_sizing: MarketSizing;
  go_to_market: GoToMarketStep[];                 // 2..6
  validation_first_actions: string[];             // 2..5, each max 160, consent-based (interviews, opt-in pilots)
  outreach_ethics: string[];                      // 1..4, each max 160
}

export type RiskCategory = 'market' | 'technical' | 'legal_compliance' | 'operational' | 'financial' | 'data_quality' | 'security_privacy' | 'dependency';

export interface Risk {
  risk_id: RiskId;
  category: RiskCategory;
  claim: Claim;                                   // basis ai_recommendation, hypothesis or unknown (never verified in the sectioned design)
  likelihood: Level3;
  impact: Level3;
  mitigation: string;                             // max 300
}

export interface Assumption {
  assumption_id: AssumptionId;
  statement: string;                              // max 300, implicitly a hypothesis
  criticality: Level3;
  how_to_validate: string;                        // max 200
}

export interface UnknownItem {
  unknown_id: UnknownId;
  question: string;                               // max 200
  why_it_matters: string;                         // max 200
  how_to_resolve: string;                         // max 200
}

export interface RisksAndUnknowns {
  risks: Risk[];                                  // 4..10
  assumptions: Assumption[];                      // 3..10
  unknowns: UnknownItem[];                        // 2..10
  evidence_limitations: string[];                 // 1..6, each max 200
}
```

### 3.8 What the model returns

```ts
export interface BlueprintModelOutputV1 {
  schema_version: typeof BLUEPRINT_SCHEMA_VERSION;
  opportunity: OpportunityIntelligence;
  market_evidence: MarketEvidence;
  personas: Persona[];                            // 1..3
  product: ProductSpec;
  mvp: MvpScope;
  journeys: UserJourney[];                        // 1..4
  workflows: Workflow[];                          // 0..2
  architecture: TechnicalArchitecture;
  database: DatabaseDesign;
  implementation: ImplementationPlan;
  testing: TestingPlan;
  commercial: CommercialStrategy;
  risks: RisksAndUnknowns;
}
```

### 3.9 What the backend adds (never written by the model)

```ts
/** Request parameters are enumerated on purpose: free text would make every request a cache miss and a live free-tier call. */
export interface BlueprintRequestParams {
  team_size: 'solo' | 'small_team' | 'larger_team';
  budget_band: 'bootstrap' | 'small' | 'funded';
  preferred_stack: 'unspecified' | 'typescript_postgres' | 'python_postgres' | 'low_code';
  business_model_hint: 'unspecified' | 'b2b_saas' | 'b2c_subscription' | 'marketplace' | 'api_usage_based';
  target_region: 'unspecified' | 'global' | 'north_america' | 'europe' | 'africa' | 'asia_pacific' | 'latin_america' | 'middle_east';
}

export type PassName = 'A' | 'B' | 'C' | 'single';

export interface PassRecord {
  pass: PassName;
  cache_id: string | null;                        // dr_ai_cache id of this pass's entry
  input_hash: string;                             // 64 hex
  served_model: string | null;                    // as reported by the provider
  provider: string | null;
  finish_reason: string | null;
  prompt_tokens: number;
  completion_tokens: number;                      // includes reasoning tokens where the provider counts them that way
  reasoning_tokens: number | null;
  reported_cost_usd: number | null;               // null = not reported (unknown, not zero)
  duration_ms: number;
  from_cache: boolean;
}

export interface EvidencePackSummary {
  excerpt_count: number;
  metric_count: number;
  pack_sha256: string;
  truncated: boolean;                             // true when more evidence existed than the caps allowed
  sufficiency: EvidenceSufficiency;               // authoritative, computed by the backend
  sufficiency_reasons: string[];                  // fixed phrases from the backend, never model text
}

export interface BlueprintMeta {
  blueprint_id: string;
  cluster_id: string;
  generated_at: string;                           // ISO 8601
  contract_version: typeof BLUEPRINT_SCHEMA_VERSION;
  prompt_version: string;                         // e.g. "blueprint-prompt-v1"
  config_version: string;                         // cache config version used for the assembled entry
  requested_model: string;                        // an explicit :free slug
  generation_mode: 'single_pass' | 'sectioned';
  passes: PassRecord[];
  request_params: BlueprintRequestParams;
  evidence_pack: EvidencePackSummary;
  disclaimers: string[];                          // fixed backend text
}

export type MetricClass = 'measured' | 'derived' | 'ai_estimate' | 'insufficient_data';
export type MetricName =
  | 'unique_discussions' | 'source_count' | 'sources' | 'recent_discussions' | 'prior_discussions'
  | 'growth_rate_pct' | 'wtp_signal_count' | 'severity_avg' | 'cluster_confidence' | 'competitor_mentions' | 'score_component';

interface EvidenceBase {
  id: EvidenceId;
  /** JSON Pointers (RFC 6901) of every place in the blueprint that cites this item. Empty when the model did not cite it. */
  cited_by: string[];
}

export interface DiscussionEvidence extends EvidenceBase {
  kind: 'discussion_excerpt';
  record_id: string;                              // dr_raw_records.id
  source_id: string;
  url: string;                                    // from the database, never from the model
  title: string | null;
  excerpt: string;                                // exactly what the model saw, max 400 chars
  content_sha256: string;
  published_at: string | null;
  license: string;
  attribution: string | null;
  analysis_method: 'llm' | 'heuristic';
  has_wtp_quote: boolean;                         // a grounded willingness-to-pay quote exists for this record
}

export interface MetricEvidence extends EvidenceBase {
  kind: 'cluster_metric';
  cluster_id: string;
  name: MetricName;
  label: string;                                  // human wording written by the backend
  value: string | number | boolean | null | string[] | Record<string, number>;
  evidence_class: MetricClass;
}

export type EvidenceIndexEntry = DiscussionEvidence | MetricEvidence;

export type VerificationCheckName =
  | 'json_parse' | 'schema_shape' | 'required_fields' | 'enums' | 'size_caps' | 'identifier_integrity'
  | 'evidence_ref_resolution' | 'basis_rules' | 'name_and_number_grounding' | 'willingness_to_pay_rule'
  | 'commercial_rules' | 'no_executable_sql' | 'no_urls';

export interface VerificationCheck { check: VerificationCheckName; passed: boolean; detail?: string }

export type RepairAction = 'downgraded_basis' | 'dropped_ref' | 'truncated_text' | 'truncated_list' | 'removed_unknown_key' | 'replaced_with_canonical' | 'reclassified';
export interface VerificationRepair { path: string; action: RepairAction; reason: string }

export interface VerificationReport {
  /** A rejected output is never stored, so only these two states exist on a stored blueprint. */
  status: 'verified' | 'verified_with_repairs';
  checks: VerificationCheck[];
  repairs: VerificationRepair[];
  claim_counts: Record<Basis, number>;
  ref_count: number;
  unresolved_refs: 0;
}

export interface ProductBlueprintV1 extends BlueprintModelOutputV1 {
  meta: BlueprintMeta;
  evidence_index: EvidenceIndexEntry[];           // every item shown to the model, cited or not
  verification: VerificationReport;
}
```

### 3.10 Pass boundaries (only relevant if the sectioned strategy is used)

```ts
export type PassAOutput = Pick<BlueprintModelOutputV1, 'schema_version' | 'opportunity' | 'market_evidence' | 'personas' | 'product' | 'mvp' | 'journeys' | 'workflows' | 'commercial'>;
export type PassBOutput = Pick<BlueprintModelOutputV1, 'architecture' | 'database'>;
export type PassCOutput = Pick<BlueprintModelOutputV1, 'implementation' | 'testing' | 'risks'>;
```

Pass A is the **only pass that receives the evidence pack**, so it is the only place a `verified_evidence` claim can originate. Pass B and Pass C receive structured outputs of earlier passes (ids, names, short descriptions), never raw excerpts. Details in the reliability document §3.

## 4. Cross-field integrity rules

These are checked by the backend (`identifier_integrity`), not trusted to the model.

1. Every id is unique within its list and matches its regular expression (§3.1).
2. Every `persona_id`, `feature_id`, `component_id`, `task_id`, `criterion_id`, `phase_id` reference resolves to an item in the same blueprint.
3. `mvp.features[*].depends_on` and `implementation.tasks[*].depends_on` are acyclic.
4. `implementation.critical_path` is a dependency chain: each element depends on the previous one.
5. Each task appears in **exactly one** phase.
6. Every MVP feature has at least one acceptance criterion, and every acceptance criterion's `feature_id` exists.
7. Every `must` feature is covered by at least one task and at least one capability.
8. Workflow transitions reference declared state names.
9. Database: every `primary_key` column exists; every foreign key's `columns` exist, its `references_table` is a table in the design or `auth.users`, and `references_columns` exist in that table; every index and unique constraint column exists; every `feature_ids` entry exists.
10. Database: `rls.enabled` is true for every table unless `tenancy_model` is `public_read_only`; in `user_owned_rows` every table carries a column named `owner_id` or `user_id` (or declares why not in `rls.notes`).
11. Database: every foreign-key column set is covered by an index, or the table's `indexes` include a purpose naming the exception.
12. `validation_experiments[*].tests` reference existing `A#` or `U#` ids.
13. `architecture.decisions[*].decision` names one of that decision's `options`.
14. `product.capabilities[*].feature_ids` and `architecture.components[*].feature_ids` exist in `mvp.features`.

## 5. Size limits and counts (summary)

| Item | Limit |
|---|---|
| Any single string | ≤ 400 characters (a few fields are tighter, noted inline in §3) |
| `Claim.text` | ≤ 400; `rationale`, `validation`, `missing_information` ≤ 300 |
| Personas / journeys / workflows | 1–3 / 1–4 / 0–2 |
| MVP features / `must` / `should` / exclusions | 3–7 / ≤ 5 / ≤ 2 / 2–8 |
| Components / tech choices / decisions / non-functional | 3–10 / 4–10 / 2–6 / 3–9 |
| Tables / columns per table / indexes per table / policies per table | 3–8 / 3–16 / ≤ 8 / ≤ 6 |
| Phases / tasks | 2–5 / 8–30 |
| Acceptance criteria / experiments | 4–40 / 2–6 |
| Risks / assumptions / unknowns / evidence gaps | 4–10 / 3–10 / 2–10 / 1–6 |
| Evidence pack (supplied to Pass A) | ≤ 24 excerpts (`E01`–`E24`) and the fixed catalogue of ≤ 16 metrics (`M01`–`M16`) |

Rationale and the token estimates derived from these caps are in the reliability document §3.

## 6. Versioning

- `schema_version` is `product-blueprint.v1` and is the first key of the model output.
- **Additive, backward-compatible changes** (a new optional field, a new enum value readers can ignore) keep `v1` and bump the prompt and config versions only.
- **Breaking changes** (a removed or retyped field, a changed meaning) require `product-blueprint.v2` and a new cache identity. A reader must refuse a `schema_version` it does not know.
- Stored blueprints are immutable. A new prompt or contract produces a **new** cache entry; old entries are bypassed, not rewritten (same rule as the existing cache).

## 7. Worked example (illustrative, fictional evidence)

The evidence below is invented to show the shape. It deliberately has **limited** evidence so the blueprint demonstrates the honest-absence behaviour: verdict `validate_first`, willingness to pay `not_evidenced`, market sizing `not_estimated`, and an `unknown` claim. The evidence index lists everything the model was shown, cited or not. Pass token counts and durations are illustrative fictional metadata only, not benchmark results.

```json
{
  "schema_version": "product-blueprint.v1",
  "meta": {
    "blueprint_id": "00000000-0000-4000-8000-000000000001",
    "cluster_id": "00000000-0000-4000-8000-0000000000c1",
    "generated_at": "2026-11-20T10:15:00Z",
    "contract_version": "product-blueprint.v1",
    "prompt_version": "blueprint-prompt-v1",
    "config_version": "bp1.p1.s1",
    "requested_model": "baidu/ernie-5.5-flash-preview:free",
    "generation_mode": "sectioned",
    "passes": [
      { "pass": "A", "cache_id": null, "input_hash": "a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1a1", "served_model": null, "provider": null, "finish_reason": "stop", "prompt_tokens": 4200, "completion_tokens": 5100, "reasoning_tokens": null, "reported_cost_usd": null, "duration_ms": 61000, "from_cache": false },
      { "pass": "B", "cache_id": null, "input_hash": "b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2", "served_model": null, "provider": null, "finish_reason": "stop", "prompt_tokens": 1900, "completion_tokens": 6200, "reasoning_tokens": null, "reported_cost_usd": null, "duration_ms": 74000, "from_cache": false },
      { "pass": "C", "cache_id": null, "input_hash": "c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3", "served_model": null, "provider": null, "finish_reason": "stop", "prompt_tokens": 3100, "completion_tokens": 4800, "reasoning_tokens": null, "reported_cost_usd": null, "duration_ms": 58000, "from_cache": false }
    ],
    "request_params": { "team_size": "solo", "budget_band": "bootstrap", "preferred_stack": "typescript_postgres", "business_model_hint": "b2b_saas", "target_region": "unspecified" },
    "evidence_pack": { "excerpt_count": 5, "metric_count": 5, "pack_sha256": "d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4", "truncated": false, "sufficiency": "limited", "sufficiency_reasons": ["fewer than 10 independent discussions", "fewer than 8 usable excerpts"] },
    "disclaimers": ["AI-generated design proposal. Items marked hypothesis or ai_recommendation are not validated facts.", "Evidence excerpts are third-party content shown with source, licence and attribution.", "AI-generated estimate — not a delivery commitment"]
  },
  "opportunity": {
    "title": "Cross-channel bug report triage for small teams",
    "one_line_summary": "Small teams lose customer bug reports that arrive through several channels and want one place to triage them.",
    "verdict": "validate_first",
    "verdict_rationale": { "text": "Several independent discussions describe the same pain, but the sample is small and shows little proof that teams would pay.", "basis": "ai_recommendation", "evidence_refs": ["M01", "M04"], "rationale": "Nine discussions and one payment quote support further validation, not a build commitment.", "confidence": "medium" },
    "problem_statement": { "text": "Teams report that bug reports arrive in issue trackers, email and chat and that duplicates and lost reports are common.", "basis": "verified_evidence", "evidence_refs": ["E01", "E02", "E03"], "confidence": "medium" },
    "affected_users": { "text": "Maintainers and support leads on teams of two to ten people who triage reports by hand.", "basis": "hypothesis", "evidence_refs": ["E01"], "validation": "Ask five maintainers how many channels they check and how they de-duplicate." },
    "current_alternatives": [
      { "name": "Spreadsheets and manual labels", "kind": "suggested_category", "how_it_falls_short": { "text": "Manual tracking is likely to drift out of date as report volume grows.", "basis": "hypothesis", "evidence_refs": [], "validation": "Observe two teams for a week." } }
    ],
    "thesis": [
      { "text": "The same triage pain is described independently on two different sources.", "basis": "verified_evidence", "evidence_refs": ["M01", "M02"] }
    ],
    "counter_thesis": [
      { "text": "Growth over time could not be computed, so it is unknown whether interest is rising.", "basis": "unknown", "evidence_refs": ["M03"], "missing_information": "Discussion counts per month for at least three months." }
    ]
  },
  "market_evidence": {
    "sufficiency_self_assessment": "limited",
    "demand_signals": [
      { "signal_id": "S1", "metric_refs": ["M01", "M02"], "excerpt_refs": ["E01", "E02"], "interpretation": { "text": "Independent discussions across more than one source suggest the problem is not confined to one community.", "basis": "ai_recommendation", "evidence_refs": ["M01", "M02"], "rationale": "Breadth across sources lowers the chance of a single-community quirk.", "confidence": "medium" }, "strength": "moderate" }
    ],
    "willingness_to_pay": { "status": "not_evidenced", "summary": { "text": "Only a single payment-related quote was found, which is not enough to say teams would pay.", "basis": "unknown", "evidence_refs": [], "missing_information": "Direct statements of budget or current spend from the target personas." } },
    "evidence_gaps": [
      { "gap_id": "G1", "description": "No evidence of how much teams spend today on triage tooling.", "impact": "Pricing cannot be anchored to anything observed.", "how_to_close": "Run five consent-based interviews and ask about current tools and budget." },
      { "gap_id": "G2", "description": "Growth rate could not be computed from the collected window.", "impact": "Unknown whether the problem is growing or shrinking.", "how_to_close": "Collect at least three months of data before relying on trend claims." }
    ]
  },
  "personas": [
    {
      "persona_id": "P1", "priority": "primary", "name": "The overloaded maintainer", "role": "Maintainer or support lead",
      "context": "Works in a team of two to ten and receives bug reports from several places.",
      "goals": ["See every report in one list", "Avoid answering the same report twice"],
      "frustrations": [{ "text": "Reports are scattered and easy to miss.", "basis": "verified_evidence", "evidence_refs": ["E01", "E04"] }],
      "current_workaround": { "text": "Copying reports into a shared spreadsheet by hand.", "basis": "hypothesis", "evidence_refs": [], "validation": "Confirm in interviews." },
      "buying_role": "unknown"
    }
  ],
  "product": {
    "product_name": "InboxTriage (working name)", "product_type": "web_app",
    "positioning": { "text": "A lightweight inbox that merges bug reports from a few channels and flags duplicates.", "basis": "ai_recommendation", "evidence_refs": [], "rationale": "Narrow scope keeps the first build small." },
    "value_proposition": { "text": "Fewer lost and duplicated reports for small teams without adopting a heavy support suite.", "basis": "hypothesis", "evidence_refs": [], "validation": "Landing-page test with two positioning variants." },
    "differentiation": { "text": "Designed for teams of two to ten and for bug reports rather than general helpdesk tickets.", "basis": "hypothesis", "evidence_refs": [], "validation": "Compare against two named alternatives in interviews." },
    "capabilities": [
      { "name": "Unified inbox", "description": "Collect reports from connected channels into one list.", "feature_ids": ["F1", "F2"] },
      { "name": "Duplicate flagging", "description": "Suggest likely duplicates for a human to confirm.", "feature_ids": ["F3"] },
      { "name": "Assignment and status", "description": "Assign a report and track its status.", "feature_ids": ["F4"] }
    ],
    "non_goals": ["Replace a full helpdesk suite", "Automatic closing of reports without a human"],
    "constraints": ["One developer, part time"],
    "success_metrics": [
      { "name": "Weekly active teams", "target": "5 pilot teams after 8 weeks", "how_measured": "Count teams that triage at least 10 reports in a week" },
      { "name": "Duplicate acceptance rate", "target": "At least 50 percent of flagged duplicates confirmed", "how_measured": "Confirm or reject actions on suggestions" }
    ]
  },
  "mvp": {
    "features": [
      { "feature_id": "F1", "name": "Email forwarding intake", "description": "A forwarding address turns each email into a report.", "user_value": "Reports from email land in the list.", "persona_ids": ["P1"], "priority": "must", "complexity": "M", "depends_on": [], "justification": { "text": "Email is one of the channels named in the discussions.", "basis": "verified_evidence", "evidence_refs": ["E02"] } },
      { "feature_id": "F2", "name": "Issue tracker import", "description": "Read-only import of issues from one tracker.", "user_value": "Existing tracker issues appear in the same list.", "persona_ids": ["P1"], "priority": "must", "complexity": "M", "depends_on": [], "justification": { "text": "A public issue tracker is a channel named in the discussions.", "basis": "verified_evidence", "evidence_refs": ["E01"] } },
      { "feature_id": "F3", "name": "Duplicate suggestions", "description": "Show similar reports and let a person merge them.", "user_value": "Fewer repeated answers.", "persona_ids": ["P1"], "priority": "must", "complexity": "L", "depends_on": ["F1", "F2"], "justification": { "text": "One maintainer says duplicate reports take up much of their morning.", "basis": "verified_evidence", "evidence_refs": ["E03"] } },
      { "feature_id": "F4", "name": "Assignment and status", "description": "Assign an owner and set a status.", "user_value": "Clear ownership of each report.", "persona_ids": ["P1"], "priority": "should", "complexity": "S", "depends_on": ["F1"], "justification": { "text": "Common triage practice; not directly evidenced in the excerpts.", "basis": "ai_recommendation", "evidence_refs": [], "rationale": "Needed for the inbox to be usable day to day." } }
    ],
    "exclusions": [
      { "name": "Chat channel integrations", "reason": "Each integration adds maintenance; validate email and tracker first.", "revisit_when": "Pilot teams ask for a specific chat tool" },
      { "name": "Automatic merging", "reason": "A wrong merge loses information; keep a human in the loop.", "revisit_when": "Duplicate acceptance rate is consistently high" }
    ],
    "scope_assessment": { "team_assumption": "One part-time developer, experienced with TypeScript and PostgreSQL", "estimated_build_weeks": { "min": 6, "max": 10 }, "estimate_confidence": "low", "complexity_notes": "Assumes the four listed MVP features; duplicate suggestions are the riskiest part. Email forwarding and tracker API access are dependencies, and provider onboarding or scope growth could change the range." }
  },
  "journeys": [
    {
      "journey_id": "J1", "name": "Triage a new report", "persona_id": "P1", "goal": "Decide what to do with a new report in under a minute", "trigger": "A new report arrives",
      "steps": [
        { "order": 1, "actor": "external_service", "action": "A report arrives by email or from the tracker", "system_response": "The report is added to the inbox", "feature_ids": ["F1", "F2"] },
        { "order": 2, "actor": "system", "action": "Look for similar existing reports", "system_response": "Show up to three likely duplicates", "feature_ids": ["F3"] },
        { "order": 3, "actor": "user", "action": "Merge a duplicate or keep the report separate", "feature_ids": ["F3"] },
        { "order": 4, "actor": "user", "action": "Assign an owner and set a status", "feature_ids": ["F4"] }
      ],
      "success_outcome": "The report has an owner and a status, with no duplicate left open",
      "failure_modes": ["Email forwarding fails silently", "A merge is applied to the wrong report"]
    }
  ],
  "workflows": [
    {
      "workflow_id": "W1", "name": "Report lifecycle", "entity": "report",
      "states": [
        { "name": "new", "description": "Received, not yet reviewed" },
        { "name": "triaged", "description": "Reviewed, owner assigned" },
        { "name": "closed", "description": "Resolved or merged" }
      ],
      "transitions": [
        { "from": "new", "to": "triaged", "trigger": "owner assigned" },
        { "from": "triaged", "to": "closed", "trigger": "resolved or merged", "guard": "a person confirmed the action" }
      ],
      "feature_ids": ["F3", "F4"]
    }
  ],
  "architecture": {
    "style": "modular_monolith",
    "summary": "One web application with a background worker for intake, kept in a single repository and deployable as one unit.",
    "components": [
      { "component_id": "C1", "name": "Web app", "responsibility": "Inbox UI and authentication", "technology": "React with TypeScript", "feature_ids": ["F3", "F4"], "talks_to": ["C2"] },
      { "component_id": "C2", "name": "API", "responsibility": "Business logic and persistence", "technology": "Node with TypeScript", "feature_ids": ["F1", "F2", "F3", "F4"], "talks_to": ["C3", "C4"] },
      { "component_id": "C3", "name": "Intake worker", "responsibility": "Process forwarded email and import issues", "technology": "Node with TypeScript", "feature_ids": ["F1", "F2"], "talks_to": ["C4"] },
      { "component_id": "C4", "name": "Database", "responsibility": "Store reports, teams and memberships", "technology": "PostgreSQL", "feature_ids": ["F1", "F2", "F3", "F4"], "talks_to": [] }
    ],
    "tech_choices": [
      { "area": "frontend", "choice": "React with TypeScript", "rationale": "Matches the preferred stack and the solo developer's skills.", "alternatives": [{ "name": "Server-rendered pages", "why_not_chosen": "A live inbox benefits from client-side updates." }], "trade_offs": "A larger client bundle in exchange for a responsive inbox.", "reversibility": "moderate" },
      { "area": "backend", "choice": "Node with TypeScript", "rationale": "One language across the stack lowers cognitive load.", "alternatives": [{ "name": "Python", "why_not_chosen": "Adds a second language for one developer." }], "trade_offs": "Less convenient for later text-similarity experiments.", "reversibility": "moderate" },
      { "area": "database", "choice": "PostgreSQL", "rationale": "Relational data with simple text search is enough for the MVP.", "alternatives": [{ "name": "Document database", "why_not_chosen": "Reports, teams and assignments are relational." }], "trade_offs": "Schema changes need migrations.", "reversibility": "hard" },
      { "area": "auth", "choice": "Managed email login", "rationale": "Avoids building password handling.", "alternatives": [{ "name": "Self-built accounts", "why_not_chosen": "More security surface for no MVP benefit." }], "trade_offs": "Depends on a third-party provider.", "reversibility": "moderate" }
    ],
    "integrations": [
      { "name": "Inbound email forwarding", "purpose": "Turn forwarded emails into reports", "direction": "inbound", "required_for_mvp": true, "failure_handling": "Keep the raw message, retry, and alert an admin after repeated failures." }
    ],
    "non_functional": [
      { "category": "privacy", "requirement": "Store only what is needed from forwarded messages", "approach": "Keep subject and body text, drop attachments, allow deletion per team." },
      { "category": "security", "requirement": "Isolate each team's data", "approach": "Row-level access rules keyed on team membership." },
      { "category": "availability", "requirement": "Intake must not lose messages", "target": "No lost reports during a single worker restart", "approach": "Persist the message before processing and process idempotently." }
    ],
    "decisions": [
      { "decision_id": "D1", "title": "Single deployable unit versus separate services", "context": "One part-time developer must ship and operate everything.", "options": [{ "name": "Modular monolith", "pros": ["Simple to deploy and debug"], "cons": ["Harder to scale parts independently"] }, { "name": "Separate services", "pros": ["Independent scaling"], "cons": ["Operational overhead for one developer"] }], "decision": "Modular monolith", "consequences": "Fast to build; revisit if intake load grows by an order of magnitude." },
      { "decision_id": "D2", "title": "Duplicate detection method", "context": "A simple, explainable method is preferred for the first version.", "options": [{ "name": "Text similarity in the database", "pros": ["No extra service"], "cons": ["Lower accuracy on short reports"] }, { "name": "Embedding service", "pros": ["Better matching"], "cons": ["Extra cost and a new dependency"] }], "decision": "Text similarity in the database", "consequences": "Accept lower accuracy and measure the duplicate acceptance rate before investing more." }
    ],
    "deployment_notes": "One web service and one worker on a managed platform with a managed PostgreSQL instance; environments for staging and production."
  },
  "database": {
    "engine": "postgresql",
    "tenancy_model": "organisation_scoped",
    "tenancy_rationale": "Reports belong to a team and every query is scoped to the caller's team memberships.",
    "conventions": ["snake_case names", "every table has created_at", "uuid primary keys"],
    "tables": [
      {
        "name": "teams", "purpose": "A group of people who share an inbox", "feature_ids": ["F1", "F4"],
        "columns": [
          { "name": "id", "data_type": "uuid", "nullable": false, "default": "generated uuid", "description": "Primary key" },
          { "name": "name", "data_type": "varchar(80)", "nullable": false, "description": "Team display name" },
          { "name": "created_at", "data_type": "timestamptz", "nullable": false, "default": "current time", "description": "Creation time" }
        ],
        "primary_key": ["id"], "foreign_keys": [], "unique_constraints": [],
        "check_constraints": [{ "name": "teams_name_not_blank", "rule": "name must not be empty after trimming spaces" }],
        "indexes": [], "rls": { "enabled": true, "policies": [{ "name": "teams_member_read", "operation": "select", "role": "authenticated", "rule": "visible when the signed-in user is a member of the team" }] },
        "expected_volume": "small"
      },
      {
        "name": "team_members", "purpose": "Which users belong to which team", "feature_ids": ["F4"],
        "columns": [
          { "name": "team_id", "data_type": "uuid", "nullable": false, "description": "The team" },
          { "name": "user_id", "data_type": "uuid", "nullable": false, "description": "The user", "contains_personal_data": true },
          { "name": "role", "data_type": "text", "nullable": false, "default": "member", "description": "owner or member" }
        ],
        "primary_key": ["team_id", "user_id"],
        "foreign_keys": [
          { "name": "team_members_team_fk", "columns": ["team_id"], "references_table": "teams", "references_columns": ["id"], "on_delete": "cascade" },
          { "name": "team_members_user_fk", "columns": ["user_id"], "references_table": "auth.users", "references_columns": ["id"], "on_delete": "cascade" }
        ],
        "unique_constraints": [],
        "check_constraints": [{ "name": "team_members_role_valid", "rule": "role is either owner or member" }],
        "indexes": [{ "name": "team_members_user_idx", "columns": ["user_id"], "method": "btree", "unique": false, "purpose": "Find a user's teams for access checks" }],
        "rls": { "enabled": true, "policies": [{ "name": "team_members_self_read", "operation": "select", "role": "authenticated", "rule": "visible when user_id is the signed-in user" }] },
        "expected_volume": "small"
      },
      {
        "name": "reports", "purpose": "A bug report collected from any channel", "feature_ids": ["F1", "F2", "F3", "F4"],
        "columns": [
          { "name": "id", "data_type": "uuid", "nullable": false, "default": "generated uuid", "description": "Primary key" },
          { "name": "team_id", "data_type": "uuid", "nullable": false, "description": "Owning team" },
          { "name": "channel", "data_type": "text", "nullable": false, "description": "email or tracker" },
          { "name": "external_ref", "data_type": "text", "nullable": true, "description": "Id of the report at the source, for idempotent import" },
          { "name": "title", "data_type": "text", "nullable": false, "description": "Subject or issue title" },
          { "name": "body", "data_type": "text", "nullable": true, "description": "Message text", "contains_personal_data": true },
          { "name": "status", "data_type": "text", "nullable": false, "default": "new", "description": "new, triaged or closed" },
          { "name": "assignee_id", "data_type": "uuid", "nullable": true, "description": "Assigned team member" },
          { "name": "duplicate_of", "data_type": "uuid", "nullable": true, "description": "The report this one was merged into" },
          { "name": "created_at", "data_type": "timestamptz", "nullable": false, "default": "current time", "description": "Receipt time" }
        ],
        "primary_key": ["id"],
        "foreign_keys": [
          { "name": "reports_team_fk", "columns": ["team_id"], "references_table": "teams", "references_columns": ["id"], "on_delete": "cascade" },
          { "name": "reports_assignee_fk", "columns": ["assignee_id"], "references_table": "auth.users", "references_columns": ["id"], "on_delete": "set null" },
          { "name": "reports_duplicate_fk", "columns": ["duplicate_of"], "references_table": "reports", "references_columns": ["id"], "on_delete": "set null" }
        ],
        "unique_constraints": [{ "name": "reports_source_unique", "columns": ["team_id", "channel", "external_ref"] }],
        "check_constraints": [
          { "name": "reports_status_valid", "rule": "status is one of new, triaged, closed" },
          { "name": "reports_not_self_duplicate", "rule": "a report cannot be a duplicate of itself" }
        ],
        "indexes": [
          { "name": "reports_team_status_idx", "columns": ["team_id", "status", "created_at"], "method": "btree", "unique": false, "purpose": "List a team's open reports newest first" },
          { "name": "reports_assignee_idx", "columns": ["assignee_id"], "method": "btree", "unique": false, "purpose": "Covers the assignee foreign key and per-person views" },
          { "name": "reports_duplicate_idx", "columns": ["duplicate_of"], "method": "btree", "unique": false, "purpose": "Covers the duplicate foreign key" },
          { "name": "reports_title_search_idx", "columns": ["title"], "method": "gin", "unique": false, "purpose": "Text similarity search for duplicate suggestions" }
        ],
        "rls": { "enabled": true, "policies": [
          { "name": "reports_team_read", "operation": "select", "role": "authenticated", "rule": "visible when the signed-in user is a member of the report's team" },
          { "name": "reports_team_update", "operation": "update", "role": "authenticated", "rule": "changeable when the signed-in user is a member of the report's team" }
        ], "notes": "Inserts come from the intake worker using the service role." },
        "retention": "Delete a team's reports on request", "expected_volume": "medium"
      }
    ],
    "migration_considerations": ["Create teams before team_members and reports", "Backfill is not needed for a new product"],
    "open_questions": ["Whether attachments are in scope after the pilot"]
  },
  "implementation": {
    "team_assumption": "One developer, about 15 hours per week",
    "phases": [
      { "phase_id": "PH1", "name": "Foundations and intake", "goal": "Reports from email and one tracker appear in a list", "task_ids": ["T01", "T02", "T03", "T04", "T05"], "exit_criteria": ["A forwarded email appears as a report", "An imported issue appears without duplication on re-import"] },
      { "phase_id": "PH2", "name": "Triage workflow", "goal": "A person can triage reports end to end", "task_ids": ["T06", "T07", "T08"], "exit_criteria": ["Duplicates can be merged", "Reports can be assigned and closed"] }
    ],
    "tasks": [
      { "task_id": "T01", "title": "Set up project, auth and environments", "description": "Repository, CI, managed login and staging.", "type": "infrastructure", "feature_ids": ["F1"], "depends_on": [], "size": "M", "deliverables": ["Running staging environment", "CI on every pull request"], "criterion_ids": ["AC01"] },
      { "task_id": "T02", "title": "Create the data model for teams and reports", "description": "Implement the proposed tables with access rules.", "type": "database", "feature_ids": ["F1", "F2", "F4"], "depends_on": ["T01"], "size": "M", "deliverables": ["Reviewed migrations", "Access rule tests"], "criterion_ids": ["AC01", "AC04"] },
      { "task_id": "T03", "title": "Email intake worker", "description": "Receive forwarded email, persist it, then process it idempotently.", "type": "backend", "feature_ids": ["F1"], "depends_on": ["T02"], "size": "L", "deliverables": ["Worker with retry", "Idempotency test"], "criterion_ids": ["AC01"] },
      { "task_id": "T04", "title": "Tracker import", "description": "Read-only import of issues with a re-import safe key.", "type": "integration", "feature_ids": ["F2"], "depends_on": ["T02"], "size": "M", "deliverables": ["Importer", "Re-import test"], "criterion_ids": ["AC02"] },
      { "task_id": "T05", "title": "Inbox list UI", "description": "List, filter by status and open a report.", "type": "frontend", "feature_ids": ["F1", "F2"], "depends_on": ["T02"], "size": "M", "deliverables": ["Inbox page"], "criterion_ids": ["AC01", "AC02"] },
      { "task_id": "T06", "title": "Duplicate suggestion query", "description": "Return up to three similar reports using text search.", "type": "backend", "feature_ids": ["F3"], "depends_on": ["T03", "T04"], "size": "M", "deliverables": ["Suggestion endpoint", "Relevance test set"], "criterion_ids": ["AC03"] },
      { "task_id": "T07", "title": "Merge and unmerge actions", "description": "Confirm a duplicate and allow undo.", "type": "frontend", "feature_ids": ["F3"], "depends_on": ["T06", "T05"], "size": "M", "deliverables": ["Merge UI", "Undo"], "criterion_ids": ["AC03"] },
      { "task_id": "T08", "title": "Assignment and status", "description": "Assign an owner and move a report through its states.", "type": "backend", "feature_ids": ["F4"], "depends_on": ["T05"], "size": "S", "deliverables": ["Assign and status endpoints"], "criterion_ids": ["AC04"] }
    ],
    "critical_path": ["T01", "T02", "T03", "T06", "T07"]
  },
  "testing": {
    "strategy": "Automated tests for access rules, idempotent intake and duplicate suggestions; manual checks for the triage flow with pilot teams.",
    "acceptance_criteria": [
      { "criterion_id": "AC01", "feature_id": "F1", "given": "A team has a forwarding address", "when": "An email is sent to it", "then": "A report with the subject as title appears in the team's inbox within one minute", "test_level": "integration" },
      { "criterion_id": "AC02", "feature_id": "F2", "given": "A tracker is connected", "when": "The import runs twice", "then": "Each issue appears exactly once", "test_level": "integration" },
      { "criterion_id": "AC03", "feature_id": "F3", "given": "Two reports describe the same problem", "when": "The newer one is opened", "then": "The older one is suggested and can be merged and unmerged", "test_level": "end_to_end" },
      { "criterion_id": "AC04", "feature_id": "F4", "given": "A user belongs to team A only", "when": "The user requests a report of team B", "then": "No data is returned", "test_level": "security" }
    ],
    "quality_gates": ["All access-rule tests pass before any pilot", "No report is lost in the restart test"],
    "validation_experiments": [
      { "experiment_id": "X1", "tests": ["A1", "U1"], "method": "customer_interview", "description": "Interview five maintainers about channels, volume, duplicates and current spend.", "success_threshold": "At least three describe a weekly duplicate problem and name a budget or current tool cost", "effort": "M" },
      { "experiment_id": "X2", "tests": ["A2"], "method": "landing_page_test", "description": "Publish a landing page and measure sign-ups for early access.", "success_threshold": "At least 30 qualified sign-ups from 500 visitors", "effort": "S" }
    ]
  },
  "commercial": {
    "business_model": { "text": "A subscription per team is a plausible starting model to test.", "basis": "hypothesis", "evidence_refs": [], "validation": "Ask interviewees which pricing structure they would expect." },
    "pricing_hypotheses": [
      { "hypothesis_id": "H1", "model": "subscription", "statement": { "text": "Teams may accept a flat monthly fee per team rather than per seat.", "basis": "hypothesis", "evidence_refs": [], "validation": "Test two framings in interviews and on the landing page." }, "price_placeholder": "to be set after interviews", "how_to_validate": "Compare reactions to per-team and per-seat framing in five interviews." }
    ],
    "market_sizing": { "status": "not_estimated", "statement": { "text": "Not estimated — insufficient market-sizing evidence", "basis": "unknown", "evidence_refs": [], "missing_information": "Counts of target teams and observed spend." }, "assumptions": [] },
    "go_to_market": [
      { "step_id": "GT1", "timeframe": "weeks 1-2", "action": "Recruit five maintainers for opt-in interviews", "target_persona_ids": ["P1"], "expected_learning": "Whether the pain and budget are real" },
      { "step_id": "GT2", "timeframe": "weeks 3-6", "action": "Run a landing-page test and a manual concierge pilot", "target_persona_ids": ["P1"], "expected_learning": "Sign-up intent and the minimum useful feature set" }
    ],
    "validation_first_actions": ["Interview before building", "Run a concierge pilot with a shared inbox and manual merging"],
    "outreach_ethics": ["Never contact authors of public discussions as sales leads", "Recruit only opt-in participants"]
  },
  "risks": {
    "risks": [
      { "risk_id": "R1", "category": "market", "claim": { "text": "Teams may already tolerate manual triage and not pay to remove it.", "basis": "hypothesis", "evidence_refs": [], "validation": "Interview question on current spend." }, "likelihood": "medium", "impact": "high", "mitigation": "Validate willingness to pay before building the full MVP." },
      { "risk_id": "R2", "category": "technical", "claim": { "text": "Text similarity may be too weak for short reports.", "basis": "ai_recommendation", "evidence_refs": [], "rationale": "Short texts share few terms." }, "likelihood": "medium", "impact": "medium", "mitigation": "Measure acceptance rate and keep a human in the loop." },
      { "risk_id": "R3", "category": "security_privacy", "claim": { "text": "Forwarded emails may contain personal data.", "basis": "ai_recommendation", "evidence_refs": [], "rationale": "Bug reports often include names and addresses." }, "likelihood": "high", "impact": "medium", "mitigation": "Minimise stored content and support deletion." },
      { "risk_id": "R4", "category": "dependency", "claim": { "text": "The email intake provider could change terms or pricing.", "basis": "ai_recommendation", "evidence_refs": [], "rationale": "Single external dependency for a core feature." }, "likelihood": "low", "impact": "medium", "mitigation": "Keep intake behind an interface so the provider can be replaced." }
    ],
    "assumptions": [
      { "assumption_id": "A1", "statement": "Small teams feel enough duplicate-report pain to change tools.", "criticality": "high", "how_to_validate": "Five interviews with a clear threshold." },
      { "assumption_id": "A2", "statement": "Teams will sign up for early access from a landing page.", "criticality": "medium", "how_to_validate": "Landing page test." },
      { "assumption_id": "A3", "statement": "Email and one tracker cover most of the reports.", "criticality": "medium", "how_to_validate": "Ask interviewees to list their channels." }
    ],
    "unknowns": [
      { "unknown_id": "U1", "question": "What do teams spend today on triage?", "why_it_matters": "Pricing cannot be anchored without it.", "how_to_resolve": "Interviews and a short survey." },
      { "unknown_id": "U2", "question": "Is the discussion volume growing?", "why_it_matters": "Timing of the opportunity.", "how_to_resolve": "Collect more months of data." }
    ],
    "evidence_limitations": ["Only two public sources were sampled.", "Excerpts are truncated and may omit context."]
  },
  "evidence_index": [
    { "id": "E01", "kind": "discussion_excerpt", "record_id": "00000000-0000-4000-8000-0000000000e1", "source_id": "github", "url": "https://example.invalid/issue/1", "title": "Reports come in from everywhere", "excerpt": "We get bug reports by email, in issues and in chat and I keep losing track of which ones are already answered.", "content_sha256": "e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1", "published_at": "2026-09-02T08:00:00Z", "license": "Example licence text", "attribution": null, "analysis_method": "llm", "has_wtp_quote": false, "cited_by": ["/opportunity/problem_statement/evidence_refs/0", "/opportunity/affected_users/evidence_refs/0", "/market_evidence/demand_signals/0/excerpt_refs/0", "/personas/0/frustrations/0/evidence_refs/0", "/mvp/features/1/justification/evidence_refs/0"] },
    { "id": "E02", "kind": "discussion_excerpt", "record_id": "00000000-0000-4000-8000-0000000000e2", "source_id": "hackernews", "url": "https://example.invalid/story/2", "title": "Ask: how do you triage support email and issues?", "excerpt": "Anyone have a lightweight way to merge support email with GitHub issues? A spreadsheet is not cutting it.", "content_sha256": "e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2", "published_at": "2026-09-20T12:00:00Z", "license": "Example licence text", "attribution": null, "analysis_method": "llm", "has_wtp_quote": false, "cited_by": ["/opportunity/problem_statement/evidence_refs/1", "/market_evidence/demand_signals/0/excerpt_refs/1", "/mvp/features/0/justification/evidence_refs/0"] },
    { "id": "E03", "kind": "discussion_excerpt", "record_id": "00000000-0000-4000-8000-0000000000e3", "source_id": "github", "url": "https://example.invalid/issue/3", "title": "Duplicate reports waste maintainer time", "excerpt": "Half my mornings go to closing duplicates of the same report that came in through different channels.", "content_sha256": "e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3", "published_at": "2026-10-05T09:30:00Z", "license": "Example licence text", "attribution": null, "analysis_method": "llm", "has_wtp_quote": false, "cited_by": ["/opportunity/problem_statement/evidence_refs/2", "/mvp/features/2/justification/evidence_refs/0"] },
    { "id": "E04", "kind": "discussion_excerpt", "record_id": "00000000-0000-4000-8000-0000000000e4", "source_id": "hackernews", "url": "https://example.invalid/story/4", "title": "Small team support tooling", "excerpt": "Our support inbox, issue tracker and chat are three separate worlds. I would pay for something simple that joins them.", "content_sha256": "e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4", "published_at": "2026-10-12T15:10:00Z", "license": "Example licence text", "attribution": null, "analysis_method": "llm", "has_wtp_quote": true, "cited_by": ["/personas/0/frustrations/0/evidence_refs/1"] },
    { "id": "E05", "kind": "discussion_excerpt", "record_id": "00000000-0000-4000-8000-0000000000e5", "source_id": "github", "url": "https://example.invalid/issue/5", "title": "Feature request: unified inbox", "excerpt": "It would be great to see issues and emails in one view with duplicate detection.", "content_sha256": "e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5", "published_at": "2026-10-28T11:45:00Z", "license": "Example licence text", "attribution": null, "analysis_method": "heuristic", "has_wtp_quote": false, "cited_by": [] },
    { "id": "M01", "kind": "cluster_metric", "cluster_id": "00000000-0000-4000-8000-0000000000c1", "name": "unique_discussions", "label": "Independent discussions in this cluster", "value": 9, "evidence_class": "measured", "cited_by": ["/opportunity/verdict_rationale/evidence_refs/0", "/opportunity/thesis/0/evidence_refs/0", "/market_evidence/demand_signals/0/metric_refs/0", "/market_evidence/demand_signals/0/interpretation/evidence_refs/0"] },
    { "id": "M02", "kind": "cluster_metric", "cluster_id": "00000000-0000-4000-8000-0000000000c1", "name": "source_count", "label": "Distinct sources", "value": 2, "evidence_class": "measured", "cited_by": ["/opportunity/thesis/0/evidence_refs/1", "/market_evidence/demand_signals/0/metric_refs/1", "/market_evidence/demand_signals/0/interpretation/evidence_refs/1"] },
    { "id": "M03", "kind": "cluster_metric", "cluster_id": "00000000-0000-4000-8000-0000000000c1", "name": "growth_rate_pct", "label": "Discussion growth, last 30 days versus the 30 before", "value": null, "evidence_class": "insufficient_data", "cited_by": ["/opportunity/counter_thesis/0/evidence_refs/0"] },
    { "id": "M04", "kind": "cluster_metric", "cluster_id": "00000000-0000-4000-8000-0000000000c1", "name": "wtp_signal_count", "label": "Records with a grounded willingness-to-pay quote", "value": 1, "evidence_class": "measured", "cited_by": ["/opportunity/verdict_rationale/evidence_refs/1"] },
    { "id": "M05", "kind": "cluster_metric", "cluster_id": "00000000-0000-4000-8000-0000000000c1", "name": "cluster_confidence", "label": "Cluster confidence rating", "value": "medium", "evidence_class": "derived", "cited_by": [] }
  ],
  "verification": {
    "status": "verified",
    "checks": [
      { "check": "json_parse", "passed": true },
      { "check": "schema_shape", "passed": true },
      { "check": "required_fields", "passed": true },
      { "check": "enums", "passed": true },
      { "check": "size_caps", "passed": true },
      { "check": "identifier_integrity", "passed": true },
      { "check": "evidence_ref_resolution", "passed": true },
      { "check": "basis_rules", "passed": true },
      { "check": "name_and_number_grounding", "passed": true },
      { "check": "willingness_to_pay_rule", "passed": true },
      { "check": "commercial_rules", "passed": true },
      { "check": "no_executable_sql", "passed": true },
      { "check": "no_urls", "passed": true }
    ],
    "repairs": [],
    "claim_counts": { "verified_evidence": 6, "ai_recommendation": 7, "hypothesis": 8, "unknown": 3 },
    "ref_count": 20,
    "unresolved_refs": 0
  }
}
```

Reading the example:

- E04 contains a payment-related statement and `has_wtp_quote: true`, yet `willingness_to_pay.status` is `not_evidenced`. A single quote from one author is not treated as evidence that the persona pays. The rule in the evidence contract allows `evidenced` only with the backend's threshold met (§6 there), and otherwise the model is told to report `unknown`.
- `claim_counts` (24 claims) and `ref_count` (20 references, counting `metric_refs` and `excerpt_refs` of demand signals) were computed by a reference validator run against this example. The real backend recomputes both from the stored object; they are never taken from the model.
- `meta.passes` shows `"sectioned"`. In single-pass mode `passes` has one element with `pass: "single"`.

## 8. Reading guide for later phases

- The **validator** is written from §3 and §4 and tested against §7 as a golden fixture.
- The **system prompt** (see [`ernie-system-prompt.md`](./ernie-system-prompt.md)) carries a compact skeleton of §3.8 with every enum, count and cap. A unit test must assert the prompt's enums equal the code's enums, so the two can never drift.
- The **UI and every export** (a later phase, not designed here) render `basis` for every `Claim`, show cited excerpts next to `verified_evidence` claims, and label `estimated_build_weeks` with the exact text **AI-generated estimate — not a delivery commitment**. Never present that range as a verified delivery commitment.
