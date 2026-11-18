// Phase A3: deterministic excerpt selection (evidence contract section 3.4). Synthetic data only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { cluster, hex, input, manyMembers, member, prepared, rid, selectedNs, shuffled } from './evidence-fixtures.ts';
import { deepFreeze } from './helpers.ts';
import { readInput } from '../evidence-input.ts';
import { selectExcerpts } from '../evidence-select.ts';
import type { ClusterMemberInput } from '../evidence.ts';

/** A mixed population: four sources, ties on engagement and hash, missing dates, shared discussions and willingness-to-pay flags. */
function mixed(): ClusterMemberInput[] {
  const out: ClusterMemberInput[] = [];
  let n = 1;
  for (const source of ['github', 'hackernews', 'stackexchange', 'zeta']) {
    for (let i = 0; i < 12; i++, n++) {
      out.push(member({
        n,
        source,
        discussion: `d${n % 30}`,
        engagement: { likes: i % 5, comments: n % 3 },
        published: i % 4 === 0 ? null : `2026-0${1 + (i % 9)}-1${i % 9}T0${i % 9}:00:00Z`,
        hash: hex((n * 37) % 11),
        wtp: n % 7 === 0,
        problem: n % 13 !== 0,
      }));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------------------------------------------------------------

test('determinism: any ordering of the members gives byte-identical pack, index, canonical pack, summary and diagnostics', () => {
  const members = mixed();
  const base = prepared(input(members));
  for (const seed of [1, 2, 3, 7, 42, 99, 12345, 987654321]) {
    const again = prepared(input(shuffled(members, seed)));
    assert.deepEqual(again.pack, base.pack, `pack differs for seed ${seed}`);
    assert.deepEqual(again.index, base.index, `index differs for seed ${seed}`);
    assert.equal(again.canonical_pack_json, base.canonical_pack_json);
    assert.deepEqual(again.summary, base.summary);
    assert.deepEqual(again.diagnostics, base.diagnostics);
  }
  // Reversed, and the same input twice.
  assert.equal(prepared(input([...members].reverse())).canonical_pack_json, base.canonical_pack_json);
  assert.equal(prepared(input(members)).canonical_pack_json, base.canonical_pack_json);
});

test('determinism: the order of object keys in the input does not matter', () => {
  const members = mixed().slice(0, 20);
  const reordered = members.map((m) => ({
    signal: m.signal && Object.fromEntries(Object.entries(m.signal).reverse()),
    record: Object.fromEntries(Object.entries(m.record).reverse()),
  }));
  const c = cluster();
  const reversedCluster = Object.fromEntries(Object.entries(c).reverse());
  assert.equal(
    prepared({ members: reordered, cluster: reversedCluster }).canonical_pack_json,
    prepared(input(members)).canonical_pack_json,
  );
});

test('the input is never modified (a deeply frozen input is accepted and unchanged)', () => {
  const i = deepFreeze(input(mixed()));
  const before = JSON.stringify(i);
  prepared(i);
  assert.equal(JSON.stringify(i), before);
});

test('ordering uses code-unit comparison, not the locale: accented and upper/lower case source ids sort by code unit', () => {
  // By code unit: "Zeta" < "alpha" < "zeta" < "Ärger"? U+00C4 is above all ASCII letters, so it sorts last.
  const p = prepared(input([
    member({ n: 1, source: 'zeta' }), member({ n: 2, source: 'Ärger' }), member({ n: 3, source: 'alpha' }), member({ n: 4, source: 'Zeta' }),
  ]));
  assert.deepEqual(p.pack.excerpts.map((e) => e.source), ['Zeta', 'alpha', 'zeta', 'Ärger']);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Eligibility (step 1)
// ---------------------------------------------------------------------------------------------------------------------------------

test('only records whose signal has is_problem = true are candidates; the exclusions are counted, not hidden', () => {
  const p = prepared(input([
    member({ n: 1 }),
    member({ n: 2, problem: false }),
    member({ n: 3, signal: null }),
    member({ n: 4, problem: false }),
  ]));
  assert.deepEqual(selectedNs(p), [1]);
  assert.equal(p.diagnostics.members_total, 4);
  assert.equal(p.diagnostics.problem_members, 1);
  assert.equal(p.diagnostics.excluded_not_problem, 2);
  assert.equal(p.diagnostics.excluded_no_signal, 1);
});

test('a problem record with no usable text (null, empty or whitespace excerpt) cannot be evidence and does not win a collapse', () => {
  const p = prepared(input([
    member({ n: 1, discussion: 'same', engagement: { likes: 100 }, text: '   \n\t  ' }),   // would win on engagement, but has no text
    member({ n: 2, discussion: 'same', engagement: { likes: 1 }, text: 'A usable synthetic excerpt.' }),
    member({ n: 3, text: null }),
    member({ n: 4, text: '' }),
  ]));
  assert.deepEqual(selectedNs(p), [2]);
  assert.equal(p.diagnostics.excluded_no_usable_text, 3);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Collapse by discussion_key (step 2)
// ---------------------------------------------------------------------------------------------------------------------------------

test('records sharing a discussion_key collapse to one excerpt: the one with the highest engagement', () => {
  const p = prepared(input([
    member({ n: 1, discussion: 'thread-a', engagement: { likes: 3 } }),
    member({ n: 2, discussion: 'thread-a', engagement: { likes: 9 } }),
    member({ n: 3, discussion: 'thread-a', engagement: { likes: 5 } }),
    member({ n: 4, discussion: 'thread-b', engagement: { likes: 1 } }),
  ]));
  assert.deepEqual(selectedNs(p).sort((a, b) => a - b), [2, 4]);
  assert.equal(p.diagnostics.eligible_discussions, 2);
});

test('discussion keys are compared exactly: case and surrounding text make different discussions', () => {
  const p = prepared(input([
    member({ n: 1, discussion: 'Thread' }), member({ n: 2, discussion: 'thread' }), member({ n: 3, discussion: 'thread ' }),
  ]));
  assert.equal(p.pack.excerpts.length, 3);
});

test('engagement is the sum of the numeric values: numeric strings count, other values are ignored', () => {
  const p = prepared(input([
    member({ n: 1, discussion: 'd', engagement: { likes: 3, comments: '4', note: 'many', nested: { x: 99 }, flag: true, nothing: null } }), // 3 + 4 = 7
    member({ n: 2, discussion: 'd', engagement: { likes: 6 } }),                                                                          // 6
  ]));
  assert.deepEqual(selectedNs(p), [1]);
});

test('collapse tie-break 1: equal engagement keeps the earliest published_at', () => {
  const p = prepared(input([
    member({ n: 1, discussion: 'd', engagement: { likes: 5 }, published: '2026-03-01T00:00:00Z' }),
    member({ n: 2, discussion: 'd', engagement: { likes: 5 }, published: '2026-01-01T00:00:00Z' }),
    member({ n: 3, discussion: 'd', engagement: { likes: 5 }, published: '2026-02-01T00:00:00Z' }),
  ]));
  assert.deepEqual(selectedNs(p), [2]);
});

test('collapse tie-break 1b: a missing published_at loses to any dated record', () => {
  const p = prepared(input([
    member({ n: 1, discussion: 'd', engagement: { likes: 5 }, published: null, hash: hex(1) }),
    member({ n: 2, discussion: 'd', engagement: { likes: 5 }, published: '2030-01-01T00:00:00Z', hash: hex(2) }),
  ]));
  assert.deepEqual(selectedNs(p), [2]);
});

test('collapse tie-break 2: equal engagement and date keeps the smallest content_hash', () => {
  const p = prepared(input([
    member({ n: 1, discussion: 'd', engagement: { likes: 5 }, hash: hex(0xcc) }),
    member({ n: 2, discussion: 'd', engagement: { likes: 5 }, hash: hex(0xaa) }),
    member({ n: 3, discussion: 'd', engagement: { likes: 5 }, hash: hex(0xbb) }),
  ]));
  assert.deepEqual(selectedNs(p), [2]);
});

test('collapse tie-break 3 (a choice the contract leaves open): identical hash too keeps the smallest record id, in any input order', () => {
  const a = member({ n: 7, discussion: 'd', hash: hex(1) });
  const b = member({ n: 3, discussion: 'd', hash: hex(1) });
  assert.deepEqual(selectedNs(prepared(input([a, b]))), [3]);
  assert.deepEqual(selectedNs(prepared(input([b, a]))), [3]);
});

test('engagement beats recency when collapsing: the record with more engagement wins even if older', () => {
  const p = prepared(input([
    member({ n: 1, discussion: 'd', engagement: { likes: 9 }, published: '2020-01-01T00:00:00Z' }),
    member({ n: 2, discussion: 'd', engagement: { likes: 8 }, published: '2026-01-01T00:00:00Z' }),
  ]));
  assert.deepEqual(selectedNs(p), [1]);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Willingness to pay first (step 3)
// ---------------------------------------------------------------------------------------------------------------------------------

test('WTP first: willingness-to-pay candidates are taken before higher-engagement ones, up to 4, and the flag is carried', () => {
  // 30 candidates, all in one source. Records 1-3 carry a WTP quote but the lowest engagement; 4-30 have more engagement.
  const members: ClusterMemberInput[] = [
    ...[1, 2, 3].map((n) => member({ n, wtp: true, engagement: { likes: 0 } })),
    ...Array.from({ length: 27 }, (_, i) => member({ n: i + 4, engagement: { likes: 100 + i } })),
  ];
  const p = prepared(input(members));
  const ns = selectedNs(p);
  assert.equal(ns.length, 24);
  for (const n of [1, 2, 3]) assert.ok(ns.includes(n), `WTP record ${n} must be selected despite its low engagement`);
  assert.equal(p.pack.excerpts.filter((e) => e.wtp).length, 3);
  assert.equal(p.diagnostics.selected_wtp_first, 3);
  // The 21 non-WTP slots go to the highest engagement: records 30 down to 10 (engagement 100+i, i = n - 4).
  assert.deepEqual(ns.filter((n) => n > 3).sort((a, b) => a - b), Array.from({ length: 21 }, (_, i) => i + 10));
});

test('WTP first takes at most 4; which 4 of more is decided by engagement, then recency, then hash', () => {
  const members: ClusterMemberInput[] = [
    member({ n: 1, wtp: true, engagement: { likes: 50 } }),                                   // default date 2026-09-01
    member({ n: 2, wtp: true, engagement: { likes: 50 }, published: '2026-05-01T00:00:00Z' }),
    member({ n: 3, wtp: true, engagement: { likes: 50 }, published: '2026-06-01T00:00:00Z' }),
    member({ n: 4, wtp: true, engagement: { likes: 90 } }),
    member({ n: 5, wtp: true, engagement: { likes: 10 } }),
    member({ n: 6, wtp: true, engagement: { likes: 50 }, published: '2026-01-01T00:00:00Z' }),
    // 30 non-WTP records with higher engagement fill all 20 remaining slots, so the two WTP records left out of the first pass stay out.
    ...Array.from({ length: 30 }, (_, i) => member({ n: 100 + i, engagement: { likes: 1000 + i } })),
  ];
  const p = prepared(input(members));
  assert.equal(p.diagnostics.selected_wtp_first, 4);
  const flagged = p.index.filter((e) => e.kind === 'discussion_excerpt' && e.has_wtp_quote).map((e) => Number((e as { record_id: string }).record_id.slice(-12)));
  // Engagement 90 (record 4) first; then the engagement-50 records, most recent first: record 1 (Sep), 3 (Jun), 2 (May), 6 (Jan). Record 5 (10) is last.
  assert.deepEqual(flagged.sort((a, b) => a - b), [1, 2, 3, 4]);
});

test('a WTP candidate left out of the first pass can still be selected by the fill pass when slots remain', () => {
  const members = [1, 2, 3, 4, 5, 6].map((n) => member({ n, wtp: true, engagement: { likes: n } }));
  const p = prepared(input(members));
  assert.equal(p.pack.excerpts.length, 6);       // all six fit under the cap
  assert.equal(p.diagnostics.selected_wtp_first, 4);
  assert.equal(p.pack.excerpts.filter((e) => e.wtp).length, 6);
});

test('the wtp flag of a collapsed discussion is that of the record that was kept', () => {
  const p = prepared(input([
    member({ n: 1, discussion: 'd', engagement: { likes: 9 }, wtp: false }),
    member({ n: 2, discussion: 'd', engagement: { likes: 1 }, wtp: true }),
  ]));
  assert.deepEqual(p.pack.excerpts.map((e) => e.wtp), [false]);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Round-robin across sources (step 4)
// ---------------------------------------------------------------------------------------------------------------------------------

test('round-robin: sources take turns; a short source is exhausted and the rest keep going; within a source, engagement decides', () => {
  const members: ClusterMemberInput[] = [];
  let n = 1;
  for (const [source, count] of [['alpha', 10], ['bravo', 10], ['charlie', 5]] as const) {
    for (let i = 0; i < count; i++) members.push(member({ n: n++, source, engagement: { likes: i + 1 } })); // engagement 1..count, higher = later in the list
  }
  const p = prepared(input(members)); // 25 candidates: 24 selected
  const perSource = (s: string) => p.pack.excerpts.filter((e) => e.source === s).length;
  // Rounds 0-4 give 5 each (15); charlie is then exhausted. Rounds 5-8 add alpha and bravo (23). Round 9: alpha takes the 24th, bravo is cut off.
  assert.equal(perSource('alpha'), 10);
  assert.equal(perSource('bravo'), 9);
  assert.equal(perSource('charlie'), 5);
  // Bravo's lowest-engagement record (engagement 1 = record 11) is the one left out.
  assert.ok(!selectedNs(p).includes(11));
  assert.equal(p.summary.truncated, true);
});

test('round-robin: sources take turns starting with the smallest source_id, whatever the input order', () => {
  // One WTP record (its own source "zulu") takes 1 of the 24 places, leaving 23 for the fill: 7 full rounds of 3 sources (21) plus 2 more.
  // The two extra places go to the first two sources in source_id order (alpha, bravo), so charlie ends up with one fewer.
  const members: ClusterMemberInput[] = [member({ n: 900, source: 'zulu', wtp: true, engagement: { likes: 1 } })];
  let n = 1;
  for (const source of ['bravo', 'charlie', 'alpha']) for (let i = 0; i < 10; i++) members.push(member({ n: n++, source, engagement: { likes: 10 - i } }));
  for (const order of [members, [...members].reverse(), shuffled(members, 11)]) {
    const p = prepared(input(order));
    const count = (s: string) => p.pack.excerpts.filter((e) => e.source === s).length;
    assert.equal(count('zulu'), 1);
    assert.equal(count('alpha'), 8);
    assert.equal(count('bravo'), 8);
    assert.equal(count('charlie'), 7);
  }
});

test('round-robin: with fewer than 24 candidates every candidate is selected', () => {
  const p = prepared(input([
    member({ n: 1, source: 'bravo' }), member({ n: 2, source: 'bravo' }), member({ n: 3, source: 'alpha' }),
    member({ n: 4, source: 'alpha' }), member({ n: 5, source: 'charlie' }),
  ]));
  assert.equal(p.pack.excerpts.length, 5);
  assert.equal(p.summary.truncated, false);
});

test('within a source the fill order is engagement, then recency (newest first), then content_hash', () => {
  const members: ClusterMemberInput[] = [
    // 27 records in one source; the 24 kept are those that rank first. Rank by engagement desc, published desc, hash asc.
    ...Array.from({ length: 24 }, (_, i) => member({ n: 100 + i, engagement: { likes: 1000 + i } })),
    member({ n: 1, engagement: { likes: 5 }, published: '2026-01-01T00:00:00Z', hash: hex(9) }),
    member({ n: 2, engagement: { likes: 5 }, published: '2026-02-01T00:00:00Z', hash: hex(9) }),
    member({ n: 3, engagement: { likes: 5 }, published: '2026-02-01T00:00:00Z', hash: hex(1) }),
  ];
  const p = prepared(input(members));
  assert.equal(p.pack.excerpts.length, 24);
  assert.deepEqual(selectedNs(p).filter((n) => n < 100), []); // none of the three low-engagement records fits
  // Now make room for exactly one of them: 23 high-engagement records.
  const members2 = [...members.filter((m) => Number(m.record.id.slice(-12)) !== 123)];
  const p2 = prepared(input(members2));
  assert.deepEqual(selectedNs(p2).filter((n) => n < 100), [3]); // newest of the engagement-5 group, and of those the smaller hash
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Cap and truncation flag
// ---------------------------------------------------------------------------------------------------------------------------------

test('cap: exactly 24 eligible discussions are all kept and not marked truncated', () => {
  const p = prepared(input(manyMembers(24)));
  assert.equal(p.pack.excerpts.length, 24);
  assert.equal(p.summary.truncated, false);
  assert.equal(p.pack.excerpts[23].id, 'E24');
});

test('cap: 25 eligible discussions keep 24 and set truncated', () => {
  const p = prepared(input(manyMembers(25)));
  assert.equal(p.pack.excerpts.length, 24);
  assert.equal(p.summary.truncated, true);
  assert.equal(p.diagnostics.eligible_discussions, 25);
  assert.ok(!selectedNs(p).includes(1)); // record 1 has the lowest engagement
});

test('cap: many records in few discussions is NOT truncation (an excerpt stands for a discussion, not a record)', () => {
  const members = Array.from({ length: 100 }, (_, i) => member({ n: i + 1, discussion: `d${i % 5}`, engagement: { likes: i } }));
  const p = prepared(input(members));
  assert.equal(p.pack.excerpts.length, 5);
  assert.equal(p.summary.truncated, false);
});

test('cap: 30 records over 25 discussions are truncated; 30 records over 24 discussions are not', () => {
  const over = Array.from({ length: 30 }, (_, i) => member({ n: i + 1, discussion: `d${i % 25}` }));
  assert.equal(prepared(input(over)).summary.truncated, true);
  const exact = Array.from({ length: 30 }, (_, i) => member({ n: i + 1, discussion: `d${i % 24}` }));
  assert.equal(prepared(input(exact)).summary.truncated, false);
});

test('cap with WTP: 4 WTP picks plus 20 fills make 24, and the flag follows the discussion count', () => {
  const members = [
    ...[1, 2, 3, 4].map((n) => member({ n, wtp: true })),
    ...Array.from({ length: 21 }, (_, i) => member({ n: 10 + i })),
  ];
  const p = prepared(input(members)); // 25 discussions
  assert.equal(p.pack.excerpts.length, 24);
  assert.equal(p.diagnostics.selected_wtp_first, 4);
  assert.equal(p.summary.truncated, true);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Identifiers (step 6)
// ---------------------------------------------------------------------------------------------------------------------------------

test('ids run E01.. in order of source_id, then published_at ascending with nulls last, then content_hash', () => {
  const p = prepared(input([
    member({ n: 1, source: 'bravo', published: '2026-01-01T00:00:00Z' }),
    member({ n: 2, source: 'alpha', published: '2026-03-01T00:00:00Z' }),
    member({ n: 3, source: 'alpha', published: '2026-02-01T00:00:00Z', hash: hex(0xbb) }),
    member({ n: 4, source: 'alpha', published: null }),
    member({ n: 5, source: 'alpha', published: '2026-02-01T00:00:00Z', hash: hex(0xaa) }),
  ]));
  const order = p.index.filter((e) => e.kind === 'discussion_excerpt').map((e) => [e.id, Number(e.record_id.slice(-12))]);
  assert.deepEqual(order, [['E01', 5], ['E02', 3], ['E03', 2], ['E04', 4], ['E05', 1]]);
  assert.deepEqual(p.pack.excerpts.map((e) => e.id), ['E01', 'E02', 'E03', 'E04', 'E05']);
});

test('ids do not move when engagement changes but the selected set does not (ids are independent of engagement)', () => {
  const members = Array.from({ length: 10 }, (_, i) => member({ n: i + 1, source: i < 5 ? 'alpha' : 'bravo', engagement: { likes: i } }));
  const idOf = (p: ReturnType<typeof prepared>) => Object.fromEntries(p.index.filter((e) => e.kind === 'discussion_excerpt').map((e) => [e.record_id, e.id]));
  const before = idOf(prepared(input(members)));
  const drifted = members.map((m, i) => member({ n: i + 1, source: i < 5 ? 'alpha' : 'bravo', engagement: { likes: 1000 - i * 7 } }));
  assert.deepEqual(idOf(prepared(input(drifted))), before);
});

test('the same pack content always yields the same ids: ids depend only on the selected set', () => {
  const members = mixed();
  const a = prepared(input(members));
  const b = prepared(input(shuffled(members, 5)));
  assert.deepEqual(a.pack.excerpts.map((e) => e.id), b.pack.excerpts.map((e) => e.id));
  assert.deepEqual(a.pack.excerpts.map((e) => e.id), Array.from({ length: a.pack.excerpts.length }, (_, i) => `E${String(i + 1).padStart(2, '0')}`));
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Text: whitespace and the 400 code-point limit
// ---------------------------------------------------------------------------------------------------------------------------------

test('whitespace is normalised: runs of any white space (tabs, newlines, no-break space, line separators) become one space, ends trimmed', () => {
  const p = prepared(input([member({ n: 1, text: '  Hello\t\tworld\n\nfrom\u00A0here\u2028and\u3000there  ', title: '\n  A   spaced\ttitle \n' })]));
  assert.equal(p.pack.excerpts[0].text, 'Hello world from here and there');
  assert.equal(p.pack.excerpts[0].title, 'A spaced title');
  assert.equal(p.index[0].kind === 'discussion_excerpt' && p.index[0].excerpt, 'Hello world from here and there'); // the index holds exactly what the model saw
});

test('a title that is blank after normalisation is treated as absent', () => {
  assert.equal(prepared(input([member({ n: 1, title: ' \n\t ' })])).pack.excerpts[0].title, null);
  assert.equal(prepared(input([member({ n: 1, title: null })])).pack.excerpts[0].title, null);
});

test('text is cut to 400 Unicode code points: 400 stays, 401 is cut, 1,000 is cut', () => {
  const len = (s: string) => [...s].length;
  assert.equal(len(prepared(input([member({ n: 1, text: 'a'.repeat(399) })])).pack.excerpts[0].text), 399);
  assert.equal(len(prepared(input([member({ n: 1, text: 'a'.repeat(400) })])).pack.excerpts[0].text), 400);
  assert.equal(len(prepared(input([member({ n: 1, text: 'a'.repeat(401) })])).pack.excerpts[0].text), 400);
  assert.equal(len(prepared(input([member({ n: 1, text: 'a'.repeat(1000) })])).pack.excerpts[0].text), 400);
});

test('truncation counts code points, not UTF-16 units: 450 emoji give exactly 400 emoji and never a lone surrogate', () => {
  const text = prepared(input([member({ n: 1, text: '😀'.repeat(450) })])).pack.excerpts[0].text;
  assert.equal([...text].length, 400);
  assert.equal(text.length, 800);
  assert.equal(text, '😀'.repeat(400));
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text), false);
});

test('truncation at a surrogate-pair boundary: 399 letters then an emoji keeps the whole emoji; 400 letters then an emoji drops it whole', () => {
  const keep = prepared(input([member({ n: 1, text: `${'a'.repeat(399)}😀tail` })])).pack.excerpts[0].text;
  assert.equal(keep, `${'a'.repeat(399)}😀`);
  const drop = prepared(input([member({ n: 1, text: `${'a'.repeat(400)}😀tail` })])).pack.excerpts[0].text;
  assert.equal(drop, 'a'.repeat(400));
});

test('truncation is by code point, so a combining sequence can be cut between its code points (documented: not grapheme aware)', () => {
  const text = prepared(input([member({ n: 1, text: `${'a'.repeat(399)}e\u0301x` })])).pack.excerpts[0].text; // e + combining acute = 2 code points
  assert.equal([...text].length, 400);
  assert.ok(text.endsWith('e'));
});

test('normalisation happens before the cut: leading white space does not use up the 400', () => {
  const text = prepared(input([member({ n: 1, text: `${' '.repeat(500)}${'b'.repeat(10)}` })])).pack.excerpts[0].text;
  assert.equal(text, 'b'.repeat(10));
  const long = prepared(input([member({ n: 1, text: 'word '.repeat(100) })])).pack.excerpts[0].text; // 499 after normalisation
  assert.equal([...long].length, 400);
  assert.equal(long, 'word '.repeat(100).trim().slice(0, 400));
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Dates in the pack
// ---------------------------------------------------------------------------------------------------------------------------------

test('published is "YYYY-MM" in UTC; a zone offset can move the month; null stays null', () => {
  const p = prepared(input([
    member({ n: 1, published: '2026-09-30T23:30:00-02:00' }),   // 2026-10-01T01:30Z
    member({ n: 2, published: '2026-09-30T23:30:00Z' }),
    member({ n: 3, published: null }),
    member({ n: 4, published: '2026-01-15T08:00:00.123456+00:00' }),
  ]));
  const byN = new Map(p.index.filter((e) => e.kind === 'discussion_excerpt').map((e, i) => [Number(e.record_id.slice(-12)), p.pack.excerpts[i]]));
  assert.equal(byN.get(1)?.published, '2026-10');
  assert.equal(byN.get(2)?.published, '2026-09');
  assert.equal(byN.get(3)?.published, null);
  assert.equal(byN.get(4)?.published, '2026-01');
});

test('records are ordered by instant, not by the text of the timestamp (different offsets)', () => {
  // 10:00+05:00 is 05:00Z, earlier than 08:00Z although "10" > "08" as text.
  const p = prepared(input([
    member({ n: 1, published: '2026-04-01T08:00:00Z' }),
    member({ n: 2, published: '2026-04-01T10:00:00+05:00' }),
  ]));
  assert.deepEqual(selectedNs(p), [2, 1]);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Review round 1: the WTP pick policy is documented and order-independent; engagement does not depend on key order
// ---------------------------------------------------------------------------------------------------------------------------------

/** The numeric part of the record ids chosen in the WTP first pass, read from the selection itself. */
function wtpPassNs(members: ClusterMemberInput[]): number[] {
  const read = readInput(input(members));
  assert.equal(read.ok, true);
  if (!read.ok) return [];
  return selectExcerpts(read.members).selected.filter((x) => x.from_wtp_pass).map((x) => Number(x.member.id.slice(-12))).sort((a, b) => a - b);
}

test('WTP pick policy: global (not per source), ordered by engagement, then recency, then content_hash, then record id', () => {
  const members: ClusterMemberInput[] = [
    member({ n: 1, source: 'a', wtp: true, engagement: { likes: 90 }, published: '2026-01-01T00:00:00Z' }),
    member({ n: 2, source: 'b', wtp: true, engagement: { likes: 90 }, published: '2026-06-01T00:00:00Z' }),  // same engagement as 1, more recent: ranks first
    member({ n: 3, source: 'b', wtp: true, engagement: { likes: 70 }, published: '2026-06-01T00:00:00Z', hash: hex(5) }),
    member({ n: 4, source: 'a', wtp: true, engagement: { likes: 70 }, published: '2026-06-01T00:00:00Z', hash: hex(2) }), // smaller hash than 3
    member({ n: 5, source: 'a', wtp: true, engagement: { likes: 70 }, published: '2026-06-01T00:00:00Z', hash: hex(2) }), // same hash as 4: record id decides
    member({ n: 6, source: 'a', wtp: true, engagement: { likes: 10 } }),
    ...Array.from({ length: 12 }, (_, i) => member({ n: 100 + i, source: 'a', engagement: { likes: 1000 + i } })),
  ];
  // Ranking: 2, 1 (engagement 90, newer first), 4, 5 (70, hash then id), 3, 6. The four places go to 2, 1, 4, 5, from both sources.
  assert.deepEqual(wtpPassNs(members), [1, 2, 4, 5]);
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) assert.deepEqual(wtpPassNs(shuffled(members, seed)), [1, 2, 4, 5], `seed ${seed}`);
  assert.deepEqual(wtpPassNs([...members].reverse()), [1, 2, 4, 5]);
});

test('WTP pick policy: a missing published_at is the least recent, so a dated record wins an otherwise equal contest', () => {
  const members = [
    member({ n: 1, wtp: true, engagement: { likes: 5 }, published: null, hash: hex(1) }),
    member({ n: 2, wtp: true, engagement: { likes: 5 }, published: '2001-01-01T00:00:00Z', hash: hex(9) }),
    member({ n: 3, wtp: true, engagement: { likes: 5 }, published: null, hash: hex(2) }),
    member({ n: 4, wtp: true, engagement: { likes: 5 }, published: '2002-01-01T00:00:00Z', hash: hex(9) }),
    member({ n: 5, wtp: true, engagement: { likes: 5 }, published: null, hash: hex(3) }),
  ];
  // Dated first (newest first: 4, 2), then undated by hash (1, 2 -> records 1 and 3); record 5 (hash 3) misses the four.
  assert.deepEqual(wtpPassNs(members), [1, 2, 3, 4]);
  assert.deepEqual(wtpPassNs(shuffled(members, 3)), [1, 2, 3, 4]);
});

test('WTP pick policy: a total tie (same engagement, date and hash) is decided by record id, from any ordering of the input', () => {
  const members = Array.from({ length: 10 }, (_, i) => member({ n: i + 1, source: i % 2 ? 'a' : 'b', wtp: true, engagement: { likes: 7 }, hash: hex(1) }));
  assert.deepEqual(wtpPassNs(members), [1, 2, 3, 4]);
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) assert.deepEqual(wtpPassNs(shuffled(members, seed)), [1, 2, 3, 4], `seed ${seed}`);
});

test('WTP pick policy: a WTP candidate that misses the four still competes in the fill pass', () => {
  const members = [1, 2, 3, 4, 5].map((n) => member({ n, wtp: true, engagement: { likes: 100 - n } }));
  const p = prepared(input(members));
  assert.equal(p.pack.excerpts.length, 5);                 // all five are selected: four by the WTP pass, the fifth by the fill pass
  assert.equal(p.diagnostics.selected_wtp_first, 4);
  assert.deepEqual(wtpPassNs(members), [1, 2, 3, 4]);
});

test('WTP pick policy: the flag of a collapsed discussion is the kept record\'s, so a lower-engagement sibling cannot smuggle a WTP quote in', () => {
  const members = [
    member({ n: 1, discussion: 'd', wtp: false, engagement: { likes: 9 } }),
    member({ n: 2, discussion: 'd', wtp: true, engagement: { likes: 1 } }),
    ...Array.from({ length: 5 }, (_, i) => member({ n: 10 + i, wtp: i === 0 })),
  ];
  assert.deepEqual(wtpPassNs(members), [10]);
});

test('whole-pipeline permutation check with heavy WTP ties: pack, index and canonical pack are identical for many orderings', () => {
  const members: ClusterMemberInput[] = [
    ...Array.from({ length: 14 }, (_, i) => member({ n: i + 1, source: ['a', 'b', 'c'][i % 3], wtp: true, engagement: { likes: i % 2 }, hash: hex(i % 3) })),
    ...Array.from({ length: 20 }, (_, i) => member({ n: 100 + i, source: ['a', 'b', 'c'][i % 3], engagement: { likes: i % 4 }, published: i % 5 === 0 ? null : '2026-03-01T00:00:00Z' })),
  ];
  const base = prepared(input(members));
  for (const seed of [11, 12, 13, 14, 15, 16, 17, 18, 19, 20]) {
    const again = prepared(input(shuffled(members, seed)));
    assert.deepEqual(again.pack, base.pack);
    assert.deepEqual(again.index, base.index);
    assert.equal(again.canonical_pack_json, base.canonical_pack_json);
  }
});

test('engagement does not depend on the order of the keys of the engagement object (floating-point addition is not associative)', () => {
  // With keys summed in insertion order a,c,b the total is 1; in order a,b,c it is 0. Summing in sorted key order makes it 0 either way,
  // so the rival (engagement 0.5) wins both times.
  const x1 = { a: 1e16, c: -1e16, b: 1 };
  const x2 = { a: 1e16, b: 1, c: -1e16 };
  for (const x of [x1, x2]) {
    const p = prepared(input([
      member({ n: 1, discussion: 'd', engagement: x }),
      member({ n: 2, discussion: 'd', engagement: { z: 0.5 } }),
    ]));
    assert.deepEqual(selectedNs(p), [2], JSON.stringify(Object.keys(x)));
  }
});

void rid; void cluster;
