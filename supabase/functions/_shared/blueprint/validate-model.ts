// Structural validation (tiers T1-T4) of the model-owned part of a blueprint: required and optional fields, unexpected fields,
// primitive types, enums, string lengths, list sizes, numeric ranges, identifier formats and the shape of every nested structure.
// Cross-references, uniqueness, cycles and database integrity are a separate pass (validate-integrity.ts) that only runs on a
// structurally valid document, so those rules can rely on the shapes checked here.
import {
  ALTERNATIVE_KIND, ARCHITECTURE_STYLE, BACKEND_OWNED_KEYS, BASIS, BLUEPRINT_SCHEMA_VERSION, BUILD_WEEKS, BUYING_ROLE, CAP, COMPLEXITY, COUNT, DB_ENGINE,
  EVIDENCE_SUFFICIENCY, EXPECTED_VOLUME, EXPERIMENT_METHOD, EXPERIMENT_TARGET_PATTERN, FEATURE_PRIORITY, ID_PATTERNS, INDEX_METHOD, INTEGRATION_DIRECTION,
  LEVEL3, MARKET_SIZING_STATUS, MODEL_OUTPUT_KEYS, NFR_CATEGORY, OPPORTUNITY_VERDICT, PERSONA_PRIORITY, PG_SIMPLE_TYPES, PG_TYPE_PATTERNS, PRICING_MODEL,
  PRODUCT_TYPE, REFERENTIAL_ACTION, REVERSIBILITY, RISK_CATEGORY, RLS_OPERATION, RLS_ROLE, SAFEGUARDS, SIGNAL_STRENGTH, SNAKE_CASE_PATTERN, STEP_ACTOR,
  TASK_SIZE, TASK_TYPE, TECH_AREA, TENANCY_MODEL, TEST_LEVEL, WTP_STATUS,
} from './constants.ts';
import type { Range } from './constants.ts';
import {
  at, Ctx, fBool, fEnum, fId, fIdList, fList, fNum, fObj, fStr, fStrList, hasKey, isRec, readEvidenceIdList, readList, readObject, Rec,
} from './validate-core.ts';

const L = COUNT;
const SG = SAFEGUARDS;

// ---------------------------------------------------------------------------------------------------------------------------------
// Reusable shapes
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * Claim (section 3.1). `downgraded_from` is backend-only metadata: the documents write it only when a verifier lowered a basis, and record every
 * such downgrade as a `downgraded_basis` repair. It is rejected in model output (the model must not write it) and, as a Phase A2 policy, also in the
 * assembled blueprint, because Phase A2 is rejection-only: nothing is ever downgraded or repaired, so a stored claim carrying it would contradict
 * `verification.status === "verified"` and an empty `verification.repairs`. The documented type keeps the optional field (contract.ts).
 */
export function readClaim(c: Ctx, p: string, v: unknown): void {
  const o = readObject(c, p, v, ['text', 'basis', 'evidence_refs'], ['confidence', 'rationale', 'validation', 'missing_information', 'downgraded_from']);
  if (!o) return;
  fStr(c, o, p, 'text', CAP.claimText);
  const basis = fEnum(c, o, p, 'basis', BASIS);
  if (hasKey(o, 'evidence_refs')) {
    readEvidenceIdList(c, at(p, 'evidence_refs'), o.evidence_refs, 'any', basis === 'verified_evidence' ? L.evidenceRefsVerified : L.evidenceRefsOther);
  }
  fEnum(c, o, p, 'confidence', LEVEL3);
  fStr(c, o, p, 'rationale', CAP.companion);
  fStr(c, o, p, 'validation', CAP.companion);
  fStr(c, o, p, 'missing_information', CAP.companion);
  if (hasKey(o, 'downgraded_from')) {
    if (c.mode === 'model') c.err('downgraded_from_forbidden', at(p, 'downgraded_from'), 'Only the backend may record a downgrade; the model must not write this field.');
    else c.err('downgraded_from_not_allowed', at(p, 'downgraded_from'), 'Phase A2 is rejection-only and never downgrades a claim, so a stored claim must not carry downgrade metadata.');
  }
}

const fClaim = (c: Ctx, o: Rec, p: string, k: string): void => { if (hasKey(o, k)) readClaim(c, at(p, k), o[k]); };
const fClaimList = (c: Ctx, o: Rec, p: string, k: string, r: Range): void => { fList(c, o, p, k, r, (item, ip) => readClaim(c, ip, item)); };

/** A snake_case name (table, column, workflow state). Identifier-shaped, so it is not scanned as free text. */
function readSnake(c: Ctx, path: string, v: unknown, max: number): void {
  if (typeof v !== 'string') { c.err('invalid_type', path, 'Expected a string.'); return; }
  if (v.length > max || !SNAKE_CASE_PATTERN.test(v)) c.err('invalid_format', path, `Expected a snake_case name of at most ${max} characters.`);
}
const fSnake = (c: Ctx, o: Rec, p: string, k: string, max: number): void => { if (hasKey(o, k)) readSnake(c, at(p, k), o[k], max); };

/** A constraint, index or policy name: a PostgreSQL-style identifier (safeguard SG3). */
function readDbName(c: Ctx, path: string, v: unknown): void {
  if (typeof v !== 'string') { c.err('invalid_type', path, 'Expected a string.'); return; }
  if (v.length > SG.dbObjectName.max || !SG.dbObjectName.pattern.test(v)) c.err('invalid_format', path, `Expected a lowercase identifier of at most ${SG.dbObjectName.max} characters.`);
}
const fDbName = (c: Ctx, o: Rec, p: string, k: string): void => { if (hasKey(o, k)) readDbName(c, at(p, k), o[k]); };

/** A list of snake_case column names with no repeated entry. */
function fNameList(c: Ctx, o: Rec, p: string, k: string, r: Range, max = CAP.snake40): void {
  if (!hasKey(o, k)) return;
  const seen = new Set<string>();
  readList(c, at(p, k), o[k], r, (item, ip) => {
    readSnake(c, ip, item, max);
    if (typeof item === 'string') {
      if (seen.has(item)) c.err('duplicate_item', ip, 'The list repeats an entry.');
      seen.add(item);
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 3.2 Opportunity and market evidence
// ---------------------------------------------------------------------------------------------------------------------------------

function readOpportunity(c: Ctx, p: string, v: unknown): void {
  const o = readObject(c, p, v, ['title', 'one_line_summary', 'verdict', 'verdict_rationale', 'problem_statement', 'affected_users', 'current_alternatives', 'thesis', 'counter_thesis']);
  if (!o) return;
  fStr(c, o, p, 'title', CAP.title120);
  fStr(c, o, p, 'one_line_summary', CAP.summary200);
  fEnum(c, o, p, 'verdict', OPPORTUNITY_VERDICT);
  fClaim(c, o, p, 'verdict_rationale');
  fClaim(c, o, p, 'problem_statement');
  fClaim(c, o, p, 'affected_users');
  fList(c, o, p, 'current_alternatives', L.alternatives, (item, ip) => {
    const a = readObject(c, ip, item, ['name', 'kind', 'how_it_falls_short']);
    if (!a) return;
    fStr(c, a, ip, 'name', CAP.name80);
    fEnum(c, a, ip, 'kind', ALTERNATIVE_KIND);
    fClaim(c, a, ip, 'how_it_falls_short');
  });
  fClaimList(c, o, p, 'thesis', L.thesis);
  fClaimList(c, o, p, 'counter_thesis', L.counterThesis);
}

function readMarketEvidence(c: Ctx, p: string, v: unknown): void {
  const o = readObject(c, p, v, ['sufficiency_self_assessment', 'demand_signals', 'willingness_to_pay', 'evidence_gaps']);
  if (!o) return;
  fEnum(c, o, p, 'sufficiency_self_assessment', EVIDENCE_SUFFICIENCY);
  fList(c, o, p, 'demand_signals', L.demandSignals, (item, ip) => {
    const s = readObject(c, ip, item, ['signal_id', 'metric_refs', 'excerpt_refs', 'interpretation', 'strength']);
    if (!s) return;
    fId(c, s, ip, 'signal_id', ID_PATTERNS.signal);
    if (hasKey(s, 'metric_refs')) readEvidenceIdList(c, at(ip, 'metric_refs'), s.metric_refs, 'M', SG.signalRefs);
    if (hasKey(s, 'excerpt_refs')) readEvidenceIdList(c, at(ip, 'excerpt_refs'), s.excerpt_refs, 'E', SG.signalRefs);
    fClaim(c, s, ip, 'interpretation');
    fEnum(c, s, ip, 'strength', SIGNAL_STRENGTH);
  });
  const w = fObj(c, o, p, 'willingness_to_pay', ['status', 'summary']);
  if (w) {
    const wp = at(p, 'willingness_to_pay');
    fEnum(c, w, wp, 'status', WTP_STATUS);
    fClaim(c, w, wp, 'summary');
  }
  fList(c, o, p, 'evidence_gaps', L.evidenceGaps, (item, ip) => {
    const g = readObject(c, ip, item, ['gap_id', 'description', 'impact', 'how_to_close']);
    if (!g) return;
    fId(c, g, ip, 'gap_id', ID_PATTERNS.gap);
    fStr(c, g, ip, 'description', CAP.text400);
    fStr(c, g, ip, 'impact', CAP.text300);
    fStr(c, g, ip, 'how_to_close', CAP.text300);
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 3.3 Personas, product, MVP
// ---------------------------------------------------------------------------------------------------------------------------------

function readPersonas(c: Ctx, p: string, v: unknown): void {
  readList(c, p, v, L.personas, (item, ip) => {
    const o = readObject(c, ip, item, ['persona_id', 'priority', 'name', 'role', 'context', 'goals', 'frustrations', 'current_workaround', 'buying_role']);
    if (!o) return;
    fId(c, o, ip, 'persona_id', ID_PATTERNS.persona);
    fEnum(c, o, ip, 'priority', PERSONA_PRIORITY);
    fStr(c, o, ip, 'name', CAP.name80);
    fStr(c, o, ip, 'role', CAP.name80);
    fStr(c, o, ip, 'context', CAP.text300);
    fStrList(c, o, ip, 'goals', L.personaGoals, CAP.text160);
    fClaimList(c, o, ip, 'frustrations', L.personaFrustrations);
    fClaim(c, o, ip, 'current_workaround');
    fEnum(c, o, ip, 'buying_role', BUYING_ROLE);
  });
}

function readProduct(c: Ctx, p: string, v: unknown): void {
  const o = readObject(c, p, v, ['product_name', 'product_type', 'positioning', 'value_proposition', 'differentiation', 'capabilities', 'non_goals', 'constraints', 'success_metrics']);
  if (!o) return;
  fStr(c, o, p, 'product_name', CAP.name80);
  fEnum(c, o, p, 'product_type', PRODUCT_TYPE);
  fClaim(c, o, p, 'positioning');
  fClaim(c, o, p, 'value_proposition');
  fClaim(c, o, p, 'differentiation');
  fList(c, o, p, 'capabilities', L.capabilities, (item, ip) => {
    const cap = readObject(c, ip, item, ['name', 'description', 'feature_ids']);
    if (!cap) return;
    fStr(c, cap, ip, 'name', CAP.name80);
    fStr(c, cap, ip, 'description', CAP.text300);
    fIdList(c, cap, ip, 'feature_ids', ID_PATTERNS.feature, SG.featureIdList);
  });
  fStrList(c, o, p, 'non_goals', L.nonGoals, CAP.default);
  fStrList(c, o, p, 'constraints', L.constraints, CAP.default);
  fList(c, o, p, 'success_metrics', L.successMetrics, (item, ip) => {
    const m = readObject(c, ip, item, ['name', 'target', 'how_measured']);
    if (!m) return;
    fStr(c, m, ip, 'name', CAP.name80);
    fStr(c, m, ip, 'target', CAP.text160);
    fStr(c, m, ip, 'how_measured', CAP.text200);
  });
}

function readMvp(c: Ctx, p: string, v: unknown): void {
  const o = readObject(c, p, v, ['features', 'exclusions', 'scope_assessment']);
  if (!o) return;
  fList(c, o, p, 'features', L.features, (item, ip) => {
    const f = readObject(c, ip, item, ['feature_id', 'name', 'description', 'user_value', 'persona_ids', 'priority', 'complexity', 'depends_on', 'justification']);
    if (!f) return;
    fId(c, f, ip, 'feature_id', ID_PATTERNS.feature);
    fStr(c, f, ip, 'name', CAP.name80);
    fStr(c, f, ip, 'description', CAP.text300);
    fStr(c, f, ip, 'user_value', CAP.text200);
    fIdList(c, f, ip, 'persona_ids', ID_PATTERNS.persona, L.personasPerFeature);
    fEnum(c, f, ip, 'priority', FEATURE_PRIORITY);
    fEnum(c, f, ip, 'complexity', COMPLEXITY);
    fIdList(c, f, ip, 'depends_on', ID_PATTERNS.feature, SG.featureDependsOn);
    fClaim(c, f, ip, 'justification');
  });
  fList(c, o, p, 'exclusions', L.exclusions, (item, ip) => {
    const e = readObject(c, ip, item, ['name', 'reason', 'revisit_when']);
    if (!e) return;
    fStr(c, e, ip, 'name', CAP.name80);
    fStr(c, e, ip, 'reason', CAP.text300);
    fStr(c, e, ip, 'revisit_when', CAP.text200);
  });
  const s = fObj(c, o, p, 'scope_assessment', ['team_assumption', 'estimated_build_weeks', 'estimate_confidence', 'complexity_notes']);
  if (s) {
    const sp = at(p, 'scope_assessment');
    fStr(c, s, sp, 'team_assumption', CAP.text200);
    fEnum(c, s, sp, 'estimate_confidence', LEVEL3);
    fStr(c, s, sp, 'complexity_notes', CAP.text400);
    const w = fObj(c, s, sp, 'estimated_build_weeks', ['min', 'max']);
    if (w) {
      const wp = at(sp, 'estimated_build_weeks');
      const min = fNum(c, w, wp, 'min', BUILD_WEEKS);
      const max = fNum(c, w, wp, 'max', BUILD_WEEKS);
      if (min !== undefined && max !== undefined && min > max) c.err('estimate_range_invalid', wp, 'The minimum number of weeks must not exceed the maximum.');
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 3.4 Journeys and workflows
// ---------------------------------------------------------------------------------------------------------------------------------

function readJourneys(c: Ctx, p: string, v: unknown): void {
  readList(c, p, v, L.journeys, (item, ip) => {
    const j = readObject(c, ip, item, ['journey_id', 'name', 'persona_id', 'goal', 'trigger', 'steps', 'success_outcome', 'failure_modes']);
    if (!j) return;
    fId(c, j, ip, 'journey_id', ID_PATTERNS.journey);
    fStr(c, j, ip, 'name', CAP.name80);
    fId(c, j, ip, 'persona_id', ID_PATTERNS.persona);
    fStr(c, j, ip, 'goal', CAP.text200);
    fStr(c, j, ip, 'trigger', CAP.text200);
    fList(c, j, ip, 'steps', L.journeySteps, (step, sp) => {
      const s = readObject(c, sp, step, ['order', 'actor', 'action', 'feature_ids'], ['system_response']);
      if (!s) return;
      fNum(c, s, sp, 'order', { min: 1, max: L.journeySteps.max }, true);
      fEnum(c, s, sp, 'actor', STEP_ACTOR);
      fStr(c, s, sp, 'action', CAP.text200);
      fStr(c, s, sp, 'system_response', CAP.text200);
      fIdList(c, s, sp, 'feature_ids', ID_PATTERNS.feature, SG.featureIdList);
    });
    fStr(c, j, ip, 'success_outcome', CAP.text200);
    fStrList(c, j, ip, 'failure_modes', L.failureModes, CAP.text160);
  });
}

function readWorkflows(c: Ctx, p: string, v: unknown): void {
  readList(c, p, v, L.workflows, (item, ip) => {
    const w = readObject(c, ip, item, ['workflow_id', 'name', 'entity', 'states', 'transitions', 'feature_ids']);
    if (!w) return;
    fId(c, w, ip, 'workflow_id', ID_PATTERNS.workflow);
    fStr(c, w, ip, 'name', CAP.name80);
    fStr(c, w, ip, 'entity', CAP.name80);
    fList(c, w, ip, 'states', L.workflowStates, (state, sp) => {
      const s = readObject(c, sp, state, ['name', 'description']);
      if (!s) return;
      fSnake(c, s, sp, 'name', CAP.snake40);
      fStr(c, s, sp, 'description', CAP.text160);
    });
    fList(c, w, ip, 'transitions', L.workflowTransitions, (tr, tp) => {
      const t = readObject(c, tp, tr, ['from', 'to', 'trigger'], ['guard']);
      if (!t) return;
      fSnake(c, t, tp, 'from', CAP.snake40);
      fSnake(c, t, tp, 'to', CAP.snake40);
      fStr(c, t, tp, 'trigger', CAP.text120);
      fStr(c, t, tp, 'guard', CAP.text160);
    });
    fIdList(c, w, ip, 'feature_ids', ID_PATTERNS.feature, SG.featureIdList);
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 3.5 Architecture
// ---------------------------------------------------------------------------------------------------------------------------------

function readArchitecture(c: Ctx, p: string, v: unknown): void {
  const o = readObject(c, p, v, ['style', 'summary', 'components', 'tech_choices', 'integrations', 'non_functional', 'decisions', 'deployment_notes']);
  if (!o) return;
  fEnum(c, o, p, 'style', ARCHITECTURE_STYLE);
  fStr(c, o, p, 'summary', CAP.text400);
  fList(c, o, p, 'components', L.components, (item, ip) => {
    const k = readObject(c, ip, item, ['component_id', 'name', 'responsibility', 'technology', 'feature_ids', 'talks_to']);
    if (!k) return;
    fId(c, k, ip, 'component_id', ID_PATTERNS.component);
    fStr(c, k, ip, 'name', CAP.name80);
    fStr(c, k, ip, 'responsibility', CAP.text200);
    fStr(c, k, ip, 'technology', CAP.name80);
    fIdList(c, k, ip, 'feature_ids', ID_PATTERNS.feature, SG.featureIdList);
    fIdList(c, k, ip, 'talks_to', ID_PATTERNS.component, SG.componentTalksTo);
  });
  fList(c, o, p, 'tech_choices', L.techChoices, (item, ip) => {
    const t = readObject(c, ip, item, ['area', 'choice', 'rationale', 'alternatives', 'trade_offs', 'reversibility']);
    if (!t) return;
    fEnum(c, t, ip, 'area', TECH_AREA);
    fStr(c, t, ip, 'choice', CAP.name80);
    fStr(c, t, ip, 'rationale', CAP.text300);
    fList(c, t, ip, 'alternatives', L.techAlternatives, (alt, ap) => {
      const a = readObject(c, ap, alt, ['name', 'why_not_chosen']);
      if (!a) return;
      fStr(c, a, ap, 'name', CAP.name80);
      fStr(c, a, ap, 'why_not_chosen', CAP.text200);
    });
    fStr(c, t, ip, 'trade_offs', CAP.text300);
    fEnum(c, t, ip, 'reversibility', REVERSIBILITY);
  });
  fList(c, o, p, 'integrations', L.integrations, (item, ip) => {
    const g = readObject(c, ip, item, ['name', 'purpose', 'direction', 'required_for_mvp', 'failure_handling']);
    if (!g) return;
    fStr(c, g, ip, 'name', CAP.name80);
    fStr(c, g, ip, 'purpose', CAP.text200);
    fEnum(c, g, ip, 'direction', INTEGRATION_DIRECTION);
    fBool(c, g, ip, 'required_for_mvp');
    fStr(c, g, ip, 'failure_handling', CAP.text200);
  });
  fList(c, o, p, 'non_functional', L.nonFunctional, (item, ip) => {
    const n = readObject(c, ip, item, ['category', 'requirement', 'approach'], ['target']);
    if (!n) return;
    fEnum(c, n, ip, 'category', NFR_CATEGORY);
    fStr(c, n, ip, 'requirement', CAP.text200);
    fStr(c, n, ip, 'target', CAP.text120);
    fStr(c, n, ip, 'approach', CAP.text300);
  });
  fList(c, o, p, 'decisions', L.decisions, (item, ip) => {
    const d = readObject(c, ip, item, ['decision_id', 'title', 'context', 'options', 'decision', 'consequences']);
    if (!d) return;
    fId(c, d, ip, 'decision_id', ID_PATTERNS.decision);
    fStr(c, d, ip, 'title', CAP.title120);
    fStr(c, d, ip, 'context', CAP.text300);
    fList(c, d, ip, 'options', L.decisionOptions, (opt, op) => {
      const x = readObject(c, op, opt, ['name', 'pros', 'cons']);
      if (!x) return;
      fStr(c, x, op, 'name', CAP.name80);
      fStrList(c, x, op, 'pros', L.optionPros, CAP.text160);
      fStrList(c, x, op, 'cons', L.optionCons, CAP.text160);
    });
    fStr(c, d, ip, 'decision', CAP.text200);
    fStr(c, d, ip, 'consequences', CAP.text300);
  });
  fStr(c, o, p, 'deployment_notes', CAP.text400);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 3.6 Database design (a proposal, never SQL)
// ---------------------------------------------------------------------------------------------------------------------------------

/** Closed column-type list. `varchar(n)` and `numeric(p,s)` carry bounds (safeguard SG6: PostgreSQL's own limits). */
function readPgType(c: Ctx, path: string, v: unknown): void {
  if (typeof v !== 'string') { c.err('invalid_type', path, 'Expected a string.'); return; }
  if ((PG_SIMPLE_TYPES as readonly string[]).includes(v)) return;
  const vc = PG_TYPE_PATTERNS.varchar.exec(v);
  if (vc) {
    if (!(Number(vc[1]) >= SG.varcharLength.min && Number(vc[1]) <= SG.varcharLength.max)) c.err('number_out_of_range', path, `The varchar length must be between ${SG.varcharLength.min} and ${SG.varcharLength.max}.`);
    return;
  }
  const nm = PG_TYPE_PATTERNS.numeric.exec(v);
  if (nm) {
    const precision = Number(nm[1]);
    const scale = Number(nm[2]);
    if (precision < SG.numericPrecision.min || precision > SG.numericPrecision.max || scale > precision) {
      c.err('number_out_of_range', path, `The numeric precision must be between ${SG.numericPrecision.min} and ${SG.numericPrecision.max} and the scale must not exceed it.`);
    }
    return;
  }
  c.err('invalid_enum', path, 'The column type is not in the allowed list.');
}

function readReferencesTable(c: Ctx, path: string, v: unknown): void {
  if (typeof v !== 'string') { c.err('invalid_type', path, 'Expected a string.'); return; }
  if (v === 'auth.users') return;
  readSnake(c, path, v, CAP.snake40);
}

function readColumn(c: Ctx, p: string, v: unknown): void {
  const o = readObject(c, p, v, ['name', 'data_type', 'nullable', 'description'], ['default', 'contains_personal_data']);
  if (!o) return;
  fSnake(c, o, p, 'name', CAP.snake40);
  if (hasKey(o, 'data_type')) readPgType(c, at(p, 'data_type'), o.data_type);
  fBool(c, o, p, 'nullable');
  fStr(c, o, p, 'default', CAP.default80, 'expr');
  fStr(c, o, p, 'description', CAP.text160);
  fBool(c, o, p, 'contains_personal_data');
}

function readTable(c: Ctx, p: string, v: unknown): void {
  const o = readObject(c, p, v, ['name', 'purpose', 'feature_ids', 'columns', 'primary_key', 'foreign_keys', 'unique_constraints', 'check_constraints', 'indexes', 'rls'], ['retention', 'expected_volume']);
  if (!o) return;
  fSnake(c, o, p, 'name', CAP.snake40);
  fStr(c, o, p, 'purpose', CAP.text200);
  fIdList(c, o, p, 'feature_ids', ID_PATTERNS.feature, SG.featureIdList);
  fList(c, o, p, 'columns', L.columns, (item, ip) => readColumn(c, ip, item));
  fNameList(c, o, p, 'primary_key', L.primaryKey);
  fList(c, o, p, 'foreign_keys', SG.foreignKeys, (item, ip) => {
    const f = readObject(c, ip, item, ['name', 'columns', 'references_table', 'references_columns', 'on_delete']);
    if (!f) return;
    fDbName(c, f, ip, 'name');
    fNameList(c, f, ip, 'columns', SG.columnListRange);
    if (hasKey(f, 'references_table')) readReferencesTable(c, at(ip, 'references_table'), f.references_table);
    fNameList(c, f, ip, 'references_columns', SG.columnListRange);
    fEnum(c, f, ip, 'on_delete', REFERENTIAL_ACTION);
  });
  fList(c, o, p, 'unique_constraints', SG.uniqueConstraints, (item, ip) => {
    const u = readObject(c, ip, item, ['name', 'columns']);
    if (!u) return;
    fDbName(c, u, ip, 'name');
    fNameList(c, u, ip, 'columns', SG.columnListRange);
  });
  fList(c, o, p, 'check_constraints', SG.checkConstraints, (item, ip) => {
    const k = readObject(c, ip, item, ['name', 'rule']);
    if (!k) return;
    fDbName(c, k, ip, 'name');
    fStr(c, k, ip, 'rule', CAP.default, 'expr');
  });
  fList(c, o, p, 'indexes', L.indexes, (item, ip) => {
    const x = readObject(c, ip, item, ['name', 'columns', 'method', 'unique', 'purpose'], ['partial_condition']);
    if (!x) return;
    fDbName(c, x, ip, 'name');
    fNameList(c, x, ip, 'columns', SG.columnListRange);
    fEnum(c, x, ip, 'method', INDEX_METHOD);
    fBool(c, x, ip, 'unique');
    fStr(c, x, ip, 'partial_condition', CAP.partial120, 'expr');
    fStr(c, x, ip, 'purpose', CAP.text160);
  });
  const rls = fObj(c, o, p, 'rls', ['enabled', 'policies'], ['notes']);
  if (rls) {
    const rp = at(p, 'rls');
    fBool(c, rls, rp, 'enabled');
    fList(c, rls, rp, 'policies', L.policies, (item, ip) => {
      const pol = readObject(c, ip, item, ['name', 'operation', 'role', 'rule']);
      if (!pol) return;
      fDbName(c, pol, ip, 'name');
      fEnum(c, pol, ip, 'operation', RLS_OPERATION);
      fEnum(c, pol, ip, 'role', RLS_ROLE);
      fStr(c, pol, ip, 'rule', CAP.rls200, 'expr');
    });
    fStr(c, rls, rp, 'notes', CAP.text300);
  }
  fStr(c, o, p, 'retention', CAP.retention160);
  fEnum(c, o, p, 'expected_volume', EXPECTED_VOLUME);
}

function readDatabase(c: Ctx, p: string, v: unknown): void {
  const o = readObject(c, p, v, ['engine', 'tenancy_model', 'tenancy_rationale', 'conventions', 'tables', 'migration_considerations', 'open_questions']);
  if (!o) return;
  fEnum(c, o, p, 'engine', DB_ENGINE);
  fEnum(c, o, p, 'tenancy_model', TENANCY_MODEL);
  fStr(c, o, p, 'tenancy_rationale', CAP.text300);
  fStrList(c, o, p, 'conventions', L.conventions, CAP.default);
  fList(c, o, p, 'tables', L.tables, (item, ip) => readTable(c, ip, item));
  fStrList(c, o, p, 'migration_considerations', L.migrationConsiderations, CAP.default);
  fStrList(c, o, p, 'open_questions', L.openQuestions, CAP.default);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// 3.7 Implementation, testing, commercial, risks
// ---------------------------------------------------------------------------------------------------------------------------------

function readImplementation(c: Ctx, p: string, v: unknown): void {
  const o = readObject(c, p, v, ['team_assumption', 'phases', 'tasks', 'critical_path']);
  if (!o) return;
  fStr(c, o, p, 'team_assumption', CAP.text200);
  fList(c, o, p, 'phases', L.phases, (item, ip) => {
    const ph = readObject(c, ip, item, ['phase_id', 'name', 'goal', 'task_ids', 'exit_criteria']);
    if (!ph) return;
    fId(c, ph, ip, 'phase_id', ID_PATTERNS.phase);
    fStr(c, ph, ip, 'name', CAP.name80);
    fStr(c, ph, ip, 'goal', CAP.text200);
    fIdList(c, ph, ip, 'task_ids', ID_PATTERNS.task, SG.phaseTaskIds);
    fStrList(c, ph, ip, 'exit_criteria', L.exitCriteria, CAP.text160);
  });
  fList(c, o, p, 'tasks', L.tasks, (item, ip) => {
    const t = readObject(c, ip, item, ['task_id', 'title', 'description', 'type', 'feature_ids', 'depends_on', 'size', 'deliverables', 'criterion_ids']);
    if (!t) return;
    fId(c, t, ip, 'task_id', ID_PATTERNS.task);
    fStr(c, t, ip, 'title', CAP.text100);
    fStr(c, t, ip, 'description', CAP.text300);
    fEnum(c, t, ip, 'type', TASK_TYPE);
    fIdList(c, t, ip, 'feature_ids', ID_PATTERNS.feature, SG.featureIdList);
    fIdList(c, t, ip, 'depends_on', ID_PATTERNS.task, SG.taskDependsOn);
    fEnum(c, t, ip, 'size', TASK_SIZE);
    fStrList(c, t, ip, 'deliverables', L.deliverables, CAP.text160);
    fIdList(c, t, ip, 'criterion_ids', ID_PATTERNS.criterion, SG.taskCriterionIds);
  });
  fIdList(c, o, p, 'critical_path', ID_PATTERNS.task, SG.criticalPath);
}

function readTesting(c: Ctx, p: string, v: unknown): void {
  const o = readObject(c, p, v, ['strategy', 'acceptance_criteria', 'quality_gates', 'validation_experiments']);
  if (!o) return;
  fStr(c, o, p, 'strategy', CAP.text400);
  fList(c, o, p, 'acceptance_criteria', L.acceptanceCriteria, (item, ip) => {
    const a = readObject(c, ip, item, ['criterion_id', 'feature_id', 'given', 'when', 'then', 'test_level']);
    if (!a) return;
    fId(c, a, ip, 'criterion_id', ID_PATTERNS.criterion);
    fId(c, a, ip, 'feature_id', ID_PATTERNS.feature);
    fStr(c, a, ip, 'given', CAP.text200);
    fStr(c, a, ip, 'when', CAP.text200);
    fStr(c, a, ip, 'then', CAP.text200);
    fEnum(c, a, ip, 'test_level', TEST_LEVEL);
  });
  fStrList(c, o, p, 'quality_gates', L.qualityGates, CAP.text160);
  fList(c, o, p, 'validation_experiments', L.experiments, (item, ip) => {
    const x = readObject(c, ip, item, ['experiment_id', 'tests', 'method', 'description', 'success_threshold', 'effort']);
    if (!x) return;
    fId(c, x, ip, 'experiment_id', ID_PATTERNS.experiment);
    fIdList(c, x, ip, 'tests', EXPERIMENT_TARGET_PATTERN, L.experimentTests);
    fEnum(c, x, ip, 'method', EXPERIMENT_METHOD);
    fStr(c, x, ip, 'description', CAP.text300);
    fStr(c, x, ip, 'success_threshold', CAP.text160);
    fEnum(c, x, ip, 'effort', TASK_SIZE);
  });
}

function readCommercial(c: Ctx, p: string, v: unknown): void {
  const o = readObject(c, p, v, ['business_model', 'pricing_hypotheses', 'market_sizing', 'go_to_market', 'validation_first_actions', 'outreach_ethics']);
  if (!o) return;
  fClaim(c, o, p, 'business_model');
  fList(c, o, p, 'pricing_hypotheses', L.pricingHypotheses, (item, ip) => {
    const h = readObject(c, ip, item, ['hypothesis_id', 'model', 'statement', 'how_to_validate'], ['price_placeholder']);
    if (!h) return;
    fId(c, h, ip, 'hypothesis_id', ID_PATTERNS.pricing);
    fEnum(c, h, ip, 'model', PRICING_MODEL);
    fClaim(c, h, ip, 'statement');
    fStr(c, h, ip, 'price_placeholder', CAP.price80);
    fStr(c, h, ip, 'how_to_validate', CAP.text200);
  });
  const ms = fObj(c, o, p, 'market_sizing', ['status', 'statement', 'assumptions']);
  if (ms) {
    const mp = at(p, 'market_sizing');
    fEnum(c, ms, mp, 'status', MARKET_SIZING_STATUS);
    fClaim(c, ms, mp, 'statement');
    fStrList(c, ms, mp, 'assumptions', L.marketSizingAssumptions, CAP.default);
  }
  fList(c, o, p, 'go_to_market', L.goToMarket, (item, ip) => {
    const g = readObject(c, ip, item, ['step_id', 'timeframe', 'action', 'target_persona_ids', 'expected_learning']);
    if (!g) return;
    fId(c, g, ip, 'step_id', ID_PATTERNS.goToMarketStep);
    fStr(c, g, ip, 'timeframe', CAP.text40);
    fStr(c, g, ip, 'action', CAP.text200);
    fIdList(c, g, ip, 'target_persona_ids', ID_PATTERNS.persona, SG.personaIdList);
    fStr(c, g, ip, 'expected_learning', CAP.text200);
  });
  fStrList(c, o, p, 'validation_first_actions', L.validationFirstActions, CAP.text160);
  fStrList(c, o, p, 'outreach_ethics', L.outreachEthics, CAP.text160);
}

function readRisks(c: Ctx, p: string, v: unknown): void {
  const o = readObject(c, p, v, ['risks', 'assumptions', 'unknowns', 'evidence_limitations']);
  if (!o) return;
  fList(c, o, p, 'risks', L.risks, (item, ip) => {
    const r = readObject(c, ip, item, ['risk_id', 'category', 'claim', 'likelihood', 'impact', 'mitigation']);
    if (!r) return;
    fId(c, r, ip, 'risk_id', ID_PATTERNS.risk);
    fEnum(c, r, ip, 'category', RISK_CATEGORY);
    fClaim(c, r, ip, 'claim');
    fEnum(c, r, ip, 'likelihood', LEVEL3);
    fEnum(c, r, ip, 'impact', LEVEL3);
    fStr(c, r, ip, 'mitigation', CAP.text300);
  });
  fList(c, o, p, 'assumptions', L.assumptions, (item, ip) => {
    const a = readObject(c, ip, item, ['assumption_id', 'statement', 'criticality', 'how_to_validate']);
    if (!a) return;
    fId(c, a, ip, 'assumption_id', ID_PATTERNS.assumption);
    fStr(c, a, ip, 'statement', CAP.text300);
    fEnum(c, a, ip, 'criticality', LEVEL3);
    fStr(c, a, ip, 'how_to_validate', CAP.text200);
  });
  fList(c, o, p, 'unknowns', L.unknowns, (item, ip) => {
    const u = readObject(c, ip, item, ['unknown_id', 'question', 'why_it_matters', 'how_to_resolve']);
    if (!u) return;
    fId(c, u, ip, 'unknown_id', ID_PATTERNS.unknown);
    fStr(c, u, ip, 'question', CAP.text200);
    fStr(c, u, ip, 'why_it_matters', CAP.text200);
    fStr(c, u, ip, 'how_to_resolve', CAP.text200);
  });
  fStrList(c, o, p, 'evidence_limitations', L.evidenceLimitations, CAP.text200);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Entry point for the model-owned part
// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * Validates the structure of the document root. In `model` mode the root must contain exactly the model keys; backend-owned keys are rejected
 * with a dedicated code. In `assembled` mode the backend-owned keys are required too and are read by validate-backend.ts (the caller passes `root`).
 * Returns the root object when it is an object (so the caller can continue with the backend-owned parts), otherwise undefined.
 */
export function readModelStructure(c: Ctx, root: unknown): Rec | undefined {
  if (!isRec(root)) { c.err('invalid_type', '', 'Expected a JSON object at the top level.'); return undefined; }
  if (c.mode === 'model') {
    for (const k of BACKEND_OWNED_KEYS) if (hasKey(root, k)) c.err('backend_owned_key_forbidden', at('', k), 'This section is written by the backend and must not appear in model output.');
  }
  const o = readObject(
    c, '', root,
    c.mode === 'assembled' ? [...MODEL_OUTPUT_KEYS, ...BACKEND_OWNED_KEYS] : MODEL_OUTPUT_KEYS,
    c.mode === 'assembled' ? [] : BACKEND_OWNED_KEYS, // already reported above; do not also count them as unexpected
  );
  if (!o) return undefined;

  if (hasKey(o, 'schema_version')) {
    const v = o.schema_version;
    if (typeof v !== 'string') c.err('invalid_type', '/schema_version', 'Expected a string.');
    else if (v !== BLUEPRINT_SCHEMA_VERSION) c.err('unsupported_schema_version', '/schema_version', 'This schema version is not supported.');
  }
  if (hasKey(o, 'opportunity')) readOpportunity(c, '/opportunity', o.opportunity);
  if (hasKey(o, 'market_evidence')) readMarketEvidence(c, '/market_evidence', o.market_evidence);
  if (hasKey(o, 'personas')) readPersonas(c, '/personas', o.personas);
  if (hasKey(o, 'product')) readProduct(c, '/product', o.product);
  if (hasKey(o, 'mvp')) readMvp(c, '/mvp', o.mvp);
  if (hasKey(o, 'journeys')) readJourneys(c, '/journeys', o.journeys);
  if (hasKey(o, 'workflows')) readWorkflows(c, '/workflows', o.workflows);
  if (hasKey(o, 'architecture')) readArchitecture(c, '/architecture', o.architecture);
  if (hasKey(o, 'database')) readDatabase(c, '/database', o.database);
  if (hasKey(o, 'implementation')) readImplementation(c, '/implementation', o.implementation);
  if (hasKey(o, 'testing')) readTesting(c, '/testing', o.testing);
  if (hasKey(o, 'commercial')) readCommercial(c, '/commercial', o.commercial);
  if (hasKey(o, 'risks')) readRisks(c, '/risks', o.risks);
  return o;
}
