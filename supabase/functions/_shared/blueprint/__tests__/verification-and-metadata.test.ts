// Review corrections to Phase A2:
//   1. rejection-only verification semantics (status "verified", no repairs)
//   2. every documented verification check present exactly once and passed
//   3. disclaimers are fixed backend text
//   4. cluster metrics belong to meta.cluster_id
//   5. database rules: what the approved documentation requires, and what it does not
//   6. downgraded_from is rejected in the assembled blueprint (Phase A2 policy), and still in model output
// Each correction has positive and negative tests. The worked example stays valid and unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ACCEPTED_VERIFICATION_STATUS, ESTIMATE_DISCLAIMER, FIXED_DISCLAIMERS, REPAIR_ACTION, REQUIRED_VERIFICATION_CHECKS } from '../constants.ts';
import type { ProductBlueprintV1 } from '../contract.ts';
import { validateBlueprintModelOutput, validateProductBlueprint } from '../validate.ts';
import { assertAccepted, assertNoError, assertRejected, deepFreeze, errorsOf, getAt, setAt, validBlueprint, validModelOutput, WORKED_EXAMPLE_DOC } from './helpers.ts';

const bp = (): ProductBlueprintV1 => validBlueprint();
const validate = (d: unknown) => validateProductBlueprint(d);
const EVIDENCE_DOC = new URL('../../../../../docs/blueprint-engine/evidence-contract.md', import.meta.url);

test('the worked example is still valid and unchanged by these corrections', () => {
  assertAccepted(validate(bp()));
  const blocks = [...readFileSync(WORKED_EXAMPLE_DOC, 'utf8').matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  assert.deepEqual(bp(), JSON.parse(blocks[0]));
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 1. Rejection-only verification semantics
// ---------------------------------------------------------------------------------------------------------------------------------

test('status must be "verified"; "verified_with_repairs" is rejected (a Phase A2 policy narrowing the documented type)', () => {
  assert.equal(ACCEPTED_VERIFICATION_STATUS, 'verified');
  assert.equal(getAt(bp(), '/verification/status'), 'verified');
  assertAccepted(validate(bp()));
  const d = bp();
  setAt(d, '/verification/status', 'verified_with_repairs');
  assertRejected(validate(d), 'verification_status_not_allowed', '/verification/status');
  assertNoError(validate(d), 'verification_repairs_not_allowed', '/verification/repairs'); // repairs are still empty
});

test('repairs must be empty: every documented repair action is rejected', () => {
  assert.deepEqual(getAt(bp(), '/verification/repairs'), []);
  for (const action of REPAIR_ACTION) {
    const d = bp();
    setAt(d, '/verification/repairs', [{ path: '/opportunity/thesis/0/text', action, reason: 'A fixed backend reason' }]);
    assertRejected(validate(d), 'verification_repairs_not_allowed', '/verification/repairs', action);
  }
});

test('status and repairs are judged independently; both problems are reported together', () => {
  const d = bp();
  setAt(d, '/verification/status', 'verified_with_repairs');
  setAt(d, '/verification/repairs', [{ path: '', action: 'reclassified', reason: 'A fixed backend reason' }]);
  const r = validate(d);
  assertRejected(r, 'verification_status_not_allowed', '/verification/status');
  assertRejected(r, 'verification_repairs_not_allowed', '/verification/repairs');
});

test('an unknown status is still an ordinary enum error, not the policy error', () => {
  const d = bp();
  setAt(d, '/verification/status', 'rejected');
  const r = validate(d);
  assertRejected(r, 'invalid_enum', '/verification/status');
  assert.ok(!errorsOf(r).some((e) => e.code === 'verification_status_not_allowed'));
});

test('a malformed repair record is a shape error and is reported before the policy rule', () => {
  const d = bp();
  setAt(d, '/verification/repairs', [{ path: 'not-a-pointer', action: 'dropped_ref', reason: 'A fixed backend reason' }]);
  const r = validate(d);
  assertRejected(r, 'invalid_format', '/verification/repairs/0/path');
  assert.ok(!errorsOf(r).some((e) => e.code === 'verification_repairs_not_allowed'), 'tiers: shape first');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 2. Required verification checks
// ---------------------------------------------------------------------------------------------------------------------------------

const NAMES = ['json_parse', 'schema_shape', 'required_fields', 'enums', 'size_caps', 'identifier_integrity', 'evidence_ref_resolution', 'basis_rules',
  'name_and_number_grounding', 'willingness_to_pay_rule', 'commercial_rules', 'no_executable_sql', 'no_urls'];

test('the required checks are exactly the 13 names the contract defines, and the evidence contract section 5.1 records each of them', () => {
  assert.deepEqual([...REQUIRED_VERIFICATION_CHECKS], NAMES);
  const contract = readFileSync(WORKED_EXAMPLE_DOC, 'utf8');
  const typeBlock = contract.slice(contract.indexOf('export type VerificationCheckName'), contract.indexOf('export interface VerificationCheck {'));
  assert.deepEqual([...typeBlock.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]), NAMES);
  const evidence = readFileSync(EVIDENCE_DOC, 'utf8');
  const steps = evidence.slice(evidence.indexOf('### 5.1 Steps'), evidence.indexOf('### 5.2 Allowed basis by path'));
  assert.ok(steps.includes('Each step names') || evidence.includes('Each step names the `VerificationCheckName` it records'));
  for (const n of NAMES) assert.ok(steps.includes(`\`${n}\``), `${n} is not in the section 5.1 table`);
});

test('the example carries all 13 checks once each, all passed, and is accepted; order does not matter', () => {
  const checks = getAt(bp(), '/verification/checks') as { check: string; passed: boolean }[];
  assert.deepEqual(checks.map((c) => c.check), NAMES);
  assert.ok(checks.every((c) => c.passed === true));
  const reversed = bp();
  setAt(reversed, '/verification/checks', [...checks].reverse());
  assertAccepted(validate(reversed));
});

test('a missing required check is rejected, naming the check from the fixed list', () => {
  for (const name of NAMES) {
    const d = bp();
    d.verification.checks = d.verification.checks.filter((c) => c.check !== name);
    const r = validate(d);
    const hits = errorsOf(r).filter((e) => e.code === 'verification_check_missing');
    assert.equal(hits.length, 1, name);
    assert.equal(hits[0].path, '/verification/checks');
    assert.ok(hits[0].message.includes(`"${name}"`), name);
  }
});

test('no checks at all reports every required check as missing', () => {
  const d = bp();
  setAt(d, '/verification/checks', []);
  const missing = errorsOf(validate(d)).filter((e) => e.code === 'verification_check_missing');
  assert.equal(missing.length, 13);
});

test('a failed required check is rejected at that check, for each of the 13', () => {
  NAMES.forEach((name, i) => {
    const d = bp();
    setAt(d, `/verification/checks/${i}/passed`, false);
    const r = validate(d);
    assertRejected(r, 'verification_check_failed', `/verification/checks/${i}/passed`, name);
    assert.equal(errorsOf(r).filter((e) => e.code === 'verification_check_failed').length, 1);
  });
});

test('a duplicate check is rejected as a shape error (a repeated name cannot stand in for the missing one)', () => {
  const d = bp();
  setAt(d, '/verification/checks/12/check', 'json_parse'); // no_urls replaced by a second json_parse
  assertRejected(validate(d), 'duplicate_item', '/verification/checks/12/check');
  const extra = bp();
  extra.verification.checks.push({ check: 'json_parse', passed: true });
  assertRejected(validate(extra), 'list_too_long', '/verification/checks'); // 14 entries cannot be 13 distinct checks
});

test('an unknown check name is rejected: the validator accepts no invented check', () => {
  const d = bp();
  setAt(d, '/verification/checks/0/check', 'security_review');
  assertRejected(validate(d), 'invalid_enum', '/verification/checks/0/check');
});

test('check detail text is optional and does not change the outcome', () => {
  const d = bp();
  setAt(d, '/verification/checks/8/detail', 'Two numeric claims checked against cited excerpts');
  assertAccepted(validate(d));
  setAt(d, '/verification/checks/8/passed', false);
  assertRejected(validate(d), 'verification_check_failed', '/verification/checks/8/passed');
});

test('the validator records nothing and adds nothing: it checks the stored record and returns it unchanged', () => {
  const input = deepFreeze(bp());
  const before = JSON.stringify(input);
  const r = validate(input);
  assert.ok(r.ok);
  assert.deepEqual(r.value.verification.checks, input.verification.checks);
  assert.equal(r.value.verification.checks.length, 13);
  assert.equal(JSON.stringify(input), before);
  // a blueprint with the check record removed is not "completed" by the validator
  const stripped = bp();
  stripped.verification.checks = [];
  const failed = validate(stripped);
  assert.equal(failed.ok, false);
  assert.ok(!('value' in failed));
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 3. Disclaimers are fixed backend text
// ---------------------------------------------------------------------------------------------------------------------------------

test('the fixed disclaimers are the wording in product-blueprint-v1.md, and the estimate label is the exact section 8 text', () => {
  const doc = readFileSync(WORKED_EXAMPLE_DOC, 'utf8');
  for (const text of FIXED_DISCLAIMERS) assert.ok(doc.includes(text), text);
  assert.equal(ESTIMATE_DISCLAIMER, 'AI-generated estimate — not a delivery commitment');
  assert.ok(doc.includes(`**${ESTIMATE_DISCLAIMER}**`), 'section 8 states the exact label in bold');
  assert.equal(FIXED_DISCLAIMERS.length, 3);
});

test('the example disclaimers are accepted; any subset that keeps the estimate label is accepted, in any order', () => {
  assert.deepEqual(getAt(bp(), '/meta/disclaimers'), [...FIXED_DISCLAIMERS]);
  const sets: string[][] = [[ESTIMATE_DISCLAIMER], [FIXED_DISCLAIMERS[0], ESTIMATE_DISCLAIMER], [ESTIMATE_DISCLAIMER, FIXED_DISCLAIMERS[1], FIXED_DISCLAIMERS[0]]];
  for (const s of sets) { const d = bp(); setAt(d, '/meta/disclaimers', s); assertAccepted(validate(d)); }
});

test('arbitrary disclaimer text is rejected, including near misses of the fixed wording', () => {
  const bad = [
    'This product is guaranteed to succeed.', 'See https://example.com/terms', '', '   ', 'DROP TABLE reports',
    'AI-generated estimate - not a delivery commitment',            // hyphen instead of the em dash
    'ai-generated estimate — not a delivery commitment',            // case
    `${ESTIMATE_DISCLAIMER}.`, ` ${ESTIMATE_DISCLAIMER}`, `${ESTIMATE_DISCLAIMER} `, 'AI-generated estimate — not a delivery  commitment',
    FIXED_DISCLAIMERS[0].replace('hypothesis', 'guess'),
  ];
  for (const text of bad) {
    const d = bp();
    setAt(d, '/meta/disclaimers/0', text);
    assertRejected(validate(d), 'disclaimer_not_allowed', '/meta/disclaimers/0', JSON.stringify(text));
  }
});

test('an extra arbitrary entry next to valid ones is rejected at that entry', () => {
  const d = bp();
  setAt(d, '/meta/disclaimers', [...FIXED_DISCLAIMERS, 'Free of charge, forever']);
  assertRejected(validate(d), 'disclaimer_not_allowed', '/meta/disclaimers/3');
});

test('a repeated disclaimer is rejected; a non-string entry is a type error', () => {
  const dup = bp();
  setAt(dup, '/meta/disclaimers', [ESTIMATE_DISCLAIMER, ESTIMATE_DISCLAIMER]);
  assertRejected(validate(dup), 'duplicate_item', '/meta/disclaimers/1');
  const num = bp();
  setAt(num, '/meta/disclaimers', [ESTIMATE_DISCLAIMER, 5]);
  assertRejected(validate(num), 'invalid_type', '/meta/disclaimers/1');
});

test('the estimate disclaimer must be present', () => {
  const without = bp();
  setAt(without, '/meta/disclaimers', [FIXED_DISCLAIMERS[0], FIXED_DISCLAIMERS[1]]);
  assertRejected(validate(without), 'disclaimer_missing', '/meta/disclaimers');
  const empty = bp();
  setAt(empty, '/meta/disclaimers', []);
  assertRejected(validate(empty), 'disclaimer_missing', '/meta/disclaimers');
});

test('disclaimer errors never echo the rejected text', () => {
  const d = bp();
  setAt(d, '/meta/disclaimers/0', 'ZZ_SECRET_DISCLAIMER_TEXT');
  assert.ok(!JSON.stringify(errorsOf(validate(d))).includes('ZZ_SECRET_DISCLAIMER_TEXT'));
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 4. Cluster metrics belong to meta.cluster_id
// ---------------------------------------------------------------------------------------------------------------------------------

const METRIC_INDEXES = [5, 6, 7, 8, 9];

test('in the example every cluster metric names the blueprint cluster', () => {
  const d = bp();
  for (const i of METRIC_INDEXES) assert.equal(getAt(d, `/evidence_index/${i}/cluster_id`), d.meta.cluster_id);
  assertAccepted(validate(d));
});

test('a metric from another cluster is rejected at that metric only', () => {
  for (const i of METRIC_INDEXES) {
    const d = bp();
    setAt(d, `/evidence_index/${i}/cluster_id`, '00000000-0000-4000-8000-0000000000c2');
    const r = validate(d);
    assertRejected(r, 'evidence_index_mismatch', `/evidence_index/${i}/cluster_id`);
    assert.equal(errorsOf(r).filter((e) => e.path.endsWith('/cluster_id')).length, 1);
  }
});

test('changing meta.cluster_id alone makes every metric inconsistent', () => {
  const d = bp();
  setAt(d, '/meta/cluster_id', '00000000-0000-4000-8000-0000000000c2');
  const paths = errorsOf(validate(d)).filter((e) => e.code === 'evidence_index_mismatch' && e.path.endsWith('/cluster_id')).map((e) => e.path);
  assert.deepEqual(paths, METRIC_INDEXES.map((i) => `/evidence_index/${i}/cluster_id`));
});

test('changing both to the same new value is consistent', () => {
  const d = bp();
  const id = '11111111-2222-4333-8444-555555555555';
  setAt(d, '/meta/cluster_id', id);
  for (const i of METRIC_INDEXES) setAt(d, `/evidence_index/${i}/cluster_id`, id);
  assertAccepted(validate(d));
});

test('the comparison is exact: a different letter case is a different cluster', () => {
  const d = bp();
  setAt(d, '/meta/cluster_id', '00000000-0000-4000-8000-0000000000C1');
  assertRejected(validate(d), 'evidence_index_mismatch', '/evidence_index/5/cluster_id');
});

test('discussion excerpts carry no cluster_id, so they are unaffected', () => {
  const d = bp();
  setAt(d, '/meta/cluster_id', '00000000-0000-4000-8000-0000000000c2');
  assert.ok(!errorsOf(validate(d)).some((e) => /^\/evidence_index\/[0-4]\//.test(e.path)));
});

test('a blank or non-string metric cluster_id is a shape error', () => {
  const blank = bp();
  setAt(blank, '/evidence_index/5/cluster_id', '');
  assertRejected(validate(blank), 'string_blank', '/evidence_index/5/cluster_id');
  const num = bp();
  setAt(num, '/evidence_index/5/cluster_id', 7);
  assertRejected(validate(num), 'invalid_type', '/evidence_index/5/cluster_id');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 5. Database rules: required by the documentation vs not required
// ---------------------------------------------------------------------------------------------------------------------------------

const T2 = '/database/tables/2';

test('documented rule 9 is enforced: references_columns must exist in the referenced table of the design', () => {
  const doc = readFileSync(WORKED_EXAMPLE_DOC, 'utf8');
  assert.ok(doc.includes('and `references_columns` exist in that table'), 'the documented wording changed: review the database rules');
  const d = bp();
  setAt(d, `${T2}/foreign_keys/0/references_columns`, ['ghost']);
  assertRejected(validate(d), 'db_column_reference', `${T2}/foreign_keys/0/references_columns/0`);
  const ok = bp(); // references the primary key of teams, and reports references itself
  assertAccepted(validate(ok));
});

test('documented rule 11 is preserved: the foreign-key index coverage rule is unchanged', () => {
  const d = bp();
  setAt(d, `${T2}/indexes/1`, undefined); // drop reports_assignee_idx
  assertRejected(validate(d), 'db_fk_not_indexed', `${T2}/foreign_keys/1/columns`);
  assertAccepted(validate(bp()));
});

test('KNOWN GAP, not in the approved documentation: a foreign key may reference a column that is not a primary or unique key', () => {
  // The documents only say references_columns must exist in the referenced table. Requiring a primary-key or unique target is real PostgreSQL
  // behaviour but is not a documented contract rule, so it is reported rather than invented. Flip this test if the documentation adds the rule.
  const d = bp();
  setAt(d, `${T2}/foreign_keys/0/references_columns`, ['name']); // teams.name is neither primary nor unique
  assertAccepted(validate(d));
});

test('KNOWN GAP, not in the approved documentation: SET NULL on a foreign key whose columns are NOT NULL is not rejected', () => {
  // PostgreSQL would fail at run time, but no document says so. Reported rather than invented. In the example both SET NULL keys use nullable columns.
  const d = bp();
  setAt(d, `${T2}/columns/7/nullable`, false); // assignee_id, used by reports_assignee_fk (set null)
  assert.equal(getAt(d, `${T2}/foreign_keys/1/on_delete`), 'set null');
  assertAccepted(validate(d));
});

test('the example is consistent with both undocumented rules, so adding them later would not invalidate it', () => {
  const d = bp();
  const tables = d.database.tables;
  for (const t of tables) {
    for (const fk of t.foreign_keys) {
      if (fk.references_table !== 'auth.users') {
        const target = tables.find((x) => x.name === fk.references_table);
        assert.ok(target, fk.name);
        const keys = [target.primary_key, ...target.unique_constraints.map((u) => u.columns)];
        assert.ok(keys.some((k) => k.length === fk.references_columns.length && k.every((c, i) => c === fk.references_columns[i])), `${fk.name} targets a key`);
      }
      if (fk.on_delete === 'set null') {
        for (const col of fk.columns) assert.equal(t.columns.find((c) => c.name === col)?.nullable, true, `${fk.name}.${col}`);
      }
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// 6. downgraded_from
// ---------------------------------------------------------------------------------------------------------------------------------
// Documented contract: product-blueprint-v1.md 3.1 types `downgraded_from?: Basis` as "BACKEND ONLY. Present when the verifier lowered the basis; the
// model must not write it", and evidence-contract.md 5.2 and 7 record every downgrade as a `downgraded_basis` repair. Phase A2 is rejection-only and
// requires status "verified" with no repairs, so a stored claim carrying downgraded_from would contradict that record. It is therefore rejected in the
// assembled blueprint as a Phase A2 policy (narrower than the documented type). Model output keeps its own, original rejection.

/** Pointers of every Claim-shaped object, found by a generic scan that does not use the validator's own claim list. */
function claimPointers(node: unknown, pointer = '', out: string[] = []): string[] {
  if (Array.isArray(node)) { node.forEach((v, i) => claimPointers(v, `${pointer}/${i}`, out)); return out; }
  if (node === null || typeof node !== 'object') return out;
  const rec = node as Record<string, unknown>;
  if ('text' in rec && 'basis' in rec && 'evidence_refs' in rec) out.push(pointer);
  for (const [k, v] of Object.entries(rec)) claimPointers(v, `${pointer}/${k}`, out);
  return out;
}

test('the worked example carries no downgraded_from and remains valid and unchanged', () => {
  const text = readFileSync(WORKED_EXAMPLE_DOC, 'utf8');
  const block = [...text.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => m[1])[0];
  assert.ok(!block.includes('downgraded_from'));
  assert.deepEqual(bp(), JSON.parse(block));
  assert.ok(!JSON.stringify(bp()).includes('downgraded_from'));
  assertAccepted(validate(bp()));
});

test('every claim in the assembled blueprint rejects downgraded_from, whatever basis it names', () => {
  const pointers = claimPointers(bp());
  assert.equal(pointers.length, 24);
  for (const p of pointers) {
    for (const basis of ['verified_evidence', 'ai_recommendation', 'hypothesis', 'unknown']) {
      const d = bp();
      setAt(d, `${p}/downgraded_from`, basis);
      const r = validate(d);
      assertRejected(r, 'downgraded_from_not_allowed', `${p}/downgraded_from`, basis);
      assert.deepEqual(errorsOf(r).map((e) => `${e.code}@${e.path}`), [`downgraded_from_not_allowed@${p}/downgraded_from`], 'exactly one error, nothing else changed');
    }
  }
});

test('the contradiction is the point: the same blueprint is verified, repair-free, and still rejected', () => {
  const d = bp();
  assert.equal(d.verification.status, 'verified');
  assert.deepEqual(d.verification.repairs, []);
  setAt(d, '/opportunity/problem_statement/downgraded_from', 'verified_evidence');
  assert.equal(d.verification.status, 'verified');
  assert.deepEqual(d.verification.repairs, []);
  assertRejected(validate(d), 'downgraded_from_not_allowed', '/opportunity/problem_statement/downgraded_from');
});

test('presence is what is rejected, not the value: an invalid, null or oddly typed value gets the same error', () => {
  for (const value of ['made_up', '', null, 5, true, {}, []]) {
    const d = bp();
    setAt(d, '/risks/risks/0/claim/downgraded_from', value);
    const r = validate(d);
    assertRejected(r, 'downgraded_from_not_allowed', '/risks/risks/0/claim/downgraded_from', JSON.stringify(value));
    assert.ok(!errorsOf(r).some((e) => e.code === 'invalid_enum' || e.code === 'invalid_type'), 'no value-level error: the field itself is not allowed');
  }
});

test('the error is content-free and nothing is repaired or removed', () => {
  const MARK = 'ZZ_SECRET_DOWNGRADE_VALUE';
  const input = bp();
  setAt(input, '/commercial/business_model/downgraded_from', MARK);
  deepFreeze(input);
  const before = JSON.stringify(input);
  const r = validate(input);
  assertRejected(r, 'downgraded_from_not_allowed', '/commercial/business_model/downgraded_from');
  assert.ok(!JSON.stringify(errorsOf(r)).includes(MARK));
  assert.ok(!('value' in r), 'no partial result is returned');
  assert.equal(JSON.stringify(input), before, 'the field is not stripped from the input');
});

test('several claims with downgraded_from are each reported, alongside any other shape error', () => {
  const d = bp();
  setAt(d, '/opportunity/thesis/0/downgraded_from', 'hypothesis');
  setAt(d, '/personas/0/current_workaround/downgraded_from', 'unknown');
  setAt(d, '/opportunity/title', 42);
  const r = validate(d);
  assertRejected(r, 'downgraded_from_not_allowed', '/opportunity/thesis/0/downgraded_from');
  assertRejected(r, 'downgraded_from_not_allowed', '/personas/0/current_workaround/downgraded_from');
  assertRejected(r, 'invalid_type', '/opportunity/title');
});

test('removing the field makes the blueprint valid again: no other rule depends on it', () => {
  const d = bp();
  setAt(d, '/opportunity/affected_users/downgraded_from', 'verified_evidence');
  assert.equal(validate(d).ok, false);
  setAt(d, '/opportunity/affected_users/downgraded_from', undefined);
  assertAccepted(validate(d));
});

test('model output keeps its original rejection, with its own code, at every claim', () => {
  const model = validModelOutput();
  const pointers = claimPointers(model);
  assert.equal(pointers.length, 24);
  for (const p of pointers) {
    const d = validModelOutput();
    setAt(d, `${p}/downgraded_from`, 'hypothesis');
    const r = validateBlueprintModelOutput(d);
    assertRejected(r, 'downgraded_from_forbidden', `${p}/downgraded_from`);
    assert.ok(!errorsOf(r).some((e) => e.code === 'downgraded_from_not_allowed'));
  }
});

test('the documented type still lists the optional field: only the Phase A2 validator narrows it', () => {
  const contract = readFileSync(WORKED_EXAMPLE_DOC, 'utf8');
  assert.ok(contract.includes('downgraded_from?: Basis;'));
  assert.ok(contract.includes('BACKEND ONLY. Present when the verifier lowered the basis; the model must not write it.'));
  const code = readFileSync(new URL('../contract.ts', import.meta.url), 'utf8');
  assert.ok(code.includes('downgraded_from?: Basis;'));
});
