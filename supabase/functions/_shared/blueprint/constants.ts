// ProductBlueprint v1 - the single source of truth for every enum, identifier pattern, count and cap.
// Written from docs/blueprint-engine/product-blueprint-v1.md (section numbers below refer to it unless another document is named).
// The TypeScript types (contract.ts) and the validator (validate*.ts) are both derived from this module, so they cannot drift.
//
// Two kinds of numbers live here and are kept apart on purpose:
//  - DOCUMENTED limits: taken from the approved documents. They are authoritative.
//  - SAFEGUARDS: where the documents are silent, a conservative, explicit limit chosen in Phase A2. Each is listed in SAFEGUARDS with
//    the reason. They bound resources or reject content that cannot be meaningful; they do not change what the contract means.
//
// Runtime-agnostic (no Node or Deno specific API), like the rest of the shared code.

export const BLUEPRINT_SCHEMA_VERSION = 'product-blueprint.v1' as const;

/** Evidence contract section 6: the only valid market-sizing statement in v1. */
export const NOT_ESTIMATED_TEXT = 'Not estimated — insufficient market-sizing evidence';

/** Reliability document section 9.4: hard cap on a stored result, in bytes of UTF-8 JSON. Also applied to model output (a stricter bound is implied by the caps). */
export const BLUEPRINT_MAX_RESULT_BYTES = 262_144;

// ---------------------------------------------------------------------------------------------------------------------------------
// Identifier patterns (section 3.1). The regular expression is part of the contract.
// ---------------------------------------------------------------------------------------------------------------------------------

export const ID_PATTERNS = {
  evidence: /^[EM]\d{2}$/,
  persona: /^P\d$/,
  feature: /^F\d{1,2}$/,
  journey: /^J\d$/,
  workflow: /^W\d$/,
  component: /^C\d{1,2}$/,
  decision: /^D\d{1,2}$/,
  task: /^T\d{2}$/,
  phase: /^PH\d$/,
  criterion: /^AC\d{2}$/,
  experiment: /^X\d$/,
  risk: /^R\d{1,2}$/,
  assumption: /^A\d{1,2}$/,
  unknown: /^U\d{1,2}$/,
  gap: /^G\d$/,
  signal: /^S\d$/,
  pricing: /^H\d$/,
  goToMarketStep: /^GT\d$/,
} as const;

/** `validation_experiments[*].tests` holds assumption (A#) or unknown (U#) ids (section 3.7). */
export const EXPERIMENT_TARGET_PATTERN = /^(?:A\d{1,2}|U\d{1,2})$/;

/** Evidence contract section 3.1: the backend issues E01-E24 and M01-M16 only. An id outside these ranges can never have been supplied. */
export const EVIDENCE_EXCERPT_MAX_ID = 24;
export const EVIDENCE_METRIC_MAX_ID = 16;

/** Identifier shape for names the contract says are snake_case (table, column, workflow state). */
export const SNAKE_CASE_PATTERN = /^[a-z][a-z0-9_]*$/;

// ---------------------------------------------------------------------------------------------------------------------------------
// Enumerations. `as const` arrays so the types below are derived from the same values the validator checks.
// ---------------------------------------------------------------------------------------------------------------------------------

export const LEVEL3 = ['low', 'medium', 'high'] as const;
export const BASIS = ['verified_evidence', 'ai_recommendation', 'hypothesis', 'unknown'] as const;
export const OPPORTUNITY_VERDICT = ['pursue_mvp', 'validate_first', 'insufficient_evidence', 'not_recommended'] as const;
export const ALTERNATIVE_KIND = ['named_in_evidence', 'suggested_category'] as const;
export const SIGNAL_STRENGTH = ['weak', 'moderate', 'strong'] as const;
export const WTP_STATUS = ['evidenced', 'not_evidenced', 'unknown'] as const;
export const EVIDENCE_SUFFICIENCY = ['insufficient', 'limited', 'adequate'] as const;
export const PERSONA_PRIORITY = ['primary', 'secondary'] as const;
export const BUYING_ROLE = ['decision_maker', 'budget_holder', 'end_user', 'influencer', 'unknown'] as const;
export const PRODUCT_TYPE = ['web_app', 'mobile_app', 'api_service', 'browser_extension', 'integration', 'internal_tool', 'data_product', 'other'] as const;
export const COMPLEXITY = ['S', 'M', 'L'] as const;
export const FEATURE_PRIORITY = ['must', 'should'] as const;
export const STEP_ACTOR = ['user', 'system', 'admin', 'external_service'] as const;
export const ARCHITECTURE_STYLE = ['monolith', 'modular_monolith', 'serverless', 'client_heavy_with_baas', 'service_oriented'] as const;
export const TECH_AREA = ['frontend', 'backend', 'database', 'auth', 'hosting', 'integration', 'ai', 'observability', 'payments', 'other'] as const;
export const REVERSIBILITY = ['easy', 'moderate', 'hard'] as const;
export const INTEGRATION_DIRECTION = ['inbound', 'outbound', 'both'] as const;
export const NFR_CATEGORY = ['performance', 'security', 'privacy', 'availability', 'cost', 'compliance', 'scalability', 'observability', 'accessibility'] as const;
export const DB_ENGINE = ['postgresql'] as const;
export const TENANCY_MODEL = ['single_tenant', 'user_owned_rows', 'organisation_scoped', 'public_read_only'] as const;
export const REFERENTIAL_ACTION = ['cascade', 'restrict', 'set null', 'no action'] as const;
export const INDEX_METHOD = ['btree', 'gin', 'gist', 'hash', 'brin'] as const;
export const RLS_OPERATION = ['select', 'insert', 'update', 'delete', 'all'] as const;
export const RLS_ROLE = ['anon', 'authenticated', 'service_role'] as const;
export const EXPECTED_VOLUME = ['tiny', 'small', 'medium', 'large'] as const;
export const TASK_TYPE = ['backend', 'frontend', 'database', 'infrastructure', 'security', 'integration', 'testing', 'documentation'] as const;
export const TASK_SIZE = ['XS', 'S', 'M', 'L'] as const;
export const TEST_LEVEL = ['unit', 'integration', 'end_to_end', 'manual', 'performance', 'security'] as const;
export const EXPERIMENT_METHOD = ['customer_interview', 'landing_page_test', 'prototype_test', 'concierge_manual_service', 'survey', 'data_analysis'] as const;
export const PRICING_MODEL = ['subscription', 'usage_based', 'one_time', 'freemium', 'marketplace_fee', 'services_plus_software', 'undecided'] as const;
export const MARKET_SIZING_STATUS = ['not_estimated', 'hypothesis'] as const;
export const RISK_CATEGORY = ['market', 'technical', 'legal_compliance', 'operational', 'financial', 'data_quality', 'security_privacy', 'dependency'] as const;

/** Closed list of non-parameterised column types (section 3.6). Parameterised types are validated by PG_TYPE_PATTERNS. */
export const PG_SIMPLE_TYPES = [
  'uuid', 'text', 'boolean', 'smallint', 'integer', 'bigint', 'real', 'double precision',
  'date', 'time', 'timestamptz', 'jsonb', 'bytea', 'inet',
  'uuid[]', 'text[]', 'integer[]', 'bigint[]',
] as const;

// Backend-owned (section 3.9).
export const TEAM_SIZE = ['solo', 'small_team', 'larger_team'] as const;
export const BUDGET_BAND = ['bootstrap', 'small', 'funded'] as const;
export const PREFERRED_STACK = ['unspecified', 'typescript_postgres', 'python_postgres', 'low_code'] as const;
export const BUSINESS_MODEL_HINT = ['unspecified', 'b2b_saas', 'b2c_subscription', 'marketplace', 'api_usage_based'] as const;
export const TARGET_REGION = ['unspecified', 'global', 'north_america', 'europe', 'africa', 'asia_pacific', 'latin_america', 'middle_east'] as const;
export const PASS_NAME = ['A', 'B', 'C', 'single'] as const;
export const GENERATION_MODE = ['single_pass', 'sectioned'] as const;
export const METRIC_CLASS = ['measured', 'derived', 'ai_estimate', 'insufficient_data'] as const;
export const METRIC_NAME = [
  'unique_discussions', 'source_count', 'sources', 'recent_discussions', 'prior_discussions',
  'growth_rate_pct', 'wtp_signal_count', 'severity_avg', 'cluster_confidence', 'competitor_mentions', 'score_component',
] as const;
export const ANALYSIS_METHOD = ['llm', 'heuristic'] as const;
export const VERIFICATION_CHECK_NAME = [
  'json_parse', 'schema_shape', 'required_fields', 'enums', 'size_caps', 'identifier_integrity',
  'evidence_ref_resolution', 'basis_rules', 'name_and_number_grounding', 'willingness_to_pay_rule',
  'commercial_rules', 'no_executable_sql', 'no_urls',
] as const;
export const REPAIR_ACTION = ['downgraded_basis', 'dropped_ref', 'truncated_text', 'truncated_list', 'removed_unknown_key', 'replaced_with_canonical', 'reclassified'] as const;
export const VERIFICATION_STATUS = ['verified', 'verified_with_repairs'] as const;

/**
 * Evidence contract section 3.2: fixed metric catalogue. M01..M10 each have one name; M11..M16 are the six score components.
 * Index 0 is M01.
 */
export const METRIC_CATALOGUE_NAMES = [
  'unique_discussions', 'source_count', 'growth_rate_pct', 'wtp_signal_count', 'cluster_confidence',
  'sources', 'recent_discussions', 'prior_discussions', 'severity_avg', 'competitor_mentions',
  'score_component', 'score_component', 'score_component', 'score_component', 'score_component', 'score_component',
] as const;

/** Top-level keys the model writes (section 3.8). `schema_version` is the contract marker. */
export const MODEL_OUTPUT_KEYS = [
  'schema_version', 'opportunity', 'market_evidence', 'personas', 'product', 'mvp', 'journeys', 'workflows',
  'architecture', 'database', 'implementation', 'testing', 'commercial', 'risks',
] as const;

/** Keys only the backend may write (section 3.9; reliability document section 4.2, tier T1). */
export const BACKEND_OWNED_KEYS = ['meta', 'evidence_index', 'verification'] as const;

// ---------------------------------------------------------------------------------------------------------------------------------
// Counts and caps. DOCUMENTED unless the name or comment says SAFEGUARD.
// ---------------------------------------------------------------------------------------------------------------------------------

export interface Range { readonly min: number; readonly max: number }
const range = (min: number, max: number): Range => ({ min, max });

/** List sizes (section 3 and the section 5 summary table). */
export const COUNT = {
  // opportunity / market evidence
  alternatives: range(0, 6), thesis: range(1, 3), counterThesis: range(1, 3),
  demandSignals: range(1, 6), evidenceGaps: range(1, 6),
  // personas, product, MVP
  personas: range(1, 3), personaGoals: range(1, 4), personaFrustrations: range(1, 4),
  capabilities: range(3, 8), nonGoals: range(2, 8), constraints: range(0, 8), successMetrics: range(2, 5),
  features: range(3, 7), personasPerFeature: range(1, 3), exclusions: range(2, 8),
  // journeys / workflows
  journeys: range(1, 4), journeySteps: range(3, 10), failureModes: range(1, 4),
  workflows: range(0, 2), workflowStates: range(3, 8), workflowTransitions: range(2, 16),
  // architecture
  components: range(3, 10), techChoices: range(4, 10), techAlternatives: range(1, 3), integrations: range(0, 6),
  nonFunctional: range(3, 9), decisions: range(2, 6), decisionOptions: range(2, 3), optionPros: range(1, 3), optionCons: range(1, 3),
  // database
  tables: range(3, 8), columns: range(3, 16), primaryKey: range(1, 3), indexes: range(0, 8), policies: range(0, 6),
  conventions: range(0, 6), migrationConsiderations: range(0, 6), openQuestions: range(0, 6),
  // implementation / testing
  phases: range(2, 5), tasks: range(8, 30), deliverables: range(1, 4), exitCriteria: range(1, 4),
  acceptanceCriteria: range(4, 40), qualityGates: range(2, 6), experiments: range(2, 6), experimentTests: range(1, 4),
  // commercial
  pricingHypotheses: range(0, 3), marketSizingAssumptions: range(0, 5), goToMarket: range(2, 6), validationFirstActions: range(2, 5), outreachEthics: range(1, 4),
  // risks
  risks: range(4, 10), assumptions: range(3, 10), unknowns: range(2, 10), evidenceLimitations: range(1, 6),
  // evidence references on one Claim: 1..4 for verified_evidence (section 3.1); at most 4 for every basis (evidence contract section 10).
  evidenceRefsVerified: range(1, 4), evidenceRefsOther: range(0, 4),
} as const;

/** Section 1 rule 5 and section 5: at most 5 `must` and at most 2 `should` MVP features. */
export const MVP_MAX_MUST = 5;
export const MVP_MAX_SHOULD = 2;

/** Weeks bound in ScopeAssessment.estimated_build_weeks: 1 <= min <= max <= 26 (section 3.3). */
export const BUILD_WEEKS = range(1, 26);

/** Evidence contract section 6 and prompt rule A4: "evidenced" needs at least two excerpts that carry a willingness-to-pay quote. */
export const WTP_MIN_EXCERPTS = 2;

/** String caps in characters (Unicode code points). Section 5: any single string <= 400 unless tighter, noted inline in section 3. */
export const CAP = {
  default: 400,
  claimText: 400, companion: 300,
  title120: 120, summary200: 200, name80: 80, text300: 300, text200: 200, text160: 160, text120: 120, text100: 100, text40: 40, text400: 400,
  snake40: 40, price80: 80, default80: 80, partial120: 120, rls200: 200, retention160: 160,
  excerpt: 400,
} as const;

// ---------------------------------------------------------------------------------------------------------------------------------
// SAFEGUARDS: documented silence, conservative explicit choice. Reported in the PR; change here and nowhere else.
// ---------------------------------------------------------------------------------------------------------------------------------

export const SAFEGUARDS = {
  /** SG1. Strings must contain a visible character: a blank required text carries no content (and honest absence is expressed by `unknown`). */
  nonBlankStrings: true,
  /** SG2. Reject NUL and other control characters (tab, LF, CR allowed) and lone UTF-16 surrogates: PostgreSQL text rejects NUL and PostgREST rejects lone surrogates (architecture audit R15). */
  rejectControlAndLoneSurrogates: true,
  /** SG3. Names of constraints, indexes and policies are PostgreSQL-style identifiers. */
  dbObjectName: { pattern: /^[a-z_][a-z0-9_]*$/, max: 63 },
  /** SG4. List sizes the documents leave open. */
  columnListRange: range(1, 8),         // columns of an FK / unique constraint / index, and referenced columns
  foreignKeys: range(0, 16),
  uniqueConstraints: range(0, 8),
  checkConstraints: range(0, 16),
  featureIdList: range(0, 7),           // an unspecified list of feature ids; 7 is the MVP feature maximum (ids must be unique)
  personaIdList: range(0, 3),           // 3 is the persona maximum
  componentTalksTo: range(0, 9),
  taskDependsOn: range(0, 29),
  featureDependsOn: range(0, 6),
  taskCriterionIds: range(0, 40),
  phaseTaskIds: range(1, 30),
  criticalPath: range(1, 30),           // a chain has at least one element
  signalRefs: range(0, 8),              // metric_refs and excerpt_refs of one demand signal
  /** SG5. Backend-owned text the contract leaves uncapped. */
  backendText: 1000,
  backendShortText: 200,
  backendUrl: 2048,
  backendList: range(0, 10),
  metricValueListItems: 64,             // MetricEvidence.value as string[] or Record<string, number>
  evidenceIndexEntries: range(0, EVIDENCE_EXCERPT_MAX_ID + EVIDENCE_METRIC_MAX_ID),
  passes: range(1, 3),
  citedBy: range(0, 100),
  repairs: range(0, 500),
  checks: range(0, 13),
  /** SG6. Varchar / numeric parameter bounds are PostgreSQL's own limits. */
  varcharLength: range(1, 10_485_760),
  numericPrecision: range(1, 1000),
  /** SG7. Whole-input resource bounds. */
  maxDepth: 16,
  maxNodes: 50_000,
  maxErrors: 100,
  maxUrlsAndPatternsScanChars: 2_000,
  /** SG8. Largest integer accepted for backend counters and durations. */
  maxCounter: Number.MAX_SAFE_INTEGER,
} as const;

/** A model-written string must not contain a URL: any http(s):// or www. text fails no_urls (evidence contract section 5.1 step 9). */
export const URL_PATTERN = /(?:\bhttps?:\/\/|\bwww\.)/i;

/** Postgres-style parameterised column types (section 3.6). */
export const PG_TYPE_PATTERNS = {
  varchar: /^varchar\((\d+)\)$/,
  numeric: /^numeric\((\d+),(\d+)\)$/,
} as const;

/** Backend-owned format checks. */
export const FORMAT = {
  sha256Hex: /^[0-9a-fA-F]{64}$/,
  /** Reliability document section 10.1: bp{N}.p{N}.s{N} with an optional +suffix of 1-24 [A-Za-z0-9._-] characters. */
  configVersion: /^bp\d+\.p\d+\.s\d+(?:\+[A-Za-z0-9._-]{1,24})?$/,
  /** prompt_version, e.g. "blueprint-prompt-v1". */
  promptVersion: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/,
  /** Mirrors isFreeModelSlug in the collector's ai-common.ts: only explicitly free slugs. Kept as a copy so the blueprint engine stays independent; a test asserts they agree. */
  freeModelSlug: /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*:free$/i,
  /** ISO 8601 date-time with a time zone. Calendar validity is checked separately. */
  isoDateTime: /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/,
  /** RFC 6901 JSON Pointer: empty, or segments introduced by "/", with "~" only as ~0 or ~1. */
  jsonPointer: /^(?:\/(?:[^~/]|~[01])*)*$/,
  httpUrl: /^https?:\/\/\S+$/i,
} as const;

// ---------------------------------------------------------------------------------------------------------------------------------
// Allowed basis by path (evidence contract section 5.2). Rejection-only in Phase A2: a disallowed basis rejects the blueprint; the
// documented "fallback" (downgrade and repair) belongs to a later phase and is deliberately not implemented here.
// ---------------------------------------------------------------------------------------------------------------------------------

export type ClaimRole =
  | 'verdict_rationale' | 'problem_statement' | 'affected_users' | 'alternative_shortfall' | 'thesis' | 'counter_thesis'
  | 'demand_interpretation' | 'willingness_to_pay_summary' | 'persona_frustration' | 'persona_workaround'
  | 'product_statement' | 'feature_justification' | 'business_model' | 'pricing_statement' | 'market_sizing_statement' | 'risk_claim';

type BasisValue = (typeof BASIS)[number];

/** For `alternative_shortfall` and `willingness_to_pay_summary` the list below is the base; the validator adds the documented condition. */
export const BASIS_BY_ROLE: Readonly<Record<ClaimRole, readonly BasisValue[]>> = {
  verdict_rationale: ['ai_recommendation', 'hypothesis'],
  problem_statement: ['verified_evidence', 'hypothesis', 'unknown'],
  affected_users: ['verified_evidence', 'hypothesis', 'unknown'],
  alternative_shortfall: ['hypothesis', 'unknown'],            // + verified_evidence only if kind = named_in_evidence
  thesis: ['verified_evidence', 'ai_recommendation', 'hypothesis'],
  counter_thesis: ['verified_evidence', 'ai_recommendation', 'hypothesis', 'unknown'],
  demand_interpretation: ['verified_evidence', 'ai_recommendation', 'hypothesis'],
  willingness_to_pay_summary: ['unknown'],                     // verified_evidence only if status = evidenced (then it is the only valid basis)
  persona_frustration: ['verified_evidence', 'hypothesis', 'unknown'],
  persona_workaround: ['verified_evidence', 'hypothesis', 'unknown'],
  product_statement: ['ai_recommendation', 'hypothesis'],
  feature_justification: ['verified_evidence', 'ai_recommendation', 'hypothesis'],
  business_model: ['ai_recommendation', 'hypothesis', 'unknown'],
  pricing_statement: ['hypothesis', 'unknown'],
  market_sizing_statement: ['unknown'],
  risk_claim: ['ai_recommendation', 'hypothesis', 'unknown'],
};
