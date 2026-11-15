// ProductBlueprint v1 - TypeScript contract (docs/blueprint-engine/product-blueprint-v1.md, section 3).
//
// Two types, two owners (section 1, rule 1):
//  - BlueprintModelOutputV1  what the model returns. The model never writes URLs, record ids, timestamps, model names, token counts or verification results.
//  - ProductBlueprintV1      the assembled, backend-owned result: the model output plus `meta`, `evidence_index` and `verification`.
//
// Enumerations are derived from constants.ts so the types and the validator share one definition. Every field, optional marker and nested
// structure below mirrors the document; caps and counts are enforced by the validator, not by these types.
import {
  ALTERNATIVE_KIND, ANALYSIS_METHOD, ARCHITECTURE_STYLE, BASIS, BLUEPRINT_SCHEMA_VERSION, BUDGET_BAND, BUSINESS_MODEL_HINT, BUYING_ROLE, COMPLEXITY, DB_ENGINE,
  EVIDENCE_SUFFICIENCY, EXPECTED_VOLUME, EXPERIMENT_METHOD, FEATURE_PRIORITY, GENERATION_MODE, INDEX_METHOD, INTEGRATION_DIRECTION, LEVEL3, MARKET_SIZING_STATUS,
  METRIC_CLASS, METRIC_NAME, NFR_CATEGORY, OPPORTUNITY_VERDICT, PASS_NAME, PERSONA_PRIORITY, PREFERRED_STACK, PRICING_MODEL, PRODUCT_TYPE, REFERENTIAL_ACTION,
  REPAIR_ACTION, REVERSIBILITY, RISK_CATEGORY, RLS_OPERATION, RLS_ROLE, SIGNAL_STRENGTH, STEP_ACTOR, TARGET_REGION, TASK_SIZE, TASK_TYPE, TEAM_SIZE, TECH_AREA,
  TENANCY_MODEL, TEST_LEVEL, VERIFICATION_CHECK_NAME, VERIFICATION_STATUS, WTP_STATUS,
} from './constants.ts';

export { BLUEPRINT_SCHEMA_VERSION, NOT_ESTIMATED_TEXT } from './constants.ts';

type Member<T extends readonly string[]> = T[number];

// ---------------------------------------------------------------------------------------------------------------------------------
// 3.1 Primitives and provenance
// ---------------------------------------------------------------------------------------------------------------------------------

export type EvidenceId = string;    // /^[EM]\d{2}$/  E = discussion excerpt, M = measured cluster metric
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

export type Level3 = Member<typeof LEVEL3>;
export type Basis = Member<typeof BASIS>;

export interface Claim {
  /** The statement itself. Max 400 characters. */
  text: string;
  basis: Basis;
  /** verified_evidence: 1..4 ids. Every other basis: 0..4; a cited id never upgrades the basis. */
  evidence_refs: EvidenceId[];
  confidence?: Level3;
  /** ai_recommendation: why this is recommended (max 300). */
  rationale?: string;
  /** hypothesis: the cheapest way to test it (max 300). */
  validation?: string;
  /** unknown: what information is missing (max 300). */
  missing_information?: string;
  /** BACKEND ONLY. Present when a verifier lowered the basis; rejected in model output. */
  downgraded_from?: Basis;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 3.2 Opportunity intelligence and market evidence
// ---------------------------------------------------------------------------------------------------------------------------------

export type OpportunityVerdict = Member<typeof OPPORTUNITY_VERDICT>;

export interface Alternative {
  name: string;                                   // max 80
  kind: Member<typeof ALTERNATIVE_KIND>;
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
  thesis: Claim[];                                // 1..3
  counter_thesis: Claim[];                        // 1..3
}

export type SignalStrength = Member<typeof SIGNAL_STRENGTH>;

export interface DemandSignal {
  signal_id: SignalId;
  metric_refs: EvidenceId[];                      // M## ids
  excerpt_refs: EvidenceId[];                     // E## ids
  interpretation: Claim;
  strength: SignalStrength;
}

export type WtpStatus = Member<typeof WTP_STATUS>;

export interface WillingnessToPay {
  status: WtpStatus;
  summary: Claim;
}

export interface EvidenceGap {
  gap_id: GapId;
  description: string;                            // max 400
  impact: string;                                 // max 300
  how_to_close: string;                           // max 300
}

export type EvidenceSufficiency = Member<typeof EVIDENCE_SUFFICIENCY>;

export interface MarketEvidence {
  sufficiency_self_assessment: EvidenceSufficiency;
  demand_signals: DemandSignal[];                 // 1..6
  willingness_to_pay: WillingnessToPay;
  evidence_gaps: EvidenceGap[];                   // 1..6
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 3.3 Personas, product, MVP
// ---------------------------------------------------------------------------------------------------------------------------------

export interface Persona {
  persona_id: PersonaId;
  priority: Member<typeof PERSONA_PRIORITY>;
  name: string;                                   // max 80
  role: string;                                   // max 80
  context: string;                                // max 300
  goals: string[];                                // 1..4, each max 160
  frustrations: Claim[];                          // 1..4
  current_workaround: Claim;
  buying_role: Member<typeof BUYING_ROLE>;
}

export type ProductType = Member<typeof PRODUCT_TYPE>;

export interface Capability {
  name: string;                                   // max 80
  description: string;                            // max 300
  feature_ids: FeatureId[];
}

export interface SuccessMetric {
  name: string;                                   // max 80
  target: string;                                 // max 160
  how_measured: string;                           // max 200
}

export interface ProductSpec {
  product_name: string;                           // max 80
  product_type: ProductType;
  positioning: Claim;
  value_proposition: Claim;
  differentiation: Claim;
  capabilities: Capability[];                     // 3..8
  non_goals: string[];                            // 2..8
  constraints: string[];                          // 0..8
  success_metrics: SuccessMetric[];               // 2..5
}

export type Complexity = Member<typeof COMPLEXITY>;

export interface MvpFeature {
  feature_id: FeatureId;
  name: string;                                   // max 80
  description: string;                            // max 300
  user_value: string;                             // max 200
  persona_ids: PersonaId[];                       // 1..3
  priority: Member<typeof FEATURE_PRIORITY>;
  complexity: Complexity;
  depends_on: FeatureId[];                        // acyclic
  justification: Claim;
}

export interface Exclusion {
  name: string;                                   // max 80
  reason: string;                                 // max 300
  revisit_when: string;                           // max 200
}

export interface ScopeAssessment {
  team_assumption: string;                        // max 200
  /** 1 <= min <= max <= 26. AI-generated estimate, not a delivery commitment. */
  estimated_build_weeks: { min: number; max: number };
  estimate_confidence: Level3;
  complexity_notes: string;                       // max 400
}

export interface MvpScope {
  features: MvpFeature[];                         // 3..7, at most 5 must, at most 2 should
  exclusions: Exclusion[];                        // 2..8
  scope_assessment: ScopeAssessment;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 3.4 Journeys and workflows
// ---------------------------------------------------------------------------------------------------------------------------------

export type StepActor = Member<typeof STEP_ACTOR>;

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
  from: string;                                   // a state name
  to: string;                                     // a state name
  trigger: string;                                // max 120
  guard?: string;                                 // max 160
}

export interface Workflow {
  workflow_id: WorkflowId;
  name: string;                                   // max 80
  entity: string;                                 // max 80
  states: WorkflowState[];                        // 3..8
  transitions: WorkflowTransition[];              // 2..16
  feature_ids: FeatureId[];
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 3.5 Technical architecture
// ---------------------------------------------------------------------------------------------------------------------------------

export type ArchitectureStyle = Member<typeof ARCHITECTURE_STYLE>;
export type TechArea = Member<typeof TECH_AREA>;
export type Reversibility = Member<typeof REVERSIBILITY>;

export interface TechAlternative {
  name: string;                                   // max 80
  why_not_chosen: string;                         // max 200
}

export interface TechChoice {
  area: TechArea;
  choice: string;                                 // max 80
  rationale: string;                              // max 300
  alternatives: TechAlternative[];                // 1..3
  trade_offs: string;                             // max 300
  reversibility: Reversibility;
}

export interface ArchComponent {
  component_id: ComponentId;
  name: string;                                   // max 80
  responsibility: string;                         // max 200
  technology: string;                             // max 80
  feature_ids: FeatureId[];
  talks_to: ComponentId[];
}

export interface Integration {
  name: string;                                   // max 80
  purpose: string;                                // max 200
  direction: Member<typeof INTEGRATION_DIRECTION>;
  required_for_mvp: boolean;
  failure_handling: string;                       // max 200
}

export type NfrCategory = Member<typeof NFR_CATEGORY>;

export interface NonFunctionalRequirement {
  category: NfrCategory;
  requirement: string;                            // max 200
  target?: string;                                // max 120
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
  decisions: ArchitectureDecision[];              // 2..6
  deployment_notes: string;                       // max 400
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 3.6 Database design (a proposal, not SQL)
// ---------------------------------------------------------------------------------------------------------------------------------

export type PgType =
  | 'uuid' | 'text' | 'boolean' | 'smallint' | 'integer' | 'bigint' | 'real' | 'double precision'
  | 'date' | 'time' | 'timestamptz' | 'jsonb' | 'bytea' | 'inet'
  | `varchar(${number})` | `numeric(${number},${number})`
  | `${'uuid' | 'text' | 'integer' | 'bigint'}[]`;

export interface ColumnDesign {
  name: string;                                   // snake_case, max 40
  data_type: PgType;
  nullable: boolean;
  default?: string;                               // described, never an expression; max 80
  description: string;                            // max 160
  contains_personal_data?: boolean;
}

export type ReferentialAction = Member<typeof REFERENTIAL_ACTION>;

export interface ForeignKeyDesign {
  name: string;
  columns: string[];
  references_table: string;                       // a table in this design, or 'auth.users'
  references_columns: string[];
  on_delete: ReferentialAction;
}

export interface UniqueDesign { name: string; columns: string[] }

/** A constraint described in plain language. It is not an expression and must not contain SQL. */
export interface CheckDesign { name: string; rule: string }

export type IndexMethod = Member<typeof INDEX_METHOD>;

export interface IndexDesign {
  name: string;
  columns: string[];
  method: IndexMethod;
  unique: boolean;
  partial_condition?: string;                     // described in words; max 120
  purpose: string;                                // max 160
}

export type RlsOperation = Member<typeof RLS_OPERATION>;
export type RlsRole = Member<typeof RLS_ROLE>;

export interface RlsPolicyDesign {
  name: string;
  operation: RlsOperation;
  role: RlsRole;
  rule: string;                                   // plain language; max 200
}

export interface RlsDesign {
  enabled: boolean;
  policies: RlsPolicyDesign[];                    // 0..6
  notes?: string;                                 // max 300
}

export type ExpectedVolume = Member<typeof EXPECTED_VOLUME>;

export interface TableDesign {
  name: string;                                   // snake_case, max 40
  purpose: string;                                // max 200
  feature_ids: FeatureId[];
  columns: ColumnDesign[];                        // 3..16
  primary_key: string[];                          // 1..3
  foreign_keys: ForeignKeyDesign[];
  unique_constraints: UniqueDesign[];
  check_constraints: CheckDesign[];
  indexes: IndexDesign[];                         // 0..8
  rls: RlsDesign;
  retention?: string;                             // max 160
  expected_volume?: ExpectedVolume;
}

export type TenancyModel = Member<typeof TENANCY_MODEL>;

export interface DatabaseDesign {
  engine: Member<typeof DB_ENGINE>;
  tenancy_model: TenancyModel;
  tenancy_rationale: string;                      // max 300
  conventions: string[];                          // 0..6
  tables: TableDesign[];                          // 3..8
  migration_considerations: string[];             // 0..6, never statements
  open_questions: string[];                       // 0..6
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 3.7 Implementation, testing, commercial, risks
// ---------------------------------------------------------------------------------------------------------------------------------

export type TaskType = Member<typeof TASK_TYPE>;
export type TaskSize = Member<typeof TASK_SIZE>;

export interface DevTask {
  task_id: TaskId;
  title: string;                                  // max 100
  description: string;                            // max 300
  type: TaskType;
  feature_ids: FeatureId[];
  depends_on: TaskId[];                           // acyclic
  size: TaskSize;
  deliverables: string[];                         // 1..4, each max 160
  criterion_ids: CriterionId[];
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
  critical_path: TaskId[];
}

export type TestLevel = Member<typeof TEST_LEVEL>;

export interface AcceptanceCriterion {
  criterion_id: CriterionId;
  feature_id: FeatureId;
  given: string;                                  // max 200
  when: string;                                   // max 200
  then: string;                                   // max 200
  test_level: TestLevel;
}

export type ExperimentMethod = Member<typeof EXPERIMENT_METHOD>;

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
  acceptance_criteria: AcceptanceCriterion[];     // 4..40
  quality_gates: string[];                        // 2..6, each max 160
  validation_experiments: ValidationExperiment[]; // 2..6
}

export type PricingModel = Member<typeof PRICING_MODEL>;

export interface PricingHypothesis {
  hypothesis_id: PricingHypothesisId;
  model: PricingModel;
  /** basis must be hypothesis or unknown. */
  statement: Claim;
  price_placeholder?: string;                     // max 80
  how_to_validate: string;                        // max 200
}

export interface MarketSizing {
  status: Member<typeof MARKET_SIZING_STATUS>;
  statement: Claim;
  assumptions: string[];                          // 0..5
}

export interface GoToMarketStep {
  step_id: GoToMarketStepId;
  timeframe: string;                              // max 40
  action: string;                                 // max 200
  target_persona_ids: PersonaId[];
  expected_learning: string;                      // max 200
}

export interface CommercialStrategy {
  business_model: Claim;
  pricing_hypotheses: PricingHypothesis[];        // 0..3
  market_sizing: MarketSizing;
  go_to_market: GoToMarketStep[];                 // 2..6
  validation_first_actions: string[];             // 2..5, each max 160
  outreach_ethics: string[];                      // 1..4, each max 160
}

export type RiskCategory = Member<typeof RISK_CATEGORY>;

export interface Risk {
  risk_id: RiskId;
  category: RiskCategory;
  claim: Claim;
  likelihood: Level3;
  impact: Level3;
  mitigation: string;                             // max 300
}

export interface Assumption {
  assumption_id: AssumptionId;
  statement: string;                              // max 300
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

// ---------------------------------------------------------------------------------------------------------------------------------
// 3.8 What the model returns
// ---------------------------------------------------------------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------------------------------------------------------------
// 3.9 What the backend adds (never written by the model)
// ---------------------------------------------------------------------------------------------------------------------------------

export interface BlueprintRequestParams {
  team_size: Member<typeof TEAM_SIZE>;
  budget_band: Member<typeof BUDGET_BAND>;
  preferred_stack: Member<typeof PREFERRED_STACK>;
  business_model_hint: Member<typeof BUSINESS_MODEL_HINT>;
  target_region: Member<typeof TARGET_REGION>;
}

export type PassName = Member<typeof PASS_NAME>;

export interface PassRecord {
  pass: PassName;
  cache_id: string | null;
  input_hash: string;                             // 64 hex
  served_model: string | null;
  provider: string | null;
  finish_reason: string | null;
  prompt_tokens: number;
  completion_tokens: number;
  reasoning_tokens: number | null;
  reported_cost_usd: number | null;               // null = not reported (unknown, not zero)
  duration_ms: number;
  from_cache: boolean;
}

export interface EvidencePackSummary {
  excerpt_count: number;
  metric_count: number;
  pack_sha256: string;
  truncated: boolean;
  sufficiency: EvidenceSufficiency;               // authoritative, computed by the backend
  sufficiency_reasons: string[];
}

export interface BlueprintMeta {
  blueprint_id: string;
  cluster_id: string;
  generated_at: string;                           // ISO 8601
  contract_version: typeof BLUEPRINT_SCHEMA_VERSION;
  prompt_version: string;
  config_version: string;
  requested_model: string;                        // an explicit :free slug
  generation_mode: Member<typeof GENERATION_MODE>;
  passes: PassRecord[];
  request_params: BlueprintRequestParams;
  evidence_pack: EvidencePackSummary;
  disclaimers: string[];
}

export type MetricClass = Member<typeof METRIC_CLASS>;
export type MetricName = Member<typeof METRIC_NAME>;

interface EvidenceBase {
  id: EvidenceId;
  /** JSON Pointers (RFC 6901) of every place in the blueprint that cites this item. Empty when the model did not cite it. */
  cited_by: string[];
}

export interface DiscussionEvidence extends EvidenceBase {
  kind: 'discussion_excerpt';
  record_id: string;
  source_id: string;
  url: string;                                    // from the database, never from the model
  title: string | null;
  excerpt: string;                                // exactly what the model saw, max 400 chars
  content_sha256: string;
  published_at: string | null;
  license: string;
  attribution: string | null;
  analysis_method: Member<typeof ANALYSIS_METHOD>;
  has_wtp_quote: boolean;
}

export interface MetricEvidence extends EvidenceBase {
  kind: 'cluster_metric';
  cluster_id: string;
  name: MetricName;
  label: string;
  value: string | number | boolean | null | string[] | Record<string, number>;
  evidence_class: MetricClass;
}

export type EvidenceIndexEntry = DiscussionEvidence | MetricEvidence;

export type VerificationCheckName = Member<typeof VERIFICATION_CHECK_NAME>;

export interface VerificationCheck { check: VerificationCheckName; passed: boolean; detail?: string }

export type RepairAction = Member<typeof REPAIR_ACTION>;
export interface VerificationRepair { path: string; action: RepairAction; reason: string }

export interface VerificationReport {
  /** A rejected output is never stored, so only these two states exist on a stored blueprint. */
  status: Member<typeof VERIFICATION_STATUS>;
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

// ---------------------------------------------------------------------------------------------------------------------------------
// 3.10 Pass boundaries (only relevant if the sectioned strategy is used)
// ---------------------------------------------------------------------------------------------------------------------------------

export type PassAOutput = Pick<BlueprintModelOutputV1, 'schema_version' | 'opportunity' | 'market_evidence' | 'personas' | 'product' | 'mvp' | 'journeys' | 'workflows' | 'commercial'>;
export type PassBOutput = Pick<BlueprintModelOutputV1, 'architecture' | 'database'>;
export type PassCOutput = Pick<BlueprintModelOutputV1, 'implementation' | 'testing' | 'risks'>;
