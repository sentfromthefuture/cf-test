// Tests the Edge Function entry point (CORS preflight + auth gate) by stubbing the Deno globals it expects.
import test from 'node:test';
import assert from 'node:assert/strict';

let handler: (req: Request) => Promise<Response>;
(globalThis as any).Deno = {
  env: { toObject: () => ({ SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'svc', SUPABASE_ANON_KEY: 'anon', COLLECTOR_SECRET: 'cron-secret' }) },
  serve: (h: typeof handler) => { handler = h; },
};
await import('../../../collect/index.ts');

const origin = 'https://app.example';
const call = (init: RequestInit & { url?: string } = {}) => handler(new Request(init.url ?? 'https://x.supabase.co/functions/v1/collect', init));

test('CORS preflight allows the headers supabase-js really sends (x-client-info, apikey, authorization)', async () => {
  const res = await call({ method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,x-client-info,apikey,content-type' } });
  assert.equal(res.status, 204);
  const allowed = res.headers.get('access-control-allow-headers')!.toLowerCase();
  for (const h of ['authorization', 'x-client-info', 'apikey', 'content-type']) assert.ok(allowed.includes(h), `missing ${h}: ${allowed}`);
  assert.equal(res.headers.get('access-control-allow-origin'), '*');
  assert.match(res.headers.get('access-control-allow-methods')!, /POST/);
});

test('rejections still carry CORS headers so the browser can read the real error', async () => {
  const noAuth = await call({ method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' });
  assert.equal(noAuth.status, 401);
  assert.equal(noAuth.headers.get('access-control-allow-origin'), '*');
  assert.deepEqual(await noAuth.json(), { error: 'unauthorized' });

  const wrongSecret = await call({ method: 'POST', headers: { 'x-collector-secret': 'nope' }, body: '{}' });
  assert.equal(wrongSecret.status, 401);

  const get = await call({ method: 'GET' });
  assert.equal(get.status, 405);
});

test('a signed-in non-admin is refused (admin is re-checked server-side via dr_is_admin)', async () => {
  const realFetch = globalThis.fetch;
  let asked = '';
  globalThis.fetch = (async (u: string) => { asked = String(u); return new Response('false', { status: 200 }); }) as typeof fetch;
  try {
    const res = await call({ method: 'POST', headers: { authorization: 'Bearer user-jwt' }, body: '{}' });
    assert.equal(res.status, 401);
    assert.match(asked, /rpc\/dr_is_admin$/);
  } finally { globalThis.fetch = realFetch; }
});

test('re-analyse is not available to the scheduler secret', async () => {
  const res = await call({ method: 'POST', headers: { 'x-collector-secret': 'cron-secret', 'content-type': 'application/json' }, body: '{"action":"reanalyse"}' });
  assert.equal(res.status, 403);
});
