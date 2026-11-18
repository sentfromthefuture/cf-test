// Phase A3: evidence sufficiency (evidence contract section 3.6). Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SUFFICIENCY_REASON_MESSAGES, SUFFICIENCY_THRESHOLDS, evaluateSufficiency } from '../evidence.ts';
import type { SufficiencyInput } from '../evidence.ts';
import { cluster, input, manyMembers, member, prepared } from './evidence-fixtures.ts';

const base: SufficiencyInput = { unique_discussions: 12, source_count: 3, confidence: 'high', usable_excerpts: 12 };
const evalWith = (over: Partial<SufficiencyInput>) => evaluateSufficiency({ ...base, ...over });
const messages = (over: Partial<SufficiencyInput>) => evalWith(over).reasons.map((r) => r.message);

test('the documented thresholds and the fixed reason wording', () => {
  assert.deepEqual({ ...SUFFICIENCY_THRESHOLDS }, {
    minUniqueDiscussions: 4, minUsableExcerpts: 3, adequateUsableExcerpts: 8, highConfidenceDiscussions: 10, highConfidenceSources: 2,
  });
  assert.deepEqual({ ...SUFFICIENCY_REASON_MESSAGES }, {
    fewer_than_min_discussions: 'fewer than 4 independent discussions',
    fewer_than_min_excerpts: 'fewer than 3 usable excerpts',
    fewer_than_high_discussions: 'fewer than 10 independent discussions',
    fewer_than_high_sources: 'fewer than 2 distinct sources',
    confidence_not_high: 'cluster confidence is not high',
    fewer_than_adequate_excerpts: 'fewer than 8 usable excerpts',
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// insufficient: unique_discussions < 4 OR fewer than 3 usable excerpts
// ---------------------------------------------------------------------------------------------------------------------------------

test('insufficient: 3 unique discussions is insufficient, 4 is not (boundary)', () => {
  assert.equal(evalWith({ unique_discussions: 3 }).level, 'insufficient');
  assert.notEqual(evalWith({ unique_discussions: 4 }).level, 'insufficient');
  assert.equal(evalWith({ unique_discussions: 0 }).level, 'insufficient');
});

test('insufficient: 2 usable excerpts is insufficient, 3 is not (boundary)', () => {
  assert.equal(evalWith({ usable_excerpts: 2 }).level, 'insufficient');
  assert.equal(evalWith({ usable_excerpts: 0 }).level, 'insufficient');
  assert.notEqual(evalWith({ usable_excerpts: 3 }).level, 'insufficient');
});

test('insufficient: either condition is enough, and both are listed (discussions first)', () => {
  assert.deepEqual(messages({ unique_discussions: 3 }), ['fewer than 4 independent discussions']);
  assert.deepEqual(messages({ usable_excerpts: 2 }), ['fewer than 3 usable excerpts']);
  assert.deepEqual(messages({ unique_discussions: 1, usable_excerpts: 0 }), ['fewer than 4 independent discussions', 'fewer than 3 usable excerpts']);
});

test('insufficient wins over everything else: high confidence cannot rescue too few discussions or excerpts', () => {
  assert.equal(evalWith({ confidence: 'high', unique_discussions: 3, usable_excerpts: 24 }).level, 'insufficient');
  assert.equal(evalWith({ confidence: 'high', usable_excerpts: 2 }).level, 'insufficient');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// limited: not insufficient, but confidence not high OR fewer than 8 usable excerpts
// ---------------------------------------------------------------------------------------------------------------------------------

test('limited: 7 usable excerpts is limited even with high confidence; 8 is adequate (boundary)', () => {
  assert.equal(evalWith({ usable_excerpts: 7 }).level, 'limited');
  assert.deepEqual(messages({ usable_excerpts: 7 }), ['fewer than 8 usable excerpts']);
  assert.equal(evalWith({ usable_excerpts: 8 }).level, 'adequate');
  assert.equal(evalWith({ usable_excerpts: 3 }).level, 'limited');
});

test('limited: confidence low or medium is limited however many excerpts there are', () => {
  for (const confidence of ['low', 'medium'] as const) {
    assert.equal(evalWith({ confidence, unique_discussions: 12, usable_excerpts: 24 }).level, 'limited', confidence);
  }
});

test('limited: the reason says which part of the `high` rule falls short (10 discussions across 2 sources)', () => {
  assert.deepEqual(messages({ confidence: 'medium', unique_discussions: 9, source_count: 2 }), ['fewer than 10 independent discussions']);
  assert.deepEqual(messages({ confidence: 'medium', unique_discussions: 12, source_count: 1 }), ['fewer than 2 distinct sources']);
  assert.deepEqual(messages({ confidence: 'low', unique_discussions: 5, source_count: 1 }), ['fewer than 10 independent discussions', 'fewer than 2 distinct sources']);
  // The stored confidence disagrees with its own rule (for example stale statistics): say only that it is not high.
  assert.deepEqual(messages({ confidence: 'medium', unique_discussions: 12, source_count: 3 }), ['cluster confidence is not high']);
});

test('limited: reproduces the two reasons written in the worked example of product-blueprint-v1.md', () => {
  const r = evaluateSufficiency({ unique_discussions: 9, source_count: 2, confidence: 'medium', usable_excerpts: 5 });
  assert.equal(r.level, 'limited');
  assert.deepEqual(r.reasons.map((x) => x.message), ['fewer than 10 independent discussions', 'fewer than 8 usable excerpts']);
});

test('limited: not-high confidence and too few excerpts are both reported, confidence first', () => {
  assert.deepEqual(messages({ confidence: 'low', unique_discussions: 5, source_count: 2, usable_excerpts: 4 }), ['fewer than 10 independent discussions', 'fewer than 8 usable excerpts']);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// adequate
// ---------------------------------------------------------------------------------------------------------------------------------

test('adequate: high confidence and at least 8 usable excerpts, with no reasons', () => {
  const r = evalWith({});
  assert.equal(r.level, 'adequate');
  assert.deepEqual(r.reasons, []);
  assert.equal(evalWith({ usable_excerpts: 24, unique_discussions: 500 }).level, 'adequate');
});

test('every reason carries a fixed code and the fixed message for that code', () => {
  for (const over of [{ unique_discussions: 1, usable_excerpts: 0 }, { confidence: 'low' as const, unique_discussions: 5, source_count: 1, usable_excerpts: 4 }]) {
    for (const r of evalWith(over).reasons) assert.equal(r.message, SUFFICIENCY_REASON_MESSAGES[r.code]);
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The stored `high` is not trusted by itself: "adequate" needs unique_discussions >= 10 AND source_count >= 2 AND 8 excerpts
// ---------------------------------------------------------------------------------------------------------------------------------

const codes = (over: Partial<SufficiencyInput>) => evalWith(over).reasons.map((r) => r.code);

test('review case 1: stored high, 5 discussions, 2 sources, 8 excerpts is limited, not adequate', () => {
  const r = evaluateSufficiency({ confidence: 'high', unique_discussions: 5, source_count: 2, usable_excerpts: 8 });
  assert.equal(r.level, 'limited');
  assert.deepEqual(r.reasons, [{ code: 'fewer_than_high_discussions', message: 'fewer than 10 independent discussions' }]);
});

test('review case 2: stored high, 10 discussions, 1 source, 8 excerpts is limited, not adequate', () => {
  const r = evaluateSufficiency({ confidence: 'high', unique_discussions: 10, source_count: 1, usable_excerpts: 8 });
  assert.equal(r.level, 'limited');
  assert.deepEqual(r.reasons, [{ code: 'fewer_than_high_sources', message: 'fewer than 2 distinct sources' }]);
});

test('review case 3: stored high, 10 discussions, 2 sources, 8 excerpts is adequate, with no reasons', () => {
  const r = evaluateSufficiency({ confidence: 'high', unique_discussions: 10, source_count: 2, usable_excerpts: 8 });
  assert.deepEqual(r, { level: 'adequate', reasons: [] });
});

test('review case 4: stored medium, 10 discussions, 2 sources, 8 excerpts is limited (the stored confidence is not upgraded)', () => {
  const r = evaluateSufficiency({ confidence: 'medium', unique_discussions: 10, source_count: 2, usable_excerpts: 8 });
  assert.equal(r.level, 'limited');
  assert.deepEqual(r.reasons, [{ code: 'confidence_not_high', message: 'cluster confidence is not high' }]);
});

test('the numeric conditions are checked at their boundaries: 9/10 discussions and 1/2 sources', () => {
  assert.equal(evalWith({ unique_discussions: 9 }).level, 'limited');
  assert.equal(evalWith({ unique_discussions: 10 }).level, 'adequate');
  assert.equal(evalWith({ source_count: 1 }).level, 'limited');
  assert.equal(evalWith({ source_count: 2 }).level, 'adequate');
  assert.equal(evalWith({ source_count: 0 }).level, 'limited');
});

test('a stored high that fails both numbers reports both shortfalls, numbers first, then too few excerpts', () => {
  assert.deepEqual(codes({ confidence: 'high', unique_discussions: 5, source_count: 1, usable_excerpts: 8 }), ['fewer_than_high_discussions', 'fewer_than_high_sources']);
  assert.deepEqual(codes({ confidence: 'high', unique_discussions: 5, source_count: 1, usable_excerpts: 7 }), ['fewer_than_high_discussions', 'fewer_than_high_sources', 'fewer_than_adequate_excerpts']);
  assert.deepEqual(codes({ confidence: 'high', unique_discussions: 5, source_count: 2, usable_excerpts: 7 }), ['fewer_than_high_discussions', 'fewer_than_adequate_excerpts']);
});

test('the reasons are the same whether the stored word says high or not: the numbers speak, the word is named only when the numbers agree with it', () => {
  for (const confidence of ['low', 'medium', 'high'] as const) {
    assert.deepEqual(codes({ confidence, unique_discussions: 5, source_count: 2 }), ['fewer_than_high_discussions'], confidence);
    assert.deepEqual(codes({ confidence, unique_discussions: 10, source_count: 1 }), ['fewer_than_high_sources'], confidence);
  }
  assert.deepEqual(codes({ confidence: 'low', unique_discussions: 10, source_count: 2 }), ['confidence_not_high']);
  assert.deepEqual(codes({ confidence: 'high', unique_discussions: 10, source_count: 2 }), []);
});

test('insufficient still comes first: a stored high with 3 discussions is insufficient, not limited', () => {
  assert.equal(evalWith({ confidence: 'high', unique_discussions: 3, source_count: 2, usable_excerpts: 8 }).level, 'insufficient');
});

test('a stored high that meets both numbers still needs 8 usable excerpts', () => {
  assert.deepEqual(codes({ confidence: 'high', unique_discussions: 10, source_count: 2, usable_excerpts: 7 }), ['fewer_than_adequate_excerpts']);
  assert.equal(evalWith({ confidence: 'high', unique_discussions: 10, source_count: 2, usable_excerpts: 7 }).level, 'limited');
});

test('pipeline: the four review cases end to end - the stored confidence is shown unchanged (M05) and never repaired', () => {
  const run = (confidence: 'low' | 'medium' | 'high', discussions: number, sources: number) =>
    prepared(input(manyMembers(8), { confidence, unique_discussions: discussions, source_count: sources, sources: ['github', 'hackernews', 'stackexchange'].slice(0, Math.max(sources, 1)) }));

  const c1 = run('high', 5, 2);
  assert.equal(c1.sufficiency.level, 'limited');
  assert.deepEqual(c1.summary.sufficiency_reasons, ['fewer than 10 independent discussions']);

  const c2 = run('high', 10, 1);
  assert.equal(c2.sufficiency.level, 'limited');
  assert.deepEqual(c2.summary.sufficiency_reasons, ['fewer than 2 distinct sources']);

  const c3 = run('high', 10, 2);
  assert.equal(c3.sufficiency.level, 'adequate');
  assert.deepEqual(c3.summary.sufficiency_reasons, []);

  const c4 = run('medium', 10, 2);
  assert.equal(c4.sufficiency.level, 'limited');
  assert.deepEqual(c4.summary.sufficiency_reasons, ['cluster confidence is not high']);

  // Nothing is repaired: M05, M01 and M02 carry the stored values exactly as given.
  const m = (p: typeof c1, id: string) => p.pack.metrics.find((x) => x.id === id)?.value;
  assert.deepEqual([m(c1, 'M05'), m(c1, 'M01'), m(c1, 'M02')], ['high', 5, 2]);
  assert.deepEqual([m(c2, 'M05'), m(c2, 'M01'), m(c2, 'M02')], ['high', 10, 1]);
  assert.deepEqual([m(c4, 'M05'), m(c4, 'M01'), m(c4, 'M02')], ['medium', 10, 2]);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Through the pipeline: usable excerpts are counted from the pack, the cluster values come from the cluster row
// ---------------------------------------------------------------------------------------------------------------------------------

test('pipeline: all three levels, with the meta summary carrying level and reasons', () => {
  const adequate = prepared(input(manyMembers(8), { unique_discussions: 12, confidence: 'high' }));
  assert.equal(adequate.sufficiency.level, 'adequate');
  assert.equal(adequate.summary.sufficiency, 'adequate');
  assert.deepEqual(adequate.summary.sufficiency_reasons, []);

  const limited = prepared(input(manyMembers(7), { unique_discussions: 12, confidence: 'high' }));
  assert.equal(limited.summary.sufficiency, 'limited');
  assert.deepEqual(limited.summary.sufficiency_reasons, ['fewer than 8 usable excerpts']);

  const insufficient = prepared(input(manyMembers(2), { unique_discussions: 12, confidence: 'high' }));
  assert.equal(insufficient.summary.sufficiency, 'insufficient');
  assert.deepEqual(insufficient.summary.sufficiency_reasons, ['fewer than 3 usable excerpts']);
});

test('pipeline: the usable-excerpt count is the number of excerpts in the pack, not the number of members', () => {
  // 30 records in 2 discussions: 2 excerpts, so insufficient even though the cluster says 12 discussions.
  const crowded = Array.from({ length: 30 }, (_, i) => member({ n: i + 1, discussion: `d${i % 2}` }));
  assert.equal(prepared(input(crowded, { unique_discussions: 12 })).sufficiency.level, 'insufficient');
  // 10 problem members but 5 have no usable text: 5 usable excerpts, so limited.
  const blank = [
    ...Array.from({ length: 5 }, (_, i) => member({ n: i + 1 })),
    ...Array.from({ length: 5 }, (_, i) => member({ n: i + 10, text: '  ' })),
  ];
  const p = prepared(input(blank, { unique_discussions: 12, confidence: 'high' }));
  assert.equal(p.pack.excerpts.length, 5);
  assert.equal(p.sufficiency.level, 'limited');
});

test('pipeline: unique_discussions comes from the stored cluster value (M01)', () => {
  assert.equal(prepared(input(manyMembers(10), { unique_discussions: 3 })).sufficiency.level, 'insufficient');
  assert.equal(prepared(input(manyMembers(10), { unique_discussions: 4, confidence: 'low' })).sufficiency.level, 'limited');
});

test('pipeline: nothing a model writes can influence sufficiency (a self-assessment field on the input is ignored)', () => {
  const c = { ...cluster({ unique_discussions: 3 }), sufficiency_self_assessment: 'adequate', sufficiency: 'adequate' };
  const p = prepared({ cluster: c, members: manyMembers(10) });
  assert.equal(p.sufficiency.level, 'insufficient');
  assert.ok(!p.canonical_pack_json.includes('self_assessment'));
});

test('the boundary cases are exercised end to end: 3/4 discussions, 2/3 excerpts, 7/8 excerpts', () => {
  const level = (discussions: number, excerpts: number, confidence: 'low' | 'medium' | 'high' = 'high') =>
    prepared(input(manyMembers(excerpts), { unique_discussions: discussions, confidence })).sufficiency.level;
  assert.equal(level(3, 10), 'insufficient');
  assert.equal(level(4, 10), 'limited');     // 4 discussions clears "insufficient", but a stored `high` with 4 discussions is not adequate (needs 10)
  assert.equal(level(10, 10), 'adequate');   // 10 discussions across the default 3 sources, high, 10 excerpts
  assert.equal(level(12, 2), 'insufficient');
  assert.equal(level(12, 3), 'limited');
  assert.equal(level(12, 7), 'limited');
  assert.equal(level(12, 8), 'adequate');
  assert.equal(level(12, 8, 'medium'), 'limited');
});
