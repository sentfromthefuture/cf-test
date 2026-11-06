// POST /api/customer-portal — create a Dodo portal session for the authenticated user's own customer.
interface Env { SUPABASE_SERVICE_KEY: string; DODO_API_KEY: string; DODO_ENV?: string; }
const SB_URL = 'https://wgoiukbgrdyjvfpqaipp.supabase.co';
const SB_KEY = 'sb_publishable_B4fokBi_LoR1Pe8o39kTQA_REnB2KbK';

export const onRequestPost = async ({ request, env }: { request: Request; env: Env }) => {
  const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), {
    status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return json({ error: 'Sign in first.' }, 401);
  const auth = await fetch(`${SB_URL}/auth/v1/user`, {
    headers: { apikey: SB_KEY, Authorization: `Bearer ${token}` },
  });
  if (!auth.ok) return json({ error: 'Session expired. Please sign in again.' }, 401);
  const user: any = await auth.json();

  const headers = { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}` };
  const subResponse = await fetch(
    `${SB_URL}/rest/v1/subscriptions?user_id=eq.${encodeURIComponent(user.id)}&select=dodo_customer_id&limit=1`,
    { headers },
  );
  if (!subResponse.ok) return json({ error: 'Could not verify your billing account.' }, 503);
  const rows: any[] = await subResponse.json();
  const customerId = rows[0]?.dodo_customer_id;
  if (!customerId) return json({ error: 'No Dodo billing account is linked to this subscription yet.' }, 409);

  const base = env.DODO_ENV === 'live' ? 'https://live.dodopayments.com' : 'https://test.dodopayments.com';
  const returnUrl = new URL('/?tab=account', request.url).toString();
  const response = await fetch(
    `${base}/customers/${encodeURIComponent(customerId)}/customer-portal/session?return_url=${encodeURIComponent(returnUrl)}`,
    { method: 'POST', headers: { Authorization: `Bearer ${env.DODO_API_KEY}`, 'Content-Type': 'application/json' } },
  );
  const data: any = await response.json().catch(() => ({}));
  if (!response.ok || typeof data.link !== 'string') return json({ error: 'Dodo could not create a billing portal session.' }, 502);
  return json({ url: data.link });
};
