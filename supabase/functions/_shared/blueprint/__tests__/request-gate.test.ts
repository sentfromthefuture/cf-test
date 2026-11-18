import test from 'node:test';
import assert from 'node:assert/strict';
import { gateBlueprintRequest } from '../request-gate.ts';
import type { BlueprintResultIdentity, StoredBlueprintResult } from '../result-store.ts';

const identity: BlueprintResultIdentity = {
  userId: '11111111-1111-4111-8111-111111111111',
  clusterId: '22222222-2222-4222-8222-222222222222',
  requestKeyHash: 'a'.repeat(64),
  requestParams: { team_size: 'solo' },
  model: 'baidu/ernie-5.5-flash-preview:free',
  configVersion: 'bp1.p1.s1',
};
const result = { id: '33333333-3333-4333-8333-333333333333', created_at: '2026-11-18T00:00:00Z', blueprint: {} } as StoredBlueprintResult;
const reservationId = '44444444-4444-4444-8444-444444444444';

test('Blueprint request gate', async (t) => {
  await t.test('returns an existing result before quota is touched', async () => {
    let quotaCalls = 0;
    const response = await gateBlueprintRequest({
      identity, dailyLimit: 1,
      resultStore: { get: async () => result },
      quotaRpc: { rpc: async <T>() => { quotaCalls++; throw new Error('must_not_call_quota'); } },
    });
    assert.deepEqual(response, { state: 'completed', result });
    assert.equal(quotaCalls, 0);
  });

  await t.test('reserves quota when no completed result exists', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const response = await gateBlueprintRequest({
      identity, dailyLimit: 2,
      resultStore: { get: async () => null },
      quotaRpc: { rpc: async <T>(name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        return { status: 'reserved', reservation_id: reservationId, reused: false } as T;
      } },
    });
    assert.deepEqual(response, { state: 'reserved', reservationId, reused: false });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].name, 'dr_blueprint_reserve');
    assert.equal(calls[0].args.p_user, identity.userId);
    assert.equal(calls[0].args.p_request_key, identity.requestKeyHash);
    assert.equal(calls[0].args.p_daily_limit, 2);
  });

  await t.test('surfaces quota limit without proceeding', async () => {
    const response = await gateBlueprintRequest({
      identity, dailyLimit: 1,
      resultStore: { get: async () => null },
      quotaRpc: { rpc: async <T>() => ({ status: 'limit_reached' } as T) },
    });
    assert.deepEqual(response, { state: 'limit_reached' });
  });

  await t.test('fails closed if quota is committed but the result is missing', async () => {
    const response = await gateBlueprintRequest({
      identity, dailyLimit: 1,
      resultStore: { get: async () => null },
      quotaRpc: { rpc: async <T>() => ({ status: 'committed', reservation_id: reservationId, reused: true } as T) },
    });
    assert.deepEqual(response, { state: 'integrity_error', reason: 'committed_reservation_without_result' });
  });

  await t.test('does not reserve quota when result lookup fails', async () => {
    let quotaCalls = 0;
    await assert.rejects(() => gateBlueprintRequest({
      identity, dailyLimit: 1,
      resultStore: { get: async () => { throw new Error('storage_unavailable'); } },
      quotaRpc: { rpc: async <T>() => { quotaCalls++; return { status: 'reserved', reservation_id: reservationId, reused: false } as T; } },
    }), /storage_unavailable/);
    assert.equal(quotaCalls, 0);
  });
});
