// Blueprint Edge Function boundary (B9).
// Authenticates and authorises the caller, then performs a read-only evidence-preparation check.
// Provider execution and quota reservation intentionally remain disabled until privacy review is cleared
// and the separate Blueprint quota migration has been applied to the hosted database.
import { TEAM_SIZE, BUDGET_BAND, PREFERRED_STACK, BUSINESS_MODEL_HINT, TARGET_REGION } from '../_shared/blueprint/constants.ts';
import { buildEvidenceInputFromRows } from '../_shared/blueprint/evidence-source.ts';
import { prepareEvidencePack } from '../_shared/blueprint/evidence.ts';
import { checkBlueprintEntitlement } from '../_shared/blueprint/access.ts';

declare const Deno: { env: { get(name: string): string | undefined }; serve(handler: (request: Request) => Response | Promise<Response>): void };

const PROVIDER_EXECUTION_ENABLED = false;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_LIST_BATCH = 100;
const PAGE_SIZE = 1000;

type JsonRecord = Record<string, unknown>;
type Params = {
  team_size: string;
  budget_band: string;
  preferred_stack: string;
  business_model_hint: string;
  target_region: string;
};

const cors = (req: Request): Record<string, string> => ({
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': req.headers.get('access-control-request-headers') || 'authorization, apikey, content-type, x-client-info',
  'access-control-max-age': '86400',
});
const reply = (req: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors(req), 'content-type': 'application/json' } });
const deny = (req: Request, error: string, status: number) => reply(req, { error }, status);

function isObject(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function isOneOf(value: unknown, values: readonly string[]): value is string {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}
function parseRequest(value: unknown): { clusterId: string; requestKey: string; params: Params } | null {
  if (!isObject(value) || !isObject(value.params)) return null;
  const p = value.params;
  if (typeof value.cluster_id !== 'string' || !UUID.test(value.cluster_id)) return null;
  if (typeof value.request_key !== 'string' || value.request_key.length < 8 || value.request_key.length > 128) return null;
  if (!isOneOf(p.team_size, TEAM_SIZE) || !isOneOf(p.budget_band, BUDGET_BAND)
    || !isOneOf(p.preferred_stack, PREFERRED_STACK) || !isOneOf(p.business_model_hint, BUSINESS_MODEL_HINT)
    || !isOneOf(p.target_region, TARGET_REGION)) return null;
  return {
    clusterId: value.cluster_id,
    requestKey: value.request_key,
    params: {
      team_size: p.team_size,
      budget_band: p.budget_band,
      preferred_stack: p.preferred_stack,
      business_model_hint: p.business_model_hint,
      target_region: p.target_region,
    },
  };
}

function config() {
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SERVICE_KEY');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') || Deno.env.get('SUPABASE_PUBLISHABLE_KEY');
  return url && serviceKey && anonKey ? { url: url.replace(/\/$/, ''), serviceKey, anonKey } : null;
}

async function authUser(url: string, anonKey: string, authorization: string): Promise<{ id: string } | null> {
  const response = await fetch(url + '/auth/v1/user', { headers: { apikey: anonKey, authorization } });
  if (!response.ok) return null;
  const user: unknown = await response.json();
  return isObject(user) && typeof user.id === 'string' && UUID.test(user.id) ? { id: user.id } : null;
}

function serviceHeaders(serviceKey: string) {
  return { apikey: serviceKey, authorization: 'Bearer ' + serviceKey, accept: 'application/json' };
}

async function restGet<T>(url: string, headers: Record<string, string>, range?: string): Promise<T> {
  const response = await fetch(url, { headers: { ...headers, ...(range ? { range } : {}) } });
  if (!response.ok) throw new Error('database_read_failed');
  return await response.json() as T;
}

async function loadClusterEvidence(url: string, serviceKey: string, clusterId: string) {
  const headers = serviceHeaders(serviceKey);
  const base = url + '/rest/v1/';
  const clusterQuery = new URLSearchParams({
    select: 'id,title,industry,unique_discussions,source_count,sources,recent_discussions,prior_discussions,growth_rate,severity_avg,wtp_signals,competitors,scores,confidence',
    id: 'eq.' + clusterId,
    limit: '2',
  });
  const clusters = await restGet<JsonRecord[]>(base + 'dr_clusters?' + clusterQuery, headers);
  if (clusters.length !== 1) return { ok: false as const, error: 'cluster_not_found' as const };

  const memberships: JsonRecord[] = [];
  for (let start = 0; ; start += PAGE_SIZE) {
    const q = new URLSearchParams({ select: 'cluster_id,record_id', cluster_id: 'eq.' + clusterId, order: 'record_id.asc', limit: String(PAGE_SIZE) });
    const page = await restGet<JsonRecord[]>(base + 'dr_cluster_members?' + q, headers, `${start}-${start + PAGE_SIZE - 1}`);
    memberships.push(...page);
    if (page.length < PAGE_SIZE) break;
    if (memberships.length >= 10_000) return { ok: false as const, error: 'cluster_too_large' as const };
  }

  const recordIds = memberships.map((m) => m.record_id).filter((id): id is string => typeof id === 'string');
  const records: JsonRecord[] = [];
  const signals: JsonRecord[] = [];
  for (let i = 0; i < recordIds.length; i += UUID_LIST_BATCH) {
    const ids = recordIds.slice(i, i + UUID_LIST_BATCH);
    const inList = 'in.(' + ids.join(',') + ')';
    const recordQuery = new URLSearchParams({
      select: 'id,source_id,discussion_key,kind,url,title,excerpt,published_at,engagement,license,attribution,content_hash',
      id: inList,
      order: 'id.asc',
      limit: String(UUID_LIST_BATCH),
    });
    const signalQuery = new URLSearchParams({
      select: 'record_id,is_problem,wtp_evidence,analysis_method',
      record_id: inList,
      order: 'record_id.asc',
      limit: String(UUID_LIST_BATCH),
    });
    const [recordRows, signalRows] = await Promise.all([
      restGet<JsonRecord[]>(base + 'dr_raw_records?' + recordQuery, headers),
      restGet<JsonRecord[]>(base + 'dr_problem_signals?' + signalQuery, headers),
    ]);
    records.push(...recordRows);
    signals.push(...signalRows);
  }
  return { ok: true as const, rows: { cluster: clusters[0], memberships, records, signals } };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
  if (req.method !== 'POST') return deny(req, 'method_not_allowed', 405);

  const cfg = config();
  if (!cfg) return deny(req, 'server_misconfigured', 503);
  const authorization = req.headers.get('authorization');
  if (!authorization || !/^Bearer\s+\S+$/i.test(authorization)) return deny(req, 'unauthorized', 401);

  const user = await authUser(cfg.url, cfg.anonKey, authorization).catch(() => null);
  if (!user) return deny(req, 'session_invalid', 401);

  let raw: unknown;
  try { raw = await req.json(); } catch { return deny(req, 'invalid_json', 400); }
  const input = parseRequest(raw);
  if (!input) return deny(req, 'invalid_request', 400);

  const subQuery = new URLSearchParams({
    select: 'plan,status,current_period_end',
    user_id: 'eq.' + user.id,
    limit: '2',
  });
  let subscriptions: JsonRecord[];
  try {
    subscriptions = await restGet<JsonRecord[]>(cfg.url + '/rest/v1/subscriptions?' + subQuery, serviceHeaders(cfg.serviceKey));
  } catch {
    return deny(req, 'subscription_check_unavailable', 503);
  }
  if (subscriptions.length > 1) return deny(req, 'subscription_record_ambiguous', 403);
  const sub = subscriptions[0];
  const entitlement = checkBlueprintEntitlement(
    sub && typeof sub.plan === 'string' && typeof sub.status === 'string'
      ? { plan: sub.plan, status: sub.status, current_period_end: typeof sub.current_period_end === 'string' ? sub.current_period_end : null }
      : null,
    Date.now(),
  );
  if (!entitlement.allowed) return deny(req, 'blueprint_requires_active_pro_or_business', 403);

  let loaded: Awaited<ReturnType<typeof loadClusterEvidence>>;
  try { loaded = await loadClusterEvidence(cfg.url, cfg.serviceKey, input.clusterId); }
  catch { return deny(req, 'research_read_failed', 503); }
  if (!loaded.ok) return deny(req, loaded.error, loaded.error === 'cluster_not_found' ? 404 : 422);

  const mapped = buildEvidenceInputFromRows(loaded.rows);
  if (!mapped.ok) return deny(req, 'research_evidence_invalid', 422);
  const prepared = prepareEvidencePack(mapped.input);
  if (!prepared.ok) return deny(req, 'research_evidence_invalid', 422);

  // This endpoint deliberately stops before reservation/provider execution. No excerpts are returned to the client.
  // The separate quota migration is not yet applied to the hosted DB, and privacy review has not cleared third-party text for ERNIE.
  if (!PROVIDER_EXECUTION_ENABLED) {
    return reply(req, {
      status: 'privacy_review_required',
      message: 'Blueprint evidence preparation is available; model generation is not enabled yet.',
      cluster_id: input.clusterId,
      request_key: input.requestKey,
      request_params: input.params,
      evidence: prepared.value.summary,
      sufficiency: prepared.value.sufficiency.level,
      entitlement: entitlement.plan,
      generation_enabled: false,
    }, 503);
  }
  return deny(req, 'blueprint_generation_disabled', 503);
});
