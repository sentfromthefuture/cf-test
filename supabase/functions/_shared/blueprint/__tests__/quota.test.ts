import test from 'node:test';
import assert from 'node:assert/strict';
import {
  blueprintReservationKey, readBlueprintReservation, reserveBlueprint, commitBlueprint, releaseBlueprint,
} from '../quota.ts';

const user = '11111111-1111-4111-8111-111111111111';
const cluster = '22222222-2222-4222-8222-222222222222';
const reservation = '33333333-3333-4333-8333-333333333333';
const params = {
  team_size: 'solo', budget_band: 'bootstrap', preferred_stack: 'typescript_postgres',
  business_model_hint: 'b2b_saas', target_region: 'global',
};

test('Blueprint quota adapter', async (t) => {
  await t.test('derives a stable 64-character key bound to identity, cluster and params', async () => {
    const first = await blueprintReservationKey(user, 'client-request-01', cluster, params);
    const retry = await blueprintReservationKey(user, 'client-request-01', cluster, { ...params });
    const changed = await blueprintReservationKey(user, 'client-request-01', cluster, { ...params, target_region: 'north_america' });
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.equal(first, retry);
    assert.notEqual(first, changed);
  });

  await t.test('accepts only known reservation response shapes', () => {
    assert.deepEqual(readBlueprintReservation({ status: 'reserved', reservation_id: reservation, reused: false }),
      { status: 'reserved', reservation_id: reservation, reused: false });
    assert.deepEqual(readBlueprintReservation({ status: 'limit_reached' }), { status: 'limit_reached' });
    assert.equal(readBlueprintReservation({ status: 'reserved', reservation_id: 'not-a-uuid', reused: false }), null);
    assert.equal(readBlueprintReservation({ status: 'committed', reservation_id: reservation, reused: false }), null);
  });

  await t.test('uses only Blueprint-specific reserve, commit and release RPCs', async () => {
    const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
    const rpc = {
      async rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
        calls.push({ name, args });
        if (name === 'dr_blueprint_reserve') return { status: 'reserved', reservation_id: reservation, reused: true } as T;
        return true as T;
      },
    };
    const key = await blueprintReservationKey(user, 'client-request-01', cluster, params);
    assert.deepEqual(await reserveBlueprint(rpc, user, key, 1),
      { status: 'reserved', reservation_id: reservation, reused: true });
    assert.equal(await commitBlueprint(rpc, reservation), true);
    assert.equal(await releaseBlueprint(rpc, reservation), true);
    assert.deepEqual(calls.map((c) => c.name), [
      'dr_blueprint_reserve', 'dr_blueprint_commit', 'dr_blueprint_release',
    ]);
    assert.equal(calls[0].args.p_daily_limit, 1);
  });
});
