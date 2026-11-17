// Phase A3 (review round 1): numeric input validation and rounding safety. Synthetic data only.
//
// Contract of these tests:
//  - severity_avg is accepted only inside the documented 1-5 range; score components only inside 0-100; growth_rate only inside a safety bound.
//  - An out-of-range or extreme finite value (Number.MAX_VALUE, ...) is rejected with a SPECIFIC, content-free error at the exact field path.
//  - No numeric input, however extreme, becomes a generic `internal_error`, and no accepted input produces a non-finite number in the output.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { EvidenceIndexEntry } from '../contract.ts';
import { ROUND_MAX_ABS, SCORE_COMPONENT_KEYS, VALUE_RANGES } from '../evidence-constants.ts';
import { prepareEvidencePack, roundToStep } from '../evidence.ts';
import type { ClusterInput } from '../evidence.ts';
import { readBackendStructure } from '../validate-backend.ts';
import { Ctx } from '../validate-core.ts';
import { cluster, input, member, prepared, rejected, shuffled } from './evidence-fixtures.ts';

const BIG = Number.MAX_VALUE;
const TINY = Number.MIN_VALUE; // 5e-324, the smallest positive double

const a2IndexErrors = (index: EvidenceIndexEntry[]) => {
  const c = new Ctx('assembled');
  readBackendStructure(c, { evidence_index: index });
  return c.errors;
};
const m = (over: Partial<ClusterInput>, id: string) => prepared(input([], over)).pack.metrics.find((x) => x.id === id)!;
const component = (key: string, value: number | null, basis = 'measured'): Partial<ClusterInput> =>
  ({ scores: { components: { [key]: { value, basis } } } as unknown as ClusterInput['scores'] });
/** Every number anywhere in a value. */
function numbersIn(v: unknown, out: number[] = []): number[] {
  if (typeof v === 'number') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => numbersIn(x, out));
  else if (v && typeof v === 'object') Object.values(v).forEach((x) => numbersIn(x, out));
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// severity_avg: documented 1-5
// ---------------------------------------------------------------------------------------------------------------------------------

test('severity_avg: the documented 1-5 range is accepted at both ends and everywhere between', () => {
  for (const v of [1, 1.0000000000000002, 1.5, 3, 4.999999999999999, 5]) {
    assert.equal(prepareEvidencePack(input([], { severity_avg: v })).ok, true, String(v));
  }
  assert.equal(m({ severity_avg: 1 }, 'M09').value, 1);
  assert.equal(m({ severity_avg: 5 }, 'M09').value, 5);
  assert.equal(m({ severity_avg: 4.999 }, 'M09').value, 5);  // rounds to the nearest 0.5, still inside 1-5
  assert.equal(m({ severity_avg: 1.0000001 }, 'M09').value, 1);
});

test('severity_avg: values just outside the range, and extreme finite values, are rejected with a specific error at the exact path', () => {
  for (const v of [0.9999999999999999, 0, -0.0000001, -1, 5.000000000000001, 5.01, 6, 1e6, 1e15, 1e300, BIG, -BIG, TINY, -TINY, NaN, Infinity, -Infinity]) {
    const e = rejected(input([], { severity_avg: v }));
    assert.deepEqual(e.map((x) => [x.code, x.path]), [['number_out_of_range', '/cluster/severity_avg']], String(v));
    assert.equal(e[0].message, 'The value must be a finite number between 1 and 5.');
  }
});

test('severity_avg: null is still "no estimate" (insufficient_data); a non-number is a type error, not a range error', () => {
  assert.equal(m({ severity_avg: null }, 'M09').evidence_class, 'insufficient_data');
  for (const bad of ['3', true, [], {}]) {
    assert.deepEqual(rejected(input([], { severity_avg: bad as unknown as number })).map((x) => x.code), ['invalid_type']);
  }
});

test('the documented range constants are the ones the schema and refresh function state', () => {
  assert.deepEqual({ ...VALUE_RANGES.severityAvg }, { min: 1, max: 5 });
  assert.deepEqual({ ...VALUE_RANGES.scoreComponent }, { min: 0, max: 100 });
  assert.ok(VALUE_RANGES.growthRatePct.max < ROUND_MAX_ABS && -VALUE_RANGES.growthRatePct.min < ROUND_MAX_ABS);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// score components: documented 0-100
// ---------------------------------------------------------------------------------------------------------------------------------

test('score components: 0 and 100 are accepted for every component, and round inside the range', () => {
  SCORE_COMPONENT_KEYS.forEach((key, i) => {
    const id = `M${11 + i}`;
    assert.equal(m(component(key, 0), id).value, 0, key);
    assert.equal(m(component(key, 100), id).value, 100, key);
    assert.equal(m(component(key, 99.99), id).value, 100, key);   // rounds up to the top of the range, not past it
    assert.equal(m(component(key, 0.01), id).value, 0, key);
    assert.equal(m(component(key, 50), id).value, 50, key);
  });
});

test('score components: -0 is accepted and renders as plain 0', () => {
  const v = m(component('problemFrequency', -0), 'M11').value;
  assert.ok(Object.is(v, 0));
});

test('score components: values just outside 0-100, and extreme finite values, are rejected for every component with a specific error', () => {
  for (const key of SCORE_COMPONENT_KEYS) {
    for (const v of [-TINY, -0.0000001, -1, 100.00000000000001, 100.01, 101, 1e6, 1e300, BIG, -BIG, NaN, Infinity, -Infinity]) {
      const e = rejected(input([], component(key, v)));
      assert.deepEqual(e.map((x) => [x.code, x.path]), [['number_out_of_range', `/cluster/scores/components/${key}/value`]], `${key} ${v}`);
      assert.equal(e[0].message, 'The value must be a finite number between 0 and 100.');
    }
  }
});

test('score components: a null value stays allowed (insufficient_data); the range applies to the value, not to the basis', () => {
  assert.equal(m(component('demandGrowth', null, 'ai_estimate'), 'M12').evidence_class, 'insufficient_data');
  assert.deepEqual(rejected(input([], component('demandGrowth', 150, 'insufficient_data'))).map((x) => x.code), ['number_out_of_range']);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// growth_rate: safety bound
// ---------------------------------------------------------------------------------------------------------------------------------

test('growth_rate: the safety bound is accepted at both ends and rounds exactly; tiny magnitudes round to plain 0', () => {
  assert.equal(m({ growth_rate: 1e12 }, 'M03').value, 1e12);
  assert.equal(m({ growth_rate: -1e12 }, 'M03').value, -1e12);
  for (const v of [TINY, -TINY, 4.999999999999999, -4.999999999999999]) assert.ok(Object.is(m({ growth_rate: v }, 'M03').value, 0), String(v));
  assert.equal(m({ growth_rate: -100 }, 'M03').value, -100);   // the lowest value the refresh formula can produce
});

test('growth_rate: beyond the safety bound, and extreme finite values, are rejected with a specific error', () => {
  for (const v of [1e12 + 1, -(1e12 + 1), 1e13, 1e15, 1e16, 1e300, BIG, -BIG, NaN, Infinity, -Infinity]) {
    const e = rejected(input([], { growth_rate: v }));
    assert.deepEqual(e.map((x) => [x.code, x.path]), [['number_out_of_range', '/cluster/growth_rate']], String(v));
    assert.equal(e[0].message, 'The value must be a finite number between -1000000000000 and 1000000000000.');
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// roundToStep: overflow protection
// ---------------------------------------------------------------------------------------------------------------------------------

test('roundToStep refuses extreme or non-finite values instead of returning Infinity or a value that is not a multiple of the step', () => {
  for (const x of [BIG, -BIG, 1e300, 1e16, ROUND_MAX_ABS * 1.0000001, NaN, Infinity, -Infinity]) {
    assert.throws(() => roundToStep(x, 0.5), RangeError, `${x} step 0.5`);
    assert.throws(() => roundToStep(x, 10), RangeError, `${x} step 10`);
  }
  for (const step of [0, -5, NaN, Infinity]) assert.throws(() => roundToStep(1, step), RangeError);
});

test('roundToStep is exact and finite across its whole domain, including its edges', () => {
  for (const step of [0.5, 5, 10]) {
    for (const x of [ROUND_MAX_ABS, -ROUND_MAX_ABS, 1e12, -1e12, 123456789012.25, 0, -0, TINY, -TINY, 0.25, -0.25]) {
      const r = roundToStep(x, step);
      assert.ok(Number.isFinite(r));
      assert.ok(Math.abs(r - x) <= step / 2 + 1e-6, `${x} ${step}`);
      assert.equal(Math.abs(r / step) % 1, 0, `a multiple of ${step}: ${x} gave ${r}`);
      assert.ok(!Object.is(r, -0));
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Counts
// ---------------------------------------------------------------------------------------------------------------------------------

test('counts: the largest safe integer is accepted; anything beyond it, fractional or extreme is rejected with the full range in the message', () => {
  const COUNT_FIELDS = ['unique_discussions', 'source_count', 'recent_discussions', 'prior_discussions', 'wtp_signals'] as const;
  for (const f of COUNT_FIELDS) {
    assert.equal(prepareEvidencePack(input([], { [f]: Number.MAX_SAFE_INTEGER })).ok, true, f);
    for (const v of [Number.MAX_SAFE_INTEGER + 1, 2 ** 53 + 2, 1e300, BIG, -1, -BIG, 0.5, NaN, Infinity]) {
      const e = rejected(input([], { [f]: v }));
      assert.deepEqual(e.map((x) => [x.code, x.path]), [['number_out_of_range', `/cluster/${f}`]], `${f} ${v}`);
      assert.equal(e[0].message, `Expected a whole number between 0 and ${Number.MAX_SAFE_INTEGER}.`);
    }
  }
  assert.equal(m({ recent_discussions: Number.MAX_SAFE_INTEGER }, 'M07').value, '11+');
});

test('counts: -0 is the same count as 0 and renders as plain 0', () => {
  assert.ok(Object.is(m({ unique_discussions: -0 }, 'M01').value, 0));
  assert.ok(Object.is((m({ competitors: { a: -0 } }, 'M10').value as Record<string, number>).a, 0));
});

test('competitor counts: out-of-range counts are rejected without echoing the name', () => {
  for (const n of [-1, 1.5, BIG, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity]) {
    const e = rejected(input([], { competitors: { 'SECRET-NAME': n } }));
    assert.deepEqual(e.map((x) => [x.code, x.path]), [['number_out_of_range', '/cluster/competitors']]);
    assert.ok(!JSON.stringify(e).includes('SECRET'));
  }
  assert.equal(prepareEvidencePack(input([], { competitors: { a: Number.MAX_SAFE_INTEGER } })).ok, true);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The whole-input property: extreme numbers never become internal errors or non-finite output
// ---------------------------------------------------------------------------------------------------------------------------------

const EXTREMES = [BIG, -BIG, TINY, -TINY, 0, -0, 1e300, 1e16, 1e15, 1e12, 2 ** 53, 2 ** 53 + 2, Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER, 0.1 + 0.2, 4.9e-324, NaN, Infinity, -Infinity];

test('property: for every numeric cluster field and every extreme value the result is a clean acceptance or a specific rejection, never an internal error', () => {
  const fields: [string, (v: number) => Partial<ClusterInput>][] = [
    ['unique_discussions', (v) => ({ unique_discussions: v })], ['source_count', (v) => ({ source_count: v })],
    ['recent_discussions', (v) => ({ recent_discussions: v })], ['prior_discussions', (v) => ({ prior_discussions: v })],
    ['wtp_signals', (v) => ({ wtp_signals: v })], ['growth_rate', (v) => ({ growth_rate: v })], ['severity_avg', (v) => ({ severity_avg: v })],
    ['competitor count', (v) => ({ competitors: { rival: v } })],
    ...SCORE_COMPONENT_KEYS.map((k): [string, (v: number) => Partial<ClusterInput>] => [`component ${k}`, (v) => component(k, v)]),
  ];
  for (const [name, make] of fields) {
    for (const v of EXTREMES) {
      const r = prepareEvidencePack(input([member({ n: 1 }), member({ n: 2 })], make(v)));
      if (r.ok) {
        for (const n of numbersIn(r.value)) assert.ok(Number.isFinite(n), `${name} = ${v}: non-finite number in the output`);
        assert.deepEqual(JSON.parse(r.value.canonical_pack_json), r.value.pack, `${name} = ${v}`);
        assert.deepEqual(a2IndexErrors(r.value.index), [], `${name} = ${v}`);
      } else {
        for (const e of r.errors) {
          assert.notEqual(e.code, 'internal_error', `${name} = ${v} must not be an internal error`);
          assert.ok(e.path.startsWith('/cluster'), `${name} = ${v}: ${e.path}`);
          assert.ok(!e.message.includes(String(v)) || String(v).length < 3, 'the value is never echoed');
        }
      }
    }
  }
});

test('property: extreme engagement values never break selection or determinism', () => {
  const engagements: Record<string, unknown>[] = [
    { a: BIG, b: BIG }, { a: BIG, b: -BIG }, { a: -BIG }, { a: TINY }, { a: 1e300, b: 1e300, c: 1e300 }, { a: Number.MAX_SAFE_INTEGER, b: 1 },
    { a: '9'.repeat(400) }, { a: '-' + '9'.repeat(400) }, { a: NaN, b: Infinity, c: 5 }, { a: 1e16, b: 1, c: -1e16 },
  ];
  const members = engagements.map((engagement, i) => member({ n: i + 1, discussion: `d${i % 3}`, source: i % 2 ? 'github' : 'hackernews', engagement }));
  const base = prepared(input(members));
  for (const n of numbersIn(base.pack)) assert.ok(Number.isFinite(n));
  for (const seed of [1, 2, 3, 4, 5, 6]) assert.equal(prepared(input(shuffled(members, seed))).canonical_pack_json, base.canonical_pack_json, `seed ${seed}`);
  assert.deepEqual(a2IndexErrors(base.index), []);
});

test('rejections for different fields are all reported together, each with its own specific path', () => {
  const e = rejected(input([], { severity_avg: 9, growth_rate: BIG, ...component('painIntensity', -5) }));
  assert.deepEqual(e.map((x) => x.path).sort(), ['/cluster/growth_rate', '/cluster/scores/components/painIntensity/value', '/cluster/severity_avg']);
  assert.ok(e.every((x) => x.code === 'number_out_of_range'));
});

test('the error messages never contain the rejected value', () => {
  for (const v of [9.87654321, 123456.789, -777.5, 1e300]) {
    const text = JSON.stringify(rejected(input([], { severity_avg: v, ...component('painIntensity', v) })));
    assert.ok(!text.includes(String(v)), String(v));
  }
});

void cluster;
