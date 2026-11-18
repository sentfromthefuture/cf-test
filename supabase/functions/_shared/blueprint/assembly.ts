// Backend-owned ProductBlueprintV1 assembly. The model never supplies provenance or verification metadata.
import {
  ACCEPTED_VERIFICATION_STATUS,
  BLUEPRINT_SCHEMA_VERSION,
  FIXED_DISCLAIMERS,
} from './constants.ts';
import type {
  BlueprintModelOutputV1,
  BlueprintRequestParams,
  PassRecord,
  ProductBlueprintV1,
  VerificationReport,
} from './contract.ts';
import type { PreparedEvidence } from './evidence-types.ts';
import type { BlueprintResultIdentity } from './result-store.ts';
import type { BlueprintPasses } from './runtime.ts';
import { BLUEPRINT_PROMPT_VERSION } from './prompts.ts';
import { refSites, countClaimsByBasis } from './validate-evidence.ts';
import { verifyBlueprintModelOutput } from './verify-model.ts';
import { validateProductBlueprint } from './validate.ts';

export type BlueprintAssemblyResult =
  | { ok: true; blueprint: ProductBlueprintV1 }
  | { ok: false; reason: 'missing_pass' | 'verification_failed' | 'assembled_contract_invalid' };

/** SHA-256 of the exact canonical, model-facing evidence pack. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function buildEvidenceIndex(evidence: PreparedEvidence, model: BlueprintModelOutputV1) {
  const citations = new Map<string, string[]>();
  for (const ref of refSites(model)) {
    const paths = citations.get(ref.id) ?? [];
    paths.push(ref.path);
    citations.set(ref.id, paths);
  }
  return evidence.index.map((entry) => ({
    ...entry,
    cited_by: citations.get(entry.id) ?? [],
  }));
}

/**
 * Joins the independently validated A/B/C outputs, verifies them against the original evidence pack,
 * then adds all backend-owned fields and runs the assembled-result validator. It performs no I/O.
 */
export async function assembleProductBlueprint(input: {
  identity: BlueprintResultIdentity;
  request: BlueprintRequestParams;
  evidence: PreparedEvidence;
  passes: BlueprintPasses;
  passRecords: PassRecord[];
  now?: () => Date;
  createId?: () => string;
}): Promise<BlueprintAssemblyResult> {
  const { A, B, C } = input.passes;
  if (!A || !B || !C || input.passRecords.length !== 3
    || input.passRecords.map((p) => p.pass).join(',') !== 'A,B,C') {
    return { ok: false, reason: 'missing_pass' };
  }

  const model = { ...A, ...B, ...C } as BlueprintModelOutputV1;
  const verification = verifyBlueprintModelOutput(model, input.evidence.pack);
  if (!verification.ok) return { ok: false, reason: 'verification_failed' };

  const packSha256 = await sha256Hex(input.evidence.canonical_pack_json);
  const blueprint: ProductBlueprintV1 = {
    ...model,
    meta: {
      blueprint_id: (input.createId ?? (() => crypto.randomUUID()))(),
      cluster_id: input.identity.clusterId,
      generated_at: (input.now ?? (() => new Date()))().toISOString(),
      contract_version: BLUEPRINT_SCHEMA_VERSION,
      prompt_version: BLUEPRINT_PROMPT_VERSION,
      config_version: input.identity.configVersion,
      requested_model: input.identity.model,
      generation_mode: 'sectioned',
      passes: input.passRecords.map((record) => ({ ...record })),
      request_params: { ...input.request },
      evidence_pack: {
        ...input.evidence.summary,
        pack_sha256: packSha256,
      },
      disclaimers: [...FIXED_DISCLAIMERS],
    },
    evidence_index: buildEvidenceIndex(input.evidence, model),
    verification: {
      status: ACCEPTED_VERIFICATION_STATUS,
      checks: verification.checks,
      repairs: [],
      claim_counts: countClaimsByBasis(model),
      ref_count: refSites(model).length,
      unresolved_refs: 0,
    } satisfies VerificationReport,
  };

  const validated = validateProductBlueprint(blueprint);
  if (!validated.ok) return { ok: false, reason: 'assembled_contract_invalid' };
  return { ok: true, blueprint: validated.value };
}
