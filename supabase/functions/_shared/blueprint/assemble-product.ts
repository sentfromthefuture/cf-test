import type { BlueprintModelOutputV1, BlueprintMeta, EvidenceIndexEntry, ProductBlueprintV1, VerificationCheck, VerificationReport } from './contract.ts';
import { REQUIRED_VERIFICATION_CHECKS, FIXED_DISCLAIMERS, ACCEPTED_VERIFICATION_STATUS } from './constants.ts';
import { countClaimsByBasis, refSites } from './validate-evidence.ts';
import { validateProductBlueprint } from './validate.ts';

export type ProductAssemblyError =
  | { code: 'unresolved_evidence_ref'; ids: string[] }
  | { code: 'verification_checks_incomplete'; missing: string[]; failed: string[] }
  | { code: 'invalid_product_blueprint'; validation_codes: string[] };

export type ProductAssemblyResult =
  | { ok: true; value: ProductBlueprintV1 }
  | { ok: false; error: ProductAssemblyError };

export interface ProductAssemblyInput {
  model: BlueprintModelOutputV1;
  evidenceIndex: readonly EvidenceIndexEntry[];
  meta: Omit<BlueprintMeta, 'evidence_pack' | 'disclaimers'> & {
    evidence_pack: Omit<BlueprintMeta['evidence_pack'], 'pack_sha256' | 'excerpt_count' | 'metric_count'>;
  };
  /** Exact backend-computed canonical JSON for the model-facing evidence pack. */
  canonicalEvidencePack: string;
  /** Results from the backend's actual verification steps; this assembler will not invent passing checks. */
  verificationChecks: readonly VerificationCheck[];
}

/**
 * Adds backend-owned provenance and verification metadata to an already validated model output.
 * Citation pointers and all verification counts are recomputed here. Invalid or unresolved data is rejected.
 * This function never repairs model content and never manufactures verification success.
 */
export async function assembleProductBlueprint(input: ProductAssemblyInput): Promise<ProductAssemblyResult> {
  const index = input.evidenceIndex.map((entry) => ({ ...entry, cited_by: [] as string[] }));
  const byId = new Map(index.map((entry) => [entry.id, entry]));
  const refs = refSites(input.model);
  const unresolved = [...new Set(refs.filter((ref) => !byId.has(ref.id)).map((ref) => ref.id))].sort();
  if (unresolved.length) return { ok: false, error: { code: 'unresolved_evidence_ref', ids: unresolved } };

  const checkCounts = new Map<string, number>();
  for (const check of input.verificationChecks) checkCounts.set(check.check, (checkCounts.get(check.check) ?? 0) + 1);
  const missing = REQUIRED_VERIFICATION_CHECKS.filter((check) => checkCounts.get(check) !== 1);
  const failed = input.verificationChecks.filter((check) => check.passed !== true).map((check) => check.check);
  if (missing.length || failed.length || input.verificationChecks.length !== REQUIRED_VERIFICATION_CHECKS.length) {
    return { ok: false, error: { code: 'verification_checks_incomplete', missing: [...missing], failed: [...new Set(failed)].sort() } };
  }

  for (const ref of refs) {
    const entry = byId.get(ref.id);
    if (entry && !entry.cited_by.includes(ref.path)) entry.cited_by.push(ref.path);
  }
  for (const entry of index) entry.cited_by.sort();

  const excerptCount = index.filter((entry) => entry.kind === 'discussion_excerpt').length;
  const metricCount = index.length - excerptCount;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input.canonicalEvidencePack));
  const packSha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

  const meta: BlueprintMeta = {
    ...input.meta,
    evidence_pack: {
      ...input.meta.evidence_pack,
      excerpt_count: excerptCount,
      metric_count: metricCount,
      pack_sha256: packSha256,
    },
    disclaimers: [...FIXED_DISCLAIMERS],
  };
  const verification: VerificationReport = {
    status: ACCEPTED_VERIFICATION_STATUS,
    checks: input.verificationChecks.map((check) => ({ ...check })),
    repairs: [],
    claim_counts: countClaimsByBasis(input.model),
    ref_count: refs.length,
    unresolved_refs: 0,
  };

  const candidate = { ...input.model, meta, evidence_index: index, verification };
  const validated = validateProductBlueprint(candidate);
  if (!validated.ok) {
    return { ok: false, error: { code: 'invalid_product_blueprint', validation_codes: [...new Set(validated.errors.map((error) => error.code))].sort() } };
  }
  return { ok: true, value: validated.value };
}
