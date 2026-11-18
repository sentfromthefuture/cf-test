// B8: executable, backend-owned verification for the assembled Blueprint.
// A check is recorded as passed only after the corresponding validator/guard actually runs.
import { REQUIRED_VERIFICATION_CHECKS } from './constants.ts';
import type { BlueprintModelOutputV1, VerificationCheck } from './contract.ts';
import type { EvidencePack } from './evidence-types.ts';
import { buildGroundingContext, checkGeneralisation, checkNameGrounding, checkNumericGrounding, checkRelevanceFloor, checkSupportingGrade, checkWtpEvidence } from './evidence-grounding.ts';
import { claimSites, refSites } from './validate-evidence.ts';
import { validateBlueprintModelOutput } from './validate.ts';

export type BlueprintVerificationResult =
  | { ok: true; checks: VerificationCheck[] }
  | { ok: false; failed: { check: VerificationCheck['check']; detail: string }[] };

const failure = (check: VerificationCheck['check'], detail: string) => ({ check, detail });

/**
 * Runs the model contract validator and evidence-grounding guards.
 * Details are fixed internal codes/JSON pointers only; never include model text or source excerpts.
 */
export function verifyBlueprintModelOutput(
  input: unknown,
  pack: EvidencePack,
): BlueprintVerificationResult {
  const knownIds = new Set([...pack.excerpts.map((e) => e.id), ...pack.metrics.map((m) => m.id)]);
  const validation = validateBlueprintModelOutput(input, { knownEvidenceIds: knownIds });
  if (!validation.ok) {
    const codes = [...new Set(validation.errors.map((e) => e.code))].sort();
    return {
      ok: false,
      failed: [
        failure('schema_shape', codes.join(',')),
        failure('required_fields', codes.join(',')),
        failure('enums', codes.join(',')),
        failure('size_caps', codes.join(',')),
        failure('identifier_integrity', codes.join(',')),
        failure('basis_rules', codes.join(',')),
        failure('commercial_rules', codes.join(',')),
        failure('no_executable_sql', codes.join(',')),
        failure('no_urls', codes.join(',')),
      ],
    };
  }

  const model = validation.value as BlueprintModelOutputV1;
  const context = buildGroundingContext(pack);
  const failed: { check: VerificationCheck['check']; detail: string }[] = [];

  for (const ref of refSites(model)) {
    if (!knownIds.has(ref.id)) failed.push(failure('evidence_ref_resolution', ref.path));
  }

  for (const site of claimSites(model)) {
    const claim = site.claim;
    if (claim.basis === 'verified_evidence' && !checkSupportingGrade(context, claim.evidence_refs).passed) {
      failed.push(failure('name_and_number_grounding', site.path + ':no_supporting_grade'));
    }
    if (!checkNumericGrounding(context, claim.text, claim.evidence_refs).passed) {
      failed.push(failure('name_and_number_grounding', site.path + ':numeric_grounding'));
    }
    if (!checkRelevanceFloor(context, claim.text, claim.evidence_refs).passed) {
      failed.push(failure('name_and_number_grounding', site.path + ':relevance_floor'));
    }
    if (!checkGeneralisation(context, claim.text, claim.evidence_refs).passed) {
      failed.push(failure('name_and_number_grounding', site.path + ':generalisation'));
    }
    if (site.role === 'alternative_shortfall' && site.condition === 'named_in_evidence') {
      const alternative = model.opportunity.current_alternatives.find((a) => a.how_it_falls_short === claim);
      if (alternative && !checkNameGrounding(context, alternative.name, claim.evidence_refs).passed) {
        failed.push(failure('name_and_number_grounding', site.path + ':alternative_name'));
      }
    }
  }

  const wtp = model.market_evidence.willingness_to_pay;
  const wtpGuard = checkWtpEvidence(context, {
    status: wtp.status,
    basis: wtp.summary.basis,
    text: wtp.summary.text,
    evidence_refs: wtp.summary.evidence_refs,
  });
  if (!wtpGuard.passed) failed.push(failure('willingness_to_pay_rule', wtpGuard.reason));

  // Provider response parsing is a precondition: this function accepts only the already-parsed JSON value.
  // The full contract validator above owns shape, required fields, enums, caps, identifiers, basis, commercial policy,
  // executable/SQL and URL rejection. The evidence-specific guards above own refs, grounding and WTP.
  if (failed.length) return { ok: false, failed };

  const checks: VerificationCheck[] = REQUIRED_VERIFICATION_CHECKS.map((check) => ({ check, passed: true }));
  return { ok: true, checks };
}
