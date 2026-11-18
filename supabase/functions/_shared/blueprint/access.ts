// Shared request-boundary rules for the Blueprint Edge Function.
// This module is pure: no Supabase, network, clock or provider access.
export type BlueprintPlan = 'Pro' | 'Business';

export interface SubscriptionRecord {
  plan: string;
  status: string;
  current_period_end: string | null;
}

export type AccessDecision =
  | { allowed: true; plan: BlueprintPlan }
  | { allowed: false; reason: 'missing_subscription' | 'inactive_subscription' | 'unsupported_plan' };

export function readBearerToken(header: string | null): string | null {
  if (!header) return null;
  const match = /^Bearer\s+([^\s]+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

/** Mirrors the existing subscription lifecycle rule, without inheriting Gemini PRD quotas. */
export function checkBlueprintEntitlement(
  subscription: SubscriptionRecord | null,
  nowMs: number,
): AccessDecision {
  if (!subscription) return { allowed: false, reason: 'missing_subscription' };
  const active = subscription.status === 'active';
  const cancelledButPaid = subscription.status === 'cancelled'
    && typeof subscription.current_period_end === 'string'
    && Number.isFinite(Date.parse(subscription.current_period_end))
    && Date.parse(subscription.current_period_end) > nowMs;
  if (!active && !cancelledButPaid) return { allowed: false, reason: 'inactive_subscription' };
  if (subscription.plan !== 'Pro' && subscription.plan !== 'Business') {
    return { allowed: false, reason: 'unsupported_plan' };
  }
  return { allowed: true, plan: subscription.plan };
}

/**
 * Quotas are supplied by explicit server configuration; no proposed product limit is silently made authoritative here.
 * A missing, fractional, zero or unsafe limit disables new Blueprint generation.
 */
export function readDailyBlueprintLimit(value: string | undefined): number | null {
  if (!value || !/^[1-9][0-9]*$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) ? n : null;
}
