// Fixture builders for the Phase A3 evidence-preparation tests.
//
// EVERY value here is SYNTHETIC. No real third-party discussion content is used anywhere in these tests (the free ERNIE provider privacy
// review has not been completed). URLs use the reserved example.invalid domain; texts describe an invented support-tooling topic.
import type { ClusterInput, ClusterMemberInput, EvidencePrepInput, PreparedEvidence, RawRecordInput } from '../evidence.ts';
import { prepareEvidencePack } from '../evidence.ts';

export const hex = (n: number): string => n.toString(16).padStart(64, '0');
export const rid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export interface MemberSpec {
  n: number;                                  // drives the record id, hash and url
  source?: string;
  discussion?: string;                        // default: one discussion per record
  engagement?: Record<string, unknown>;
  published?: string | null;
  text?: string | null;
  title?: string | null;
  kind?: string;
  hash?: string;
  problem?: boolean;
  wtp?: boolean;
  method?: 'llm' | 'heuristic';
  signal?: null;                              // pass null for "no signal row"
  license?: string;
  attribution?: string | null;
  extraRecord?: Record<string, unknown>;      // columns the module must never forward (author_ref ...)
  extraSignal?: Record<string, unknown>;      // columns the module must never forward (problem_statement ...)
}

export function member(s: MemberSpec): ClusterMemberInput {
  const record: RawRecordInput = {
    id: rid(s.n),
    source_id: s.source ?? 'github',
    discussion_key: s.discussion ?? `disc-${s.n}`,
    kind: s.kind ?? 'issue',
    url: `https://example.invalid/item/${s.n}`,
    title: s.title === undefined ? `Synthetic title ${s.n}` : s.title,
    excerpt: s.text === undefined ? `Synthetic excerpt number ${s.n} about duplicate support reports.` : s.text,
    published_at: s.published === undefined ? '2026-09-01T10:00:00Z' : s.published,
    engagement: s.engagement ?? { comments: 0 },
    license: s.license ?? 'Synthetic licence text',
    attribution: s.attribution === undefined ? null : s.attribution,
    content_hash: s.hash ?? hex(s.n),
  };
  Object.assign(record, s.extraRecord ?? {});
  const signal = s.signal === null
    ? null
    : { is_problem: s.problem ?? true, wtp_evidence: s.wtp ?? false, analysis_method: s.method ?? 'llm', ...(s.extraSignal ?? {}) };
  return { record, signal } as ClusterMemberInput;
}

export function cluster(over: Partial<ClusterInput> = {}): ClusterInput {
  return {
    id: '00000000-0000-4000-8000-0000000000c1',
    title: 'Duplicate support reports',
    industry: 'Software',
    unique_discussions: 12,
    source_count: 3,
    sources: ['github', 'hackernews', 'stackexchange'],
    recent_discussions: 4,
    prior_discussions: 2,
    growth_rate: 40,
    severity_avg: 3.5,
    wtp_signals: 2,
    competitors: { notion: 3, linear: 1 },
    confidence: 'high',
    scores: {
      components: {
        problemFrequency: { value: 62, basis: 'measured' },
        demandGrowth: { value: 70, basis: 'measured' },
        painIntensity: { value: 65, basis: 'ai_estimate' },
        willingnessToPay: { value: 35, basis: 'evidence_count' },
        competitionGap: { value: 60, basis: 'derived' },
        developmentFeasibility: { value: 55, basis: 'ai_estimate' },
      },
    },
    ...over,
  };
}

export const input = (members: ClusterMemberInput[], c: Partial<ClusterInput> = {}): EvidencePrepInput => ({ cluster: cluster(c), members });

/** Runs the preparation and fails the test with the (content-free) error list if it was rejected. */
export function prepared(i: unknown): PreparedEvidence {
  const r = prepareEvidencePack(i);
  if (!r.ok) throw new Error(`expected the input to be accepted, got: ${JSON.stringify(r.errors)}`);
  return r.value;
}

export function rejected(i: unknown) {
  const r = prepareEvidencePack(i);
  if (r.ok) throw new Error('expected the input to be rejected');
  return r.errors;
}

/** Deterministic Fisher-Yates with a fixed linear congruential generator, so "reordered input" tests never depend on Math.random. */
export function shuffled<T>(items: readonly T[], seed: number): T[] {
  const a = [...items];
  let s = seed >>> 0;
  const next = (): number => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s; };
  for (let i = a.length - 1; i > 0; i--) {
    const j = next() % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** The ids of the selected excerpts mapped to the numeric part of the record id, e.g. E01 -> 7. Makes expectations readable. */
export function selectedNs(p: PreparedEvidence): number[] {
  return p.index.filter((e) => e.kind === 'discussion_excerpt').map((e) => Number(e.record_id.slice(-12)));
}

/** n distinct discussions spread over the given sources, engagement n, so the order is predictable. */
export function manyMembers(count: number, sources: readonly string[] = ['github']): ClusterMemberInput[] {
  return Array.from({ length: count }, (_, i) => member({ n: i + 1, source: sources[i % sources.length], engagement: { likes: i + 1 } }));
}
