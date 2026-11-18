import test from 'node:test';
import assert from 'node:assert/strict';
import { BlueprintResultStore } from '../result-store.ts';
import { validBlueprint } from './helpers.ts';
import type { ProductBlueprintV1 } from '../contract.ts';

const userId = '11111111-1111-4111-8111-111111111111';
const clusterId = '22222222-2222-4222-8222-222222222222';
const reservationKey = 'a'.repeat(64);
const identity = {
  userId, clusterId, requestKeyHash: reservationKey, requestParams: { team_size: 'solo' },
  model: 'baidu/ernie-5.5-flash-preview:free', configVersion: 'bp1.p1.s1',
};

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
    const saved = await store.save(identity, blueprint);
    assert.equal(saved.id, clusterId);
    assert.match(requestUrl, /on_conflict=user_id%2Ccluster_id%2Crequest_key_hash/);
    assert.equal(requestInit?.method, 'POST');
    const headers = new Headers(requestInit?.headers);
    assert.equal(headers.get('authorization'), 'Bearer service-role-test');
    assert.match(headers.get('prefer') ?? '', /resolution=merge-duplicates/);
    const body = JSON.parse(String(requestInit?.body));
    assert.equal(body.user_id, userId);
    assert.equal(body.request_key_hash, reservationKey);
    assert.deepEqual(body.blueprint, blueprint);
  });

  await t.test('reads an idempotent prior result scoped to the authenticated identity and revalidates it', async () => {
    let requestUrl = '';
    let requestInit: RequestInit | undefined;
    const blueprint = validBlueprint() as ProductBlueprintV1;
    const store = new BlueprintResultStore({
      supabaseUrl: 'https://example.supabase.co',
      serviceRoleKey: 'service-role-test',
      fetchImpl: async (input, init) => {
        requestUrl = String(input);
        requestInit = init;
        return new Response(JSON.stringify([{ id: clusterId, created_at: '2026-11-18T00:00:00Z', blueprint }]), { status: 200 });
      },
    });
    const found = await store.get(identity);
    assert.equal(found?.id, clusterId);
    assert.deepEqual(found?.blueprint, blueprint);
    assert.match(requestUrl, /user_id=eq\./);
    assert.match(requestUrl, /cluster_id=eq\./);
    assert.match(requestUrl, /request_key_hash=eq\./);
    assert.equal(requestInit?.method, 'GET');
    assert.equal(new Headers(requestInit?.headers).get('authorization'), 'Bearer service-role-test');
  });

  await t.test('returns null when no prior result exists', async () => {
    const store = new BlueprintResultStore({
      supabaseUrl: 'https://example.supabase.co', serviceRoleKey: 'service-role-test',
      fetchImpl: async () => new Response('[]', { status: 200 }),
    });
    assert.equal(await store.get(identity), null);
  });

  await t.test('rejects invalid identity and non-free models before network access', async () => {
    let called = false;
    const store = new BlueprintResultStore({
      supabaseUrl: 'https://example.supabase.co', serviceRoleKey: 'service-role-test',
      fetchImpl: async () => { called = true; return new Response('{}'); },
    });
    await assert.rejects(() => store.save({ ...identity, model: 'paid/model' }, validBlueprint() as ProductBlueprintV1), /invalid_blueprint_result_identity/);
    await assert.rejects(() => store.get({ ...identity, model: 'paid/model' }), /invalid_blueprint_result_identity/);
    assert.equal(called, false);
  });

  await t.test('rejects ambiguous and invalid stored rows without returning them', async () => {
    const blueprint = validBlueprint() as ProductBlueprintV1;
    const ambiguous = new BlueprintResultStore({
      supabaseUrl: 'https://example.supabase.co', serviceRoleKey: 'service-role-test',
      fetchImpl: async () => new Response(JSON.stringify([
        { id: clusterId, created_at: '2026-11-18T00:00:00Z', blueprint },
        { id: clusterId, created_at: '2026-11-18T00:00:00Z', blueprint },
      ]), { status: 200 }),
    });
    await assert.rejects(() => ambiguous.get(identity), /blueprint_result_identity_ambiguous/);
    const invalid = new BlueprintResultStore({
      supabaseUrl: 'https://example.supabase.co', serviceRoleKey: 'service-role-test',
      fetchImpl: async () => new Response(JSON.stringify([{ id: clusterId, created_at: '2026-11-18T00:00:00Z', blueprint: {} }]), { status: 200 }),
    });
    await assert.rejects(() => invalid.get(identity), /blueprint_result_failed_validation/);
  });

  await t.test('does not expose PostgREST response bodies on persistence failure', async () => {
    const store = new BlueprintResultStore({
      supabaseUrl: 'https://example.supabase.co', serviceRoleKey: 'service-role-test',
      fetchImpl: async () => new Response('private row details', { status: 500 }),
    });
    await assert.rejects(() => store.save(identity, validBlueprint() as ProductBlueprintV1), /blueprint_result_persistence_failed:500/);
  });
  await t.test('atomically finalizes the result and reservation, then re-reads the validated result', async () => {
    const blueprint = validBlueprint() as ProductBlueprintV1;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const store = new BlueprintResultStore({
      supabaseUrl: 'https://example.supabase.co',
      serviceRoleKey: 'service-role-test',
      fetchImpl: async (input, init) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.endsWith('/rpc/dr_blueprint_finalize')) {
          return new Response(JSON.stringify({
            status: 'completed', id: clusterId, created_at: '2026-11-18T00:00:00Z',
          }), { status: 200 });
        }
        return new Response(JSON.stringify([{
          id: clusterId, created_at: '2026-11-18T00:00:00Z', blueprint,
        }]), { status: 200 });
      },
    });

    const stored = await store.finalize(identity, '33333333-3333-4333-8333-333333333333', blueprint);
    assert.equal(stored.id, clusterId);
    assert.deepEqual(stored.blueprint, blueprint);
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /rpc\/dr_blueprint_finalize$/);
    assert.equal(calls[0].init?.method, 'POST');
    const headers = new Headers(calls[0].init?.headers);
    assert.equal(headers.get('authorization'), 'Bearer service-role-test');
    const body = JSON.parse(String(calls[0].init?.body));
    assert.equal(body.p_reservation, '33333333-3333-4333-8333-333333333333');
    assert.equal(body.p_user, userId);
    assert.equal(body.p_cluster, clusterId);
    assert.equal(body.p_request_key_hash, reservationKey);
    assert.equal(body.p_evidence_pack_sha256, blueprint.meta.evidence_pack.pack_sha256);
    assert.deepEqual(body.p_blueprint, blueprint);
    assert.match(calls[1].url, /user_id=eq\./);
  });

});
