// Supabase Edge Function: DemandRadar collection engine entry point.
//
// Invoked by (a) pg_cron/pg_net on a schedule with header `x-collector-secret`, or
//            (b) an admin's browser with their Supabase JWT (manual sync).
// Secrets live only in Edge Function environment variables:
//   SUPABASE_URL, SUPABASE_SERVICE_KEY (or the auto-provided SUPABASE_SERVICE_ROLE_KEY), COLLECTOR_SECRET,
//   optional: GITHUB_TOKEN, STACKEXCHANGE_KEY, GEMINI_API_KEY (+ GEMINI_MODEL, GEMINI_EMBEDDING_MODEL), AUTHOR_HASH_SALT.
import { runCollection, SupabaseStore } from '../_shared/collector/index.ts';

declare const Deno: { env: { toObject(): Record<string, string> }; serve(h: (req: Request) => Response | Promise<Response>): void };

const env = Deno.env.toObject();

/** CORS: the browser (supabase-js) sends extra headers such as x-client-info, so we echo back whatever the preflight asks for.
 *  Safe here because callers authenticate with a bearer token / shared secret header, never cookies. */
const corsFor = (req: Request): Record<string, string> => ({
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': req.headers.get('access-control-request-headers') || 'authorization, x-client-info, apikey, content-type, x-collector-secret',
  'access-control-max-age': '86400',
});

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** Verifies the caller's JWT with Supabase Auth, then asks the database whether that user is an admin. */
async function isAdminUser(req: Request, supabaseUrl: string, anonKey: string): Promise<boolean> {
  const auth = req.headers.get('authorization');
  if (!auth?.toLowerCase().startsWith('bearer ')) return false;
  const res = await fetch(`${supabaseUrl}/rest/v1/rpc/dr_is_admin`, {
    method: 'POST',
    headers: { apikey: anonKey, authorization: auth, 'content-type': 'application/json' },
    body: '{}',
  });
  return res.ok && (await res.json()) === true;
}

Deno.serve(async (req) => {
  const cors = corsFor(req);
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
  if (req.method !== 'POST') return json({ error: 'method not allowed' }, 405);

  const url = env.SUPABASE_URL;
  const serviceKey = env.SUPABASE_SERVICE_KEY || env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return json({ error: 'server misconfigured: missing Supabase credentials' }, 500);

  let trigger: 'schedule' | 'manual' | null = null;
  const secret = req.headers.get('x-collector-secret');
  if (secret && env.COLLECTOR_SECRET && timingSafeEqual(secret, env.COLLECTOR_SECRET)) trigger = 'schedule';
  else if (await isAdminUser(req, url, env.SUPABASE_ANON_KEY || env.SUPABASE_PUBLISHABLE_KEY || '').catch(() => false)) trigger = 'manual';
  if (!trigger) return json({ error: 'unauthorized' }, 401);

  let body: { source?: unknown; skipAnalysis?: unknown } = {};
  try { body = await req.json(); } catch { /* empty body is fine */ }
  const source = typeof body.source === 'string' && /^[a-z0-9_]{2,40}$/.test(body.source) ? body.source : null;

  try {
    const report = await runCollection({ env, store: new SupabaseStore(url, serviceKey), trigger, source, skipAnalysis: body.skipAnalysis === true, budgetMs: 110_000 });
    return json(report);
  } catch (e) {
    console.error('collection failed', (e as Error).message);
    return json({ error: 'collection failed', detail: (e as Error).message.slice(0, 200) }, 500);
  }
});
