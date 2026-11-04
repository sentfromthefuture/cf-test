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
}

const input = 'w-full rounded-lg bg-slate-900 border border-slate-700 px-3 py-2 text-sm text-slate-100 outline-none focus:border-cyan-500';
const btn = 'w-full py-2.5 rounded-lg text-sm font-bold cursor-pointer disabled:opacity-50';

export const PaymentModal: React.FC<PaymentModalProps> = ({ isOpen, onClose, selectedTier, authOnly }) => {
  const [session, setSession] = useState<Session | null>(null);
  const [mode, setMode] = useState<'signin' | 'signup'>('signup');
  const [email, setEmail] = useState('');
  const [email2, setEmail2] = useState('');
  const [password, setPassword] = useState('');
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
            <p className="text-xs text-slate-400">Signed in as {session.user.email}</p>
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
              {mode === 'signup' ? 'Create an account to keep your subscription.' : 'Sign in to your account.'}
            </p>
            <input className={input} type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
            {mode === 'signup' && <input className={input} type="email" placeholder="Re-enter email" value={email2} onChange={(e) => setEmail2(e.target.value)} />}
            <input className={input} type="password" placeholder="Password (6+ characters)" value={password} onChange={(e) => setPassword(e.target.value)} />
            <button onClick={submitAuth} disabled={busy || !email || !password} className={`${btn} bg-cyan-500 text-slate-950 hover:bg-cyan-400`}>
              {busy ? 'Please wait…' : mode === 'signup' ? 'Create account' : 'Sign in'}
            </button>
            <button onClick={() => { setMode(mode === 'signup' ? 'signin' : 'signup'); setErr(''); }} className="w-full text-center text-xs text-slate-400 underline cursor-pointer">
              {mode === 'signup' ? 'Already have an account? Sign in' : 'New here? Create an account'}
            </button>
          </>
        )}

        {err && <p className="text-xs text-rose-400">{err}</p>}
        <p className="flex items-center gap-1.5 text-[10px] text-slate-500"><ShieldCheck size={12} /> Payments are handled by Dodo Payments. We never see your card.</p>
      </div>
    </div>
  );
};
