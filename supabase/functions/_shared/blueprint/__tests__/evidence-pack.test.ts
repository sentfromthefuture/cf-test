// Phase A3: evidence index and provenance, privacy boundary of the model-facing pack, canonical pack, malformed input,
// and compatibility with the A2 contract. Synthetic data only: no real third-party discussion content appears here.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { EvidenceIndexEntry } from '../contract.ts';
import { canonicalJson, citationsFromIndex, indexById, prepareEvidencePack } from '../evidence.ts';
import { canonicalJson as collectorCanonicalJson } from '../../collector/ai-common.ts';
import { readBackendStructure } from '../validate-backend.ts';
import { Ctx } from '../validate-core.ts';
import { clone, cluster, hex, input, manyMembers, member, prepared, rejected, rid } from './evidence-fixtures.ts';
import { validBlueprint } from './helpers.ts';

const a2IndexErrors = (index: EvidenceIndexEntry[]) => {
  const c = new Ctx('assembled');
  readBackendStructure(c, { evidence_index: index });
  return c.errors;
};

// ---------------------------------------------------------------------------------------------------------------------------------
// Evidence index and provenance
// ---------------------------------------------------------------------------------------------------------------------------------

test('the index lists every pack item once: E01.. then M01..M16, nothing cited yet', () => {
  const p = prepared(input(manyMembers(5)));
  assert.deepEqual(p.index.map((e) => e.id), ['E01', 'E02', 'E03', 'E04', 'E05', ...Array.from({ length: 16 }, (_, i) => `M${String(i + 1).padStart(2, '0')}`)]);
  assert.deepEqual(p.index.map((e) => e.cited_by), p.index.map(() => []));
  assert.equal(p.summary.excerpt_count, 5);
  assert.equal(p.summary.metric_count, 16);
});

test('every excerpt keeps its provenance: record id, source, URL, content hash, licence, attribution, date and analysis method', () => {
  const p = prepared(input([
    member({ n: 7, source: 'hackernews', kind: 'story', published: '2026-09-02T08:00:00+00:00', hash: hex(0xabc), method: 'heuristic', wtp: true, license: 'LIC-7', attribution: 'ATTR-7', title: 'T7', text: 'Body 7' }),
    member({ n: 3, source: 'github', published: null, attribution: null }),
  ]));
  const e = p.index.filter((x) => x.kind === 'discussion_excerpt');
  assert.deepEqual(e[0], {
    id: 'E01', kind: 'discussion_excerpt', record_id: rid(3), source_id: 'github', url: 'https://example.invalid/item/3', title: 'Synthetic title 3',
    excerpt: 'Synthetic excerpt number 3 about duplicate support reports.', content_sha256: hex(3), published_at: null, license: 'Synthetic licence text',
    attribution: null, analysis_method: 'llm', has_wtp_quote: false, cited_by: [],
  });
  assert.deepEqual(e[1], {
    id: 'E02', kind: 'discussion_excerpt', record_id: rid(7), source_id: 'hackernews', url: 'https://example.invalid/item/7', title: 'T7', excerpt: 'Body 7',
    content_sha256: hex(0xabc), published_at: '2026-09-02T08:00:00Z', license: 'LIC-7', attribution: 'ATTR-7', analysis_method: 'heuristic', has_wtp_quote: true, cited_by: [],
  });
});

test('the index holds exactly what the model saw: same id, title, text and wtp flag as the pack', () => {
  const p = prepared(input(manyMembers(9, ['github', 'hackernews'])));
  for (const x of p.pack.excerpts) {
    const e = p.index.find((i) => i.id === x.id);
    assert.ok(e && e.kind === 'discussion_excerpt');
    assert.deepEqual([e.title, e.excerpt, e.has_wtp_quote, e.source_id], [x.title, x.text, x.wtp, x.source]);
  }
});

test('every metric entry belongs to the cluster the pack was built for', () => {
  const p = prepared(input([], { id: 'cluster-xyz' }));
  for (const e of p.index) assert.ok(e.kind === 'cluster_metric' && e.cluster_id === 'cluster-xyz');
});

test('ids resolve against the pack that was built, and only against it', () => {
  const p = prepared(input(manyMembers(3)));
  const byId = indexById(p.index);
  assert.equal(byId.size, 19);
  assert.equal(byId.get('E01')?.kind, 'discussion_excerpt');
  assert.equal(byId.get('M16')?.kind, 'cluster_metric');
  for (const unissued of ['E04', 'E24', 'E99', 'M17', 'X01', '']) assert.equal(byId.get(unissued), undefined, unissued);
});

test('citationsFromIndex gives the { record_id, content_sha256 } list for the cache `citations` column, sorted by record id', () => {
  const p = prepared(input([member({ n: 9 }), member({ n: 2 }), member({ n: 5 })]));
  assert.deepEqual(citationsFromIndex(p.index), [
    { record_id: rid(2), content_sha256: hex(2) }, { record_id: rid(5), content_sha256: hex(5) }, { record_id: rid(9), content_sha256: hex(9) },
  ]);
  // Limited to the cited ids; metrics and unknown ids contribute nothing.
  const e = (n: number) => p.index.find((x) => x.kind === 'discussion_excerpt' && x.record_id === rid(n))?.id as string;
  assert.deepEqual(citationsFromIndex(p.index, [e(5), 'M01', 'E99']), [{ record_id: rid(5), content_sha256: hex(5) }]);
  assert.deepEqual(citationsFromIndex(p.index, []), []);
});

test('the evidence index passes the A2 structural validator, including a full 24-excerpt pack', () => {
  assert.deepEqual(a2IndexErrors(prepared(input(manyMembers(24, ['github', 'hackernews', 'stackexchange']))).index), []);
  assert.deepEqual(a2IndexErrors(prepared(input([])).index), []);
  assert.deepEqual(a2IndexErrors(prepared(input([member({ n: 1, text: '😀'.repeat(450), attribution: 'ATTR', published: '2026-09-02T08:00:00+05:30' })])).index), []);
});

test('worked example round trip: the documented evidence entries are reproduced field for field (ids follow the contract rule)', () => {
  const doc = validBlueprint();
  const docExcerpts = doc.evidence_index.filter((e) => e.kind === 'discussion_excerpt');
  const members = docExcerpts.map((e, i) => member({
    n: i + 1, source: e.source_id, discussion: `example-${i}`, title: e.title, text: e.excerpt, published: e.published_at, hash: e.content_sha256,
    license: e.license, attribution: e.attribution, method: e.analysis_method, wtp: e.has_wtp_quote,
    extraRecord: { id: e.record_id, url: e.url },
  }));
  const c = cluster({
    id: doc.meta.cluster_id, unique_discussions: 9, source_count: 2, sources: ['github', 'hackernews'], growth_rate: null, wtp_signals: 1,
    confidence: 'medium', severity_avg: null, competitors: {}, scores: null, recent_discussions: 3, prior_discussions: 1,
  });
  const p = prepared({ cluster: c, members });

  // Each documented excerpt entry is reproduced exactly, apart from its id (see below) and cited_by (nothing has cited yet).
  for (const documented of docExcerpts) {
    const ours = p.index.find((e) => e.kind === 'discussion_excerpt' && e.record_id === documented.record_id);
    assert.deepEqual({ ...ours, id: documented.id, cited_by: documented.cited_by }, documented);
  }
  // M01-M05 are reproduced exactly (the document lists only these five of the sixteen).
  for (const documented of doc.evidence_index.filter((e) => e.kind === 'cluster_metric')) {
    const ours = p.index.find((e) => e.id === documented.id);
    assert.deepEqual({ ...ours, cited_by: documented.cited_by }, documented);
  }
  // The documented sufficiency, reasons and truncation flag.
  const documentedPack = doc.meta.evidence_pack;
  assert.deepEqual([p.summary.excerpt_count, p.summary.truncated, p.summary.sufficiency, p.summary.sufficiency_reasons],
    [documentedPack.excerpt_count, documentedPack.truncated, documentedPack.sufficiency, documentedPack.sufficiency_reasons]);

  // Observation (see the PR report): the worked example numbers its excerpts E01-E05 in an order that is not the order evidence contract
  // section 3.4 step 6 gives (source_id, then published_at ascending). The contract rule is authoritative, so the ids differ.
  const idByRecord = Object.fromEntries(p.index.filter((e) => e.kind === 'discussion_excerpt').map((e) => [e.record_id, e.id]));
  assert.deepEqual(docExcerpts.map((e) => idByRecord[e.record_id]), ['E01', 'E04', 'E02', 'E05', 'E03']);
});

test('dates at the edge of the supported years are accepted when they stay inside 0000-9999 in UTC, and the index entry stays valid for A2', () => {
  const p = prepared(input([
    member({ n: 1, published: '0000-01-01T00:00:00Z' }),
    member({ n: 2, published: '9999-12-31T23:59:59Z' }),
    member({ n: 3, published: '0001-01-01T00:00:00+14:00' }),   // 0000-12-31T10:00:00Z in UTC: still year 0
    member({ n: 4, published: '9999-12-31T00:00:00-14:00' }),   // 9999-12-31T14:00:00Z in UTC
  ]));
  const e = p.index.filter((x) => x.kind === 'discussion_excerpt').map((x) => (x as { published_at: string }).published_at);
  assert.deepEqual(e, ['0000-01-01T00:00:00Z', '0000-12-31T10:00:00Z', '9999-12-31T14:00:00Z', '9999-12-31T23:59:59Z']);
  assert.deepEqual(p.pack.excerpts.map((x) => x.published), ['0000-01', '0000-12', '9999-12', '9999-12']);
  assert.deepEqual(a2IndexErrors(p.index), []);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Privacy boundary of the model-facing pack
// ---------------------------------------------------------------------------------------------------------------------------------

const SENTINELS = {
  author: 'AUTHOR-REF-SENTINEL', attribution: 'ATTRIBUTION-SENTINEL', license: 'LICENSE-SENTINEL', statement: 'PROBLEM-STATEMENT-SENTINEL',
  quote: 'WTP-QUOTE-SENTINEL', engagement: 987654321, url: 'https://example.invalid/private-url-sentinel', clusterId: 'CLUSTER-ID-SENTINEL',
};

function sentinelInput() {
  const members = [1, 2, 3, 4].map((n) => {
    const m = member({
      n, wtp: n === 2, license: SENTINELS.license, attribution: SENTINELS.attribution, engagement: { likes: SENTINELS.engagement + n, comments: 5 },
      extraRecord: { author_ref: `${SENTINELS.author}-${n}`, parent_source_record_id: 'PARENT-SENTINEL', categories: ['CATEGORY-SENTINEL'], language: 'en' },
      extraSignal: { problem_statement: `${SENTINELS.statement} ${n}`, wtp_quote: SENTINELS.quote, severity: 5, competitors: ['COMPETITOR-SENTINEL'], embedding: [0.1, 0.2] },
    });
    (m.record as unknown as Record<string, unknown>).url = `${SENTINELS.url}-${n}`;
    return m;
  });
  return { cluster: cluster({ id: SENTINELS.clusterId }), members };
}

test('the model-facing pack has exactly the documented shape and no backend identifiers', () => {
  const p = prepared(sentinelInput());
  assert.deepEqual(Object.keys(p.pack).sort(), ['ai_labels', 'excerpts', 'metrics']);
  assert.deepEqual(Object.keys(p.pack.ai_labels).sort(), ['cluster_label', 'industry']);
  for (const e of p.pack.excerpts) assert.deepEqual(Object.keys(e).sort(), ['id', 'kind', 'published', 'source', 'text', 'title', 'wtp']);
  for (const m of p.pack.metrics) assert.deepEqual(Object.keys(m).sort(), ['evidence_class', 'id', 'label', 'name', 'value']);
});

test('no forbidden value reaches the model-facing pack or its canonical form: no record id, URL, author, attribution, licence, engagement, problem statement or cluster id', () => {
  const p = prepared(sentinelInput());
  for (const text of [JSON.stringify(p.pack), p.canonical_pack_json]) {
    for (const forbidden of [
      SENTINELS.author, SENTINELS.attribution, SENTINELS.license, SENTINELS.statement, SENTINELS.quote, SENTINELS.url, SENTINELS.clusterId,
      String(SENTINELS.engagement), '98765432', 'PARENT-SENTINEL', 'CATEGORY-SENTINEL', 'COMPETITOR-SENTINEL',
      rid(1), rid(2), rid(3), rid(4), hex(1), hex(2),
    ]) assert.ok(!text.includes(forbidden), `the pack must not contain ${forbidden}`);
    assert.ok(!/https?:\/\//i.test(text), 'no URL');
    for (const key of ['record_id', 'url', 'author_ref', 'attribution', 'license', 'engagement', 'problem_statement', 'content_sha256', 'content_hash', 'cluster_id']) {
      assert.ok(!text.includes(`"${key}"`), `no "${key}" field`);
    }
  }
});

test('fields the module is never given a place for are never copied anywhere in the result, not even into the backend index', () => {
  const p = prepared(sentinelInput());
  const all = JSON.stringify(p);
  for (const never of [SENTINELS.author, SENTINELS.statement, SENTINELS.quote, 'PARENT-SENTINEL', 'CATEGORY-SENTINEL', 'COMPETITOR-SENTINEL', String(SENTINELS.engagement), '98765432']) {
    assert.ok(!all.includes(never), `${never} must not appear in any output`);
  }
});

test('the backend index DOES keep what the model must not see: record id, URL, hash, licence and attribution', () => {
  const p = prepared(sentinelInput());
  const e = p.index.find((x) => x.id === 'E01');
  assert.ok(e && e.kind === 'discussion_excerpt');
  assert.equal(e.record_id, rid(1));
  assert.ok(e.url.startsWith(SENTINELS.url));
  assert.equal(e.content_sha256, hex(1));
  assert.equal(e.license, SENTINELS.license);
  assert.equal(e.attribution, SENTINELS.attribution);
});

test('the diagnostics and summary contain counts and fixed text only', () => {
  const p = prepared(sentinelInput());
  const text = JSON.stringify([p.diagnostics, p.summary, p.sufficiency]);
  assert.ok(!text.includes('SENTINEL'));
  for (const v of Object.values(p.diagnostics)) assert.ok(typeof v === 'number' || Array.isArray(v));
});

test('author-written text inside an excerpt is passed through as the author wrote it: URLs and addresses in it are NOT scrubbed (documented limit)', () => {
  const p = prepared(input([member({ n: 1, text: 'see https://example.invalid/page or write to someone@example.invalid' })]));
  assert.equal(p.pack.excerpts[0].text, 'see https://example.invalid/page or write to someone@example.invalid');
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Canonical pack
// ---------------------------------------------------------------------------------------------------------------------------------

test('canonicalJson sorts object keys, keeps array order, skips undefined members and has no white space', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, 1, 2], c: null }, z: undefined }), '{"a":{"c":null,"d":[3,1,2]},"b":1}');
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
  assert.equal(canonicalJson('é"\n'), '"é\\"\\n"');
  assert.throws(() => canonicalJson({ a: NaN }), RangeError);
  assert.throws(() => canonicalJson({ a: Infinity }), RangeError);
  assert.throws(() => canonicalJson(undefined), TypeError);
});

test('canonicalJson agrees with the collector\'s canonicalJson on the shapes used here, so the cache identity cannot silently diverge', () => {
  const p = prepared(input(manyMembers(6, ['github', 'hackernews'])));
  assert.equal(canonicalJson(p.pack), collectorCanonicalJson(p.pack));
  for (const sample of [{ b: [1, { y: 2, x: 1 }], a: 'é😀' }, [], {}, { n: null, t: true, f: 1.5 }]) assert.equal(canonicalJson(sample), collectorCanonicalJson(sample));
});

test('canonical_pack_json is the canonical form of the pack: it parses back to the same pack and its keys are sorted', () => {
  const p = prepared(input(manyMembers(4)));
  assert.deepEqual(JSON.parse(p.canonical_pack_json), p.pack);
  assert.equal(p.canonical_pack_json, canonicalJson(p.pack));
  assert.ok(p.canonical_pack_json.startsWith('{"ai_labels":'));
  assert.ok(!/\s{2,}|\n/.test(p.canonical_pack_json));
});

test('the canonical pack changes when what the model sees changes, and only then', () => {
  const key = (m: ReturnType<typeof manyMembers>, over = {}) => prepared(input(m, over)).canonical_pack_json;
  const base = key(manyMembers(5));
  assert.equal(key(manyMembers(5)), base);
  // engagement drift that does not change the selected set: same canonical pack
  const drift = manyMembers(5).map((m, i) => ({ ...m, record: { ...m.record, engagement: { likes: 500 - i } } }));
  assert.equal(key(drift), base);
  // changes to licence, attribution, URL, record id or hash: not part of what the model sees, same canonical pack
  const meta = manyMembers(5).map((m) => ({ ...m, record: { ...m.record, license: 'other', attribution: 'other', url: `${m.record.url}?x=1` } }));
  assert.equal(key(meta), base);
  // changes to excerpt text, title, kind, source, month, wtp flag, labels: different canonical pack
  const edit = (patch: Record<string, unknown>) => manyMembers(5).map((m, i) => (i === 0 ? { ...m, record: { ...m.record, ...patch } } : m));
  for (const patch of [{ excerpt: 'changed' }, { title: 'changed' }, { kind: 'story' }, { published_at: '2025-01-01T00:00:00Z' }]) assert.notEqual(key(edit(patch) as ReturnType<typeof manyMembers>), base, JSON.stringify(patch));
  assert.notEqual(key(manyMembers(5), { title: 'A different label' }), base);
  assert.notEqual(key(manyMembers(5), { industry: 'Finance' }), base);
  const wtp = manyMembers(5).map((m, i) => (i === 0 ? { ...m, signal: { ...(m.signal as object), wtp_evidence: true } } : m));
  assert.notEqual(key(wtp as ReturnType<typeof manyMembers>), base);
});

test('whitespace-only differences in the raw text do not change the canonical pack (the text is normalised)', () => {
  const a = prepared(input([member({ n: 1, text: 'one  two\nthree' })])).canonical_pack_json;
  const b = prepared(input([member({ n: 1, text: ' one two three ' })])).canonical_pack_json;
  assert.equal(a, b);
});

test('this module does not hash: the summary has everything except pack_sha256, which the cache phase will compute', () => {
  const p = prepared(input(manyMembers(5)));
  assert.deepEqual(Object.keys(p.summary).sort(), ['excerpt_count', 'metric_count', 'sufficiency', 'sufficiency_reasons', 'truncated']);
  assert.ok(!('pack_sha256' in p.summary));
});

test('ai_labels carry the cluster title and industry as labels, whitespace-normalised, and nothing else', () => {
  const p = prepared(input([], { title: '  Duplicate \n support   reports ', industry: ' Soft  ware ' }));
  assert.deepEqual(p.pack.ai_labels, { industry: 'Soft ware', cluster_label: 'Duplicate support reports' });
  assert.deepEqual(prepared(input([], { industry: null })).pack.ai_labels.industry, null);
});

// ---------------------------------------------------------------------------------------------------------------------------------
// Empty and malformed input
// ---------------------------------------------------------------------------------------------------------------------------------

test('empty input: a cluster with no members is accepted and gives an empty pack, the full catalogue, and an honest insufficient verdict', () => {
  const p = prepared(input([]));
  assert.deepEqual(p.pack.excerpts, []);
  assert.equal(p.pack.metrics.length, 16);
  assert.equal(p.summary.excerpt_count, 0);
  assert.equal(p.summary.truncated, false);
  assert.equal(p.sufficiency.level, 'insufficient');
  assert.deepEqual(p.summary.sufficiency_reasons, ['fewer than 3 usable excerpts']);
  assert.equal(p.diagnostics.members_total, 0);
  assert.deepEqual(prepared(input([], { unique_discussions: 0 })).summary.sufficiency_reasons, ['fewer than 4 independent discussions', 'fewer than 3 usable excerpts']);
});

test('a population with no eligible record is also an honest empty pack', () => {
  const p = prepared(input([member({ n: 1, problem: false }), member({ n: 2, signal: null }), member({ n: 3, text: null })]));
  assert.equal(p.pack.excerpts.length, 0);
  assert.equal(p.sufficiency.level, 'insufficient');
});

test('input that is not an object, or lacks cluster or members, is rejected with fixed, content-free errors', () => {
  for (const bad of [null, undefined, 5, 'text', true, [], () => 1, Symbol('x'), 10n]) {
    const e = rejected(bad);
    assert.deepEqual(e.map((x) => [x.code, x.path]), [['invalid_type', '']]);
  }
  assert.deepEqual(rejected({}).map((x) => [x.code, x.path]), [['missing_required_field', '/cluster'], ['missing_required_field', '/members']]);
  assert.deepEqual(rejected({ cluster: cluster() }).map((x) => x.path), ['/members']);
  assert.deepEqual(rejected({ members: [] }).map((x) => x.path), ['/cluster']);
  assert.deepEqual(rejected({ cluster: cluster(), members: 'nope' }).map((x) => [x.code, x.path]), [['invalid_type', '/members']]);
  assert.deepEqual(rejected({ cluster: cluster(), members: { length: 0 } }).map((x) => x.code), ['invalid_type']);
  assert.deepEqual(rejected({ cluster: null, members: [] }).map((x) => [x.code, x.path]), [['invalid_type', '/cluster']]);
});

/** [description, mutation of a valid input, expected code, expected path] */
const MALFORMED: [string, (i: { cluster: Record<string, unknown>; members: { record: Record<string, unknown>; signal: Record<string, unknown> | null }[] }) => void, string, string][] = [
  ['negative discussion count', (i) => { i.cluster.unique_discussions = -1; }, 'number_out_of_range', '/cluster/unique_discussions'],
  ['fractional discussion count', (i) => { i.cluster.unique_discussions = 1.5; }, 'number_out_of_range', '/cluster/unique_discussions'],
  ['string discussion count', (i) => { i.cluster.unique_discussions = '3'; }, 'invalid_type', '/cluster/unique_discussions'],
  ['NaN source count', (i) => { i.cluster.source_count = NaN; }, 'number_out_of_range', '/cluster/source_count'],
  ['unknown confidence', (i) => { i.cluster.confidence = 'huge'; }, 'invalid_enum', '/cluster/confidence'],
  ['numeric confidence', (i) => { i.cluster.confidence = 3; }, 'invalid_type', '/cluster/confidence'],
  ['sources not a list', (i) => { i.cluster.sources = 'github'; }, 'invalid_type', '/cluster/sources'],
  ['blank source', (i) => { i.cluster.sources = ['github', '  ']; }, 'string_blank', '/cluster/sources/1'],
  ['too many sources', (i) => { i.cluster.sources = Array.from({ length: 65 }, (_, k) => `s${k}`); }, 'list_too_long', '/cluster/sources'],
  ['competitors as a list', (i) => { i.cluster.competitors = ['a']; }, 'invalid_type', '/cluster/competitors'],
  ['negative competitor count', (i) => { i.cluster.competitors = { a: -1 }; }, 'number_out_of_range', '/cluster/competitors'],
  ['text competitor count', (i) => { i.cluster.competitors = { a: 'x' }; }, 'number_out_of_range', '/cluster/competitors'],
  ['blank competitor name', (i) => { i.cluster.competitors = { '  ': 1 }; }, 'string_invalid_characters', '/cluster/competitors'],
  ['text growth rate', (i) => { i.cluster.growth_rate = 'fast'; }, 'invalid_type', '/cluster/growth_rate'],
  ['infinite severity', (i) => { i.cluster.severity_avg = Infinity; }, 'number_out_of_range', '/cluster/severity_avg'],
  ['blank cluster id', (i) => { i.cluster.id = ''; }, 'string_blank', '/cluster/id'],
  ['control character in the title', (i) => { i.cluster.title = 'bad\u0000title'; }, 'string_invalid_characters', '/cluster/title'],
  ['missing cluster field', (i) => { delete i.cluster.confidence; }, 'missing_required_field', '/cluster/confidence'],
  ['scores not an object', (i) => { i.cluster.scores = 5; }, 'invalid_type', '/cluster/scores'],
  ['component not an object', (i) => { i.cluster.scores = { components: { problemFrequency: 5 } }; }, 'invalid_type', '/cluster/scores/components/problemFrequency'],
  ['component with an unknown basis', (i) => { i.cluster.scores = { components: { demandGrowth: { value: 1, basis: 'guess' } } }; }, 'invalid_enum', '/cluster/scores/components/demandGrowth/basis'],
  ['component value as text', (i) => { i.cluster.scores = { components: { demandGrowth: { value: '1', basis: 'measured' } } }; }, 'invalid_type', '/cluster/scores/components/demandGrowth/value'],
  ['severity below the documented 1-5 range', (i) => { i.cluster.severity_avg = 0; }, 'number_out_of_range', '/cluster/severity_avg'],
  ['severity above the documented 1-5 range', (i) => { i.cluster.severity_avg = 5.01; }, 'number_out_of_range', '/cluster/severity_avg'],
  ['extreme finite severity', (i) => { i.cluster.severity_avg = Number.MAX_VALUE; }, 'number_out_of_range', '/cluster/severity_avg'],
  ['score component below 0', (i) => { i.cluster.scores = { components: { painIntensity: { value: -1, basis: 'measured' } } }; }, 'number_out_of_range', '/cluster/scores/components/painIntensity/value'],
  ['score component above 100', (i) => { i.cluster.scores = { components: { painIntensity: { value: 101, basis: 'measured' } } }; }, 'number_out_of_range', '/cluster/scores/components/painIntensity/value'],
  ['extreme finite score component', (i) => { i.cluster.scores = { components: { competitionGap: { value: Number.MAX_VALUE, basis: 'derived' } } }; }, 'number_out_of_range', '/cluster/scores/components/competitionGap/value'],
  ['extreme finite growth rate', (i) => { i.cluster.growth_rate = -Number.MAX_VALUE; }, 'number_out_of_range', '/cluster/growth_rate'],
  ['date that is year -1 in UTC', (i) => { i.members[0].record.published_at = '0000-01-01T00:00:00+05:00'; }, 'invalid_format', '/members/0/record/published_at'],
  ['date that is year 10000 in UTC', (i) => { i.members[0].record.published_at = '9999-12-31T23:59:59-05:00'; }, 'invalid_format', '/members/0/record/published_at'],
  ['member not an object', (i) => { (i.members as unknown[])[0] = 'row'; }, 'invalid_type', '/members/0'],
  ['member without a record', (i) => { delete (i.members[0] as Record<string, unknown>).record; }, 'missing_required_field', '/members/0/record'],
  ['member without a signal key', (i) => { delete (i.members[0] as Record<string, unknown>).signal; }, 'missing_required_field', '/members/0/signal'],
  ['record missing a required field', (i) => { delete i.members[0].record.discussion_key; }, 'missing_required_field', '/members/0/record/discussion_key'],
  ['blank discussion key', (i) => { i.members[0].record.discussion_key = ' '; }, 'string_blank', '/members/0/record/discussion_key'],
  ['URL with another scheme', (i) => { i.members[0].record.url = 'ftp://example.invalid/x'; }, 'invalid_format', '/members/0/record/url'],
  ['URL that is not a URL', (i) => { i.members[0].record.url = 'not a url'; }, 'invalid_format', '/members/0/record/url'],
  ['relative URL', (i) => { i.members[0].record.url = '/item/1'; }, 'invalid_format', '/members/0/record/url'],
  ['content hash that is not SHA-256', (i) => { i.members[0].record.content_hash = 'abc123'; }, 'invalid_format', '/members/0/record/content_hash'],
  ['date without a time zone', (i) => { i.members[0].record.published_at = '2026-09-01T10:00:00'; }, 'invalid_format', '/members/0/record/published_at'],
  ['date without a time', (i) => { i.members[0].record.published_at = '2026-09-01'; }, 'invalid_format', '/members/0/record/published_at'],
  ['impossible date', (i) => { i.members[0].record.published_at = '2026-02-30T00:00:00Z'; }, 'invalid_format', '/members/0/record/published_at'],
  ['free-form date', (i) => { i.members[0].record.published_at = 'yesterday'; }, 'invalid_format', '/members/0/record/published_at'],
  ['numeric date', (i) => { i.members[0].record.published_at = 1788000000; }, 'invalid_type', '/members/0/record/published_at'],
  ['engagement as a list', (i) => { i.members[0].record.engagement = [1, 2]; }, 'invalid_type', '/members/0/record/engagement'],
  ['blank licence', (i) => { i.members[0].record.license = ''; }, 'string_blank', '/members/0/record/license'],
  ['numeric excerpt', (i) => { i.members[0].record.excerpt = 42; }, 'invalid_type', '/members/0/record/excerpt'],
  ['NUL in the excerpt', (i) => { i.members[0].record.excerpt = 'SECRET-TEXT\u0000'; }, 'string_invalid_characters', '/members/0/record/excerpt'],
  ['lone surrogate in the title', (i) => { i.members[0].record.title = 'half \uD83D emoji'; }, 'string_invalid_characters', '/members/0/record/title'],
  ['numeric title', (i) => { i.members[0].record.title = 7; }, 'invalid_type', '/members/0/record/title'],
  ['signal as a list', (i) => { (i.members[0] as Record<string, unknown>).signal = []; }, 'invalid_type', '/members/0/signal'],
  ['signal flag as text', (i) => { i.members[0].signal = { is_problem: 'true', wtp_evidence: false, analysis_method: 'llm' }; }, 'invalid_type', '/members/0/signal/is_problem'],
  ['signal missing a field', (i) => { i.members[0].signal = { is_problem: true, wtp_evidence: false }; }, 'missing_required_field', '/members/0/signal/analysis_method'],
  ['unknown analysis method', (i) => { i.members[0].signal = { is_problem: true, wtp_evidence: false, analysis_method: 'gpt' }; }, 'invalid_enum', '/members/0/signal/analysis_method'],
  ['the same record twice', (i) => { i.members[1].record.id = i.members[0].record.id; }, 'duplicate_record', '/members/1/record/id'],
];

test('malformed input is rejected as a whole, with the exact code and path, for every kind of defect', () => {
  for (const [name, mutate, code, path] of MALFORMED) {
    const i = clone({ cluster: cluster(), members: manyMembers(2) }) as unknown as Parameters<typeof mutate>[0];
    mutate(i);
    const errors = rejected(i);
    assert.ok(errors.some((e) => e.code === code && e.path === path), `${name}: expected ${code} at ${path}, got ${JSON.stringify(errors)}`);
  }
});

test('errors never echo input: no value, key name or text from the input appears in any message or path', () => {
  const i = clone({ cluster: cluster(), members: manyMembers(2) }) as unknown as { cluster: Record<string, unknown>; members: { record: Record<string, unknown> }[] };
  i.members[0].record.excerpt = 'SECRET-TEXT\u0000';
  i.members[0].record.url = 'ftp://SECRET-URL';
  i.members[0].record.content_hash = 'SECRET-HASH';
  i.cluster.competitors = { 'SECRET-NAME\u0000': -1 };
  i.cluster.title = 'SECRET-TITLE\u0001';
  const text = JSON.stringify(rejected(i));
  assert.ok(!text.includes('SECRET'));
  assert.ok(!text.includes('\\u0000'));
});

test('several defects are all reported (up to a cap), not just the first', () => {
  const i = clone({ cluster: cluster(), members: manyMembers(3) }) as unknown as { cluster: Record<string, unknown>; members: { record: Record<string, unknown> }[] };
  i.cluster.confidence = 'huge';
  i.members[0].record.url = 'nope';
  i.members[2].record.content_hash = 'nope';
  assert.deepEqual(rejected(i).map((e) => e.path).sort(), ['/cluster/confidence', '/members/0/record/url', '/members/2/record/content_hash']);
  const many = { cluster: cluster(), members: Array.from({ length: 300 }, () => 'bad') };
  assert.ok(rejected(many).length <= 100);
});

test('a list longer than the limit is rejected before any member is read', () => {
  const e = rejected({ cluster: cluster(), members: Array.from({ length: 10_001 }, () => ({})) });
  assert.deepEqual(e.map((x) => [x.code, x.path]), [['input_too_large', '/members']]);
});

test('a sparse list (a hole where a member should be) is rejected, not skipped', () => {
  const members = new Array(2);
  members[1] = member({ n: 1 });
  assert.ok(rejected({ cluster: cluster(), members }).some((e) => e.path === '/members/0' && e.code === 'invalid_type'));
});

test('it never throws: a getter that throws becomes a fixed internal error with no message from the exception', () => {
  const m = member({ n: 1 });
  Object.defineProperty(m.record, 'excerpt', { enumerable: true, get() { throw new Error('boom SECRET'); } });
  const r = prepareEvidencePack({ cluster: cluster(), members: [m] });
  assert.equal(r.ok, false);
  if (!r.ok) {
    assert.deepEqual(r.errors.map((e) => e.code), ['internal_error']);
    assert.ok(!JSON.stringify(r.errors).includes('boom'));
  }
});

test('extra columns on a row (author_ref, embeddings, categories ...) are ignored, not an error', () => {
  const p = prepared(sentinelInput());
  assert.equal(p.pack.excerpts.length, 4);
});

test('an attribution that is blank is treated as none; a title with only white space is treated as none', () => {
  const p = prepared(input([member({ n: 1, attribution: '   ', title: ' ' })]));
  const e = p.index[0];
  assert.ok(e.kind === 'discussion_excerpt' && e.attribution === null && e.title === null);
});
