import React, { useEffect, useState } from 'react';
import { X, Lock, ShieldCheck } from 'lucide-react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { PricingTier } from '../types';

interface PaymentModalProps {
  isOpen: boolean;
  onClose: () => void;
  selectedTier: PricingTier;
  authOnly?: boolean;
  activePlan?: PricingTier;
  onOpenPricing?: () => void;
}

const input = 'w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-500';
const btn = 'w-full py-2.5 rounded-lg text-sm font-bold cursor-pointer disabled:opacity-50';

export const PaymentModal: React.FC<PaymentModalProps> = ({ isOpen, onClose, selectedTier, authOnly, activePlan = 'Free', onOpenPricing }) => {
  const [session, setSession] = useState<Session | null>(null);
  const [mode, setMode] = useState<'signin' | 'signup' | 'reset'>('signup');
  const [email, setEmail] = useState('');
  const [email2, setEmail2] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session));
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => data.subscription.unsubscribe();
  }, []);

  if (!isOpen) return null;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr('');
    try { await fn(); } catch (e: any) { setErr(e.message || 'Something went wrong'); }
    setBusy(false);
  };

  const submitAuth = () => run(async () => {
    if (mode === 'signup') {
      if (email.trim().toLowerCase() !== email2.trim().toLowerCase()) throw new Error('The two emails do not match');
      const { data, error } = await supabase.auth.signUp({ email: email.trim(), password });
      if (error) throw error;
      if (!data.session) throw new Error('Check your inbox to confirm your email, then sign in.');
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (error) throw error;
    }
  });

  const sendReset = () => run(async () => {
    if (!email.trim()) throw new Error('Enter your account email first.');
    const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: window.location.origin });
    if (error) throw error;
    setErr('Password reset email sent. Follow its link, then return here to set a new password.');
  });

  const changePassword = () => run(async () => {
    if (newPassword.length < 8) throw new Error('Use at least 8 characters for your new password.');
    const { error } = await supabase.auth.updateUser({ password: newPassword });
    if (error) throw error;
    setNewPassword('');
    setErr('Password updated successfully.');
  });

  const pay = () => run(async () => {
    const res = await fetch('/api/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session!.access_token}` },
      body: JSON.stringify({ plan: selectedTier }),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.checkout_url) throw new Error(j.error || 'Checkout failed');
    window.location.href = j.checkout_url;
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
      <div className="relative w-full max-w-sm rounded-xl border border-slate-800 bg-slate-950 p-5 space-y-3">
        <button onClick={onClose} className="absolute right-3 top-3 text-slate-500 hover:text-slate-200 cursor-pointer"><X size={16} /></button>
        <h2 className="text-base font-bold text-white">
          {authOnly ? (session ? 'Account' : 'Sign in') : `Subscribe to ${selectedTier}`}
        </h2>

        {session ? (
          <>
            <div className="rounded-xl border border-slate-800 bg-slate-900/70 p-3 space-y-2">
              <div>
                <span className="block text-[10px] uppercase tracking-wider text-slate-500">Signed in as</span>
                <span className="text-xs text-slate-200">{session.user.email}</span>
              </div>
              {authOnly && (
                <>
                  <div className="border-t border-slate-800 pt-2">
                    <span className="block text-[10px] uppercase tracking-wider text-slate-500">Current plan</span>
                    <span className="text-sm font-semibold text-white">{activePlan}</span>
                  </div>
                  {onOpenPricing && <button onClick={onOpenPricing} className="text-xs font-semibold text-slate-200 underline underline-offset-4">View plans</button>}
                </>
              )}
            </div>
            {authOnly && <>
              <div className="border-t border-slate-800 pt-3 space-y-2">
                <label className="block text-[10px] uppercase tracking-wider text-slate-500" htmlFor="new-account-password">Change password</label>
                <input id="new-account-password" className={input} type="password" autoComplete="new-password" placeholder="New password (8+ characters)" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
                <button onClick={changePassword} disabled={busy || newPassword.length < 8} className={`${btn} bg-slate-800 text-slate-200 hover:bg-slate-700`}>Update password</button>
              </div>
              <p className="text-[10px] leading-5 text-slate-500">Billing is processed by Dodo Payments. In-app billing management and cancellation controls are not currently available; contact support through the payment provider receipt for billing assistance.</p>
            </>}
            {!authOnly && (
              <button onClick={pay} disabled={busy} className={`${btn} bg-cyan-500 text-slate-950 hover:bg-cyan-400 flex items-center justify-center gap-2`}>
                <Lock size={14} /> {busy ? 'Opening checkout…' : 'Continue to secure checkout'}
              </button>
            )}
            <button onClick={() => supabase.auth.signOut()} className={`${btn} bg-slate-800 text-slate-200 hover:bg-slate-700`}>Sign out</button>
          </>
        ) : (
          <>
            <p className="text-xs text-slate-400">
              {mode === 'signup' ? 'Create an account to keep your subscription.' : mode === 'reset' ? 'We will email you a secure password-reset link.' : 'Sign in to your account.'}
            </p>
            <input className={input} type="email" autoComplete="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
            {mode === 'signup' && <input className={input} type="email" autoComplete="email" placeholder="Re-enter email" value={email2} onChange={(e) => setEmail2(e.target.value)} />}
            {mode !== 'reset' && <input className={input} type="password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'} placeholder="Password (6+ characters)" value={password} onChange={(e) => setPassword(e.target.value)} />}
            {mode === 'reset' ? (
              <button onClick={sendReset} disabled={busy || !email} className={`${btn} bg-cyan-500 text-slate-950 hover:bg-cyan-400`}>{busy ? 'Sending…' : 'Send reset link'}</button>
            ) : (
              <button onClick={submitAuth} disabled={busy || !email || !password} className={`${btn} bg-cyan-500 text-slate-950 hover:bg-cyan-400`}>{busy ? 'Please wait…' : mode === 'signup' ? 'Create account' : 'Sign in'}</button>
            )}
            {mode === 'signin' && <button onClick={() => { setMode('reset'); setErr(''); }} className="w-full text-center text-xs text-slate-400 underline cursor-pointer">Forgot password?</button>}
            <button onClick={() => { setMode(mode === 'signup' ? 'signin' : mode === 'signin' ? 'signup' : 'signin'); setErr(''); }} className="w-full text-center text-xs text-slate-400 underline cursor-pointer">
              {mode === 'signup' ? 'Already have an account? Sign in' : mode === 'signin' ? 'New here? Create an account' : 'Back to sign in'}
            </button>
          </>
        )}

        {err && <p className="text-xs text-rose-400">{err}</p>}
        <p className="flex items-center gap-1.5 text-[10px] text-slate-500"><ShieldCheck size={12} /> Payments are handled by Dodo Payments. We never see your card.</p>
      </div>
    </div>
  );
};
