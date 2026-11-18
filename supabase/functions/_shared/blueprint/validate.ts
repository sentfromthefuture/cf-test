// ProductBlueprint v1 validators - the public entry points.
//
//   validateBlueprintModelOutput(input, options?)  the model-owned document (BlueprintModelOutputV1)
//   validateProductBlueprint(input)                the assembled, backend-owned blueprint (ProductBlueprintV1)
//
// Policy (Phase A2, rejection-only):
//  - An invalid input is rejected as a whole. Nothing is repaired, coerced, defaulted, truncated or silently dropped, and no field is
//    removed. `value` is returned only when `ok` is true, and it is a plain-data copy of the input (the input itself is never modified).
//  - Tiers run in order and the first tier with errors decides: shape (T1-T4) -> identifiers and references (T5) -> evidence and basis rules
//    (T6) -> content policy (T7). Every error of the deciding tier is reported, up to a cap.
//  - Errors carry a JSON Pointer, a fixed code and a fixed message. They never contain text from the input.
//  - The validators never throw. Anything unexpected is reported as `validator_internal_error` and the input is rejected.
//  - Retries, regeneration, provider fallback, repair and downgrade are NOT part of this phase.
import { BLUEPRINT_SCHEMA_VERSION } from './constants.ts';
import { scanText } from './content-policy.ts';
import type { BlueprintModelOutputV1, ProductBlueprintV1 } from './contract.ts';
import { checkAssembled, readBackendStructure } from './validate-backend.ts';
import { checkEvidenceRules } from './validate-evidence.ts';
import { checkIntegrity } from './validate-integrity.ts';
import { Ctx, isRec, snapshotInput, ValidationError, ValidationResult } from './validate-core.ts';
import { readModelStructure, readPassStructure } from './validate-model.ts';

export type { ValidationError, ValidationErrorCode, ValidationResult } from './validate-core.ts';

export interface ModelOutputOptions {
  /**
   * The evidence ids the backend showed the model. When provided, every cited id must be one of them. Without it only the id format and the
   * issued ranges (E01-E24, M01-M16) are checked; resolution against a real evidence pack is a later phase.
   */
  knownEvidenceIds?: Iterable<string>;
}

const fail = <T>(errors: ValidationError[], truncated = false): ValidationResult<T> => ({ ok: false, errors, truncated });

function run<T>(mode: 'model' | 'assembled', input: unknown, options: ModelOutputOptions): ValidationResult<T> {
  try {
    const snap = snapshotInput(input);
    if (!snap.ok) return fail([snap.error]);
    const root = snap.value;

    // A reader must refuse a schema version it does not know before judging anything else (section 8).
    if (isRec(root) && typeof root.schema_version === 'string' && root.schema_version !== BLUEPRINT_SCHEMA_VERSION) {
      return fail([{ code: 'unsupported_schema_version', path: '/schema_version', message: 'This schema version is not supported.' }]);
    }

    const c = new Ctx(mode);
    const top = readModelStructure(c, root);
    if (top && mode === 'assembled') readBackendStructure(c, top);
    const done = (): ValidationResult<T> | undefined => (c.failed ? fail<T>(c.errors, c.truncated) : undefined);
    let early = done();
    if (early) return early;

    const model = root as unknown as BlueprintModelOutputV1;
    checkIntegrity(c, model);
    early = done();
    if (early) return early;

    checkEvidenceRules(c, model, { knownEvidenceIds: options.knownEvidenceIds ? new Set(options.knownEvidenceIds) : undefined });
    if (mode === 'assembled') checkAssembled(c, root as unknown as ProductBlueprintV1);
    early = done();
    if (early) return early;

    for (const text of c.texts) {
      for (const finding of scanText(text.value, text.kind)) {
        if (finding === 'url') c.err('contains_url', text.path, 'Model-written text must not contain a URL.');
        else if (finding === 'sql') c.err('contains_sql', text.path, 'The text looks like SQL or an expression; the design must be described in plain language.');
        else c.err('contains_executable', text.path, 'The text looks like executable or markup content, which is not allowed.');
      }
    }
    early = done();
    if (early) return early;

    return { ok: true, value: root as T, errors: [] };
  } catch {
    // Deliberately content-free: an exception message could contain input text.
    return fail([{ code: 'validator_internal_error', path: '', message: 'The validator could not process this input; it was rejected.' }]);
  }
}

/** Validates the model-owned document. Backend-owned sections (`meta`, `evidence_index`, `verification`) and `downgraded_from` are rejected. */
export function validateBlueprintModelOutput(input: unknown, options: ModelOutputOptions = {}): ValidationResult<BlueprintModelOutputV1> {
  return run<BlueprintModelOutputV1>('model', input, options);
}

/** Validates the assembled blueprint: the model-owned document plus the backend-owned sections and their consistency with it. */
export function validateProductBlueprint(input: unknown): ValidationResult<ProductBlueprintV1> {
  return run<ProductBlueprintV1>('assembled', input, {});
}


/** Strict shape and content-policy validation for one A/B/C model response before it is used as a handoff. */
export function validateBlueprintPassOutput(
  pass: 'A' | 'B' | 'C',
  input: unknown,
): ValidationResult<Record<string, unknown>> {
  try {
    const snap = snapshotInput(input);
    if (!snap.ok) return fail([snap.error]);
    const c = new Ctx('model');
    const value = readPassStructure(c, pass, snap.value);
    if (c.failed || !value) return fail(c.errors, c.truncated);
    for (const site of c.texts) {
      for (const finding of scanText(site.value, site.kind)) {
        if (finding === 'url') c.err('contains_url', site.path, 'Model-written text must not contain a URL.');
        else if (finding === 'sql') c.err('contains_sql', site.path, 'The text looks like SQL or an expression; the design must be described in plain language.');
        else c.err('contains_executable', site.path, 'The text looks like executable or markup content, which is not allowed.');
      }
    }
    return c.failed ? fail(c.errors, c.truncated) : { ok: true, value, errors: [] };
  } catch {
    return fail([{ code: 'validator_internal_error', path: '', message: 'The validator could not process this input; it was rejected.' }]);
  }
}
