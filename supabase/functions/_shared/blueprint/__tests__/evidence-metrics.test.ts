// Phase A3: the fixed metric catalogue M01-M16 (evidence contract section 3.2). Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { METRIC_CATALOGUE_NAMES } from '../constants.ts';
import { Ctx } from '../validate-core.ts';
import { readBackendStructure } from '../validate-backend.ts';
import { bucketCount, buildGroundingContext, isSupportingGrade, roundToStep } from '../evidence.ts';
import type { ClusterInput, PackMetric } from '../evidence.ts';
import { cluster, input, manyMembers, prepared, rejected } from './evidence-fixtures.ts';

const metricsOf = (over: Partial<ClusterInput> = {}): PackMetric[] => prepared(input([], over)).pack.metrics;
const m = (ms: PackMetric[], id: string): PackMetric => ms.find((x) => x.id === id) as PackMetric;
const withComponent = (key: string, value: number | null, basis: string): Partial<ClusterInput> => ({ scores: { components: { [key]: { value, basis } } } as unknown as ClusterInput['scores'] });

// ---------------------------------------------------------------------------------------------------------------------------------
// The catalogue itself
// ---------------------------------------------------------------------------------------------------------------------------------

test('the catalogue always lists exactly M01..M16, in order, with the fixed names, even for an empty cluster', () => {
  const ms = metricsOf();
  assert.deepEqual(ms.map((x) => x.id), Array.from({ length: 16 }, (_, i) => `M${String(i + 1).padStart(2, '0')}`));
  assert.deepEqual(ms.map((x) => x.name), [...METRIC_CATALOGUE_NAMES]);
  assert.equal(ms.length, 16);
});

test('metric ids have the same meaning for every cluster (names and labels never change with the data)', () => {
  const a = metricsOf();
  const b = metricsOf({ unique_discussions: 0, source_count: 0, sources: [], growth_rate: null, severity_avg: null, competitors: {}, scores: null, confidence: 'low' });
  assert.deepEqual(a.map((x) => [x.id, x.name, x.label]), b.map((x) => [x.id, x.name, x.label]));
  for (const x of a) assert.ok(x.label.length > 0 && x.label.length <= 200);
});

test('M01-M05 use the labels written in the worked example of product-blueprint-v1.md', () => {
  const ms = metricsOf();
  assert.equal(m(ms, 'M01').label, 'Independent discussions in this cluster');
  assert.equal(m(ms, 'M02').label, 'Distinct sources');
  assert.equal(m(ms, 'M03').label, 'Discussion growth, last 30 days versus the 30 before');
  assert.equal(m(ms, 'M04').label, 'Records with a grounded willingness-to-pay quote');
  assert.equal(m(ms, 'M05').label, 'Cluster confidence rating');
});

test('every metric maps to its documented source column, value and class', () => {
  const c = cluster({
    unique_discussions: 14, source_count: 3, growth_rate: 27, wtp_signals: 6, confidence: 'high', sources: ['stackexchange', 'github'],
    recent_discussions: 7, prior_discussions: 3, severity_avg: 3.3, competitors: { linear: 2, notion: 5 },
  });
  const ms = prepared({ cluster: c, members: [] }).pack.metrics;
  const got = ms.map((x) => [x.id, x.name, x.value, x.evidence_class]);
  assert.deepEqual(got.slice(0, 10), [
    ['M01', 'unique_discussions', 14, 'measured'],
    ['M02', 'source_count', 3, 'measured'],
    ['M03', 'growth_rate_pct', 30, 'derived'],                  // 27 rounded to the nearest 10
    ['M04', 'wtp_signal_count', 6, 'measured'],
    ['M05', 'cluster_confidence', 'high', 'derived'],
    ['M06', 'sources', ['github', 'stackexchange'], 'measured'], // sorted
    ['M07', 'recent_discussions', '6-10', 'measured'],           // 7 bucketed
    ['M08', 'prior_discussions', '3-5', 'measured'],             // 3 bucketed
    ['M09', 'severity_avg', 3.5, 'ai_estimate'],                 // 3.3 rounded to the nearest 0.5
    ['M10', 'competitor_mentions', { linear: 2, notion: 5 }, 'measured'],
  ]);
});

test('M11-M16 are the six score components in dr_refresh_clusters order, each carrying its own basis mapped to a MetricClass', () => {
  const ms = metricsOf();
  assert.deepEqual(ms.slice(10).map((x) => [x.id, x.name, x.value, x.evidence_class]), [
    ['M11', 'score_component', 60, 'measured'],      // problemFrequency 62, measured
    ['M12', 'score_component', 70, 'measured'],      // demandGrowth 70, measured
    ['M13', 'score_component', 65, 'ai_estimate'],   // painIntensity 65, ai_estimate
    ['M14', 'score_component', 35, 'measured'],      // willingnessToPay 35, evidence_count -> measured
    ['M15', 'score_component', 60, 'derived'],       // competitionGap 60, derived
    ['M16', 'score_component', 55, 'ai_estimate'],   // developmentFeasibility 55, ai_estimate
  ]);
  assert.deepEqual(ms.slice(10).map((x) => x.label), [
    'Score component: problem frequency (0 to 100)', 'Score component: demand growth (0 to 100)', 'Score component: pain intensity (0 to 100)',
    'Score component: willingness to pay (0 to 100)', 'Score component: competition gap (0 to 100)', 'Score component: development feasibility (0 to 100)',
  ]);
});

test('every documented component basis maps to the documented MetricClass', () => {
  const cases: [string, number | null, string][] = [
    ['measured', 50, 'measured'], ['evidence_count', 50, 'measured'], ['derived', 50, 'derived'], ['ai_estimate', 50, 'ai_estimate'], ['insufficient_data', null, 'insufficient_data'],
  ];
  for (const [basis, value, expected] of cases) {
    const ms = metricsOf(withComponent('problemFrequency', value, basis));
    assert.equal(m(ms, 'M11').evidence_class, expected, `basis ${basis}`);
  }
});

test('the full class vector: only M01, M02, M04, M06, M07, M08, M10 are plain measured; M09 is an AI estimate; M05 is derived', () => {
  assert.deepEqual(metricsOf().slice(0, 10).map((x) => x.evidence_class), [
    'measured', 'measured', 'derived', 'measured', 'derived', 'measured', 'measured', 'measured', 'ai_estimate', 'measured',
  ]);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Rounding: M03 nearest 10, M09 nearest 0.5, M11-M16 nearest 5 (boundaries, ties away from zero)
// ---------------------------------------------------------------------------------------------------------------------------------

test('M03 growth_rate_pct rounds to the nearest 10 percentage points; a tie rounds away from zero', () => {
  const cases: [number, number][] = [
    [0, 0], [4.99, 0], [5, 10], [5.01, 10], [14.99, 10], [15, 20], [15.01, 20], [27, 30], [100, 100], [124.99, 120], [125, 130], [400, 400],
    [-4.99, 0], [-5, -10], [-14.99, -10], [-15, -20], [-100, -100],
  ];
  for (const [raw, rounded] of cases) assert.equal(m(metricsOf({ growth_rate: raw }), 'M03').value, rounded, `growth ${raw}`);
});

test('M03 never renders negative zero', () => {
  const v = m(metricsOf({ growth_rate: -4.99 }), 'M03').value;
  assert.ok(Object.is(v, 0), 'expected +0');
  assert.equal(JSON.stringify(v), '0');
});

test('M09 severity_avg rounds to the nearest 0.5; a tie rounds away from zero', () => {
  const cases: [number, number][] = [
    [1, 1], [1.24, 1], [1.25, 1.5], [1.26, 1.5], [1.74, 1.5], [1.75, 2], [2.5, 2.5], [3.249, 3], [3.25, 3.5], [3.3, 3.5], [4.74, 4.5], [4.75, 5], [5, 5],
  ];
  for (const [raw, rounded] of cases) assert.equal(m(metricsOf({ severity_avg: raw }), 'M09').value, rounded, `severity ${raw}`);
});

test('M11-M16 rounds to the nearest 5; a tie rounds away from zero; all six components use the same rule', () => {
  const cases: [number, number][] = [[0, 0], [2.4, 0], [2.5, 5], [7.4, 5], [7.5, 10], [62, 60], [62.5, 65], [97.4, 95], [97.5, 100], [100, 100]];
  const keys = ['problemFrequency', 'demandGrowth', 'painIntensity', 'willingnessToPay', 'competitionGap', 'developmentFeasibility'];
  keys.forEach((key, i) => {
    for (const [raw, rounded] of cases) {
      const ms = metricsOf(withComponent(key, raw, 'measured'));
      assert.equal(m(ms, `M${11 + i}`).value, rounded, `${key} ${raw}`);
    }
  });
});

test('roundToStep: exact multiples are unchanged and the function is monotone', () => {
  for (const step of [0.5, 5, 10]) for (let k = -6; k <= 6; k++) assert.equal(roundToStep(k * step, step), k * step);
  let last = -Infinity;
  for (let x = -30; x <= 30; x += 0.25) { const r = roundToStep(x, 5); assert.ok(r >= last); last = r; }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Buckets: M07 and M08
// ---------------------------------------------------------------------------------------------------------------------------------

test('M07 and M08 render as the documented bucket labels, with every boundary', () => {
  const expected: [number, string][] = [
    [0, '0'], [1, '1-2'], [2, '1-2'], [3, '3-5'], [5, '3-5'], [6, '6-10'], [10, '6-10'], [11, '11+'], [12, '11+'], [1000, '11+'],
  ];
  for (const [n, label] of expected) {
    assert.equal(bucketCount(n), label);
    const ms = metricsOf({ recent_discussions: n, prior_discussions: n });
    assert.equal(m(ms, 'M07').value, label);
    assert.equal(m(ms, 'M08').value, label);
  }
});

test('bucketCount refuses values that are not whole numbers of at least 0', () => {
  for (const bad of [-1, 1.5, NaN, Infinity]) assert.throws(() => bucketCount(bad), RangeError);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Null and insufficient-data handling
// ---------------------------------------------------------------------------------------------------------------------------------

test('M03: a null growth rate stays null and is insufficient_data; a zero growth rate is a real value', () => {
  assert.deepEqual([m(metricsOf({ growth_rate: null }), 'M03').value, m(metricsOf({ growth_rate: null }), 'M03').evidence_class], [null, 'insufficient_data']);
  assert.deepEqual([m(metricsOf({ growth_rate: 0 }), 'M03').value, m(metricsOf({ growth_rate: 0 }), 'M03').evidence_class], [0, 'derived']);
});

test('M09: a null severity is listed as null and insufficient_data, not as an AI estimate', () => {
  const x = m(metricsOf({ severity_avg: null }), 'M09');
  assert.deepEqual([x.value, x.evidence_class], [null, 'insufficient_data']);
});

test('M11-M16: a cluster that was never refreshed (no scores) still lists all six, as null and insufficient_data', () => {
  for (const scores of [null, undefined, {}, { components: {} }, { components: null }]) {
    const ms = metricsOf({ scores: scores as ClusterInput['scores'] });
    for (const x of ms.slice(10)) assert.deepEqual([x.value, x.evidence_class], [null, 'insufficient_data']);
    assert.equal(ms.length, 16);
  }
});

test('M11-M16: a null component value is insufficient_data whatever basis it carries', () => {
  const ms = metricsOf(withComponent('demandGrowth', null, 'measured'));
  assert.deepEqual([m(ms, 'M12').value, m(ms, 'M12').evidence_class], [null, 'insufficient_data']);
});

test('M11-M16: a component whose basis is insufficient_data cannot also carry a value (rejected as inconsistent)', () => {
  const errors = rejected(input([], withComponent('painIntensity', 40, 'insufficient_data')));
  assert.deepEqual(errors.map((e) => e.code), ['inconsistent_component']);
  assert.equal(errors[0].path, '/cluster/scores/components/painIntensity');
});

test('M05 is the stored confidence word; M04 is the stored wtp_signals', () => {
  for (const confidence of ['low', 'medium', 'high'] as const) assert.equal(m(metricsOf({ confidence }), 'M05').value, confidence);
  assert.equal(m(metricsOf({ wtp_signals: 0 }), 'M04').value, 0);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// AI-estimate and insufficient-data metrics never support a verified claim
// ---------------------------------------------------------------------------------------------------------------------------------

test('metrics of class ai_estimate or insufficient_data are not supporting-grade; measured and derived ones are', () => {
  const p = prepared(input([], { growth_rate: null }));
  const ctx = buildGroundingContext(p.pack);
  const verdict = Object.fromEntries(p.pack.metrics.map((x) => [x.id, isSupportingGrade(ctx, x.id)]));
  assert.equal(verdict.M09, false);   // ai_estimate
  assert.equal(verdict.M13, false);   // ai_estimate component
  assert.equal(verdict.M16, false);   // ai_estimate component
  assert.equal(verdict.M03, false);   // null growth: insufficient_data
  for (const id of ['M01', 'M02', 'M04', 'M05', 'M06', 'M07', 'M08', 'M10', 'M11', 'M12', 'M14', 'M15']) assert.equal(verdict[id], true, id);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// One rounded value everywhere
// ---------------------------------------------------------------------------------------------------------------------------------

test('the model-facing pack and the backend index hold the same rounded value, class, name and label for every metric', () => {
  const p = prepared(input([], { growth_rate: 14, severity_avg: 3.3, recent_discussions: 4, prior_discussions: 8, competitors: { a: 1, b: 2 } }));
  for (const metric of p.pack.metrics) {
    const entry = p.index.find((e) => e.id === metric.id);
    assert.ok(entry && entry.kind === 'cluster_metric');
    assert.deepEqual([entry.value, entry.evidence_class, entry.name, entry.label], [metric.value, metric.evidence_class, metric.name, metric.label]);
  }
  assert.equal(m(p.pack.metrics, 'M03').value, 10);
  assert.equal(m(p.pack.metrics, 'M09').value, 3.5);
});

test('the canonical pack carries the rounded values, never the exact ones', () => {
  const p = prepared(input([], { growth_rate: 14.7, severity_avg: 3.3, scores: { components: { problemFrequency: { value: 62.3, basis: 'measured' } } } }));
  assert.ok(p.canonical_pack_json.includes('"value":10')); // growth 14.7 -> 10
  assert.ok(!p.canonical_pack_json.includes('14.7'));
  assert.ok(!p.canonical_pack_json.includes('62.3'));
  assert.ok(!p.canonical_pack_json.includes('3.3'));
});

test('cache stability: drift inside a rounding band or a bucket does not change the canonical pack; crossing the boundary does', () => {
  const key = (over: Partial<ClusterInput>) => prepared(input([], over)).canonical_pack_json;
  const base = key({});                                                   // growth 40, severity 3.5, recent 4, prior 2
  assert.equal(key({ growth_rate: 44 }), base);                           // still rounds to 40
  assert.notEqual(key({ growth_rate: 45 }), base);                        // rounds to 50
  assert.equal(key({ recent_discussions: 3 }), base);                     // 3..5 is one bucket
  assert.equal(key({ recent_discussions: 5 }), base);
  assert.notEqual(key({ recent_discussions: 6 }), base);
  assert.notEqual(key({ recent_discussions: 2 }), base);
  assert.equal(key({ prior_discussions: 1 }), key({ prior_discussions: 2 }));
  assert.equal(key({ severity_avg: 3.3 }), base);                         // 3.3 and 3.5 both render 3.5
  assert.notEqual(key({ severity_avg: 3.2 }), base);                      // renders 3.0
  assert.equal(key({ scores: { components: { problemFrequency: { value: 60, basis: 'measured' } } } }), key({ scores: { components: { problemFrequency: { value: 62, basis: 'measured' } } } }));
});

test('exact metrics are NOT rounded: a change in M01, M02, M04, M05, M06 or M10 changes the canonical pack', () => {
  const key = (over: Partial<ClusterInput>) => prepared(input([], over)).canonical_pack_json;
  const base = key({});
  for (const over of [
    { unique_discussions: 13 }, { source_count: 2 }, { wtp_signals: 3 }, { confidence: 'medium' as const },
    { sources: ['github'] }, { competitors: { notion: 4, linear: 1 } },
  ]) assert.notEqual(key(over), base, JSON.stringify(over));
});

test('the metrics come from the cluster row, not from the members: the same cluster gives the same catalogue with or without evidence', () => {
  assert.deepEqual(prepared(input(manyMembers(3))).pack.metrics, prepared(input([])).pack.metrics);
  assert.equal(m(prepared(input(manyMembers(3))).pack.metrics, 'M01').value, 12); // 12 stored discussions, 3 members supplied
});

// ---------------------------------------------------------------------------------------------------------------------------------
// M06 and M10 shape
// ---------------------------------------------------------------------------------------------------------------------------------

test('M06 sources are de-duplicated and sorted, so the database array order cannot change the pack', () => {
  const a = m(metricsOf({ sources: ['stackexchange', 'github', 'github', 'hackernews'] }), 'M06').value;
  const b = m(metricsOf({ sources: ['hackernews', 'github', 'stackexchange'] }), 'M06').value;
  assert.deepEqual(a, ['github', 'hackernews', 'stackexchange']);
  assert.deepEqual(a, b);
});

test('M10 competitor mentions are listed by name, whatever order the object had', () => {
  const v = m(metricsOf({ competitors: { zeta: 1, alpha: 2, mid: 3 } }), 'M10').value as Record<string, number>;
  assert.deepEqual(Object.keys(v), ['alpha', 'mid', 'zeta']);
  assert.deepEqual(m(metricsOf({ competitors: {} }), 'M10').value, {});
});

test('M10: a competitor called "__proto__" is an ordinary entry and never changes a prototype', () => {
  const competitors = JSON.parse('{"__proto__": 3, "plain": 1}') as Record<string, number>;
  const p = prepared(input([], { competitors }));
  const v = m(p.pack.metrics, 'M10').value as Record<string, number>;
  assert.deepEqual(Object.keys(v).sort(), ['__proto__', 'plain']);
  assert.equal(Object.getPrototypeOf(v), Object.prototype);
  assert.equal(Object.getOwnPropertyDescriptor(v, '__proto__')?.value, 3);
  assert.ok(p.canonical_pack_json.includes('"__proto__":3'));
});

test('M10 beyond the A2 limit of 64 entries keeps the 64 with the most discussions (ties by name), and says so in the diagnostics', () => {
  const competitors = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`name${String(i).padStart(2, '0')}`, i < 6 ? 1 : 10]));
  const p = prepared(input([], { competitors }));
  const v = m(p.pack.metrics, 'M10').value as Record<string, number>;
  assert.equal(Object.keys(v).length, 64);
  for (let i = 0; i < 6; i++) assert.ok(!(`name0${i}` in v), `name0${i} (1 discussion) must be dropped`);
  assert.deepEqual(p.diagnostics.metrics_value_truncated, ['M10']);
  assert.deepEqual(prepared(input([], { competitors: { a: 1 } })).diagnostics.metrics_value_truncated, []);
  // The index entry must still satisfy the A2 structural validator.
  const c = new Ctx('assembled');
  readBackendStructure(c, { evidence_index: p.index });
  assert.deepEqual(c.errors, []);
});

test('the pack and the index never share mutable metric values', () => {
  const p = prepared(input([], { sources: ['github', 'hackernews'] }));
  (m(p.pack.metrics, 'M06').value as string[]).push('tampered');
  (m(p.pack.metrics, 'M10').value as Record<string, number>).tampered = 1;
  const entry = p.index.find((e) => e.id === 'M06');
  assert.deepEqual(entry && entry.kind === 'cluster_metric' && entry.value, ['github', 'hackernews']);
  const comp = p.index.find((e) => e.id === 'M10');
  assert.ok(comp && comp.kind === 'cluster_metric' && !('tampered' in (comp.value as object)));
});
