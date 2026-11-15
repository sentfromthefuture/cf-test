// Identifier formats and uniqueness, internal references, dependency cycles, evidence reference structure and basis-by-path rules.
// Rule numbers refer to docs/blueprint-engine/product-blueprint-v1.md section 4 and docs/blueprint-engine/evidence-contract.md section 5.2.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { BlueprintModelOutputV1 } from '../contract.ts';
import { validateBlueprintModelOutput } from '../validate.ts';
import { assertAccepted, assertNoError, assertRejected, clone, errorsOf, getAt, makeList, setAt, validModelOutput } from './helpers.ts';

const model = (): BlueprintModelOutputV1 => validModelOutput();
const validate = (d: unknown, knownEvidenceIds?: string[]) => validateBlueprintModelOutput(d, knownEvidenceIds ? { knownEvidenceIds } : {});

// ---------------------------------------------------------------------------------------------------------------------------------
// Identifier formats (section 3.1)
// ---------------------------------------------------------------------------------------------------------------------------------

// [pointer of an id field, ids the pattern accepts, ids it rejects]
const ID_FIELDS: [string, string[], string[]][] = [
  ['/personas/0/persona_id', ['P0', 'P9'], ['P', 'P10', 'p1', 'PP1', 'P1x', 'Q1']],
  ['/mvp/features/0/feature_id', ['F1', 'F12', 'F99'], ['F', 'F100', 'f1', 'F-1', 'F01x']],
  ['/journeys/0/journey_id', ['J1', 'J9'], ['J', 'J10', 'j1']],
  ['/workflows/0/workflow_id', ['W1', 'W9'], ['W', 'W10', 'w1']],
  ['/architecture/components/0/component_id', ['C1', 'C12'], ['C', 'C100', 'c1']],
  ['/architecture/decisions/0/decision_id', ['D1', 'D12'], ['D', 'D100', 'd1']],
  ['/implementation/tasks/0/task_id', ['T00', 'T99'], ['T1', 'T100', 't01', 'T0x']],
  ['/implementation/phases/0/phase_id', ['PH1', 'PH9'], ['PH', 'PH10', 'ph1', 'P1']],
  ['/testing/acceptance_criteria/0/criterion_id', ['AC00', 'AC99'], ['AC1', 'AC100', 'ac01']],
  ['/testing/validation_experiments/0/experiment_id', ['X1', 'X9'], ['X', 'X10', 'x1']],
  ['/risks/risks/0/risk_id', ['R1', 'R12'], ['R', 'R100', 'r1']],
  ['/risks/assumptions/0/assumption_id', ['A1', 'A12'], ['A', 'A100', 'a1']],
  ['/risks/unknowns/0/unknown_id', ['U1', 'U12'], ['U', 'U100', 'u1']],
  ['/market_evidence/evidence_gaps/0/gap_id', ['G1', 'G9'], ['G', 'G10', 'g1']],
  ['/market_evidence/demand_signals/0/signal_id', ['S1', 'S9'], ['S', 'S10', 's1']],
  ['/commercial/pricing_hypotheses/0/hypothesis_id', ['H1', 'H9'], ['H', 'H10', 'h1']],
  ['/commercial/go_to_market/0/step_id', ['GT1', 'GT9'], ['GT', 'GT10', 'gt1', 'G1']],
];

test('every identifier field accepts exactly its documented pattern', () => {
  for (const [p, good, bad] of ID_FIELDS) {
    for (const id of good) {
      const d = model();
      setAt(d, p, id);
      assertNoError(validate(d), 'invalid_format', p, id);
    }
    const original = getAt(model(), p) as string;
    for (const id of [...bad, '', ` ${original}`, `${original} `, `${original}\n`, original.toLowerCase() === original ? original.toUpperCase() : original.toLowerCase()]) {
      const d = model();
      setAt(d, p, id);
      assertRejected(validate(d), 'invalid_format', p, JSON.stringify(id));
    }
  }
});

test('a repeated identifier is rejected at the later occurrence, in every list that declares ids', () => {
  const lists: [string, string, number][] = [
    ['/personas', 'persona_id', 2], ['/mvp/features', 'feature_id', 4], ['/journeys', 'journey_id', 2], ['/workflows', 'workflow_id', 2],
    ['/architecture/components', 'component_id', 4], ['/architecture/decisions', 'decision_id', 2], ['/implementation/tasks', 'task_id', 9],
    ['/implementation/phases', 'phase_id', 2], ['/testing/acceptance_criteria', 'criterion_id', 5], ['/testing/validation_experiments', 'experiment_id', 2],
    ['/risks/risks', 'risk_id', 4], ['/risks/assumptions', 'assumption_id', 3], ['/risks/unknowns', 'unknown_id', 2],
    ['/market_evidence/evidence_gaps', 'gap_id', 2], ['/market_evidence/demand_signals', 'signal_id', 2],
    ['/commercial/pricing_hypotheses', 'hypothesis_id', 2], ['/commercial/go_to_market', 'step_id', 2],
  ];
  for (const [p, key, n] of lists) {
    const d = model();
    makeList(d, p, n); // every item is a copy of the first, so every id after the first repeats
    assertRejected(validate(d), 'duplicate_identifier', `${p}/1/${key}`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// References (section 4, rules 2, 4, 6, 7, 8, 12, 13)
// ---------------------------------------------------------------------------------------------------------------------------------

// [pointer to set, value to set, expected error path]
const BROKEN_REFERENCES: [string, unknown, string][] = [
  ['/mvp/features/0/persona_ids', ['P7'], '/mvp/features/0/persona_ids/0'],
  ['/mvp/features/0/depends_on', ['F9'], '/mvp/features/0/depends_on/0'],
  ['/journeys/0/persona_id', 'P7', '/journeys/0/persona_id'],
  ['/journeys/0/steps/1/feature_ids', ['F9'], '/journeys/0/steps/1/feature_ids/0'],
  ['/workflows/0/feature_ids', ['F9'], '/workflows/0/feature_ids/0'],
  ['/product/capabilities/0/feature_ids', ['F1', 'F9'], '/product/capabilities/0/feature_ids/1'],
  ['/architecture/components/0/feature_ids', ['F9'], '/architecture/components/0/feature_ids/0'],
  ['/architecture/components/0/talks_to', ['C9'], '/architecture/components/0/talks_to/0'],
  ['/database/tables/0/feature_ids', ['F9'], '/database/tables/0/feature_ids/0'],
  ['/implementation/tasks/0/feature_ids', ['F9'], '/implementation/tasks/0/feature_ids/0'],
  ['/implementation/tasks/1/depends_on', ['T99'], '/implementation/tasks/1/depends_on/0'],
  ['/implementation/tasks/0/criterion_ids', ['AC99'], '/implementation/tasks/0/criterion_ids/0'],
  ['/implementation/phases/0/task_ids', ['T01', 'T02', 'T03', 'T04', 'T05', 'T99'], '/implementation/phases/0/task_ids/5'],
  ['/implementation/critical_path', ['T99'], '/implementation/critical_path/0'],
  ['/testing/acceptance_criteria/0/feature_id', 'F9', '/testing/acceptance_criteria/0/feature_id'],
  ['/testing/validation_experiments/0/tests', ['A9', 'U1'], '/testing/validation_experiments/0/tests/0'],
  ['/testing/validation_experiments/1/tests', ['U9'], '/testing/validation_experiments/1/tests/0'],
  ['/commercial/go_to_market/0/target_persona_ids', ['P7'], '/commercial/go_to_market/0/target_persona_ids/0'],
];

test('a reference to something that is not declared is rejected at the reference', () => {
  for (const [p, value, errorPath] of BROKEN_REFERENCES) {
    const d = model();
    setAt(d, p, value);
    assertRejected(validate(d), 'unresolved_reference', errorPath);
  }
});

test('a repeated entry inside a reference list is rejected', () => {
  const d = model();
  setAt(d, '/mvp/features/0/persona_ids', ['P1', 'P1']);
  assertRejected(validate(d), 'duplicate_item', '/mvp/features/0/persona_ids/1');
});

test('an experiment target resolves against assumptions (A#) or unknowns (U#) only', () => {
  const d = model();
  setAt(d, '/testing/validation_experiments/0/tests', ['A1', 'U1', 'U2', 'A2']);
  assertAccepted(validate(d));
  const bad = model();
  setAt(bad, '/testing/validation_experiments/0/tests', ['X1']);
  assertRejected(validate(bad), 'invalid_format', '/testing/validation_experiments/0/tests/0');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Dependency cycles (rule 3)
// ---------------------------------------------------------------------------------------------------------------------------------

const cycleErrors = (d: unknown) => errorsOf(validate(d)).filter((e) => e.code === 'dependency_cycle');

test('an acyclic feature and task graph is accepted (the example has dependencies)', () => {
  assertAccepted(validate(model()));
  assert.ok((getAt(model(), '/mvp/features/2/depends_on') as string[]).length > 0);
});

test('feature dependency cycles are rejected once, at the first feature in the cycle', () => {
  const two = model();
  setAt(two, '/mvp/features/0/depends_on', ['F3']); // F3 depends on F1
  assert.deepEqual(cycleErrors(two).map((e) => e.path), ['/mvp/features/0/depends_on']);
  const self = model();
  setAt(self, '/mvp/features/1/depends_on', ['F2']);
  assert.deepEqual(cycleErrors(self).map((e) => e.path), ['/mvp/features/1/depends_on']);
  const three = model();
  setAt(three, '/mvp/features/0/depends_on', ['F3']);
  setAt(three, '/mvp/features/1/depends_on', ['F1']);
  assert.equal(cycleErrors(three).length, 1);
});

test('task dependency cycles are rejected, including a task that depends on itself', () => {
  const loop = model();
  setAt(loop, '/implementation/tasks/0/depends_on', ['T08']); // T08 -> T05 -> T02 -> T01
  assert.deepEqual(cycleErrors(loop).map((e) => e.path), ['/implementation/tasks/0/depends_on']);
  const self = model();
  setAt(self, '/implementation/tasks/2/depends_on', ['T03']);
  assert.deepEqual(cycleErrors(self).map((e) => e.path), ['/implementation/tasks/2/depends_on']);
});

test('two separate cycles are two errors', () => {
  const d = model();
  setAt(d, '/implementation/tasks/0/depends_on', ['T08']);
  setAt(d, '/mvp/features/0/depends_on', ['F3']);
  assert.equal(cycleErrors(d).length, 2);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Critical path, phases, coverage, priorities, journeys, workflows, decisions
// ---------------------------------------------------------------------------------------------------------------------------------

test('every critical-path task must depend on the one before it', () => {
  const skip = model();
  setAt(skip, '/implementation/critical_path', ['T01', 'T03']); // T03 depends on T02, not T01
  assertRejected(validate(skip), 'invalid_critical_path', '/implementation/critical_path/1');
  const repeat = model();
  setAt(repeat, '/implementation/critical_path', ['T01', 'T02', 'T02']);
  assertRejected(validate(repeat), 'duplicate_item', '/implementation/critical_path/2'); // a repeated entry in any reference list is a shape error
  assertAccepted(validate((() => { const d = model(); setAt(d, '/implementation/critical_path', ['T01']); return d; })()));
});

test('every task belongs to exactly one phase', () => {
  const missing = model();
  setAt(missing, '/implementation/phases/1/task_ids', ['T06', 'T07']); // T08 dropped
  assertRejected(validate(missing), 'task_phase_assignment', '/implementation/tasks/7/task_id');
  const twice = model();
  setAt(twice, '/implementation/phases/1/task_ids', ['T06', 'T07', 'T08', 'T01']);
  assertRejected(validate(twice), 'task_phase_assignment', '/implementation/phases/1/task_ids/3');
});

test('every MVP feature needs an acceptance criterion', () => {
  const d = model();
  setAt(d, '/testing/acceptance_criteria/3/feature_id', 'F1'); // AC04 moves from F4 to F1
  assertRejected(validate(d), 'feature_without_criterion', '/mvp/features/3/feature_id');
});

test('a "must" feature needs a task and a capability; a "should" feature needs neither', () => {
  const noTask = model();
  setAt(noTask, '/implementation/tasks/5/feature_ids', []);
  setAt(noTask, '/implementation/tasks/6/feature_ids', []); // F3 now has no task
  assertRejected(validate(noTask), 'must_feature_uncovered', '/mvp/features/2/feature_id');
  const noCapability = model();
  setAt(noCapability, '/product/capabilities/1/feature_ids', []); // F3 now has no capability
  assertRejected(validate(noCapability), 'must_feature_uncovered', '/mvp/features/2/feature_id');
  const should = model();
  setAt(should, '/implementation/tasks/7/feature_ids', []);
  setAt(should, '/implementation/tasks/1/feature_ids', ['F1', 'F2']);
  setAt(should, '/product/capabilities/2/feature_ids', []); // F4 (should) has neither
  assert.ok(!errorsOf(validate(should)).some((e) => e.code === 'must_feature_uncovered'));
});

test('at most 5 "must" and at most 2 "should" features', () => {
  const six = model();
  for (const id of ['F5', 'F6', 'F7']) {
    const f = clone(six.mvp.features[0]);
    f.feature_id = id;
    six.mvp.features.push(f);
  }
  for (const f of six.mvp.features) f.priority = 'must'; // 7 must
  assertRejected(validate(six), 'mvp_priority_limit', '/mvp/features');
  const three = model();
  for (const i of [1, 2, 3]) three.mvp.features[i].priority = 'should'; // 3 should
  assertRejected(validate(three), 'mvp_priority_limit', '/mvp/features');
  const five = model(); // 5 must + 2 should across 7 features is the documented maximum
  for (const id of ['F5', 'F6', 'F7']) { const f = clone(five.mvp.features[0]); f.feature_id = id; five.mvp.features.push(f); }
  five.mvp.features.forEach((f, i) => { f.priority = i < 5 ? 'must' : 'should'; });
  assert.ok(!errorsOf(validate(five)).some((e) => e.code === 'mvp_priority_limit'));
});

test('journey steps are numbered 1..n without repeats or gaps; any array order is accepted', () => {
  const dup = model();
  setAt(dup, '/journeys/0/steps/1/order', 1);
  assertRejected(validate(dup), 'invalid_journey_order', '/journeys/0/steps/1/order');
  const gap = model();
  setAt(gap, '/journeys/0/steps/3/order', 7);
  assertRejected(validate(gap), 'invalid_journey_order', '/journeys/0/steps/3/order');
  const swapped = model();
  setAt(swapped, '/journeys/0/steps/0/order', 2);
  setAt(swapped, '/journeys/0/steps/1/order', 1);
  assertAccepted(validate(swapped));
});

test('workflow transitions use declared states, and state names are unique', () => {
  const from = model();
  setAt(from, '/workflows/0/transitions/0/from', 'ghost');
  assertRejected(validate(from), 'invalid_workflow_transition', '/workflows/0/transitions/0/from');
  const to = model();
  setAt(to, '/workflows/0/transitions/1/to', 'ghost');
  assertRejected(validate(to), 'invalid_workflow_transition', '/workflows/0/transitions/1/to');
  const dup = model();
  setAt(dup, '/workflows/0/states/1/name', 'new');
  assertRejected(validate(dup), 'duplicate_identifier', '/workflows/0/states/1/name');
});

test('an architecture decision must name one of its options', () => {
  const d = model();
  setAt(d, '/architecture/decisions/0/decision', 'Something else entirely');
  assertRejected(validate(d), 'decision_option_mismatch', '/architecture/decisions/0/decision');
  const embedded = model();
  setAt(embedded, '/architecture/decisions/0/decision', 'Start with a Modular monolith for now');
  assertAccepted(validate(embedded));
  const wrongCase = model();
  setAt(wrongCase, '/architecture/decisions/0/decision', 'modular monolith');
  assertRejected(validate(wrongCase), 'decision_option_mismatch', '/architecture/decisions/0/decision');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Evidence references: structure and allowed id formats
// ---------------------------------------------------------------------------------------------------------------------------------

test('evidence ids must look like E## or M## and lie in the issued ranges', () => {
  const at = (ids: string[]) => { const d = model(); setAt(d, '/opportunity/affected_users/evidence_refs', ids); return validate(d); };
  const p = '/opportunity/affected_users/evidence_refs';
  for (const bad of ['E1', 'E001', 'e01', 'X01', 'M1', 'EE01', 'E0a', ' E01', 'E01 ', '']) assertRejected(at([bad]), 'invalid_format', `${p}/0`, JSON.stringify(bad));
  for (const bad of ['E00', 'E25', 'E99', 'M00', 'M17', 'M99']) assertRejected(at([bad]), 'evidence_ref_out_of_range', `${p}/0`, bad);
  for (const good of ['E01', 'E24', 'M01', 'M16']) assertNoError(at([good]), 'evidence_ref_out_of_range', `${p}/0`, good);
  for (const good of ['E01', 'E24', 'M01', 'M16']) assertNoError(at([good]), 'invalid_format', `${p}/0`, good);
});

test('a repeated evidence id in one list is rejected', () => {
  const d = model();
  setAt(d, '/opportunity/affected_users/evidence_refs', ['E01', 'E01']);
  assertRejected(validate(d), 'duplicate_item', '/opportunity/affected_users/evidence_refs/1');
});

test('demand signals take metric ids in metric_refs and excerpt ids in excerpt_refs', () => {
  const m = model();
  setAt(m, '/market_evidence/demand_signals/0/metric_refs', ['M01', 'E01']);
  assertRejected(validate(m), 'evidence_ref_kind_mismatch', '/market_evidence/demand_signals/0/metric_refs/1');
  const e = model();
  setAt(e, '/market_evidence/demand_signals/0/excerpt_refs', ['E01', 'M02']);
  assertRejected(validate(e), 'evidence_ref_kind_mismatch', '/market_evidence/demand_signals/0/excerpt_refs/1');
});

test('with a known id set, every cited id must be one the model was shown', () => {
  const all = ['E01', 'E02', 'E03', 'E04', 'E05', 'M01', 'M02', 'M03', 'M04', 'M05'];
  assertAccepted(validate(model(), all));
  const result = validate(model(), all.filter((id) => id !== 'E03'));
  assertRejected(result, 'evidence_ref_unresolved', '/opportunity/problem_statement/evidence_refs/2');
  assert.ok(errorsOf(result).every((e) => e.code === 'evidence_ref_unresolved'));
  const d = model();
  setAt(d, '/opportunity/affected_users/evidence_refs', ['E20']);
  assertRejected(validate(d, all), 'evidence_ref_unresolved', '/opportunity/affected_users/evidence_refs/0');
});

test('without a known id set, resolution is not claimed: a well-formed id the pack never had passes', () => {
  const d = model();
  setAt(d, '/opportunity/affected_users/evidence_refs', ['E20']);
  assertAccepted(validate(d));
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Basis by path (evidence contract section 5.2)
// ---------------------------------------------------------------------------------------------------------------------------------

const V = 'verified_evidence';
const AI = 'ai_recommendation';
const H = 'hypothesis';
const U = 'unknown';
const ALL = [V, AI, H, U];

// [claim pointer, allowed bases]
const BASIS_TABLE: [string, string[]][] = [
  ['/opportunity/verdict_rationale', [AI, H]],
  ['/opportunity/problem_statement', [V, H, U]],
  ['/opportunity/affected_users', [V, H, U]],
  ['/opportunity/current_alternatives/0/how_it_falls_short', [H, U]], // suggested_category in the example
  ['/opportunity/thesis/0', [V, AI, H]],
  ['/opportunity/counter_thesis/0', [V, AI, H, U]],
  ['/market_evidence/demand_signals/0/interpretation', [V, AI, H]],
  ['/personas/0/frustrations/0', [V, H, U]],
  ['/personas/0/current_workaround', [V, H, U]],
  ['/product/positioning', [AI, H]],
  ['/product/value_proposition', [AI, H]],
  ['/product/differentiation', [AI, H]],
  ['/mvp/features/0/justification', [V, AI, H]],
  ['/commercial/business_model', [AI, H, U]],
  ['/commercial/pricing_hypotheses/0/statement', [H, U]],
  ['/commercial/market_sizing/statement', [U]],
  ['/risks/risks/0/claim', [AI, H, U]],
];

function withBasis(p: string, basis: string): BlueprintModelOutputV1 {
  const d = model();
  setAt(d, `${p}/basis`, basis);
  if (basis === V && (getAt(d, `${p}/evidence_refs`) as string[]).length === 0) setAt(d, `${p}/evidence_refs`, ['E01']);
  return d;
}

test('each claim path allows exactly the bases the evidence contract lists', () => {
  for (const [p, allowed] of BASIS_TABLE) {
    for (const basis of ALL) {
      const r = validate(withBasis(p, basis));
      if (allowed.includes(basis)) assertNoError(r, 'basis_not_allowed', `${p}/basis`, basis);
      else assertRejected(r, 'basis_not_allowed', `${p}/basis`, basis);
    }
  }
  assert.equal(BASIS_TABLE.length, 17);
});

test('a named alternative may be verified; a suggested category may not', () => {
  const p = '/opportunity/current_alternatives/0/how_it_falls_short';
  const suggested = withBasis(p, V);
  assertRejected(validate(suggested), 'basis_not_allowed', `${p}/basis`);
  const named = withBasis(p, V);
  setAt(named, '/opportunity/current_alternatives/0/kind', 'named_in_evidence');
  assertNoError(validate(named), 'basis_not_allowed', `${p}/basis`);
  const namedAi = withBasis(p, AI);
  setAt(namedAi, '/opportunity/current_alternatives/0/kind', 'named_in_evidence');
  assertRejected(validate(namedAi), 'basis_not_allowed', `${p}/basis`);
});

test('an ai_recommendation or hypothesis claim never becomes verified by citing evidence, and cannot be written as verified where disallowed', () => {
  const d = withBasis('/commercial/business_model', V);
  setAt(d, '/commercial/business_model/evidence_refs', ['E01', 'E02']);
  assertRejected(validate(d), 'basis_not_allowed', '/commercial/business_model/basis'); // anything under commercial is never verified
});

test('willingness to pay: "evidenced" needs verified_evidence citing two different excerpts; otherwise the basis is unknown', () => {
  const p = '/market_evidence/willingness_to_pay';
  const evidenced = (basis: string, refs: string[]) => {
    const d = model();
    setAt(d, `${p}/status`, 'evidenced');
    setAt(d, `${p}/summary/basis`, basis);
    setAt(d, `${p}/summary/evidence_refs`, refs);
    return validate(d);
  };
  assertAccepted(evidenced(V, ['E01', 'E04']));
  assertRejected(evidenced(V, ['E04']), 'wtp_rule_violation', `${p}/summary/evidence_refs`);
  assertRejected(evidenced(V, ['E04', 'M04']), 'wtp_rule_violation', `${p}/summary/evidence_refs`); // a metric is not an excerpt
  assertRejected(evidenced(U, ['E01', 'E04']), 'basis_not_allowed', `${p}/summary/basis`);
  assertRejected(evidenced(H, []), 'basis_not_allowed', `${p}/summary/basis`);
  for (const status of ['not_evidenced', 'unknown']) {
    const d = model();
    setAt(d, `${p}/status`, status);
    assertAccepted(validate(d));
    setAt(d, `${p}/summary/basis`, V);
    setAt(d, `${p}/summary/evidence_refs`, ['E01', 'E04']);
    assertRejected(validate(d), 'basis_not_allowed', `${p}/summary/basis`);
  }
});

test('market sizing is always "not_estimated" with the canonical statement in contract v1', () => {
  const p = '/commercial/market_sizing';
  const hypothesis = model();
  setAt(hypothesis, `${p}/status`, 'hypothesis');
  setAt(hypothesis, `${p}/assumptions`, ['Roughly 1,000 teams fit the profile']);
  assertRejected(validate(hypothesis), 'market_sizing_rule_violation', `${p}/status`);
  const reworded = model();
  setAt(reworded, `${p}/statement/text`, 'The market is probably large');
  assertRejected(validate(reworded), 'market_sizing_rule_violation', `${p}/statement/text`);
  const withAssumptions = model();
  setAt(withAssumptions, `${p}/assumptions`, ['One', 'Two', 'Three', 'Four', 'Five']);
  assertAccepted(validate(withAssumptions));
});

test('the verdict is not restricted by the model-owned document alone (sufficiency is backend-owned)', () => {
  const d = model();
  setAt(d, '/opportunity/verdict', 'pursue_mvp');
  assertAccepted(validate(d));
});
