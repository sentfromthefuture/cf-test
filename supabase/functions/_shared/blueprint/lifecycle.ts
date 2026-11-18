// Coordinates the durable, retry-safe Blueprint request lifecycle.
// This module deliberately receives the final assembly operation as a dependency: the caller must
// build the backend-owned metadata, run verification, assemble ProductBlueprintV1, and call the
// atomic result-store finalizer. No provider or database configuration is read from globals here.
import { gateBlueprintRequest, type BlueprintRequestGateResult } from './request-gate.ts';
import { releaseBlueprint, type BlueprintQuotaRpc } from './quota.ts';
import type { BlueprintResultIdentity, BlueprintResultStore, StoredBlueprintResult } from './result-store.ts';
import { runBlueprintStep, type BlueprintRuntimeInput, type BlueprintStepResult } from './runtime.ts';
import type { AiCacheStore } from '../collector/ai-common.ts';
import type { BlueprintProviderConfig } from './provider.ts';

export type BlueprintLifecycleResult =
  | { state: 'completed'; result: StoredBlueprintResult; reused: true }
  | { state: 'limit_reached' }
  | { state: 'integrity_error'; reason: 'committed_reservation_without_result' }
  | { state: 'progress'; step: Exclude<BlueprintStepResult, { state: 'ready_to_assemble' }> }
  | { state: 'finalization_deferred'; reason: 'assembly_rejected' }
  | { state: 'completed_now'; result: StoredBlueprintResult; reused: false };

export interface BlueprintLifecycleInput {
  identity: BlueprintResultIdentity;
  dailyLimit: number;
  resultStore: BlueprintResultStore;
  quotaRpc: BlueprintQuotaRpc;
  cacheStore: AiCacheStore;
  provider: BlueprintProviderConfig;
  runtimeInput: BlueprintRuntimeInput;
  /** Must verify, assemble and atomically persist using the reservation supplied here. */
  finalize: (args: {
    identity: BlueprintResultIdentity;
    reservationId: string;
    passes: Extract<BlueprintStepResult, { state: 'ready_to_assemble' }>['passes'];
  }) => Promise<StoredBlueprintResult | null>;
}

/**
 * One request invocation advances at most one live provider pass. A result lookup always precedes
 * quota reservation. The quota reservation is retained across A/B/C retries and only the caller's
 * atomic finalizer can commit it alongside the completed result.
 */
export async function runBlueprintLifecycle(input: BlueprintLifecycleInput): Promise<BlueprintLifecycleResult> {
  const gate: BlueprintRequestGateResult = await gateBlueprintRequest({
    identity: input.identity,
    dailyLimit: input.dailyLimit,
    resultStore: input.resultStore,
    quotaRpc: input.quotaRpc,
  });

  if (gate.state === 'completed') return { state: 'completed', result: gate.result, reused: true };
  if (gate.state === 'limit_reached') return gate;
  if (gate.state === 'integrity_error') return gate;

  const step = await runBlueprintStep(input.cacheStore, input.provider, input.runtimeInput);
  if (step.state !== 'ready_to_assemble') return { state: 'progress', step };

  const stored = await input.finalize({
    identity: input.identity,
    reservationId: gate.reservationId,
    passes: step.passes,
  });
  if (!stored) {
    // A definitive assembly rejection is terminal, unlike a transient provider/cache failure.
    // Release the pending slot so it does not consume the user's daily capacity until expiry.
    await releaseBlueprint(input.quotaRpc, gate.reservationId);
    return { state: 'finalization_deferred', reason: 'assembly_rejected' };
  }
  return { state: 'completed_now', result: stored, reused: false };
}
