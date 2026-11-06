import React, { useEffect, useState } from 'react';
import { Activity, ArrowUpRight, CalendarClock, CheckCircle2, CircleUserRound, CreditCard, Database, KeyRound, LogOut, ShieldCheck, Sparkles } from 'lucide-react';
import { supabase } from '../lib/supabase';
import { Overview, SourceInfo } from '../lib/liveData';
import { PricingTier } from '../types';

interface AccountViewProps {
  signedIn: boolean;
  activePlan: PricingTier;
  overview: Overview | null;
  sources: SourceInfo[];
  onSignIn: () => void;
  onOpenPricing: () => void;
  onOpenAuth: () => void;
}

const dateLabel = (value: string | null) => value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'long' }).format(new Date(value)) : 'Not provided by billing provider';

export const AccountView: React.FC<AccountViewProps> = ({ signedIn, activePlan, overview, sources, onSignIn, onOpenPricing, onOpenAuth }) => {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState('Not subscribed');
  const [periodEnd, setPeriodEnd] = useState<string | null>(null);
  const [loading, setLoading] = useState(signedIn);
  const [error, setError] = useState('');
  const [usage, setUsage] = useState<{ used: number; limit: number; remaining: number; resetAt: string } | null>(null);
  const [hasBillingCustomer, setHasBillingCustomer] = useState(false);
  const [portalLoading, setPortalLoading] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      if (!signedIn) { setLoading(false); return; }
      setLoading(true); setError('');
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData.session?.access_token;
      if (!token) { setLoading(false); return; }
      const response = await fetch('/api/account', { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' });
      if (!alive) return;
      if (!response.ok) {
        setError('Account and usage details could not be loaded. Please refresh and try again.');
      } else {
        const account: any = await response.json();
        setEmail(account.email ?? '');
        setStatus(account.status ?? 'unknown');
        setPeriodEnd(account.periodEnd ?? null);
        setUsage(account.usage ?? null);
        setHasBillingCustomer(!!account.hasBillingCustomer);
      }
      setLoading(false);
    };
    load();
    return () => { alive = false; };
  }, [signedIn]);

  const dailyBriefLimit = activePlan === 'Business' ? 20 : activePlan === 'Pro' ? 5 : 0;
  const openBillingPortal = async () => {
    const { data } = await supabase.auth.getSession();
    const token = data.session?.access_token;
    if (!token) { setError('Please sign in again to manage billing.'); return; }
    setPortalLoading(true); setError('');
    try {
      const response = await fetch('/api/customer-portal', { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      const result: any = await response.json();
      if (!response.ok || !result.url) throw new Error(result.error || 'Billing portal is unavailable.');
      window.location.assign(result.url);
    } catch (err: any) { setError(err.message || 'Could not open billing portal.'); setPortalLoading(false); }
  };
  const implemented = sources.filter((s) => s.availability === 'implemented').length;
  const enabled = sources.filter((s) => s.enabled).length;

  if (!signedIn) return <section className="mx-auto max-w-2xl rounded-2xl border border-slate-800 bg-[#111418] p-8 text-center">
    <CircleUserRound className="mx-auto mb-4 h-8 w-8 text-slate-300" />
    <h1 className="text-2xl font-semibold text-white">Your account</h1>
    <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-slate-400">Sign in to view your plan, account security and workspace status.</p>
    <button onClick={onSignIn} className="mt-6 rounded-xl bg-slate-100 px-5 py-3 text-sm font-semibold text-slate-950 hover:bg-white">Sign in or create account</button>
  </section>;

  return <div className="mx-auto max-w-5xl space-y-6">
    <header className="flex flex-col gap-2 border-b border-slate-800 pb-5 sm:flex-row sm:items-end sm:justify-between">
      <div><p className="text-[11px] font-semibold uppercase tracking-[.18em] text-slate-500">Workspace settings</p><h1 className="mt-1 text-2xl font-semibold tracking-tight text-white">Account & plan</h1><p className="mt-1 text-sm text-slate-400">Your identity, subscription and research workspace at a glance.</p></div>
      <button onClick={() => supabase.auth.signOut()} className="inline-flex items-center gap-2 self-start rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:bg-slate-900"><LogOut size={14}/> Sign out</button>
    </header>

    {error && <div role="status" className="rounded-xl border border-amber-800/60 bg-amber-950/20 px-4 py-3 text-xs text-amber-200">{error}</div>}
    <div className="grid gap-4 md:grid-cols-2">
      <section className="rounded-2xl border border-slate-800 bg-[#111418] p-5">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-400"><CircleUserRound size={15}/> Account identity</div>
        <div className="mt-5 text-[10px] uppercase tracking-wider text-slate-500">Signed in email</div>
        <div className="mt-1 break-all text-sm font-medium text-white">{email || 'Loading account…'}</div>
        <p className="mt-3 text-xs leading-5 text-slate-500">Email changes and verification are managed through Supabase Auth.</p>
        <button onClick={onOpenAuth} className="mt-4 inline-flex items-center gap-2 text-xs font-semibold text-slate-200 underline underline-offset-4"><KeyRound size={13}/> Password & security</button>
      </section>
      <section className="rounded-2xl border border-slate-800 bg-[#111418] p-5">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-400"><CreditCard size={15}/> Subscription</div>
        <div className="mt-4 flex items-center justify-between gap-3"><div><div className="text-2xl font-semibold text-white">{activePlan}</div><div className="mt-1 text-xs text-slate-500">{loading ? 'Checking subscription…' : status}</div></div><span className="rounded-full border border-slate-700 px-2.5 py-1 text-[10px] text-slate-300">{activePlan === 'Free' ? 'Free access' : 'Plan active'}</span></div>
        <div className="mt-4 flex items-start gap-2 border-t border-slate-800 pt-3 text-xs text-slate-400"><CalendarClock size={14} className="mt-0.5 shrink-0"/><span>Current period ends: {dateLabel(periodEnd)}</span></div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button onClick={onOpenPricing} className="inline-flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-900">Compare plans <ArrowUpRight size={13}/></button>
          {hasBillingCustomer && <button onClick={openBillingPortal} disabled={portalLoading} className="inline-flex items-center gap-2 rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-900 disabled:opacity-50">{portalLoading ? 'Opening billing…' : 'Manage billing'} <ArrowUpRight size={13}/></button>}
        </div>
        {!hasBillingCustomer && activePlan !== 'Free' && <p className="mt-3 text-[10px] leading-5 text-slate-500">Billing management will appear once the payment provider's customer record is linked.</p>}
      </section>
    </div>

    <section className="rounded-2xl border border-slate-800 bg-[#111418] p-5">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-400"><Activity size={15}/> Plan capabilities</div>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-4"><div className="text-xs text-slate-400">AI opportunity briefs</div><div className="mt-1 text-lg font-semibold text-white">{dailyBriefLimit ? `${usage?.remaining ?? '—'} of ${usage?.limit ?? dailyBriefLimit} remaining today` : 'Not included'}</div><p className="mt-1 text-[11px] leading-5 text-slate-500">{usage ? `${usage.used} used · resets at ${new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' }).format(new Date(usage.resetAt))}` : 'Daily allowance is verified by the server.'}</p></div>
        <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-4"><div className="text-xs text-slate-400">Research workspace</div><div className="mt-1 text-lg font-semibold text-white">{activePlan === 'Free' ? 'Top 3 dossiers' : 'Expanded access'}</div><p className="mt-1 text-[11px] leading-5 text-slate-500">Access is enforced by the application, not by a browser-selected plan value.</p></div>
      </div>
    </section>

    <section className="rounded-2xl border border-slate-800 bg-[#111418] p-5">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-400"><Database size={15}/> Research workspace status</div>
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div><div className="text-xl font-semibold tabular-nums text-white">{overview?.records_total.toLocaleString() ?? '—'}</div><div className="mt-1 text-[11px] text-slate-500">Collected records</div></div>
        <div><div className="text-xl font-semibold tabular-nums text-white">{overview?.clusters_total.toLocaleString() ?? '—'}</div><div className="mt-1 text-[11px] text-slate-500">Problem clusters</div></div>
        <div><div className="text-xl font-semibold tabular-nums text-white">{enabled}/{implemented}</div><div className="mt-1 text-[11px] text-slate-500">Sources enabled</div></div>
        <div><div className="text-xl font-semibold tabular-nums text-white">{overview?.pending_analysis.toLocaleString() ?? '—'}</div><div className="mt-1 text-[11px] text-slate-500">Awaiting analysis</div></div>
      </div>
      <p className="mt-4 flex items-start gap-2 border-t border-slate-800 pt-3 text-[11px] leading-5 text-slate-500"><ShieldCheck size={13} className="mt-0.5 shrink-0"/> These are shared research-system totals, not personal usage or account-owned data.</p>
    </section>
    <div className="flex items-center gap-2 text-[11px] text-slate-600"><CheckCircle2 size={13}/> Account security is handled by Supabase Auth. Payment processing is handled by Dodo Payments.</div>
  </div>;
};
