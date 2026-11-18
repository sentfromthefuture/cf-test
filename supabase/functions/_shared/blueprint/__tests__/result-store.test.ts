import test from 'node:test';
import assert from 'node:assert/strict';
import { BlueprintResultStore } from '../result-store.ts';
import { validBlueprint } from './helpers.ts';
import type { ProductBlueprintV1 } from '../contract.ts';

const userId = '11111111-1111-4111-8111-111111111111';
const clusterId = '22222222-2222-4222-8222-222222222222';
const reservationKey = 'a'.repeat(64);

test('Blueprint result store', async (t) => {
  await t.test('upserts only validated v1 results using the service role and idempotency key', async () => {
    let requestUrl = '';
    let requestInit: RequestInit | undefined;
    const store = new BlueprintResultStore({
      supabaseUrl: 'https://example.supabase.co',
      serviceRoleKey: 'service-role-test',
      fetchImpl: async (input, init) => {
        requestUrl = String(input);
        requestInit = init;
        return new Response(JSON.stringify({ id: clusterId, created_at: '2026-11-18T00:00:00Z' }), { status: 201 });
      },
    });
    const blueprint = validBlueprint() as ProductBlueprintV1;
    const saved = await store.save({
      userId, clusterId, requestKeyHash: reservationKey,
      requestParams: { team_size: 'solo' },
      model: 'baidu/ernie-5.5-flash-preview:free',
      configVersion: 'bp1.p1.s1',
    }, blueprint);
    assert.equal(saved.id, clusterId);
    assert.match(requestUrl, /on_conflict=user_id%2Ccluster_id%2Crequest_key_hash/);
    assert.equal((requestInit?.method), 'POST');
    const headers = new Headers(requestInit?.headers);
    assert.equal(headers.get('authorization'), 'Bearer service-role-test');
    assert.match(headers.get('prefer') ?? '', /resolution=merge-duplicates/);
    const body = JSON.parse(String(requestInit?.body));
    assert.equal(body.user_id, userId);
    assert.equal(body.request_key_hash, reservationKey);
    assert.deepEqual(body.blueprint, blueprint);
  });

  await t.test('rejects invalid identity and non-free models before network access', async () => {
    let called = false;
    const store = new BlueprintResultStore({
      supabaseUrl: 'https://example.supabase.co', serviceRoleKey: 'service-role-test',
      fetchImpl: async () => { called = true; return new Response('{}'); },
    });
    const blueprint = validBlueprint() as ProductBlueprintV1;
    await assert.rejects(() => store.save({
      userId, clusterId, requestKeyHash: reservationKey, requestParams: {},
      model: 'paid/model', configVersion: 'bp1.p1.s1',
    }, blueprint), /invalid_blueprint_result/);
    assert.equal(called, false);
  });

  await t.test('does not expose PostgREST response bodies on persistence failure', async () => {
    const store = new BlueprintResultStore({
      supabaseUrl: 'https://example.supabase.co', serviceRoleKey: 'service-role-test',
      fetchImpl: async () => new Response('private row details', { status: 500 }),
    });
    await assert.rejects(() => store.save({
      userId, clusterId, requestKeyHash: reservationKey, requestParams: {},
      model: 'baidu/ernie-5.5-flash-preview:free', configVersion: 'bp1.p1.s1',
    }, validBlueprint() as ProductBlueprintV1), /blueprint_result_persistence_failed:500/);
  });
});
