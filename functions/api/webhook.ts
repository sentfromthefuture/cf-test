// POST /api/webhook — Dodo (Standard Webhooks) -> verified, idempotent plan updates in Supabase.
interface Env {
  DODO_WEBHOOK_KEY: string;
  SUPABASE_SERVICE_KEY: string;
  PID_STARTER: string;
  PID_PRO: string;
  PID_BUSINESS: string;
}

const SB_URL = 'https://wgoiukbgrdyjvfpqaipp.supabase.co';
const b64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function verify(secret: string, id: string, ts: string, sigHeader: string, body: string) {
  if (!id || !ts || !sigHeader || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const key = await crypto.subtle.importKey('raw', b64(secret.replace(/^whsec_/, '')), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify']);
  const data = new TextEncoder().encode(`${id}.${ts}.${body}`);
  for (const part of sigHeader.split(' ')) {
    const sig = part.split(',')[1];
    try {
      if (sig && (await crypto.subtle.verify('HMAC', key, b64(sig), data))) return true;
    } catch {}
  }
  return false;
}

export const onRequestPost = async ({ request, env }: { request: Request; env: Env }) => {
  const body = await request.text();
  const id = request.headers.get('webhook-id') || '';
  const ok = await verify(env.DODO_WEBHOOK_KEY, id, request.headers.get('webhook-timestamp') || '', request.headers.get('webhook-signature') || '', body);
  if (!ok) return new Response('bad signature', { status: 401 });

  const evt: any = JSON.parse(body);
  const d = evt.data || {};
  const sb = (path: string, init: RequestInit & { headers?: Record<string, string> }) =>
    fetch(`${SB_URL}/rest/v1/${path}`, {
      ...init,
      headers: { apikey: env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json', ...init.headers },
    });

  // Idempotency: a repeated delivery hits the primary key and is skipped.
  const ins = await sb('webhook_events', { method: 'POST', body: JSON.stringify({ event_id: id, type: evt.type }), headers: { Prefer: 'return=minimal' } });
  if (ins.status === 409) return new Response('duplicate');
  if (!ins.ok) return new Response('db error', { status: 500 });

  const eventStatus: Record<string, string> = {
    'subscription.active': 'active',
    'subscription.renewed': 'active',
    'subscription.on_hold': 'on_hold',
    'subscription.paused': 'paused',
    'subscription.cancelled': 'cancelled',
    'subscription.failed': 'failed',
    'subscription.expired': 'expired',
  };
  const userId = typeof d.metadata?.user_id === 'string' ? d.metadata.user_id : '';
  const validUserId = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId);

  if (String(evt.type).startsWith('subscription.') && validUserId) {
    const plan = ({ [env.PID_STARTER]: 'Starter', [env.PID_PRO]: 'Pro', [env.PID_BUSINESS]: 'Business' } as Record<string, string>)[d.product_id];
    const status = typeof d.status === 'string' && d.status ? d.status : eventStatus[evt.type];
    if (plan && status) {
      const subscriptionUpdate: Record<string, unknown> = {
        user_id: userId,
        plan,
        status,
        updated_at: new Date().toISOString(),
      };
      // Do not erase previously linked identifiers or period dates when an event omits them.
      if (typeof d.customer?.customer_id === 'string') subscriptionUpdate.dodo_customer_id = d.customer.customer_id;
      if (typeof d.subscription_id === 'string') subscriptionUpdate.dodo_subscription_id = d.subscription_id;
      const periodEnd = d.next_billing_date ?? d.expires_at ?? d.current_period_end;
      if (typeof periodEnd === 'string') subscriptionUpdate.current_period_end = periodEnd;

      const up = await sb('subscriptions?on_conflict=user_id', {
        method: 'POST',
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: JSON.stringify(subscriptionUpdate),
      });
      if (!up.ok) {
        // Un-mark the event so Dodo's retry is processed instead of skipped.
        await sb(`webhook_events?event_id=eq.${encodeURIComponent(id)}`, { method: 'DELETE' });
        return new Response('db error', { status: 500 });
      }
    }
  }
  return new Response('ok');
};
