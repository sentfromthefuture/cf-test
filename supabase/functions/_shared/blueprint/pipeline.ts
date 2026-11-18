import type { BlueprintRequestParams, PassAOutput, PassBOutput, PassCOutput } from './contract.ts';
import type { PreparedEvidence } from './evidence.ts';
import { callBlueprintProvider, type BlueprintProviderConfig, type BlueprintProviderResult } from './provider.ts';
import { blueprintSystemPrompt } from './prompts.ts';
import { validateBlueprintPassOutput } from './validate.ts';

export type BlueprintPass = 'A' | 'B' | 'C';

export interface BlueprintPassInput {
  pass: BlueprintPass;
  request: BlueprintRequestParams;
  evidence: PreparedEvidence;
  allowedVerdicts?: string[];
  passA?: PassAOutput;
  passB?: PassBOutput;
}

export interface BlueprintPassResult {
  pass: BlueprintPass;
  output: PassAOutput | PassBOutput | PassCOutput;
  provider: BlueprintProviderResult;
}

export class BlueprintPassError extends Error {
  constructor(
    public readonly code: 'missing_upstream_pass' | 'invalid_upstream_pass' | 'invalid_model_output',
    public readonly validationCodes: string[] = [],
  ) {
    super(code);
    this.name = 'BlueprintPassError';
  }
}

function assertPass(pass: 'A' | 'B' | 'C', value: unknown): Record<string, unknown> {
  const result = validateBlueprintPassOutput(pass, value);
  if (!result.ok) throw new BlueprintPassError('invalid_upstream_pass', result.errors.map((e) => e.code));
  return result.value;
}

/** Build a fresh allowlisted DTO. No raw prior-pass object is ever forwarded to a later pass. */
export function buildBlueprintPassPayload(input: BlueprintPassInput): unknown {
  const request = {
    ...input.request,
    evidence_sufficiency: input.evidence.sufficiency.level,
  };

  if (input.pass === 'A') {
    if (!input.allowedVerdicts?.length) throw new BlueprintPassError('invalid_upstream_pass');
    return {
      task: 'blueprint_pass_a',
      contract: 'product-blueprint.v1',
      request: { ...request, allowed_verdicts: [...input.allowedVerdicts] },
      evidence_pack: input.evidence.pack,
    };
  }

  if (!input.passA) throw new BlueprintPassError('missing_upstream_pass');
  const a = assertPass('A', input.passA);
  const aProduct = a.product as Record<string, unknown>;
  const aMvp = a.mvp as Record<string, unknown>;
  const features = aMvp.features as Array<Record<string, unknown>>;
  const personas = a.personas as Array<Record<string, unknown>>;
  const workflows = a.workflows as Array<Record<string, unknown>>;

  if (input.pass === 'B') {
    return {
      task: 'blueprint_pass_b',
      contract: 'product-blueprint.v1',
      request,
      product: {
        product_name: aProduct.product_name,
        product_type: aProduct.product_type,
        positioning: (aProduct.positioning as Record<string, unknown>).text,
      },
      personas: personas.map((p) => ({ persona_id: p.persona_id, role: p.role, priority: p.priority })),
      features: features.map((f) => ({
        feature_id: f.feature_id, name: f.name, description: f.description, priority: f.priority,
        complexity: f.complexity, depends_on: f.depends_on,
      })),
      workflows: workflows.map((w) => ({
        name: w.name, entity: w.entity,
        states: (w.states as Array<Record<string, unknown>>).map((s) => s.name),
      })),
    };
  }

  if (!input.passB) throw new BlueprintPassError('missing_upstream_pass');
  const b = assertPass('B', input.passB);
  const architecture = b.architecture as Record<string, unknown>;
  const database = b.database as Record<string, unknown>;
  const components = architecture.components as Array<Record<string, unknown>>;
  const tables = database.tables as Array<Record<string, unknown>>;
  return {
    task: 'blueprint_pass_c',
    contract: 'product-blueprint.v1',
    request,
    verdict: (a.opportunity as Record<string, unknown>).verdict,
    features: features.map((f) => ({
      feature_id: f.feature_id, name: f.name, description: f.description, priority: f.priority,
      complexity: f.complexity, depends_on: f.depends_on,
    })),
    components: components.map((c) => ({
      component_id: c.component_id, name: c.name, feature_ids: c.feature_ids,
    })),
    tables: tables.map((t) => ({ name: t.name, feature_ids: t.feature_ids })),
    evidence_gaps: ((a.market_evidence as Record<string, unknown>).evidence_gaps as Array<Record<string, unknown>>).map((g) => g.description),
  };
}

/** Executes exactly one live pass. Persistence, cache leases, quotas and entitlement are owned by the endpoint layer. */
export async function runBlueprintPass(
  config: BlueprintProviderConfig,
  input: BlueprintPassInput,
): Promise<BlueprintPassResult> {
  const payload = buildBlueprintPassPayload(input);
  const maxTokens = input.pass === 'A' ? 8_500 : input.pass === 'B' ? 8_500 : 7_500;
  const provider = await callBlueprintProvider(config, {
    systemPrompt: blueprintSystemPrompt(input.pass),
    userPayload: payload,
    maxTokens,
  });
  const validation = validateBlueprintPassOutput(input.pass, provider.output);
  if (!validation.ok) throw new BlueprintPassError('invalid_model_output', validation.errors.map((e) => e.code));
  return {
    pass: input.pass,
    output: validation.value as PassAOutput | PassBOutput | PassCOutput,
    provider,
  };
}
