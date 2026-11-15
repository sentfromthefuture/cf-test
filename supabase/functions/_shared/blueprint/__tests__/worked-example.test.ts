// The documented worked example (product-blueprint-v1.md section 7) and drift guards between the approved documents and constants.ts.
//
// Result of running the example through the validators, unmodified: it is ACCEPTED by both validators. Every count the document states for it
// (24 claims split 6/7/8/3, 20 references, hashes, ids, cited_by) agrees with an independent recomputation. No inconsistency in the example
// itself was found. The ambiguities that WERE found are properties of the documents, not of the example; they are listed in README.md.
//
// These tests read the documentation file. If the example or an enum in the document changes, they fail on purpose, so the contract and the
// document cannot drift apart silently.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as C from '../constants.ts';
import type { BlueprintModelOutputV1 } from '../contract.ts';
import { claimSites, countClaimsByBasis, refSites } from '../validate-evidence.ts';
import { validateBlueprintModelOutput, validateProductBlueprint } from '../validate.ts';
import { assertAccepted, validBlueprint, validModelOutput, WORKED_EXAMPLE_DOC } from './helpers.ts';

const doc = readFileSync(WORKED_EXAMPLE_DOC, 'utf8');

test('the fixture is the document example (no silent edits to make it pass)', () => {
  const blocks = [...doc.matchAll(/```json\n([\s\S]*?)\n```/g)].map((m) => m[1]);
  assert.equal(blocks.length, 1, 'the document should contain exactly one JSON example');
  assert.deepEqual(validBlueprint(), JSON.parse(blocks[0]));
});

test('the unmodified worked example is accepted, as an assembled blueprint and as model output', () => {
  assertAccepted(validateProductBlueprint(validBlueprint()));
  assertAccepted(validateBlueprintModelOutput(validModelOutput()));
});

test('the counts the document states for its example agree with a recomputation', () => {
  const bp = validBlueprint();
  assert.deepEqual(countClaimsByBasis(bp), { verified_evidence: 6, ai_recommendation: 7, hypothesis: 8, unknown: 3 });
  assert.equal(claimSites(bp).length, 24);
  assert.equal(refSites(bp).length, 20);
  assert.deepEqual(bp.verification.claim_counts, countClaimsByBasis(bp));
  assert.equal(bp.verification.ref_count, refSites(bp).length);
});

test('the list of claim locations covers every Claim-shaped object in the document, so a new Claim cannot be added unnoticed', () => {
  const found: string[] = [];
  const scan = (node: unknown, pointer: string): void => {
    if (Array.isArray(node)) { node.forEach((v, i) => scan(v, `${pointer}/${i}`)); return; }
    if (node === null || typeof node !== 'object') return;
    const rec = node as Record<string, unknown>;
    if ('text' in rec && 'basis' in rec && 'evidence_refs' in rec) found.push(pointer);
    for (const [k, v] of Object.entries(rec)) scan(v, `${pointer}/${k}`);
  };
  const model: BlueprintModelOutputV1 = validModelOutput();
  scan(model, '');
  assert.deepEqual(claimSites(model).map((s) => s.path).sort(), found.sort());
});

test('the example exercises every optional-field family and both kinds of evidence', () => {
  const bp = validBlueprint();
  assert.ok(bp.evidence_index.some((e) => e.kind === 'discussion_excerpt'));
  assert.ok(bp.evidence_index.some((e) => e.kind === 'cluster_metric'));
  const text = JSON.stringify(validModelOutput());
  for (const key of ['"rationale"', '"validation"', '"missing_information"', '"confidence"', '"guard"', '"system_response"', '"default"', '"retention"', '"expected_volume"', '"notes"']) assert.ok(text.includes(key), key);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Drift guards: the document and constants.ts say the same thing
// ---------------------------------------------------------------------------------------------------------------------------------

const ENUMS: Record<string, readonly string[]> = {
  LEVEL3: C.LEVEL3, BASIS: C.BASIS, OPPORTUNITY_VERDICT: C.OPPORTUNITY_VERDICT, ALTERNATIVE_KIND: C.ALTERNATIVE_KIND, SIGNAL_STRENGTH: C.SIGNAL_STRENGTH, WTP_STATUS: C.WTP_STATUS,
  EVIDENCE_SUFFICIENCY: C.EVIDENCE_SUFFICIENCY, PERSONA_PRIORITY: C.PERSONA_PRIORITY, BUYING_ROLE: C.BUYING_ROLE, PRODUCT_TYPE: C.PRODUCT_TYPE, COMPLEXITY: C.COMPLEXITY,
  FEATURE_PRIORITY: C.FEATURE_PRIORITY, STEP_ACTOR: C.STEP_ACTOR, ARCHITECTURE_STYLE: C.ARCHITECTURE_STYLE, TECH_AREA: C.TECH_AREA, REVERSIBILITY: C.REVERSIBILITY,
  INTEGRATION_DIRECTION: C.INTEGRATION_DIRECTION, NFR_CATEGORY: C.NFR_CATEGORY, TENANCY_MODEL: C.TENANCY_MODEL, REFERENTIAL_ACTION: C.REFERENTIAL_ACTION, INDEX_METHOD: C.INDEX_METHOD,
  RLS_OPERATION: C.RLS_OPERATION, RLS_ROLE: C.RLS_ROLE, EXPECTED_VOLUME: C.EXPECTED_VOLUME, TASK_TYPE: C.TASK_TYPE, TASK_SIZE: C.TASK_SIZE, TEST_LEVEL: C.TEST_LEVEL,
  EXPERIMENT_METHOD: C.EXPERIMENT_METHOD, PRICING_MODEL: C.PRICING_MODEL, MARKET_SIZING_STATUS: C.MARKET_SIZING_STATUS, RISK_CATEGORY: C.RISK_CATEGORY,
  TEAM_SIZE: C.TEAM_SIZE, BUDGET_BAND: C.BUDGET_BAND, PREFERRED_STACK: C.PREFERRED_STACK, BUSINESS_MODEL_HINT: C.BUSINESS_MODEL_HINT, TARGET_REGION: C.TARGET_REGION,
  PASS_NAME: C.PASS_NAME, GENERATION_MODE: C.GENERATION_MODE, METRIC_CLASS: C.METRIC_CLASS, METRIC_NAME: C.METRIC_NAME, ANALYSIS_METHOD: C.ANALYSIS_METHOD,
  VERIFICATION_CHECK_NAME: C.VERIFICATION_CHECK_NAME, REPAIR_ACTION: C.REPAIR_ACTION, VERIFICATION_STATUS: C.VERIFICATION_STATUS,
};

/** Every union of two or more string literals in the document, as a sorted set (type aliases and inline property unions alike). */
function documentUnions(): string[][] {
  const unions: string[][] = [];
  const re = /(?:=|:)\s*((?:\n?\s*\|?\s*'[^']*'\s*(?:\|\s*)?){2,})/g;
  for (const m of doc.matchAll(re)) {
    const lits = [...m[1].matchAll(/'([^']*)'/g)].map((x) => x[1]);
    if (lits.length >= 2) unions.push([...new Set(lits)].sort());
  }
  return unions;
}

test('every enumeration written in the document is an enumeration in constants.ts', () => {
  const known = new Set(Object.values(ENUMS).map((v) => JSON.stringify([...v].sort())));
  const unions = documentUnions();
  assert.ok(unions.length > 40, `expected to find the document's enumerations, found ${unions.length}`);
  for (const u of unions) {
    if (u.includes('schema_version')) continue; // Pick<...> key lists, not an enumeration
    if (u.every((x) => (C.PG_SIMPLE_TYPES as readonly string[]).includes(x))) continue; // the column-type list has its own test below
    if (u.includes('discussion_excerpt') || u.includes('cluster_metric')) continue; // discriminator of the evidence union
    assert.ok(known.has(JSON.stringify(u)), `document enumeration not in constants.ts: ${u.join(', ')}`);
  }
});

test('every enumeration in constants.ts appears in the document', () => {
  const unions = new Set(documentUnions().map((u) => JSON.stringify(u)));
  for (const [name, values] of Object.entries(ENUMS)) {
    assert.ok(unions.has(JSON.stringify([...values].sort())), `constants.ts ${name} is not written in the document`);
  }
});

test('identifier patterns match the document comments exactly', () => {
  const documented: Record<string, string> = {
    evidence: '^[EM]\\d{2}$', persona: '^P\\d$', feature: '^F\\d{1,2}$', journey: '^J\\d$', workflow: '^W\\d$', component: '^C\\d{1,2}$', decision: '^D\\d{1,2}$',
    task: '^T\\d{2}$', phase: '^PH\\d$', criterion: '^AC\\d{2}$', experiment: '^X\\d$', risk: '^R\\d{1,2}$', assumption: '^A\\d{1,2}$', unknown: '^U\\d{1,2}$',
    gap: '^G\\d$', signal: '^S\\d$', pricing: '^H\\d$', goToMarketStep: '^GT\\d$',
  };
  for (const [key, source] of Object.entries(documented)) {
    assert.equal((C.ID_PATTERNS as Record<string, RegExp>)[key].source, source, key);
    assert.ok(doc.includes(`/${source}/`), `the document does not show /${source}/`);
  }
  assert.equal(Object.keys(C.ID_PATTERNS).length, Object.keys(documented).length);
});

test('the column-type list matches the document', () => {
  const block = doc.slice(doc.indexOf('export type PgType'), doc.indexOf('export interface ColumnDesign'));
  const plain = [...block.matchAll(/'([^']*)'/g)].map((m) => m[1]).filter((t) => !t.includes('${'));
  const simple = C.PG_SIMPLE_TYPES.filter((t) => !t.endsWith('[]'));
  for (const t of simple) assert.ok(plain.includes(t), `${t} is in constants.ts but not in the document`);
  for (const t of plain) assert.ok((C.PG_SIMPLE_TYPES as readonly string[]).includes(t) || ['uuid', 'text', 'integer', 'bigint'].includes(t), `${t} is in the document but not in constants.ts`);
  assert.deepEqual(C.PG_SIMPLE_TYPES.filter((t) => t.endsWith('[]')).sort(), ['bigint[]', 'integer[]', 'text[]', 'uuid[]']);
});

test('the metric catalogue has 16 entries: ten named metrics and six score components', () => {
  assert.equal(C.METRIC_CATALOGUE_NAMES.length, 16);
  assert.equal(C.METRIC_CATALOGUE_NAMES.filter((n) => n === 'score_component').length, 6);
  for (const n of C.METRIC_CATALOGUE_NAMES) assert.ok((C.METRIC_NAME as readonly string[]).includes(n));
});

test('every claim role has an allowed-basis list drawn from the four bases, and there are 16 roles', () => {
  const roles = Object.keys(C.BASIS_BY_ROLE);
  assert.equal(roles.length, 16);
  for (const r of roles) for (const b of C.BASIS_BY_ROLE[r as keyof typeof C.BASIS_BY_ROLE]) assert.ok((C.BASIS as readonly string[]).includes(b));
});

test('the market-sizing statement and the schema version are the documented literals', () => {
  assert.equal(C.NOT_ESTIMATED_TEXT, 'Not estimated — insufficient market-sizing evidence');
  assert.equal(C.BLUEPRINT_SCHEMA_VERSION, 'product-blueprint.v1');
  assert.ok(doc.includes(C.NOT_ESTIMATED_TEXT));
});

test('the safeguard table is explicit: each undocumented limit is a named constant, and none loosens a documented one', () => {
  assert.ok(C.SAFEGUARDS.maxErrors > 0 && C.SAFEGUARDS.maxNodes > C.SAFEGUARDS.maxDepth);
  assert.equal(C.BLUEPRINT_MAX_RESULT_BYTES, 262_144);
  assert.equal(C.MVP_MAX_MUST, 5);
  assert.equal(C.MVP_MAX_SHOULD, 2);
  assert.equal(C.WTP_MIN_EXCERPTS, 2);
  assert.equal(C.SAFEGUARDS.featureIdList.max, C.COUNT.features.max); // an id list cannot be longer than the number of features
  assert.equal(C.SAFEGUARDS.personaIdList.max, C.COUNT.personas.max);
});
