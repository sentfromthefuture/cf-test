// GET /api/account — authenticated account, subscription and daily AI usage snapshot.
interface Env { SUPABASE_SERVICE_KEY: string; }
const SB_URL = 'https://wgoiukbgrdyjvfpqaipp.supabase.co';
const SB_KEY = 'sb_publishable_B4fokBi_LoR1Pe8o39kTQA_REnB2KbK';
const LIMITS: Record<string, number> = { Pro: 5, Business: 20 };

export const onRequestGet = async ({ request, env }: { request: Request; env: Env }) => {
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'Sign in to view account details.' }, 401);

  const auth = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${token}` },
  });
  if (!auth.ok) return json({ error: 'Session expired. Please sign in again.' }, 401);
  const user: any = await auth.json();
  const serviceHeaders = {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
  };

  const today = new Date().toISOString().slice(0, 10);
  const [subResponse, usageResponse] = await Promise.all([
    fetch(`${SB_URL}/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(user.id)}&select=plan,status,current_period_end,dodo_customer_id&limit=1`, { headers: serviceHeaders }),
    fetch(`${SB_URL}/rest/v1/ai_usage?user_id=eq.${encodeURIComponent(user.id)}&day=eq.${today}&select=count&limit=1`, { headers: serviceHeaders }),
  ]);
  if (!subResponse.ok || !usageResponse.ok) return json({ error: 'Account details are temporarily unavailable.' }, 503);

  const subscriptions: any[] = await subResponse.json();
  const usageRows: any[] = await usageResponse.json();
  const sub = subscriptions[0] ?? null;
  const periodEnd = sub?.current_period_end ?? null;
  const live = !!sub && (sub.status === 'active' ||
    (sub.status === 'cancelled' && periodEnd && new Date(periodEnd).getTime() > Date.now()));
  const plan = live && LIMITS[sub.plan] ? sub.plan : 'Free';
  const limit = LIMITS[plan] ?? 0;
  const used = Math.max(0, Number(usageRows[0]?.count ?? 0));
  const nextReset = new Date();
  nextReset.setUTCHours(24, 0, 0, 0);

  return json({
    email: user.email ?? '',
    plan,
    status: sub?.status ?? 'inactive',
    periodEnd,
    hasBillingCustomer: !!sub?.dodo_customer_id,
    usage: { used, limit, remaining: Math.max(0, limit - used), resetAt: nextReset.toISOString(), timezone: 'UTC' },
  });
};
