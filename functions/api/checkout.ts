// POST /api/checkout — verifies the Supabase session, then creates a Dodo hosted checkout.
interface Env {
  DODO_API_KEY: string;
  DODO_ENV?: string; // "live" for production; anything else = test
  PID_STARTER: string;
  PID_PRO: string;
  PID_BUSINESS: string;
}

const SB_URL = 'https://wgoiukbgrdyjvfpqaipp.supabase.co';
const SB_KEY = 'sb_publishable_B4fokBi_LoR1Pe8o39kTQA_REnB2KbK';

export const onRequestPost = async ({ request, env }: { request: Request; env: Env }) => {
  const json = (o: unknown, s = 200) =>
    new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json' } });

  const token = (request.headers.get('Authorization') || '').replace(/^Bearer /, '');
  if (!token) return json({ error: 'Sign in first' }, 401);
  const u = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${token}` } });
  if (!u.ok) return json({ error: 'Invalid session' }, 401);
  const user: any = await u.json();

  const { plan }: any = await request.json().catch(() => ({}));
  const pid = ({ Starter: env.PID_STARTER, Pro: env.PID_PRO, Business: env.PID_BUSINESS } as Record<string, string>)[plan];
  if (!pid) return json({ error: 'Unknown plan' }, 400);

  const base = env.DODO_ENV === 'live' ? 'https://live.dodopayments.com' : 'https://test.dodopayments.com';
  const r = await fetch(`${base}/checkouts`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.DODO_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      product_cart: [{ product_id: pid, quantity: 1 }],
      customer: { email: user.email },
      metadata: { user_id: user.id, plan },
      return_url: `${new URL(request.url).origin}/?checkout=success`,
    }),
  });
  const d: any = await r.json().catch(() => ({}));
  if (!r.ok || !d.checkout_url) return json({ error: 'Checkout failed', detail: d }, 502);
  return json({ checkout_url: d.checkout_url });
};
