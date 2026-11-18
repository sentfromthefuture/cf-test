// B10: isolated adapter for the Blueprint-only daily quota RPCs.
// No Gemini PRD quota tables or RPCs are used here.
import { canonicalJson } from '../collector/ai-common.ts';
import type { BlueprintRequestParams } from './contract.ts';

export interface BlueprintQuotaRpc {
  rpc<T>(name: string, args: Record<string, unknown>): Promise<T>;
}
export type BlueprintReservation =
  | { status: 'reserved'; reservation_id: string; reused: boolean }
  | { status: 'committed'; reservation_id: string; reused: true }
  | { status: 'limit_reached' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Binds a client retry key to the authenticated user, cluster and exact request parameters. */
export async function blueprintReservationKey(
  userId: string,
  clientRequestKey: string,
  clusterId: string,
  params: BlueprintRequestParams,
): Promise<string> {
  if (!UUID.test(userId) || !UUID.test(clusterId) || clientRequestKey.length < 8 || clientRequestKey.length > 128) {
    throw new TypeError('invalid_reservation_identity');
  }
  const canonical = canonicalJson({ user_id: userId, client_request_key: clientRequestKey, cluster_id: clusterId, params });
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Strictly parses the JSON shape returned by dr_blueprint_reserve. */
export function readBlueprintReservation(value: unknown): BlueprintReservation | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.status === 'limit_reached') return { status: 'limit_reached' };
  if ((row.status === 'reserved' || row.status === 'committed')
    && typeof row.reservation_id === 'string' && UUID.test(row.reservation_id)
    && typeof row.reused === 'boolean') {
    if (row.status === 'committed' && row.reused !== true) return null;
    return { status: row.status, reservation_id: row.reservation_id, reused: row.reused } as BlueprintReservation;
  }
  return null;
}

export async function reserveBlueprint(
  rpc: BlueprintQuotaRpc,
  userId: string,
  requestKey: string,
  dailyLimit: number,
): Promise<BlueprintReservation> {
  if (!UUID.test(userId) || !/^[a-f0-9]{64}$/.test(requestKey) || !Number.isSafeInteger(dailyLimit) || dailyLimit < 1) {
    throw new TypeError('invalid_quota_arguments');
  }
  const raw = await rpc.rpc<unknown>('dr_blueprint_reserve', {
    p_user: userId, p_request_key: requestKey, p_daily_limit: dailyLimit,
  });
  const parsed = readBlueprintReservation(raw);
  if (!parsed) throw new Error('invalid_quota_response');
  return parsed;
}

export async function commitBlueprint(rpc: BlueprintQuotaRpc, reservationId: string): Promise<boolean> {
  if (!UUID.test(reservationId)) throw new TypeError('invalid_reservation_id');
  const result = await rpc.rpc<unknown>('dr_blueprint_commit', { p_reservation: reservationId });
  return result === true;
}

export async function releaseBlueprint(rpc: BlueprintQuotaRpc, reservationId: string): Promise<boolean> {
  if (!UUID.test(reservationId)) throw new TypeError('invalid_reservation_id');
  const result = await rpc.rpc<unknown>('dr_blueprint_release', { p_reservation: reservationId });
  return result === true;
}
