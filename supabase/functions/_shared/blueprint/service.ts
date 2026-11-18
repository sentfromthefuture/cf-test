// Complete orchestration boundary for a Blueprint generation request.
// HTTP/auth/entitlement/privacy gates stay in the Edge Function; this service owns A/B/C and finalization.
import { runBlueprintLifecycle, type BlueprintLifecycleResult } from './lifecycle.ts';
import { finalizeBlueprintProduct } from './assembly.ts';
import type { BlueprintRequestParams, PassRecord } from './contract.ts';
import type { PreparedEvidence } from './evidence-types.ts';
import type { BlueprintResultIdentity, BlueprintResultStore } from './result-store.ts';
import type { BlueprintQuotaRpc } from './quota.ts';
import type { AiCacheStore } from '../collector/ai-common.ts';
import type { BlueprintProviderConfig } from './provider.ts';

export interface BlueprintGenerationInput {
  identity: BlueprintResultIdentity;
  dailyLimit: number;
  request: BlueprintRequestParams;
  evidence: PreparedEvidence;
  allowedVerdicts: string[];
  resultStore: BlueprintResultStore;
  quotaRpc: BlueprintQuotaRpc;
  cacheStore: AiCacheStore;
  provider: BlueprintProviderConfig;
  now?: () => Date;
  createId?: () => string;
}

/**
 * Runs the full retry-safe lifecycle. The injected finalizer always verifies, assembles, validates,
 * then calls the atomic result-store RPC; transient persistence errors propagate for safe retry.
 */
export function runBlueprintGeneration(input: BlueprintGenerationInput): Promise<BlueprintLifecycleResult> {
  return runBlueprintLifecycle({
    identity: input.identity,
    dailyLimit: input.dailyLimit,
    resultStore: input.resultStore,
    quotaRpc: input.quotaRpc,
    cacheStore: input.cacheStore,
    provider: input.provider,
    runtimeInput: {
      request: input.request,
      evidence: input.evidence,
      allowedVerdicts: input.allowedVerdicts,
    },
    finalize: (args: {
      identity: BlueprintResultIdentity;
      reservationId: string;
      passes: Parameters<typeof finalizeBlueprintProduct>[0]['passes'];
      passRecords: PassRecord[];
    }) => finalizeBlueprintProduct({
      ...args,
      request: input.request,
      evidence: input.evidence,
      resultStore: input.resultStore,
      ...(input.now ? { now: input.now } : {}),
      ...(input.createId ? { createId: input.createId } : {}),
    }),
  });
}
