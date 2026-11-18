// Blueprint Phase B4: durable, cache-first pass orchestration.
// One invocation may make at most ONE live provider request. Cache hits can advance through
// already-completed passes; a live pass is persisted before the caller is told to continue.
import {
  aiInputHash, cachedCompute, type AiCacheKey, type AiCacheStore, type CachedOutcome,
} from '../collector/ai-common.ts';
import type { BlueprintRequestParams, PassAOutput, PassBOutput, PassCOutput, PassRecord } from './contract.ts';
import type { PreparedEvidence } from './evidence-types.ts';
import { runBlueprintPass, type BlueprintPass } from './pipeline.ts';
import type { BlueprintProviderConfig, BlueprintProviderUsage } from './provider.ts';
import { validateBlueprintPassOutput } from './validate.ts';

export const BLUEPRINT_CONFIG_VERSION = 'bp1.p1.s1';

export type StoredPassOutput = PassAOutput | PassBOutput | PassCOutput;
export interface BlueprintRuntimeInput {
  request: BlueprintRequestParams;
  evidence: PreparedEvidence;
  allowedVerdicts: string[];
}
export interface BlueprintPasses {
  A?: PassAOutput;
  B?: PassBOutput;
  C?: PassCOutput;
}
export type BlueprintStepResult =
  | { state: 'pass_completed'; completed: BlueprintPass; next: 'B' | 'C' | 'assemble'; from_cache: boolean; passes: BlueprintPasses; passRecords: PassRecord[]; cache_id: string; input_hash: string }
  | { state: 'busy' | 'cooldown' | 'deferred'; pass: BlueprintPass; reason?: string; passes: BlueprintPasses }
  | { state: 'ready_to_assemble'; passes: BlueprintPasses; passRecords: PassRecord[] };

const PASS_ORDER: readonly BlueprintPass[] = ['A', 'B', 'C'];
const asPass = (pass: BlueprintPass, value: unknown): StoredPassOutput | null => {
  const checked = validateBlueprintPassOutput(pass, value);
  return checked.ok ? checked.value as StoredPassOutput : null;
};

function revive(pass: BlueprintPass, value: unknown): StoredPassOutput | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.pass !== pass) return null;
  return asPass(pass, record.output);
}

function usageRecord(usage: BlueprintProviderUsage): Record<string, unknown> {
  return { ...usage };
}

function readCachedProviderUsage(value: unknown): BlueprintProviderUsage | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const integer = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
  const optionalNumber = (v: unknown) => v === null || (typeof v === 'number' && Number.isFinite(v) && v >= 0);
  const optionalString = (v: unknown) => v === null || typeof v === 'string';
  if (!integer(row.input_tokens) || !integer(row.output_tokens) || !optionalNumber(row.reasoning_tokens)
    || !optionalNumber(row.reported_cost_usd) || !optionalString(row.served_model)
    || !optionalString(row.provider) || !optionalString(row.response_id) || !integer(row.duration_ms)) return null;
  return {
    input_tokens: row.input_tokens,
    output_tokens: row.output_tokens,
    reasoning_tokens: row.reasoning_tokens as number | null,
    reported_cost_usd: row.reported_cost_usd as number | null,
    served_model: row.served_model as string | null,
    provider: row.provider as string | null,
    response_id: row.response_id as string | null,
    duration_ms: row.duration_ms,
  };
}

function nextPass(pass: BlueprintPass): 'B' | 'C' | 'assemble' {
  return pass === 'A' ? 'B' : pass === 'B' ? 'C' : 'assemble';
}

/**
 * Loads all available cached passes in order and performs no more than one live pass.
 * The endpoint must run authentication, entitlement and quota gates BEFORE calling this function.
 */
export async function runBlueprintStep(
  store: AiCacheStore,
  provider: BlueprintProviderConfig,
  input: BlueprintRuntimeInput,
  options: { configVersion?: string; leaseSeconds?: number } = {},
): Promise<BlueprintStepResult> {
  const configVersion = options.configVersion ?? BLUEPRINT_CONFIG_VERSION;
  const passes: BlueprintPasses = {};
  let upstreamA: string | undefined;
  let upstreamB: string | undefined;
  const passRecords: PassRecord[] = [];

  for (const pass of PASS_ORDER) {
    const inputHash = await aiInputHash({
      contract: 'product-blueprint.v1',
      pass,
      request: input.request,
      evidence: input.evidence.canonical_pack_json,
      upstream: pass === 'A' ? null : pass === 'B' ? { A: upstreamA } : { A: upstreamA, B: upstreamB },
    });
    const key: AiCacheKey = { task: 'blueprint', model: provider.model, configVersion, hash: inputHash };
    const liveUsage: { value: BlueprintProviderUsage | null } = { value: null };
    const outcome: CachedOutcome<StoredPassOutput> = await cachedCompute(
      store,
      key,
      async () => {
        const result = await runBlueprintPass(provider, {
          pass, request: input.request, evidence: input.evidence,
          allowedVerdicts: input.allowedVerdicts,
          ...(passes.A ? { passA: passes.A } : {}),
          ...(passes.B ? { passB: passes.B } : {}),
        });
        liveUsage.value = result.provider.usage;
        const output = result.output as StoredPassOutput;
        return {
          value: output,
          result: { pass, output },
          citations: [],
          usage: usageRecord(result.provider.usage),
        };
      },
      (stored) => revive(pass, stored),
      { leaseSeconds: options.leaseSeconds ?? 150 },
    );

    if (outcome.status === 'busy') return { state: 'busy', pass, passes };
    if (outcome.status === 'cooldown') return { state: 'cooldown', pass, passes };
    if (outcome.status === 'deferred') return { state: 'deferred', pass, reason: outcome.reason, passes };

    const output = asPass(pass, outcome.value);
    if (!output) return { state: 'deferred', pass, reason: 'cached_pass_failed_validation', passes };
    // A computed pass is usable only when its cache write is durable. Advancing after a failed
    // write would make retries repeat a paid-in-quota provider call and lose pass continuity.
    if (outcome.status === 'computed' && outcome.stored !== true) {
      return { state: 'deferred', pass, reason: 'pass_result_not_durable', passes };
    }
    const provenanceUsage = liveUsage.value ?? (outcome.status === 'hit' ? readCachedProviderUsage(outcome.usage) : null);
    passRecords.push({
      pass, cache_id: outcome.cacheId, input_hash: inputHash,
      served_model: provenanceUsage?.served_model ?? null, provider: provenanceUsage?.provider ?? null, finish_reason: null,
      prompt_tokens: provenanceUsage?.input_tokens ?? 0, completion_tokens: provenanceUsage?.output_tokens ?? 0,
      reasoning_tokens: provenanceUsage?.reasoning_tokens ?? null, reported_cost_usd: provenanceUsage?.reported_cost_usd ?? null,
      duration_ms: provenanceUsage?.duration_ms ?? 0, from_cache: outcome.status === 'hit',
    });

    if (pass === 'A') {
      passes.A = output as PassAOutput;
      upstreamA = await aiInputHash(output);
    } else if (pass === 'B') {
      passes.B = output as PassBOutput;
      upstreamB = await aiInputHash(output);
    } else {
      passes.C = output as PassCOutput;
    }

    // A live result ends this invocation. Cache hits may continue to the next pass.
    if (outcome.status === 'computed') {
      return {
        state: 'pass_completed', completed: pass, next: nextPass(pass),
        from_cache: false, passes, passRecords, cache_id: outcome.cacheId, input_hash: inputHash,
      };
    }
  }

  return { state: 'ready_to_assemble', passes, passRecords };
}
