// Coordinates the first, retry-sensitive gates for one Blueprint invocation.
// A completed result is always looked up BEFORE quota reservation. This prevents retries
// after a successful generation from consuming quota or re-running model passes.
import { reserveBlueprint, type BlueprintQuotaRpc, type BlueprintReservation } from './quota.ts';
import { BlueprintResultStore, type BlueprintResultIdentity, type StoredBlueprintResult } from './result-store.ts';

export type BlueprintRequestGateResult =
  | { state: 'completed'; result: StoredBlueprintResult }
  | { state: 'limit_reached' }
  | { state: 'reserved'; reservationId: string; reused: boolean }
  | { state: 'integrity_error'; reason: 'committed_reservation_without_result' };

export interface BlueprintRequestGateInput {
  identity: BlueprintResultIdentity;
  dailyLimit: number;
  resultStore: Pick<BlueprintResultStore, 'get'>;
  quotaRpc: BlueprintQuotaRpc;
}

/**
 * The ordering here is deliberate:
 * 1. Return an existing, revalidated result without touching quota.
 * 2. Otherwise reserve exactly one Blueprint quota slot using the deterministic request hash.
 * 3. A committed reservation without its result is an integrity fault; never regenerate it.
 */
export async function gateBlueprintRequest(input: BlueprintRequestGateInput): Promise<BlueprintRequestGateResult> {
  const existing = await input.resultStore.get(input.identity);
  if (existing) return { state: 'completed', result: existing };

  const reservation: BlueprintReservation = await reserveBlueprint(
    input.quotaRpc,
    input.identity.userId,
    input.identity.requestKeyHash,
    input.dailyLimit,
  );
  if (reservation.status === 'limit_reached') return { state: 'limit_reached' };
  if (reservation.status === 'committed') {
    return { state: 'integrity_error', reason: 'committed_reservation_without_result' };
  }
  return {
    state: 'reserved',
    reservationId: reservation.reservation_id,
    reused: reservation.reused,
  };
}
