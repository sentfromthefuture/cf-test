import type { BlueprintModelOutputV1, PassAOutput, PassBOutput, PassCOutput } from './contract.ts';
import type { PreparedEvidence } from './evidence.ts';
import { validateBlueprintModelOutput } from './validate.ts';

export type ModelAssemblyError =
  | { code: 'missing_pass'; pass: 'A' | 'B' | 'C' }
  | { code: 'invalid_model_output'; validation_codes: string[] };

export type ModelAssemblyResult =
  | { ok: true; value: BlueprintModelOutputV1 }
  | { ok: false; error: ModelAssemblyError };

/**
 * Merge the three independently validated pass sections, then run the complete A2 model validator.
 * This is the only supported transition from pass-local outputs to a complete model-owned blueprint.
 * No repair, coercion, defaulting or backend-owned fields are added here.
 */
export function assembleBlueprintModelOutput(
  passes: { A?: PassAOutput; B?: PassBOutput; C?: PassCOutput },
  evidence: PreparedEvidence,
): ModelAssemblyResult {
  if (!passes.A) return { ok: false, error: { code: 'missing_pass', pass: 'A' } };
  if (!passes.B) return { ok: false, error: { code: 'missing_pass', pass: 'B' } };
  if (!passes.C) return { ok: false, error: { code: 'missing_pass', pass: 'C' } };

  const merged = {
    ...passes.A,
    ...passes.B,
    ...passes.C,
  };
  const knownEvidenceIds = new Set(evidence.index.map((item) => item.id));
  const validation = validateBlueprintModelOutput(merged, { knownEvidenceIds });
  if (!validation.ok) {
    return {
      ok: false,
      error: { code: 'invalid_model_output', validation_codes: validation.errors.map((item) => item.code) },
    };
  }
  return { ok: true, value: validation.value };
}
