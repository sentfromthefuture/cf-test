// ProductBlueprintV1: the backend-owned sections (meta, evidence_index, verification) and their consistency with the model-owned document.
// Structural evidence validation only: nothing here proves that evidence is real or that a claim is true.
// In the worked example: evidence_index = E01..E05 (indexes 0-4) then M01..M05 (indexes 5-9).
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ProductBlueprintV1 } from '../contract.ts';
import { validateBlueprintModelOutput, validateProductBlueprint } from '../validate.ts';
import { assertAccepted, assertNoError, assertRejected, errorsOf, getAt, recomputeBackendFields, setAt, text, validBlueprint } from './helpers.ts';

const bp = (): ProductBlueprintV1 => validBlueprint();
const validate = (d: unknown) => validateProductBlueprint(d);

// ---------------------------------------------------------------------------------------------------------------------------------
// Required sections and unexpected fields
// ---------------------------------------------------------------------------------------------------------------------------------

test('meta, evidence_index and verification are required in the assembled blueprint', () => {
  for (const key of ['meta', 'evidence_index', 'verification']) {
    const d = bp();
    setAt(d, `/${key}`, undefined);
    assertRejected(validate(d), 'missing_required_field', `/${key}`);
  }
});

test('the assembled validator also applies every model-owned rule', () => {
  const d = bp();
  setAt(d, '/zz_extra', 1);
  assertRejected(validate(d), 'unexpected_key', '');
  const basis = bp();
  setAt(basis, '/commercial/business_model/basis', 'verified_evidence');
  setAt(basis, '/commercial/business_model/evidence_refs', ['E01']);
  setAt(basis, '/evidence_index/0/cited_by', [...(getAt(basis, '/evidence_index/0/cited_by') as string[]), '/commercial/business_model/evidence_refs/0']);
  assertRejected(validate(basis), 'basis_not_allowed', '/commercial/business_model/basis');
});

test('backend-owned objects reject unexpected fields and missing required fields', () => {
  const parents = ['/meta', '/meta/passes/0', '/meta/request_params', '/meta/evidence_pack', '/evidence_index/0', '/evidence_index/5', '/verification', '/verification/checks/0', '/verification/claim_counts'];
  for (const p of parents) {
    const d = bp();
    setAt(d, `${p}/zz_extra`, 1);
    assertRejected(validate(d), 'unexpected_key', p);
  }
  const required = ['/meta/blueprint_id', '/meta/passes/0/input_hash', '/meta/request_params/team_size', '/meta/evidence_pack/pack_sha256', '/evidence_index/0/excerpt', '/evidence_index/5/evidence_class',
    '/evidence_index/0/cited_by', '/verification/status', '/verification/claim_counts/unknown', '/verification/unresolved_refs', '/verification/checks/0/passed'];
  for (const p of required) {
    const d = bp();
    setAt(d, p, undefined);
    assertRejected(validate(d), 'missing_required_field', p);
  }
});

test('an evidence entry needs a known kind', () => {
  const d = bp();
  setAt(d, '/evidence_index/0/kind', 'something_else');
  assertRejected(validate(d), 'invalid_enum', '/evidence_index/0/kind');
  const missing = bp();
  setAt(missing, '/evidence_index/0/kind', undefined);
  assertRejected(validate(missing), 'missing_required_field', '/evidence_index/0/kind');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// meta
// ---------------------------------------------------------------------------------------------------------------------------------

test('hashes are 64 hexadecimal characters', () => {
  for (const p of ['/meta/passes/0/input_hash', '/meta/evidence_pack/pack_sha256', '/evidence_index/0/content_sha256']) {
    for (const bad of ['a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), '', ' '.concat('a'.repeat(63))]) {
      const d = bp(); setAt(d, p, bad); assertRejected(validate(d), 'invalid_format', p, bad.length.toString());
    }
    for (const good of ['a'.repeat(64), 'A'.repeat(64), '0123456789abcdefABCDEF'.repeat(3).slice(0, 64)]) {
      const d = bp(); setAt(d, p, good); assertNoError(validate(d), 'invalid_format', p);
    }
  }
});

test('timestamps are ISO 8601 with a time zone and a real calendar date', () => {
  const at = (v: unknown) => { const d = bp(); setAt(d, '/meta/generated_at', v); return validate(d); };
  for (const good of ['2026-01-01T10:00:00Z', '2026-01-01T10:00:00.123Z', '2026-01-01T10:00:00+02:00', '2024-02-29T00:00:00Z', '2026-12-31T23:59:59-11:30']) assertAccepted(at(good), good);
  for (const bad of ['2026-01-01', '2026-01-01T10:00:00', '2026-13-01T00:00:00Z', '2026-02-30T00:00:00Z', '2023-02-29T00:00:00Z', '2026-01-01T24:00:00Z', '2026-01-01T10:60:00Z',
    '2026-04-31T00:00:00Z', 'yesterday', '2026-01-01 10:00:00Z', '']) assertRejected(at(bad), 'invalid_format', '/meta/generated_at', bad);
  assertRejected(at(20260101), 'invalid_type', '/meta/generated_at');
  const published = (v: unknown) => { const d = bp(); setAt(d, '/evidence_index/0/published_at', v); return validate(d); };
  assertAccepted(published(null));
  assertRejected(published('2026-02-30T00:00:00Z'), 'invalid_format', '/evidence_index/0/published_at');
});

test('versions and the requested model have fixed formats; only explicitly free models are accepted', () => {
  const at = (p: string, v: unknown) => { const d = bp(); setAt(d, p, v); return validate(d); };
  assertRejected(at('/meta/contract_version', 'product-blueprint.v2'), 'invalid_literal', '/meta/contract_version');
  for (const good of ['bp1.p1.s1', 'bp12.p3.s10', 'bp1.p1.s1+rc-2']) assertAccepted(at('/meta/config_version', good), good);
  for (const bad of ['', 'bp1', 'bp1.p1', 'BP1.P1.S1', 'bp1.p1.s1+', `bp1.p1.s1+${'x'.repeat(25)}`, '1.1.1']) assertRejected(at('/meta/config_version', bad), 'invalid_format', '/meta/config_version', bad);
  for (const bad of ['', ' ', '-x', 'a b']) assertRejected(at('/meta/prompt_version', bad), 'invalid_format', '/meta/prompt_version', JSON.stringify(bad));
  assertAccepted(at('/meta/requested_model', 'baidu/ernie-5.5-flash-preview:free'));
  for (const bad of ['baidu/ernie-5.5-flash-preview', 'openai/gpt-5', 'ernie:free', 'a/b:paid', '']) assertRejected(at('/meta/requested_model', bad), 'invalid_format', '/meta/requested_model', bad);
});

test('the requested-model format agrees with the collector isFreeModelSlug', async () => {
  const { isFreeModelSlug } = await import('../../collector/ai-common.ts');
  for (const slug of ['baidu/ernie-5.5-flash-preview:free', 'a/b:free', 'A/B:FREE', 'baidu/ernie', 'x:free', '/a:free', 'a/:free', 'a/b:free ', 'a//b:free']) {
    const d = bp(); setAt(d, '/meta/requested_model', slug);
    const accepted = !errorsOf(validate(d)).some((e) => e.path === '/meta/requested_model');
    assert.equal(accepted, isFreeModelSlug(slug), slug);
  }
});

test('request parameters are enums', () => {
  for (const key of ['team_size', 'budget_band', 'preferred_stack', 'business_model_hint', 'target_region']) {
    const d = bp(); setAt(d, `/meta/request_params/${key}`, 'not_a_value');
    assertRejected(validate(d), 'invalid_enum', `/meta/request_params/${key}`);
  }
});

test('pass records: counters are non-negative whole numbers; cost and reasoning tokens may be null', () => {
  const at = (p: string, v: unknown) => { const d = bp(); setAt(d, `/meta/passes/0/${p}`, v); return validate(d); };
  for (const key of ['prompt_tokens', 'completion_tokens', 'duration_ms']) {
    assertAccepted(at(key, 0));
    assertRejected(at(key, -1), 'number_out_of_range', `/meta/passes/0/${key}`);
    assertRejected(at(key, 1.5), 'invalid_integer', `/meta/passes/0/${key}`);
    assertRejected(at(key, '5'), 'invalid_type', `/meta/passes/0/${key}`);
    assertRejected(at(key, NaN), 'invalid_type', `/meta/passes/0/${key}`);
    assertRejected(at(key, null), 'invalid_type', `/meta/passes/0/${key}`);
  }
  assertAccepted(at('reasoning_tokens', null));
  assertAccepted(at('reasoning_tokens', 120));
  assertRejected(at('reasoning_tokens', -5), 'number_out_of_range', '/meta/passes/0/reasoning_tokens');
  assertAccepted(at('reported_cost_usd', null));
  assertAccepted(at('reported_cost_usd', 0));
  assertAccepted(at('reported_cost_usd', 0.0123));
  assertRejected(at('reported_cost_usd', -0.01), 'number_out_of_range', '/meta/passes/0/reported_cost_usd');
  assertRejected(at('reported_cost_usd', Infinity), 'invalid_type', '/meta/passes/0/reported_cost_usd');
  assertRejected(at('pass', 'D'), 'invalid_enum', '/meta/passes/0/pass');
  assertRejected(at('from_cache', 'false'), 'invalid_type', '/meta/passes/0/from_cache');
  for (const key of ['cache_id', 'served_model', 'provider', 'finish_reason']) { assertAccepted(at(key, null)); assertAccepted(at(key, 'x')); assertRejected(at(key, 5), 'invalid_type', `/meta/passes/0/${key}`); }
});

test('generation_mode and the pass records agree', () => {
  assertAccepted(validate(bp())); // sectioned with A, B, C
  const single = bp();
  setAt(single, '/meta/generation_mode', 'single_pass');
  assertRejected(validate(single), 'meta_inconsistent', '/meta/passes');
  setAt(single, '/meta/passes', [{ ...(getAt(single, '/meta/passes/0') as object), pass: 'single' }]);
  assertAccepted(validate(single));
  const wrongName = bp();
  setAt(wrongName, '/meta/generation_mode', 'single_pass');
  setAt(wrongName, '/meta/passes', [getAt(wrongName, '/meta/passes/0')]); // one record but named A
  assertRejected(validate(wrongName), 'meta_inconsistent', '/meta/passes');
  const repeated = bp();
  setAt(repeated, '/meta/passes/1/pass', 'A');
  assertRejected(validate(repeated), 'meta_inconsistent', '/meta/passes');
  const sectionedSingle = bp();
  setAt(sectionedSingle, '/meta/passes/0/pass', 'single');
  assertRejected(validate(sectionedSingle), 'meta_inconsistent', '/meta/passes');
  const none = bp();
  setAt(none, '/meta/passes', []);
  assertRejected(validate(none), 'list_too_short', '/meta/passes');
});

test('the evidence pack counts must match the evidence index', () => {
  const d = bp();
  setAt(d, '/meta/evidence_pack/excerpt_count', 4);
  assertRejected(validate(d), 'evidence_index_mismatch', '/meta/evidence_pack/excerpt_count');
  const m = bp();
  setAt(m, '/meta/evidence_pack/metric_count', 6);
  assertRejected(validate(m), 'evidence_index_mismatch', '/meta/evidence_pack/metric_count');
  const big = bp();
  setAt(big, '/meta/evidence_pack/excerpt_count', 25);
  assertRejected(validate(big), 'number_out_of_range', '/meta/evidence_pack/excerpt_count');
  const bigM = bp();
  setAt(bigM, '/meta/evidence_pack/metric_count', 17);
  assertRejected(validate(bigM), 'number_out_of_range', '/meta/evidence_pack/metric_count');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// evidence_index
// ---------------------------------------------------------------------------------------------------------------------------------

test('evidence ids in the index are unique, in range, and agree with their kind', () => {
  const dup = bp();
  setAt(dup, '/evidence_index/1/id', 'E01');
  assertRejected(validate(dup), 'duplicate_identifier', '/evidence_index/1/id');
  const kind = bp();
  setAt(kind, '/evidence_index/0/id', 'M10'); // a discussion excerpt cannot carry a metric id
  assertRejected(validate(kind), 'evidence_index_mismatch', '/evidence_index/0/kind');
  const range = bp();
  setAt(range, '/evidence_index/0/id', 'E25');
  assertRejected(validate(range), 'evidence_ref_out_of_range', '/evidence_index/0/id');
});

test('a metric id keeps its catalogue meaning: M01 is unique_discussions, M11 to M16 are score components', () => {
  const swapped = bp();
  setAt(swapped, '/evidence_index/5/name', 'source_count');
  assertRejected(validate(swapped), 'evidence_index_mismatch', '/evidence_index/5/name');
  const component = bp();
  setAt(component, '/evidence_index/9/id', 'M12');
  setAt(component, '/evidence_index/9/name', 'score_component');
  assertNoError(validate(component), 'evidence_index_mismatch', '/evidence_index/9/name');
  setAt(component, '/evidence_index/9/name', 'cluster_confidence');
  assertRejected(validate(component), 'evidence_index_mismatch', '/evidence_index/9/name');
});

test('index entries: http(s) URLs only, excerpts up to 400 characters, metric values of the documented types', () => {
  const at = (p: string, v: unknown) => { const d = bp(); setAt(d, p, v); return validate(d); };
  for (const bad of ['javascript:alert(1)', 'ftp://example.invalid/x', '/relative', 'https://', 'https://has space', '', 5]) {
    assertRejected(at('/evidence_index/0/url', bad), typeof bad === 'number' ? 'invalid_type' : 'invalid_format', '/evidence_index/0/url', String(bad));
  }
  assertRejected(at('/evidence_index/0/url', `https://example.invalid/${'a'.repeat(2050)}`), 'invalid_format', '/evidence_index/0/url');
  assertNoError(at('/evidence_index/0/excerpt', text(400)), 'string_too_long', '/evidence_index/0/excerpt');
  assertRejected(at('/evidence_index/0/excerpt', text(401)), 'string_too_long', '/evidence_index/0/excerpt');
  for (const good of [9, 0.5, true, false, null, 'medium', ['github', 'hackernews'], { github: 4, hackernews: 5 }, [], {}]) assertNoError(at('/evidence_index/5/value', good), 'invalid_type', '/evidence_index/5/value', JSON.stringify(good));
  assertRejected(at('/evidence_index/5/value', undefined), 'missing_required_field', '/evidence_index/5/value'); // a metric value may be null, but the field itself is required
  for (const bad of [{ a: 'x' }, { a: null }]) assertRejected(at('/evidence_index/5/value', bad), 'invalid_type', '/evidence_index/5/value', JSON.stringify(bad));
  for (const bad of [[1, 2], [['x']], [{}]]) assertRejected(at('/evidence_index/5/value', bad), 'invalid_type', '/evidence_index/5/value/0', JSON.stringify(bad));
  assertRejected(at('/evidence_index/5/evidence_class', 'guess'), 'invalid_enum', '/evidence_index/5/evidence_class');
  assertRejected(at('/evidence_index/0/analysis_method', 'manual'), 'invalid_enum', '/evidence_index/0/analysis_method');
});

test('a cited id that is not in the evidence index is unresolved', () => {
  const d = bp();
  d.evidence_index.splice(2, 1); // remove E03
  recomputeBackendFields(d);
  assertRejected(validate(d), 'evidence_ref_unresolved', '/opportunity/problem_statement/evidence_refs/2');
  assertRejected(validate(d), 'evidence_ref_unresolved', '/mvp/features/2/justification/evidence_refs/0');
});

test('an uncited index entry is fine: cited_by is simply empty', () => {
  const d = bp();
  assert.deepEqual(getAt(d, '/evidence_index/4/cited_by'), []); // E05 is shown to the model but not cited
  assertAccepted(validate(d));
});

test('cited_by must list exactly the places that cite the item', () => {
  const missing = bp();
  setAt(missing, '/evidence_index/0/cited_by', (getAt(missing, '/evidence_index/0/cited_by') as string[]).slice(1));
  assertRejected(validate(missing), 'evidence_index_mismatch', '/evidence_index/0/cited_by');
  const extra = bp();
  setAt(extra, '/evidence_index/4/cited_by', ['/opportunity/title']);
  assertRejected(validate(extra), 'evidence_index_mismatch', '/evidence_index/4/cited_by');
  const wrongPlace = bp();
  setAt(wrongPlace, '/evidence_index/0/cited_by/0', '/opportunity/problem_statement/evidence_refs/9');
  assertRejected(validate(wrongPlace), 'evidence_index_mismatch', '/evidence_index/0/cited_by');
  for (const bad of ['', 'no-slash', '/a~2b', 5]) {
    const d = bp(); setAt(d, '/evidence_index/4/cited_by', [bad]);
    assertRejected(validate(d), typeof bad === 'number' ? 'invalid_type' : 'invalid_format', '/evidence_index/4/cited_by/0', String(bad));
  }
  const dup = bp();
  setAt(dup, '/evidence_index/4/cited_by', ['/a', '/a']);
  assertRejected(validate(dup), 'duplicate_item', '/evidence_index/4/cited_by/1');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Verified claims and willingness to pay against the index
// ---------------------------------------------------------------------------------------------------------------------------------

test('a verified_evidence claim needs a supporting-grade item: an excerpt, or a measured or derived metric', () => {
  const onlyEstimates = bp(); // thesis[0] is verified and cites M01 and M02
  setAt(onlyEstimates, '/evidence_index/5/evidence_class', 'ai_estimate');
  setAt(onlyEstimates, '/evidence_index/6/evidence_class', 'insufficient_data');
  assertRejected(validate(onlyEstimates), 'verified_claim_unsupported', '/opportunity/thesis/0/evidence_refs');
  const derived = bp();
  setAt(derived, '/evidence_index/5/evidence_class', 'derived');
  setAt(derived, '/evidence_index/6/evidence_class', 'measured');
  assertNoError(validate(derived), 'verified_claim_unsupported', '/opportunity/thesis/0/evidence_refs');
  const oneGood = bp(); // one supporting item among the references is enough
  setAt(oneGood, '/evidence_index/5/evidence_class', 'ai_estimate');
  assertNoError(validate(oneGood), 'verified_claim_unsupported', '/opportunity/thesis/0/evidence_refs');
  const excerpt = bp(); // problem_statement cites excerpts
  assertNoError(validate(excerpt), 'verified_claim_unsupported', '/opportunity/problem_statement/evidence_refs');
});

test('willingness to pay "evidenced" also needs two cited excerpts that carry a willingness-to-pay quote', () => {
  const evidenced = (flags: boolean[]) => {
    const d = bp();
    setAt(d, '/market_evidence/willingness_to_pay/status', 'evidenced');
    setAt(d, '/market_evidence/willingness_to_pay/summary/basis', 'verified_evidence');
    setAt(d, '/market_evidence/willingness_to_pay/summary/evidence_refs', ['E01', 'E04']);
    setAt(d, '/evidence_index/0/has_wtp_quote', flags[0]);
    setAt(d, '/evidence_index/3/has_wtp_quote', flags[1]);
    recomputeBackendFields(d);
    return validate(d);
  };
  assertAccepted(evidenced([true, true]));
  assertRejected(evidenced([false, true]), 'wtp_rule_violation', '/market_evidence/willingness_to_pay/summary/evidence_refs');
  assertRejected(evidenced([false, false]), 'wtp_rule_violation', '/market_evidence/willingness_to_pay/summary/evidence_refs');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// verification
// ---------------------------------------------------------------------------------------------------------------------------------

test('claim_counts and ref_count are recomputed from the document, never trusted', () => {
  for (const basis of ['verified_evidence', 'ai_recommendation', 'hypothesis', 'unknown']) {
    const d = bp();
    setAt(d, `/verification/claim_counts/${basis}`, (getAt(d, `/verification/claim_counts/${basis}`) as number) + 1);
    assertRejected(validate(d), 'verification_mismatch', `/verification/claim_counts/${basis}`);
  }
  const refs = bp();
  setAt(refs, '/verification/ref_count', 19);
  assertRejected(validate(refs), 'verification_mismatch', '/verification/ref_count');
  const typeError = bp();
  setAt(typeError, '/verification/ref_count', -1);
  assertRejected(validate(typeError), 'number_out_of_range', '/verification/ref_count');
});

test('adding a claim changes the recomputed counts, so a stale report is rejected until it is recomputed', () => {
  const d = bp();
  d.risks.risks.push({ ...d.risks.risks[0], risk_id: 'R5' }); // the copied claim has basis "hypothesis"
  assertRejected(validate(d), 'verification_mismatch', '/verification/claim_counts/hypothesis');
  recomputeBackendFields(d);
  assertAccepted(validate(d));
});

test('unresolved_refs is the number 0 on a stored blueprint', () => {
  const one = bp(); setAt(one, '/verification/unresolved_refs', 1);
  assertRejected(validate(one), 'invalid_literal', '/verification/unresolved_refs');
  const str = bp(); setAt(str, '/verification/unresolved_refs', '0');
  assertRejected(validate(str), 'invalid_type', '/verification/unresolved_refs');
});

test('status, checks and repairs have fixed shapes (policy for status, repairs and required checks is in verification-and-metadata.test.ts)', () => {
  const at = (p: string, v: unknown) => { const d = bp(); setAt(d, p, v); return validate(d); };
  assertRejected(at('/verification/status', 'rejected'), 'invalid_enum', '/verification/status');
  assertRejected(at('/verification/checks/0/check', 'made_up_check'), 'invalid_enum', '/verification/checks/0/check');
  assertRejected(at('/verification/checks/1/check', 'json_parse'), 'duplicate_item', '/verification/checks/1/check');
  assertAccepted(at('/verification/checks/0/detail', 'All good'));
  assertRejected(at('/verification/checks/0/passed', 'yes'), 'invalid_type', '/verification/checks/0/passed');
  const repair = { path: '/opportunity/thesis/0/basis', action: 'downgraded_basis', reason: 'No supporting-grade item' };
  // a repair record is still checked for shape first; whether any repair is acceptable is a separate policy rule
  assertRejected(at('/verification/repairs', [{ ...repair, action: 'rewrote_everything' }]), 'invalid_enum', '/verification/repairs/0/action');
  assertRejected(at('/verification/repairs', [{ ...repair, path: 'not-a-pointer' }]), 'invalid_format', '/verification/repairs/0/path');
  assertRejected(at('/verification/repairs', [{ path: '/x', action: 'dropped_ref' }]), 'missing_required_field', '/verification/repairs/0/reason');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// downgraded_from, sufficiency
// ---------------------------------------------------------------------------------------------------------------------------------

test('downgraded_from is allowed on an assembled claim (the backend wrote it) and must be a real basis', () => {
  const ok = bp();
  setAt(ok, '/opportunity/affected_users/downgraded_from', 'verified_evidence');
  assertAccepted(validate(ok));
  const bad = bp();
  setAt(bad, '/opportunity/affected_users/downgraded_from', 'made_up');
  assertRejected(validate(bad), 'invalid_enum', '/opportunity/affected_users/downgraded_from');
  // the very same claim written by the model is rejected
  const model = bp();
  setAt(model, '/opportunity/affected_users/downgraded_from', 'verified_evidence');
  const { meta: _a, evidence_index: _b, verification: _c, ...modelOnly } = model;
  void _a; void _b; void _c;
  assertRejected(validateBlueprintModelOutput(modelOnly), 'downgraded_from_forbidden', '/opportunity/affected_users/downgraded_from');
});

test('limited evidence restricts the verdict; no rule exists for insufficient or adequate evidence', () => {
  assert.equal(getAt(bp(), '/meta/evidence_pack/sufficiency'), 'limited');
  const verdict = (sufficiency: string, v: string) => { const d = bp(); setAt(d, '/meta/evidence_pack/sufficiency', sufficiency); setAt(d, '/opportunity/verdict', v); return validate(d); };
  assertAccepted(verdict('limited', 'validate_first'));
  assertAccepted(verdict('limited', 'insufficient_evidence'));
  for (const v of ['pursue_mvp', 'not_recommended']) assertRejected(verdict('limited', v), 'verdict_not_allowed_for_sufficiency', '/opportunity/verdict', v);
  for (const v of ['pursue_mvp', 'validate_first', 'insufficient_evidence', 'not_recommended']) {
    assertAccepted(verdict('adequate', v));
    assertAccepted(verdict('insufficient', v));
  }
});

test('the assembled validator rejects a blueprint whose schema_version and meta.contract_version are different from the supported one', () => {
  const d = bp();
  setAt(d, '/schema_version', 'product-blueprint.v2');
  assert.deepEqual(errorsOf(validate(d)).map((e) => e.code), ['unsupported_schema_version']);
});
