// ProductBlueprint v1 validators: shape, strictness, bounds, malformed input, immutability and content-free errors.
// Fixtures are SYNTHETIC (the worked example in docs/blueprint-engine/product-blueprint-v1.md section 7, copied to fixtures/worked-example.json).
// Limits below are written out as literals from the document on purpose: they are an independent check on constants.ts, not a copy of it.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { BlueprintModelOutputV1 } from '../contract.ts';
import { validateBlueprintModelOutput, validateProductBlueprint } from '../validate.ts';
import {
  assertAccepted, assertNoError, assertRejected, clone, codesOf, deepFreeze, errorsOf, getAt, Json, makeList, setAt, text, validBlueprint, validModelOutput,
} from './helpers.ts';

const model = (): BlueprintModelOutputV1 => validModelOutput();

// ---------------------------------------------------------------------------------------------------------------------------------
// Acceptance, copies and mutation
// ---------------------------------------------------------------------------------------------------------------------------------

test('the documented worked example is accepted as an assembled blueprint and, without backend sections, as model output', () => {
  assertAccepted(validateProductBlueprint(validBlueprint()));
  assertAccepted(validateBlueprintModelOutput(validModelOutput()));
});

test('an accepted result is a plain copy; the input is never modified, even when frozen', () => {
  const input = deepFreeze(validBlueprint());
  const before = JSON.stringify(input);
  const r = validateProductBlueprint(input);
  assert.ok(r.ok);
  assert.notEqual(r.value, input);
  assert.deepEqual(r.value, input);
  r.value.opportunity.title = 'changed afterwards';
  assert.equal(JSON.stringify(input), before);
});

test('a rejected input is not modified either, and no value is returned', () => {
  const input = validModelOutput();
  setAt(input, '/mvp/features/0/feature_id', 'bad');
  setAt(input, '/zz_extra', 1);
  deepFreeze(input);
  const before = JSON.stringify(input);
  const r = validateBlueprintModelOutput(input);
  assert.equal(r.ok, false);
  assert.equal('value' in r, false);
  assert.equal(JSON.stringify(input), before);
});

test('an invalid blueprint is rejected as a whole: one bad field and the rest of a valid document is not returned', () => {
  const input = model();
  setAt(input, '/opportunity/title', 42);
  const r = validateBlueprintModelOutput(input);
  assert.equal(r.ok, false);
  assertRejected(r, 'invalid_type', '/opportunity/title');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Required, optional and unexpected fields (generic: every field of the worked example)
// ---------------------------------------------------------------------------------------------------------------------------------

const OPTIONAL_KEYS = new Set(['confidence', 'rationale', 'validation', 'missing_information', 'downgraded_from', 'system_response', 'guard', 'default', 'contains_personal_data', 'partial_condition', 'notes', 'retention', 'expected_volume', 'price_placeholder']);
/** `target` is optional on a non-functional requirement and required on a success metric; `rationale` is optional on a claim and required on a tech choice. */
const isOptional = (pointer: string, key: string): boolean => {
  if (key === 'target') return pointer.startsWith('/architecture/non_functional/');
  if (key === 'rationale') return !pointer.startsWith('/architecture/tech_choices/');
  return OPTIONAL_KEYS.has(key);
};

/** Every (pointer, key) pair of every object in a document. */
function eachObjectKey(node: unknown, pointer: string, visit: (pointer: string, key: string) => void): void {
  if (Array.isArray(node)) { node.forEach((v, i) => eachObjectKey(v, `${pointer}/${i}`, visit)); return; }
  if (node === null || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    visit(pointer, k);
    eachObjectKey(v, `${pointer}/${k}`, visit);
  }
}

test('removing any required field is rejected with missing_required_field at that field', () => {
  const pairs: [string, string][] = [];
  eachObjectKey(model(), '', (p, k) => { if (!isOptional(p, k)) pairs.push([p, k]); });
  assert.ok(pairs.length > 300, `expected a broad sweep, got ${pairs.length}`);
  for (const [p, k] of pairs) {
    const doc = model();
    setAt(doc, `${p}/${k}`, undefined);
    assertRejected(validateBlueprintModelOutput(doc), 'missing_required_field', `${p}/${k}`);
  }
});

test('removing any optional field keeps the blueprint valid', () => {
  const pairs: [string, string][] = [];
  eachObjectKey(model(), '', (p, k) => { if (isOptional(p, k)) pairs.push([p, k]); });
  assert.ok(pairs.length >= 30, `expected many optional fields in the example, got ${pairs.length}`);
  for (const [p, k] of pairs) {
    const doc = model();
    setAt(doc, `${p}/${k}`, undefined);
    assertAccepted(validateBlueprintModelOutput(doc), `without ${p}/${k}`);
  }
});

test('optional fields that the example leaves out are accepted when present', () => {
  const doc = model();
  setAt(doc, '/database/tables/0/retention', 'Kept until the team is deleted');
  setAt(doc, '/database/tables/0/expected_volume', 'small');
  setAt(doc, '/database/tables/0/columns/0/contains_personal_data', false);
  setAt(doc, '/database/tables/2/indexes/0/partial_condition', 'only reports that are still open');
  setAt(doc, '/opportunity/thesis/0/confidence', 'low');
  setAt(doc, '/architecture/non_functional/0/target', 'Under two seconds');
  assertAccepted(validateBlueprintModelOutput(doc));
});

function objectPointers(node: unknown, pointer: string, out: string[]): string[] {
  if (Array.isArray(node)) { node.forEach((v, i) => objectPointers(v, `${pointer}/${i}`, out)); return out; }
  if (node === null || typeof node !== 'object') return out;
  out.push(pointer);
  for (const [k, v] of Object.entries(node)) objectPointers(v, `${pointer}/${k}`, out);
  return out;
}

test('an unexpected field anywhere is rejected at its parent object, with a count and never the key', () => {
  const objectPointers_ = objectPointers(model(), '', []);
  assert.ok(objectPointers_.length > 100, `expected a broad sweep, got ${objectPointers_.length}`);
  for (const p of objectPointers_) {
    const doc = model();
    setAt(doc, `${p}/ZZ_UNEXPECTED_KEY_NAME`, 1);
    const r = validateBlueprintModelOutput(doc);
    assertRejected(r, 'unexpected_key', p);
    assert.ok(!JSON.stringify(errorsOf(r)).includes('ZZ_UNEXPECTED_KEY_NAME'), `key echoed for ${p}`);
  }
});

test('a __proto__ key from JSON.parse is an unexpected key, not a prototype change', () => {
  const doc = JSON.parse(JSON.stringify(model()).replace('{"schema_version"', '{"__proto__":{"polluted":true},"schema_version"')) as unknown;
  const r = validateBlueprintModelOutput(doc);
  assertRejected(r, 'unexpected_key', '');
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test('backend-owned sections in model output are rejected with their own code', () => {
  for (const key of ['meta', 'evidence_index', 'verification']) {
    const doc = model() as unknown as Record<string, unknown>;
    doc[key] = key === 'evidence_index' ? [] : {};
    assertRejected(validateBlueprintModelOutput(doc), 'backend_owned_key_forbidden', `/${key}`);
  }
});

test('downgraded_from is rejected in model output, wherever a claim appears', () => {
  for (const p of ['/opportunity/problem_statement', '/opportunity/thesis/0', '/risks/risks/0/claim', '/commercial/market_sizing/statement']) {
    const doc = model();
    setAt(doc, `${p}/downgraded_from`, 'hypothesis');
    assertRejected(validateBlueprintModelOutput(doc), 'downgraded_from_forbidden', `${p}/downgraded_from`);
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Types and enums: no coercion, ever
// ---------------------------------------------------------------------------------------------------------------------------------

function scalarLeaves(node: unknown, pointer: string, out: { pointer: string; value: unknown }[]): void {
  if (Array.isArray(node)) { node.forEach((v, i) => scalarLeaves(v, `${pointer}/${i}`, out)); return; }
  if (node !== null && typeof node === 'object') { for (const [k, v] of Object.entries(node)) scalarLeaves(v, `${pointer}/${k}`, out); return; }
  out.push({ pointer, value: node });
}

test('every scalar field rejects a value of the wrong type and null (nothing is coerced)', () => {
  const leaves: { pointer: string; value: unknown }[] = [];
  scalarLeaves(model(), '', leaves);
  assert.ok(leaves.length > 400, `expected a broad sweep, got ${leaves.length}`);
  for (const { pointer, value } of leaves) {
    const wrong = typeof value === 'string' ? 12345 : typeof value === 'number' ? String(value) : 'true';
    for (const bad of [wrong, null]) {
      const doc = model();
      setAt(doc, pointer, bad);
      assertRejected(validateBlueprintModelOutput(doc), 'invalid_type', pointer, `value ${String(bad)}`);
    }
  }
});

test('numeric strings, boolean strings and 0/1 are not coerced', () => {
  const doc = model();
  setAt(doc, '/mvp/scope_assessment/estimated_build_weeks/min', '3');
  setAt(doc, '/architecture/integrations/0/required_for_mvp', 1);
  const r = validateBlueprintModelOutput(doc);
  assertRejected(r, 'invalid_type', '/mvp/scope_assessment/estimated_build_weeks/min');
  assertRejected(r, 'invalid_type', '/architecture/integrations/0/required_for_mvp');
});

const ENUM_FIELDS: string[] = [
  '/opportunity/verdict', '/opportunity/current_alternatives/0/kind', '/opportunity/thesis/0/basis', '/opportunity/thesis/0/confidence',
  '/market_evidence/sufficiency_self_assessment', '/market_evidence/demand_signals/0/strength', '/market_evidence/willingness_to_pay/status',
  '/personas/0/priority', '/personas/0/buying_role', '/product/product_type', '/mvp/features/0/priority', '/mvp/features/0/complexity',
  '/mvp/scope_assessment/estimate_confidence', '/journeys/0/steps/0/actor', '/architecture/style', '/architecture/tech_choices/0/area',
  '/architecture/tech_choices/0/reversibility', '/architecture/integrations/0/direction', '/architecture/non_functional/0/category',
  '/database/engine', '/database/tenancy_model', '/database/tables/0/columns/0/data_type', '/database/tables/2/foreign_keys/0/on_delete',
  '/database/tables/2/indexes/0/method', '/database/tables/0/rls/policies/0/operation', '/database/tables/0/rls/policies/0/role',
  '/database/tables/0/expected_volume', '/implementation/tasks/0/type', '/implementation/tasks/0/size', '/testing/acceptance_criteria/0/test_level',
  '/testing/validation_experiments/0/method', '/testing/validation_experiments/0/effort', '/commercial/pricing_hypotheses/0/model',
  '/commercial/market_sizing/status', '/risks/risks/0/category', '/risks/risks/0/likelihood', '/risks/risks/0/impact', '/risks/assumptions/0/criticality',
];

test('every enum field rejects a value outside its list, including a different letter case', () => {
  for (const p of ENUM_FIELDS) {
    const existing = getAt(model(), p);
    for (const bad of ['not_a_value', typeof existing === 'string' ? existing.toUpperCase() + '_' : 'X', '']) {
      const doc = model();
      setAt(doc, p, bad);
      assertRejected(validateBlueprintModelOutput(doc), 'invalid_enum', p, `value "${bad}"`);
    }
  }
});

test('literal enum values are accepted exactly: the documented lists', () => {
  const accepted: [string, string[]][] = [
    ['/opportunity/verdict', ['pursue_mvp', 'validate_first', 'insufficient_evidence', 'not_recommended']],
    ['/database/tables/2/foreign_keys/0/on_delete', ['cascade', 'restrict', 'set null', 'no action']],
    ['/database/tables/2/indexes/0/method', ['btree', 'gin', 'gist', 'hash', 'brin']],
    ['/implementation/tasks/0/size', ['XS', 'S', 'M', 'L']],
    ['/mvp/features/0/complexity', ['S', 'M', 'L']],
  ];
  for (const [p, values] of accepted) {
    for (const v of values) {
      const doc = model();
      setAt(doc, p, v);
      assertNoError(validateBlueprintModelOutput(doc), 'invalid_enum', p, v);
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Schema version
// ---------------------------------------------------------------------------------------------------------------------------------

test('an unsupported schema version is the only error reported', () => {
  for (const v of ['product-blueprint.v2', 'product-blueprint.v0', 'PRODUCT-BLUEPRINT.V1', '1', '']) {
    const doc = model();
    setAt(doc, '/schema_version', v);
    const r = validateBlueprintModelOutput(doc);
    assert.deepEqual(codesOf(r), ['unsupported_schema_version']);
    assertRejected(r, 'unsupported_schema_version', '/schema_version');
    assertRejected(validateProductBlueprint({ ...validBlueprint(), schema_version: v }), 'unsupported_schema_version', '/schema_version');
  }
});

test('schema_version missing or not a string is an ordinary shape error', () => {
  const missing = model();
  setAt(missing, '/schema_version', undefined);
  assertRejected(validateBlueprintModelOutput(missing), 'missing_required_field', '/schema_version');
  for (const bad of [1, null, true, ['product-blueprint.v1'], {}]) {
    const doc = model();
    setAt(doc, '/schema_version', bad);
    assertRejected(validateBlueprintModelOutput(doc), 'invalid_type', '/schema_version');
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// List sizes (min and max boundaries, from the document)
// ---------------------------------------------------------------------------------------------------------------------------------

// [pointer, min, max, sample item for lists the example leaves empty]
const LISTS: [string, number, number, Json?][] = [
  ['/opportunity/current_alternatives', 0, 6], ['/opportunity/thesis', 1, 3], ['/opportunity/counter_thesis', 1, 3],
  ['/market_evidence/demand_signals', 1, 6], ['/market_evidence/evidence_gaps', 1, 6],
  ['/personas', 1, 3], ['/personas/0/goals', 1, 4], ['/personas/0/frustrations', 1, 4],
  ['/product/capabilities', 3, 8], ['/product/non_goals', 2, 8], ['/product/constraints', 0, 8], ['/product/success_metrics', 2, 5],
  ['/mvp/features', 3, 7], ['/mvp/exclusions', 2, 8],
  ['/journeys', 1, 4], ['/journeys/0/steps', 3, 10], ['/journeys/0/failure_modes', 1, 4],
  ['/workflows', 0, 2], ['/workflows/0/states', 3, 8], ['/workflows/0/transitions', 2, 16],
  ['/architecture/components', 3, 10], ['/architecture/tech_choices', 4, 10], ['/architecture/tech_choices/0/alternatives', 1, 3],
  ['/architecture/integrations', 0, 6], ['/architecture/non_functional', 3, 9], ['/architecture/decisions', 2, 6],
  ['/architecture/decisions/0/options', 2, 3], ['/architecture/decisions/0/options/0/pros', 1, 3], ['/architecture/decisions/0/options/0/cons', 1, 3],
  ['/database/conventions', 0, 6], ['/database/tables', 3, 8], ['/database/tables/2/columns', 3, 16], ['/database/tables/1/primary_key', 1, 3],
  ['/database/tables/2/indexes', 0, 8], ['/database/tables/2/rls/policies', 0, 6], ['/database/migration_considerations', 0, 6], ['/database/open_questions', 0, 6],
  ['/implementation/phases', 2, 5], ['/implementation/phases/0/exit_criteria', 1, 4], ['/implementation/tasks', 8, 30], ['/implementation/tasks/0/deliverables', 1, 4],
  ['/testing/acceptance_criteria', 4, 40], ['/testing/quality_gates', 2, 6], ['/testing/validation_experiments', 2, 6], ['/testing/validation_experiments/0/tests', 1, 4],
  ['/commercial/pricing_hypotheses', 0, 3], ['/commercial/market_sizing/assumptions', 0, 5, 'An assumption'], ['/commercial/go_to_market', 2, 6],
  ['/commercial/validation_first_actions', 2, 5], ['/commercial/outreach_ethics', 1, 4],
  ['/risks/risks', 4, 10], ['/risks/assumptions', 3, 10], ['/risks/unknowns', 2, 10], ['/risks/evidence_limitations', 1, 6],
];

test('every list enforces its documented minimum and maximum (and accepts both boundaries)', () => {
  for (const [p, min, max, sample] of LISTS) {
    const at = (n: number) => { const d = model(); makeList(d, p, n, sample); return validateBlueprintModelOutput(d); };
    if (min > 0) assertRejected(at(min - 1), 'list_too_short', p, `${min - 1} items`);
    assertNoError(at(min), 'list_too_short', p, `${min} items`);
    assertNoError(at(min), 'list_too_long', p, `${min} items`);
    assertNoError(at(max), 'list_too_short', p, `${max} items`);
    assertNoError(at(max), 'list_too_long', p, `${max} items`);
    assertRejected(at(max + 1), 'list_too_long', p, `${max + 1} items`);
  }
});

test('a list that is not a list is rejected', () => {
  for (const p of ['/personas', '/mvp/features', '/database/tables', '/risks/risks']) {
    for (const bad of [{}, 'x', 1, null]) {
      const d = model();
      setAt(d, p, bad);
      assertRejected(validateBlueprintModelOutput(d), 'invalid_type', p);
    }
  }
});

test('evidence_refs: verified_evidence needs 1 to 4 ids, every other basis allows 0 to 4', () => {
  const refs = (p: string, ids: string[]) => { const d = model(); setAt(d, `${p}/evidence_refs`, ids); return validateBlueprintModelOutput(d); };
  const verified = '/opportunity/problem_statement'; // basis verified_evidence in the example
  assertRejected(refs(verified, []), 'list_too_short', `${verified}/evidence_refs`);
  assertNoError(refs(verified, ['E01']), 'list_too_short', `${verified}/evidence_refs`);
  assertNoError(refs(verified, ['E01', 'E02', 'E03', 'E04']), 'list_too_long', `${verified}/evidence_refs`);
  assertRejected(refs(verified, ['E01', 'E02', 'E03', 'E04', 'E05']), 'list_too_long', `${verified}/evidence_refs`);
  const other = '/opportunity/affected_users'; // hypothesis
  assertNoError(refs(other, []), 'list_too_short', `${other}/evidence_refs`);
  assertNoError(refs(other, ['E01', 'E02', 'E03', 'E04']), 'list_too_long', `${other}/evidence_refs`);
  assertRejected(refs(other, ['E01', 'E02', 'E03', 'E04', 'E05']), 'list_too_long', `${other}/evidence_refs`);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// String caps (characters, counted as Unicode code points)
// ---------------------------------------------------------------------------------------------------------------------------------

const STRINGS: [string, number][] = [
  ['/opportunity/title', 120], ['/opportunity/one_line_summary', 200], ['/opportunity/thesis/0/text', 400], ['/opportunity/thesis/0/rationale', 300],
  ['/opportunity/thesis/0/validation', 300], ['/opportunity/thesis/0/missing_information', 300], ['/opportunity/current_alternatives/0/name', 80],
  ['/market_evidence/evidence_gaps/0/description', 400], ['/market_evidence/evidence_gaps/0/impact', 300], ['/market_evidence/evidence_gaps/0/how_to_close', 300],
  ['/personas/0/name', 80], ['/personas/0/role', 80], ['/personas/0/context', 300], ['/personas/0/goals/0', 160],
  ['/product/product_name', 80], ['/product/capabilities/0/name', 80], ['/product/capabilities/0/description', 300], ['/product/non_goals/0', 400],
  ['/product/success_metrics/0/target', 160], ['/product/success_metrics/0/how_measured', 200],
  ['/mvp/features/0/name', 80], ['/mvp/features/0/description', 300], ['/mvp/features/0/user_value', 200], ['/mvp/exclusions/0/reason', 300], ['/mvp/exclusions/0/revisit_when', 200],
  ['/mvp/scope_assessment/team_assumption', 200], ['/mvp/scope_assessment/complexity_notes', 400],
  ['/journeys/0/goal', 200], ['/journeys/0/steps/0/action', 200], ['/journeys/0/steps/0/system_response', 200], ['/journeys/0/failure_modes/0', 160],
  ['/workflows/0/states/0/description', 160], ['/workflows/0/transitions/0/trigger', 120], ['/workflows/0/transitions/0/guard', 160],
  ['/architecture/summary', 400], ['/architecture/components/0/responsibility', 200], ['/architecture/components/0/technology', 80],
  ['/architecture/tech_choices/0/rationale', 300], ['/architecture/tech_choices/0/trade_offs', 300], ['/architecture/tech_choices/0/alternatives/0/why_not_chosen', 200],
  ['/architecture/integrations/0/failure_handling', 200], ['/architecture/non_functional/0/target', 120], ['/architecture/non_functional/0/approach', 300],
  ['/architecture/decisions/0/context', 300], ['/architecture/decisions/0/consequences', 300], ['/architecture/decisions/0/options/0/pros/0', 160], ['/architecture/deployment_notes', 400],
  ['/database/tenancy_rationale', 300], ['/database/conventions/0', 400], ['/database/tables/0/purpose', 200], ['/database/tables/0/columns/0/description', 160],
  ['/database/tables/0/columns/0/default', 80], ['/database/tables/2/indexes/0/partial_condition', 120], ['/database/tables/2/indexes/0/purpose', 160],
  ['/database/tables/0/rls/policies/0/rule', 200], ['/database/tables/2/rls/notes', 300], ['/database/tables/0/retention', 160], ['/database/tables/0/check_constraints/0/rule', 400],
  ['/database/migration_considerations/0', 400], ['/database/open_questions/0', 400],
  ['/implementation/team_assumption', 200], ['/implementation/tasks/0/title', 100], ['/implementation/tasks/0/description', 300], ['/implementation/tasks/0/deliverables/0', 160],
  ['/implementation/phases/0/name', 80], ['/implementation/phases/0/goal', 200], ['/implementation/phases/0/exit_criteria/0', 160],
  ['/testing/strategy', 400], ['/testing/acceptance_criteria/0/given', 200], ['/testing/acceptance_criteria/0/when', 200], ['/testing/acceptance_criteria/0/then', 200],
  ['/testing/quality_gates/0', 160], ['/testing/validation_experiments/0/description', 300], ['/testing/validation_experiments/0/success_threshold', 160],
  ['/commercial/pricing_hypotheses/0/price_placeholder', 80], ['/commercial/pricing_hypotheses/0/how_to_validate', 200], ['/commercial/go_to_market/0/timeframe', 40],
  ['/commercial/go_to_market/0/action', 200], ['/commercial/go_to_market/0/expected_learning', 200], ['/commercial/validation_first_actions/0', 160], ['/commercial/outreach_ethics/0', 160],
  ['/risks/risks/0/mitigation', 300], ['/risks/assumptions/0/statement', 300], ['/risks/assumptions/0/how_to_validate', 200],
  ['/risks/unknowns/0/question', 200], ['/risks/unknowns/0/why_it_matters', 200], ['/risks/unknowns/0/how_to_resolve', 200], ['/risks/evidence_limitations/0', 200],
];

test('every capped string accepts exactly its maximum and rejects one more character', () => {
  for (const [p, max] of STRINGS) {
    const withText = (n: number) => { const d = model(); setAt(d, p, text(n)); return validateBlueprintModelOutput(d); };
    assertNoError(withText(max), 'string_too_long', p, `${max} chars`);
    assertRejected(withText(max + 1), 'string_too_long', p, `${max + 1} chars`);
  }
});

test('length is counted in characters (code points), not UTF-16 units: 120 emoji fit a 120-character title', () => {
  const ok = model();
  setAt(ok, '/opportunity/title', '😀'.repeat(120));
  assertNoError(validateBlueprintModelOutput(ok), 'string_too_long', '/opportunity/title');
  const tooLong = model();
  setAt(tooLong, '/opportunity/title', '😀'.repeat(121));
  assertRejected(validateBlueprintModelOutput(tooLong), 'string_too_long', '/opportunity/title');
});

test('blank text, control characters and unpaired surrogates are rejected; tab and newline are allowed', () => {
  const at = (v: string) => { const d = model(); setAt(d, '/opportunity/title', v); return validateBlueprintModelOutput(d); };
  assertRejected(at(''), 'string_blank', '/opportunity/title');
  assertRejected(at('   \t\n'), 'string_blank', '/opportunity/title');
  assertRejected(at('has\u0000nul'), 'string_invalid_characters', '/opportunity/title');
  assertRejected(at('bell\u0007'), 'string_invalid_characters', '/opportunity/title');
  assertRejected(at('half \ud83d pair'), 'string_invalid_characters', '/opportunity/title');
  assertRejected(at('half \ude00 pair'), 'string_invalid_characters', '/opportunity/title');
  assertNoError(at('two\tcolumns and\na new line'), 'string_invalid_characters', '/opportunity/title');
  assertNoError(at('a full pair 😀'), 'string_invalid_characters', '/opportunity/title');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Numeric ranges, scope estimate
// ---------------------------------------------------------------------------------------------------------------------------------

test('estimated_build_weeks: 1 <= min <= max <= 26, boundaries inclusive', () => {
  const weeks = (min: number, max: number) => { const d = model(); setAt(d, '/mvp/scope_assessment/estimated_build_weeks', { min, max }); return validateBlueprintModelOutput(d); };
  assertAccepted(weeks(1, 1));
  assertAccepted(weeks(1, 26));
  assertAccepted(weeks(26, 26));
  assertRejected(weeks(0, 5), 'number_out_of_range', '/mvp/scope_assessment/estimated_build_weeks/min');
  assertRejected(weeks(1, 27), 'number_out_of_range', '/mvp/scope_assessment/estimated_build_weeks/max');
  assertRejected(weeks(27, 27), 'number_out_of_range', '/mvp/scope_assessment/estimated_build_weeks/min');
  assertRejected(weeks(-1, 5), 'number_out_of_range', '/mvp/scope_assessment/estimated_build_weeks/min');
  assertRejected(weeks(8, 4), 'estimate_range_invalid', '/mvp/scope_assessment/estimated_build_weeks');
  assertRejected(validateBlueprintModelOutput((() => { const d = model(); setAt(d, '/mvp/scope_assessment/estimated_build_weeks/min', 2); setAt(d, '/mvp/scope_assessment/estimated_build_weeks/zz', 1); return d; })()), 'unexpected_key', '/mvp/scope_assessment/estimated_build_weeks');
});

test('whole-number weeks are not required by the documents, so a fractional estimate is accepted', () => {
  const d = model();
  setAt(d, '/mvp/scope_assessment/estimated_build_weeks', { min: 2.5, max: 6.5 });
  assertAccepted(validateBlueprintModelOutput(d));
});

test('a low-confidence estimate is valid and is not treated as an error', () => {
  const d = model();
  setAt(d, '/mvp/scope_assessment/estimate_confidence', 'low');
  assertAccepted(validateBlueprintModelOutput(d));
});

test('the scope estimate must state its team assumption, confidence and notes', () => {
  for (const key of ['team_assumption', 'estimate_confidence', 'complexity_notes', 'estimated_build_weeks']) {
    const d = model();
    setAt(d, `/mvp/scope_assessment/${key}`, undefined);
    assertRejected(validateBlueprintModelOutput(d), 'missing_required_field', `/mvp/scope_assessment/${key}`);
  }
  const blank = model();
  setAt(blank, '/mvp/scope_assessment/team_assumption', '  ');
  assertRejected(validateBlueprintModelOutput(blank), 'string_blank', '/mvp/scope_assessment/team_assumption');
  const missingBlock = model();
  setAt(missingBlock, '/mvp/scope_assessment', undefined);
  assertRejected(validateBlueprintModelOutput(missingBlock), 'missing_required_field', '/mvp/scope_assessment');
});

test('journey step order must be a whole number from 1 to 10', () => {
  const order = (v: number) => { const d = model(); setAt(d, '/journeys/0/steps/0/order', v); return validateBlueprintModelOutput(d); };
  assertRejected(order(0), 'number_out_of_range', '/journeys/0/steps/0/order');
  assertRejected(order(11), 'number_out_of_range', '/journeys/0/steps/0/order');
  assertRejected(order(1.5), 'invalid_integer', '/journeys/0/steps/0/order');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Malformed and hostile inputs: no unhandled exception, useful paths
// ---------------------------------------------------------------------------------------------------------------------------------

test('non-object inputs are rejected at the root without throwing', () => {
  for (const bad of [null, undefined, 'a string', 42, true, [], [1, 2], () => 1, Symbol('x'), 10n, new Date(0), new Map(), NaN, {}]) {
    for (const fn of [validateBlueprintModelOutput, validateProductBlueprint]) {
      const r = fn(bad);
      assert.equal(r.ok, false);
      assert.ok(Array.isArray(r.ok ? [] : r.errors));
    }
  }
  assertRejected(validateBlueprintModelOutput(null), 'invalid_type', '');
  assertRejected(validateBlueprintModelOutput([]), 'invalid_type', '');
  assertRejected(validateBlueprintModelOutput({}), 'missing_required_field', '/opportunity');
});

test('values that are not JSON are rejected at their position: undefined, NaN, Infinity, functions, symbols, bigint, class instances, sparse arrays', () => {
  const cases: [string, unknown][] = [
    ['/opportunity/title', undefined], ['/mvp/scope_assessment/estimated_build_weeks/min', NaN], ['/mvp/scope_assessment/estimated_build_weeks/max', Infinity],
    ['/opportunity/one_line_summary', () => 'x'], ['/personas/0/name', Symbol('s')], ['/personas/0/role', 10n], ['/product/product_name', new Date(0)],
    ['/product/non_goals', new Array(3)],
  ];
  for (const [p, bad] of cases) {
    const d = model();
    setAt(d, p, bad);
    const r = validateBlueprintModelOutput(d);
    assert.equal(r.ok, false, p);
    assert.ok(errorsOf(r).some((e) => e.path === p || e.path.startsWith(`${p}/`)), `no error at ${p}: ${JSON.stringify(errorsOf(r))}`);
  }
});

test('an accessor property is rejected, not evaluated twice', () => {
  const d = model() as unknown as Record<string, unknown>;
  let reads = 0;
  Object.defineProperty(d, 'opportunity', { enumerable: true, get() { reads++; return model().opportunity; } });
  const r = validateBlueprintModelOutput(d);
  assertRejected(r, 'invalid_type', '/opportunity');
  assert.ok(reads === 0);
});

test('a circular reference does not hang or throw', () => {
  const d = model() as unknown as Record<string, unknown>;
  d.zz_cycle = d;
  const r = validateBlueprintModelOutput(d);
  assert.equal(r.ok, false);
  const nested = model();
  (nested.personas[0] as unknown as Record<string, unknown>).goals = [nested];
  assert.equal(validateBlueprintModelOutput(nested).ok, false);
});

test('a throwing Proxy yields a content-free internal error instead of an exception', () => {
  const hostile = new Proxy({}, { ownKeys() { throw new Error('SECRET_PROXY_TEXT'); }, getPrototypeOf() { throw new Error('SECRET_PROXY_TEXT'); } });
  const r = validateBlueprintModelOutput(hostile);
  assertRejected(r, 'validator_internal_error', '');
  assert.ok(!JSON.stringify(errorsOf(r)).includes('SECRET_PROXY_TEXT'));
});

test('absurdly nested values are cut off and rejected', () => {
  let deep: unknown = 'leaf';
  for (let i = 0; i < 200; i++) deep = [deep];
  const d = model();
  setAt(d, '/product/non_goals', [deep, 'second non-goal']);
  const r = validateBlueprintModelOutput(d);
  assertRejected(r, 'invalid_type', '/product/non_goals/0');
});

test('inputs over the size cap or the node cap are rejected up front', () => {
  const big = model();
  setAt(big, '/product/non_goals', [text(130_000), text(130_000), text(130_000)]);
  assertRejected(validateBlueprintModelOutput(big), 'input_too_large', '');
  const wide = model();
  setAt(wide, '/product/non_goals', new Array(60_000).fill('a'));
  assertRejected(validateBlueprintModelOutput(wide), 'input_too_large', '');
});

test('error reporting is capped and says so', () => {
  const d = model();
  for (let i = 0; i < 300; i++) (d as unknown as Record<string, unknown>)[`zz_${i}`] = 1;
  const doc = clone(d);
  const many = { ...doc, product: { ...doc.product } } as unknown as Record<string, unknown>;
  for (const k of Object.keys(doc)) if (k !== 'schema_version') many[k] = 12345; // every section the wrong type: one error each
  const r = validateBlueprintModelOutput(many);
  assert.equal(r.ok, false);
  assert.ok(errorsOf(r).length <= 100);
  const bad = model();
  makeList(bad, '/risks/risks', 10);
  for (let i = 0; i < 10; i++) for (const k of ['category', 'claim', 'likelihood', 'impact', 'mitigation']) setAt(bad, `/risks/risks/${i}/${k}`, 7);
  for (let i = 0; i < 10; i++) setAt(bad, `/risks/risks/${i}/risk_id`, 7);
  assert.equal(validateBlueprintModelOutput(bad).ok, false);
});

test('a deterministic mutation sweep never throws and never accepts a damaged document', () => {
  let seed = 20260715;
  const rand = (n: number): number => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed % n; };
  const junk: unknown[] = [null, undefined, 0, -1, 1e308, NaN, '', ' ', 'x'.repeat(5000), [], {}, [[]], { a: 1 }, true, 'E99', 'DROP TABLE x', '\u0000'];
  const leaves: { pointer: string; value: unknown }[] = [];
  scalarLeaves(model(), '', leaves);
  for (let i = 0; i < 400; i++) {
    const { pointer, value } = leaves[rand(leaves.length)];
    const replacement = junk[rand(junk.length)];
    if (JSON.stringify(replacement) === JSON.stringify(value)) continue;
    const d = model();
    setAt(d, pointer, replacement);
    const r = validateBlueprintModelOutput(d);
    assert.ok(typeof r.ok === 'boolean');
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Errors never contain text from the input
// ---------------------------------------------------------------------------------------------------------------------------------

test('no error echoes input text: not a value, a key, an identifier, a reference or an enum', () => {
  const MARK = 'ZZ_SECRET_MARKER_91';
  const d = model();
  setAt(d, '/opportunity/title', `${MARK} ${text(200)}`);                       // too long
  setAt(d, '/opportunity/verdict', MARK);                                       // bad enum
  setAt(d, '/mvp/features/0/feature_id', MARK);                                 // bad id
  setAt(d, '/mvp/features/1/persona_ids', [MARK]);                              // bad reference format
  setAt(d, '/mvp/features/2/depends_on', ['F77']);                              // unresolved reference
  setAt(d, `/${MARK}`, MARK);                                                   // unexpected key
  setAt(d, '/opportunity/thesis/0/evidence_refs', [MARK, 'E01', 'E01']);        // bad evidence ids
  setAt(d, '/database/tables/0/columns/0/data_type', MARK);                     // bad column type
  setAt(d, '/product/product_name', 5);                                         // type
  const r = validateBlueprintModelOutput(d);
  assert.equal(r.ok, false);
  assert.ok(errorsOf(r).length >= 6);
  assert.ok(!JSON.stringify(errorsOf(r)).includes(MARK), 'an error contains input text');
  assert.ok(!JSON.stringify(errorsOf(r)).includes('F77'), 'an error contains a referenced id');
});

test('every error has a code, a JSON Pointer path and a message', () => {
  const d = model();
  setAt(d, '/opportunity/title', 5);
  setAt(d, '/zz', 1);
  for (const e of errorsOf(validateBlueprintModelOutput(d))) {
    assert.match(e.code, /^[a-z_]+$/);
    assert.match(e.path, /^(\/[^/~]*(~[01][^/~]*)*)*$/);
    assert.ok(e.message.length > 10);
  }
});
