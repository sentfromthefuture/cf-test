// Test helpers for the ProductBlueprint v1 contract and validators. All fixtures are SYNTHETIC: the worked example from
// docs/blueprint-engine/product-blueprint-v1.md section 7 describes an invented product and invented evidence (example.invalid URLs).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { BlueprintModelOutputV1, ProductBlueprintV1 } from '../contract.ts';
import type { ValidationError, ValidationErrorCode, ValidationResult } from '../validate.ts';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

const EXAMPLE_URL = new URL('./fixtures/worked-example.json', import.meta.url);
export const WORKED_EXAMPLE_DOC = new URL('../../../../../docs/blueprint-engine/product-blueprint-v1.md', import.meta.url);

/** A fresh deep copy of the worked example (assembled blueprint) every call, so a test can mutate it freely. */
export const validBlueprint = (): ProductBlueprintV1 => JSON.parse(readFileSync(EXAMPLE_URL, 'utf8')) as ProductBlueprintV1;

/** The model-owned part only: what the model is allowed to return. */
export function validModelOutput(): BlueprintModelOutputV1 {
  const { meta: _meta, evidence_index: _index, verification: _verification, ...model } = validBlueprint();
  void _meta; void _index; void _verification;
  return model;
}

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

export function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) {
    Object.freeze(v);
    for (const child of Object.values(v as object)) deepFreeze(child);
  }
  return v;
}

const segments = (pointer: string): string[] => (pointer === '' ? [] : pointer.slice(1).split('/').map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~')));

/** Reads the value at a JSON Pointer. */
export function getAt(doc: unknown, pointer: string): unknown {
  let cur: unknown = doc;
  for (const s of segments(pointer)) cur = (cur as Record<string, unknown>)[s];
  return cur;
}

/** Sets (or, with `undefined`, removes) the value at a JSON Pointer, in place. Returns the document for chaining. */
export function setAt<T>(doc: T, pointer: string, value: unknown): T {
  const segs = segments(pointer);
  const last = segs.pop() as string;
  let cur: unknown = doc;
  for (const s of segs) cur = (cur as Record<string, unknown>)[s];
  if (value === undefined) {
    if (Array.isArray(cur)) cur.splice(Number(last), 1);
    else delete (cur as Record<string, unknown>)[last];
  } else (cur as Record<string, unknown>)[last] = value;
  return doc;
}

export const errorsOf = <T>(r: ValidationResult<T>): ValidationError[] => (r.ok ? [] : r.errors);

export function codesOf<T>(r: ValidationResult<T>): ValidationErrorCode[] {
  return errorsOf(r).map((e) => e.code);
}

/** Asserts the result is rejected with an error of `code` at exactly `path` (when given). */
export function assertRejected<T>(r: ValidationResult<T>, code: ValidationErrorCode, path?: string, note = ''): void {
  assert.equal(r.ok, false, `expected rejection ${code}${path !== undefined ? ` at ${path}` : ''} ${note}`);
  const hit = errorsOf(r).some((e) => e.code === code && (path === undefined || e.path === path));
  assert.ok(hit, `expected ${code}${path !== undefined ? ` at ${path}` : ''}; got ${JSON.stringify(errorsOf(r).map((e) => `${e.code}@${e.path}`))} ${note}`);
}

export function assertAccepted<T>(r: ValidationResult<T>, note = ''): void {
  assert.equal(r.ok, true, `expected acceptance ${note}; got ${JSON.stringify(errorsOf(r).map((e) => `${e.code}@${e.path}`))}`);
}

/** No error of this code exists at exactly this path (used by boundary tests that only look at one rule). */
export function assertNoError<T>(r: ValidationResult<T>, code: ValidationErrorCode, path: string, note = ''): void {
  const hit = errorsOf(r).some((e) => e.code === code && e.path === path);
  assert.equal(hit, false, `unexpected ${code} at ${path} ${note}`);
}

/** A string of exactly n characters (code points). */
export const text = (n: number, ch = 'x'): string => ch.repeat(n);

/**
 * Sets the list at `pointer` to exactly `n` items by repeating its first item (or `sample` when the list is empty). Items are copied, never shared.
 * The result is structurally valid for size rules but is not meant to be consistent for cross-reference rules.
 */
export function makeList(doc: unknown, pointer: string, n: number, sample?: unknown): void {
  const list = getAt(doc, pointer) as unknown[];
  const proto = list.length > 0 ? list[0] : sample;
  assert.notEqual(proto, undefined, `no item to repeat at ${pointer}`);
  list.length = 0;
  for (let i = 0; i < n; i++) list.push(clone(proto));
}

type Counts = { verified_evidence: number; ai_recommendation: number; hypothesis: number; unknown: number };

/**
 * Recomputes the backend-owned bookkeeping of a blueprint from scratch with a generic scan that is independent of the validator's own
 * claim and reference enumeration: cited_by, claim_counts, ref_count and the evidence pack counts. Used after a test edits citations.
 */
export function recomputeBackendFields(bp: ProductBlueprintV1): void {
  const cites = new Map<string, string[]>();
  const counts: Counts = { verified_evidence: 0, ai_recommendation: 0, hypothesis: 0, unknown: 0 };
  let refCount = 0;
  const scan = (node: unknown, pointer: string): void => {
    if (Array.isArray(node)) { node.forEach((v, i) => scan(v, `${pointer}/${i}`)); return; }
    if (node === null || typeof node !== 'object') return;
    const rec = node as Record<string, unknown>;
    if ('text' in rec && 'basis' in rec && 'evidence_refs' in rec) counts[rec.basis as keyof Counts]++;
    for (const [k, v] of Object.entries(rec)) {
      if ((k === 'evidence_refs' || k === 'metric_refs' || k === 'excerpt_refs') && Array.isArray(v)) {
        v.forEach((id, i) => {
          refCount++;
          cites.set(id as string, [...(cites.get(id as string) ?? []), `${pointer}/${k}/${i}`]);
        });
      } else if (k !== 'cited_by') scan(v, `${pointer}/${k}`);
    }
  };
  const { meta: _m, evidence_index: _e, verification: _v, ...model } = bp;
  void _m; void _e; void _v;
  scan(model, '');
  for (const entry of bp.evidence_index) entry.cited_by = cites.get(entry.id) ?? [];
  bp.verification.claim_counts = counts;
  bp.verification.ref_count = refCount;
  bp.meta.evidence_pack.excerpt_count = bp.evidence_index.filter((e) => e.kind === 'discussion_excerpt').length;
  bp.meta.evidence_pack.metric_count = bp.evidence_index.filter((e) => e.kind === 'cluster_metric').length;
}
