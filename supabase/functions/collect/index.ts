// Supabase Edge Function: DemandRadar collection engine entry point.
//
// Invoked by (a) pg_cron/pg_net on a schedule with header `x-collector-secret`, or
//            (b) an admin's browser with their Supabase JWT (manual sync).
// Secrets live only in Edge Function environment variables:
//   SUPABASE_URL, SUPABASE_SERVICE_KEY (or the auto-provided SUPABASE_SERVICE_ROLE_KEY), COLLECTOR_SECRET,
//   optional: GITHUB_TOKEN, STACKEXCHANGE_KEY, GEMINI_API_KEY (+ GEMINI_MODEL, GEMINI_EMBEDDING_MODEL), AUTHOR_HASH_SALT.
//   optional AI engines (both OFF by default, free models only; see docs/AI_ARCHITECTURE.md): OPENROUTER_API_KEY, DECISIONS_ENABLED (+ DECISIONS_MODEL, DECISIONS_MAX_PER_RUN,
//   DECISIONS_MIN_PROBLEM_PROBABILITY, DECISIONS_MIN_INTERVAL_MS), OPENROUTER_ENABLED (+ OPENROUTER_MODEL, OPENROUTER_MAX_SUMMARIES_PER_RUN), AI_CACHE_VERSION.
import { runAiSmokeTest, runAnalysisTest, runCollection, SupabaseStore } from '../_shared/collector/index.ts';

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

/** The ONLY actions this function understands. Anything else is rejected with 400 before any store or connector is touched.
 *  (A request with no action at all is the normal collection run used by cron and the manual sync button.) */
const ACTIONS = ['reanalyse', 'analysis_test', 'ai_smoke_test'] as const;
type Action = (typeof ACTIONS)[number];

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

  // Auth is checked first (above), so unauthenticated callers learn nothing about which actions exist.
  // A genuinely empty body is a normal collection run (cron sends '{}'), but a body that is present and unreadable is rejected:
  // silently treating a truncated '{"action":"analysis_test"' as '{}' would run a real collection instead of what was asked.
  let body: { source?: unknown; skipAnalysis?: unknown; action?: unknown } = {};
  const rawBody = await req.text().catch(() => null);
  if (rawBody === null) return json({ error: 'invalid request body' }, 400);
  if (rawBody.trim() !== '') {
    let parsed: unknown;
    try { parsed = JSON.parse(rawBody); } catch { return json({ error: 'invalid JSON body' }, 400); }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return json({ error: 'request body must be a JSON object' }, 400);
    body = parsed as typeof body;
  }
  const source = typeof body.source === 'string' && /^[a-z0-9_]{2,40}$/.test(body.source) ? body.source : null;

  // Strict allowlist. Only an absent/null action means "normal collection"; any other value - a typo, different casing, stray
  // whitespace, an empty string, 0/false, an object, 'constructor' - is a 400 and never reaches runCollection or a connector.
  let action: Action | null = null;
  if (body.action !== undefined && body.action !== null) {
    if (typeof body.action !== 'string' || !(ACTIONS as readonly string[]).includes(body.action)) {
      return json({ error: 'unknown action', supported: ACTIONS }, 400);
    }
    action = body.action as Action;
  }

  try {
    const store = new SupabaseStore(url, serviceKey);
    switch (action) {
      case 'analysis_test': {
        // Admin JWT only (never the schedule secret). Analysis-only smoke test, hard-capped at 10 pending records, heuristic-only.
        // Any other body field (source, skipAnalysis, a limit, ...) is deliberately ignored: this branch cannot be steered by the caller.
        if (trigger !== 'manual') return json({ error: 'forbidden' }, 403);
        return json(await runAnalysisTest({ store, budgetMs: 110_000 }));
      }
      case 'ai_smoke_test': {
        // Admin JWT only (never the schedule secret: this must not be schedulable). Tests Decisions Fast and the summary engine independently on at most 3
        // existing pending records, reusing the production adapters and cache; no retries, no record status changes. See docs/ai-smoke-test.md.
        // By this point the handler has already read and parsed the JSON body (a malformed body, or one that is not an object, got a 400
        // above) and used `action` to route here. Nothing else in it is used: `source`, `skipAnalysis` and any other field are ignored, and
        // only `store`, `env` and a fixed budget reach runAiSmokeTest, so the caller cannot steer the run (no limit, model or record ids).
        if (trigger !== 'manual') return json({ error: 'forbidden' }, 403);
        return json(await runAiSmokeTest({ store, env, budgetMs: 110_000 }));
      }
      case 'reanalyse': {
        // Admin only: re-queue keyword-analysed records so they are re-processed (with AI when a key is configured).
        if (trigger !== 'manual') return json({ error: 'forbidden' }, 403);
        const requeued = await store.requeueHeuristicAnalysis(5000);
        const report = await runCollection({ env, store, trigger, analysisOnly: true, budgetMs: 110_000 });
        return json({ ...report, requeued });
      }
      case null: {
        const report = await runCollection({ env, store, trigger, source, skipAnalysis: body.skipAnalysis === true, budgetMs: 110_000 });
        return json(report);
      }
      default: {
        // Compile-time guarantee: adding an action to ACTIONS without handling it here is a type error, and at runtime this
        // fails closed rather than falling through to a collection run.
        const unhandled: never = action;
        void unhandled;
        return json({ error: 'unknown action', supported: ACTIONS }, 400);
      }
    }
  } catch (e) {
    console.error('collection failed', (e as Error).message);
    return json({ error: 'collection failed', detail: (e as Error).message.slice(0, 200) }, 500);
  }
});
