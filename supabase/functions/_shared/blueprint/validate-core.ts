// Validator core for ProductBlueprint v1: structured errors, a defensive input snapshot, and small field readers.
//
// Rules this module enforces for every validator built on it (reliability document sections 4.1 and 4.4):
//  - Strict: nothing is coerced, defaulted, repaired, truncated or silently dropped. An invalid input is rejected as a whole.
//  - Content-free diagnostics: an error carries a JSON Pointer built from OUR schema keys and array indexes, a fixed code and a fixed message.
//    No error ever contains text from the input (not a value, not a key name, not an identifier). Where the offending thing is an
//    unexpected key, the error points at the parent object and reports only a count.
//  - Never throws: callers wrap the whole run, and the snapshot below turns exotic inputs into rejectable markers instead of exceptions.
import { BLUEPRINT_MAX_RESULT_BYTES, EVIDENCE_EXCERPT_MAX_ID, EVIDENCE_METRIC_MAX_ID, ID_PATTERNS, Range, SAFEGUARDS } from './constants.ts';
import { TextKind } from './content-policy.ts';

export type ValidationErrorCode =
  // whole-input problems
  | 'input_too_large' | 'validator_internal_error'
  // shape (tiers T1-T4)
  | 'invalid_type' | 'missing_required_field' | 'unexpected_key' | 'backend_owned_key_forbidden' | 'downgraded_from_forbidden' | 'downgraded_from_not_allowed'
  | 'unsupported_schema_version' | 'invalid_enum' | 'invalid_literal' | 'invalid_format'
  | 'string_blank' | 'string_too_long' | 'string_invalid_characters'
  | 'list_too_short' | 'list_too_long' | 'duplicate_item' | 'number_out_of_range' | 'invalid_integer'
  // identifiers and cross-references (tier T5)
  | 'duplicate_identifier' | 'unresolved_reference' | 'dependency_cycle' | 'invalid_critical_path' | 'task_phase_assignment'
  | 'feature_without_criterion' | 'must_feature_uncovered' | 'mvp_priority_limit' | 'invalid_journey_order' | 'invalid_workflow_transition'
  | 'decision_option_mismatch' | 'estimate_range_invalid'
  | 'db_column_reference' | 'db_table_reference' | 'db_fk_arity' | 'db_fk_not_indexed' | 'db_rls_required' | 'db_owner_column_required'
  // evidence references and basis rules (tier T6)
  | 'evidence_ref_kind_mismatch' | 'evidence_ref_out_of_range' | 'evidence_ref_unresolved' | 'basis_not_allowed'
  | 'verified_claim_unsupported' | 'wtp_rule_violation' | 'market_sizing_rule_violation' | 'verdict_not_allowed_for_sufficiency'
  // backend-owned parts of the assembled blueprint
  | 'evidence_index_mismatch' | 'verification_mismatch' | 'meta_inconsistent'
  | 'verification_status_not_allowed' | 'verification_repairs_not_allowed' | 'verification_check_missing' | 'verification_check_failed'
  | 'disclaimer_not_allowed' | 'disclaimer_missing'
  // content policy (tier T7)
  | 'contains_url' | 'contains_sql' | 'contains_executable';

export interface ValidationError {
  code: ValidationErrorCode;
  /** RFC 6901 JSON Pointer into the input; "" is the document root. Built only from schema keys and array indexes. */
  path: string;
  /** Fixed explanation chosen by the validator. Never contains text from the input. */
  message: string;
}

export type ValidationResult<T> =
  | { ok: true; value: T; errors: [] }
  | { ok: false; errors: ValidationError[]; /** true when more errors existed than the validator reports */ truncated: boolean };

// ---------------------------------------------------------------------------------------------------------------------------------
// Snapshot: a plain-JSON copy of the input, taken once, before any rule runs.
// ---------------------------------------------------------------------------------------------------------------------------------

/** Marks a position whose value is not plain JSON (undefined, function, symbol, bigint, NaN, class instance, accessor, hole ...). */
export class Invalid {
  constructor(readonly reason: string) {}
}

/**
 * Copies the input into plain data. Every read happens exactly once (no getter can answer differently later), cycles and absurd depth/width
 * are cut off, and anything that is not JSON becomes an `Invalid` marker that the readers reject with the precise schema path.
 * The input itself is never modified.
 */
export function snapshotInput(input: unknown): { ok: true; value: unknown } | { ok: false; error: ValidationError } {
  let nodes = 0;
  let overflow = false;
  const walk = (v: unknown, depth: number): unknown => {
    if (overflow) return new Invalid('limit');
    if (++nodes > SAFEGUARDS.maxNodes) { overflow = true; return new Invalid('limit'); }
    if (v === null || typeof v === 'boolean' || typeof v === 'string') return v;
    if (typeof v === 'number') return Number.isFinite(v) ? v : new Invalid('non_finite_number');
    if (typeof v !== 'object') return new Invalid('not_json');
    if (depth >= SAFEGUARDS.maxDepth) return new Invalid('too_deep');
    if (Array.isArray(v)) {
      if (v.length > SAFEGUARDS.maxNodes) { overflow = true; return new Invalid('limit'); }
      const out: unknown[] = [];
      for (let i = 0; i < v.length; i++) {
        out.push(i in v ? walk(v[i], depth + 1) : new Invalid('sparse_array'));
        if (overflow) break;
      }
      return out;
    }
    const proto = Object.getPrototypeOf(v);
    if ((proto !== Object.prototype && proto !== null) || Object.getOwnPropertySymbols(v).length > 0) return new Invalid('not_plain_object');
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(v)) {
      const d = Object.getOwnPropertyDescriptor(v, key);
      const value = d && 'value' in d ? walk(d.value, depth + 1) : new Invalid('accessor');
      // defineProperty, not assignment: a key called "__proto__" must become an ordinary own property, never change the prototype.
      Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
      if (overflow) break;
    }
    return out;
  };
  const value = walk(input, 0);
  if (overflow) return { ok: false, error: { code: 'input_too_large', path: '', message: 'The input has too many values to validate.' } };
  if (new TextEncoder().encode(JSON.stringify(value) ?? '').length > BLUEPRINT_MAX_RESULT_BYTES) {
    return { ok: false, error: { code: 'input_too_large', path: '', message: `The input is larger than ${BLUEPRINT_MAX_RESULT_BYTES} bytes.` } };
  }
  return { ok: true, value };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Context and readers
// ---------------------------------------------------------------------------------------------------------------------------------

export type Rec = Record<string, unknown>;

export interface TextSite { path: string; value: string; kind: TextKind }

export class Ctx {
  readonly errors: ValidationError[] = [];
  truncated = false;
  /** Every model-written free-text string seen by the structural pass, for the content-policy tier. */
  readonly texts: TextSite[] = [];
  /** `model`: the model-owned document alone. `assembled`: the model-owned parts plus the backend-owned meta, evidence_index and verification. Backend-owned strings are never scanned (scan = false), only model-written text is. */
  constructor(readonly mode: 'model' | 'assembled') {}

  err(code: ValidationErrorCode, path: string, message: string): void {
    if (this.errors.length >= SAFEGUARDS.maxErrors) { this.truncated = true; return; }
    this.errors.push({ code, path, message });
  }
  get failed(): boolean { return this.errors.length > 0 || this.truncated; }
}

export const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v) && !(v instanceof Invalid);
export const hasKey = (o: Rec, k: string): boolean => Object.prototype.hasOwnProperty.call(o, k);
/** Child JSON Pointer. Schema keys never contain "/" or "~"; escaping is applied anyway. */
export const at = (p: string, k: string | number): string => `${p}/${String(k).replace(/~/g, '~0').replace(/\//g, '~1')}`;

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** Length in characters, counted as Unicode code points (evidence contract section 3.4: "cut to 400 characters at a code-point boundary"). */
export function charLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** Reads an object and reports missing required keys and a count of keys that are not part of the contract. Returns the object, or undefined if it is not one. */
export function readObject(c: Ctx, path: string, v: unknown, required: readonly string[], optional: readonly string[] = []): Rec | undefined {
  if (!isRec(v)) { c.err('invalid_type', path, 'Expected an object.'); return undefined; }
  const allowed = new Set<string>([...required, ...optional]);
  let unexpected = 0;
  for (const k of Object.keys(v)) if (!allowed.has(k)) unexpected++;
  if (unexpected > 0) c.err('unexpected_key', path, `The object has ${unexpected} field(s) that are not part of the contract.`);
  for (const k of required) if (!hasKey(v, k)) c.err('missing_required_field', at(path, k), 'A required field is missing.');
  return v;
}

export function readString(c: Ctx, path: string, v: unknown, max: number, kind: TextKind = 'text', scan = true): string | undefined {
  if (typeof v !== 'string') { c.err('invalid_type', path, 'Expected a string.'); return undefined; }
  let ok = true;
  if (CONTROL_CHARS.test(v) || LONE_SURROGATE.test(v)) { c.err('string_invalid_characters', path, 'The text contains control characters or an unpaired surrogate.'); ok = false; }
  if (v.trim().length === 0) { c.err('string_blank', path, 'The text is empty or only whitespace.'); ok = false; }
  if (charLength(v) > max) { c.err('string_too_long', path, `The text is longer than ${max} characters.`); ok = false; }
  if (scan) c.texts.push({ path, value: v, kind });
  return ok ? v : undefined;
}

export function readEnum<T extends string>(c: Ctx, path: string, v: unknown, values: readonly T[]): T | undefined {
  if (typeof v !== 'string') { c.err('invalid_type', path, 'Expected a string.'); return undefined; }
  if (!(values as readonly string[]).includes(v)) { c.err('invalid_enum', path, 'The value is not one of the allowed values.'); return undefined; }
  return v as T;
}

export function readBoolean(c: Ctx, path: string, v: unknown): boolean | undefined {
  if (typeof v !== 'boolean') { c.err('invalid_type', path, 'Expected a boolean.'); return undefined; }
  return v;
}

export function readNumber(c: Ctx, path: string, v: unknown, r: Range, integer = false): number | undefined {
  if (typeof v !== 'number') { c.err('invalid_type', path, 'Expected a number.'); return undefined; }
  if (integer && !Number.isInteger(v)) { c.err('invalid_integer', path, 'Expected a whole number.'); return undefined; }
  if (v < r.min || v > r.max) { c.err('number_out_of_range', path, `The number must be between ${r.min} and ${r.max}.`); return undefined; }
  return v;
}

export function readList(c: Ctx, path: string, v: unknown, r: Range, each: (item: unknown, itemPath: string, index: number) => void): unknown[] | undefined {
  if (!Array.isArray(v)) { c.err('invalid_type', path, 'Expected a list.'); return undefined; }
  if (v.length < r.min) c.err('list_too_short', path, `The list needs at least ${r.min} item(s).`);
  if (v.length > r.max) c.err('list_too_long', path, `The list allows at most ${r.max} item(s).`);
  v.slice(0, r.max).forEach((item, i) => each(item, at(path, i), i));
  return v;
}

export function readId(c: Ctx, path: string, v: unknown, pattern: RegExp): string | undefined {
  if (typeof v !== 'string') { c.err('invalid_type', path, 'Expected a string.'); return undefined; }
  if (!pattern.test(v)) { c.err('invalid_format', path, 'The identifier does not match the required format.'); return undefined; }
  return v;
}

/** A list of identifiers in one pattern. Duplicate entries are rejected (a repeated reference carries no meaning and would inflate counts). */
export function readIdList(c: Ctx, path: string, v: unknown, pattern: RegExp, r: Range): string[] | undefined {
  const seen = new Set<string>();
  const list = readList(c, path, v, r, (item, p) => {
    const id = readId(c, p, item, pattern);
    if (id === undefined) return;
    if (seen.has(id)) c.err('duplicate_item', p, 'The list repeats an entry.');
    seen.add(id);
  });
  return list as string[] | undefined;
}

export type EvidenceKind = 'E' | 'M' | 'any';

/** An evidence id: format /^[EM]\d{2}$/, the expected letter, and the issued range (E01-E24, M01-M16). Resolution against a pack or index happens later. */
export function readEvidenceId(c: Ctx, path: string, v: unknown, expect: EvidenceKind): string | undefined {
  const id = readId(c, path, v, ID_PATTERNS.evidence);
  if (id === undefined) return undefined;
  if (expect !== 'any' && id[0] !== expect) { c.err('evidence_ref_kind_mismatch', path, expect === 'E' ? 'This list takes excerpt ids (E##) only.' : 'This list takes metric ids (M##) only.'); return undefined; }
  const n = Number(id.slice(1));
  const max = id[0] === 'E' ? EVIDENCE_EXCERPT_MAX_ID : EVIDENCE_METRIC_MAX_ID;
  if (n < 1 || n > max) { c.err('evidence_ref_out_of_range', path, 'The id is outside the range the backend issues.'); return undefined; }
  return id;
}

export function readEvidenceIdList(c: Ctx, path: string, v: unknown, expect: EvidenceKind, r: Range): string[] | undefined {
  const seen = new Set<string>();
  const list = readList(c, path, v, r, (item, p) => {
    const id = readEvidenceId(c, p, item, expect);
    if (id === undefined) return;
    if (seen.has(id)) c.err('duplicate_item', p, 'The list repeats an entry.');
    seen.add(id);
  });
  return list as string[] | undefined;
}

// Field-level shorthands: read `o[k]` if the key exists (a missing required key was already reported by readObject).
export const fStr = (c: Ctx, o: Rec, p: string, k: string, max: number, kind: TextKind = 'text'): void => { if (hasKey(o, k)) readString(c, at(p, k), o[k], max, kind); };
export const fEnum = <T extends string>(c: Ctx, o: Rec, p: string, k: string, values: readonly T[]): T | undefined => (hasKey(o, k) ? readEnum(c, at(p, k), o[k], values) : undefined);
export const fBool = (c: Ctx, o: Rec, p: string, k: string): void => { if (hasKey(o, k)) readBoolean(c, at(p, k), o[k]); };
export const fNum = (c: Ctx, o: Rec, p: string, k: string, r: Range, integer = false): number | undefined => (hasKey(o, k) ? readNumber(c, at(p, k), o[k], r, integer) : undefined);
export const fId = (c: Ctx, o: Rec, p: string, k: string, pattern: RegExp): void => { if (hasKey(o, k)) readId(c, at(p, k), o[k], pattern); };
export const fIdList = (c: Ctx, o: Rec, p: string, k: string, pattern: RegExp, r: Range): void => { if (hasKey(o, k)) readIdList(c, at(p, k), o[k], pattern, r); };
export const fList = (c: Ctx, o: Rec, p: string, k: string, r: Range, each: (item: unknown, itemPath: string, index: number) => void): void => { if (hasKey(o, k)) readList(c, at(p, k), o[k], r, each); };
export const fStrList = (c: Ctx, o: Rec, p: string, k: string, r: Range, max: number, kind: TextKind = 'text'): void => {
  if (hasKey(o, k)) readList(c, at(p, k), o[k], r, (item, ip) => { readString(c, ip, item, max, kind); });
};
export const fObj = (c: Ctx, o: Rec, p: string, k: string, required: readonly string[], optional: readonly string[] = []): Rec | undefined => (hasKey(o, k) ? readObject(c, at(p, k), o[k], required, optional) : undefined);
