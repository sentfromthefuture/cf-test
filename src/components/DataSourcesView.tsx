import React, { useState } from 'react';
import { Database, RefreshCw, Sparkles, ShieldAlert, ExternalLink, CheckCircle2, XCircle, PauseCircle, Ban, Loader2, AlertTriangle } from 'lucide-react';
import { adminSetSource, SourceInfo, timeAgo, triggerSync } from '../lib/liveData';
import type { LiveStatus } from '../App';
import { AiSmokeTestPanel } from './AiSmokeTestPanel';

interface Props {
  sources: SourceInfo[];
  status: LiveStatus;
  isAdmin: boolean;
  signedIn: boolean;
  onRefresh: () => Promise<void> | void;
  onOpenAuth: () => void;
}

const STATUS_STYLE: Record<string, { label: string; cls: string; Icon: React.ElementType }> = {
  idle: { label: 'Enabled', cls: 'text-emerald-300 border-emerald-800 bg-emerald-950/40', Icon: CheckCircle2 },
  running: { label: 'Running', cls: 'text-cyan-300 border-cyan-800 bg-cyan-950/40', Icon: Loader2 },
  error: { label: 'Error', cls: 'text-rose-300 border-rose-800 bg-rose-950/40', Icon: XCircle },
  stalled: { label: 'Stalled (no heartbeat)', cls: 'text-amber-300 border-amber-800 bg-amber-950/40', Icon: AlertTriangle },
  disabled: { label: 'Disabled', cls: 'text-slate-400 border-slate-700 bg-slate-900', Icon: PauseCircle },
  unavailable: { label: 'Not connected', cls: 'text-slate-400 border-slate-700 bg-slate-900', Icon: Ban },
};

const num = (n: number) => n.toLocaleString();

export const DataSourcesView: React.FC<Props> = ({ sources, status, isAdmin, signedIn, onRefresh, onOpenAuth }) => {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const act = async (key: string, fn: () => Promise<string | void>) => {
    setBusy(key);
    setMessage(null);
    try {
      const text = await fn();
      if (text) setMessage({ ok: true, text });
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
      await onRefresh();
    }
  };

  const sync = (id?: string) =>
    act(`sync:${id ?? 'all'}`, async () => {
      const r = await triggerSync(id);
      const parts = r.sources.map((s) => `${s.id}: ${s.status} (+${s.stats.inserted} new, ${s.stats.duplicates} duplicates${s.error ? `, ${s.error}` : ''})`);
      if (r.analysis) {
        const a = r.analysis;
        parts.push(`analysis (${a.method === 'llm' ? 'AI' : 'keyword fallback'}): ${a.analysed} analysed, ${a.problems} problems, ${a.skipped} skipped, ${a.failed} failed, ${a.clustered} clustered, ${a.summaries} summaries${a.note ? ` — ${a.note}` : ''}`);
      }
      return parts.length ? parts.join(' · ') : 'No source was due or available to run (locked, disabled, or already running).';
    });

  const reanalyse = () =>
    act('reanalyse', async () => {
      const r = await triggerSync(undefined, 'reanalyse');
      const a = r.analysis;
      return `Re-queued ${r.requeued ?? 0} keyword-analysed records. ` + (a ? `This pass: ${a.analysed} analysed (${a.method === 'llm' ? 'AI' : 'keyword fallback'}), ${a.problems} problems, ${a.failed} failed, ${a.clustered} clustered, ${a.summaries} summaries${a.note ? ` — ${a.note}` : ''}. Tap again to continue while records remain pending.` : '');
    });

  const implemented = sources.filter((s) => s.availability === 'implemented');
  const skipped = sources.filter((s) => s.availability === 'skipped');

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-white flex items-center gap-2"><Database className="h-5 w-5 text-cyan-400" /> Data Sources</h1>
          <p className="text-xs text-slate-400 mt-1 max-w-2xl">
            Only official public APIs are used. Every figure here comes from the collection database; a source is shown as connected only if it has actually run.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isAdmin ? (
            <button
              disabled={!!busy}
              onClick={() => sync()}
              className="flex items-center gap-1.5 rounded-lg bg-cyan-600 px-3 py-2 text-xs font-bold text-white hover:bg-cyan-500 disabled:opacity-50 cursor-pointer"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${busy === 'sync:all' ? 'animate-spin' : ''}`} /> Sync all due sources
            </button>
          ) : null}
          {isAdmin ? (
            <button
              disabled={!!busy}
              onClick={reanalyse}
              title="Re-run analysis for records classified by the keyword fallback, using AI if a key is configured"
              className="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-semibold text-slate-100 hover:bg-slate-700 disabled:opacity-50 cursor-pointer"
            >
              {busy === 'reanalyse' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Sparkles className="h-3.5 w-3.5 text-cyan-300" />} Re-analyse / process queue
            </button>
          ) : (
            <button onClick={signedIn ? undefined : onOpenAuth} className="text-[11px] text-slate-500 border border-slate-800 rounded-lg px-3 py-2 cursor-pointer">
              {signedIn ? 'Source controls are limited to administrators' : 'Sign in as an administrator to manage sources'}
            </button>
          )}
        </div>
      </div>

      {status === 'unavailable' && (
        <div className="rounded-xl border border-amber-800/60 bg-amber-950/20 p-4 text-xs text-amber-200 flex gap-3">
          <ShieldAlert className="h-4 w-4 shrink-0 mt-0.5" />
          <div>
            <p className="font-semibold">The collection backend is not reachable.</p>
            <p className="text-amber-300/80 mt-1">Apply the migrations in <code>supabase/migrations</code> and deploy the <code>collect</code> Edge Function (see docs/DATA_COLLECTION.md). Nothing below is being collected until then.</p>
          </div>
        </div>
      )}

      {message && (
        <div className={`rounded-lg border px-3 py-2 text-xs ${message.ok ? 'border-emerald-800 bg-emerald-950/30 text-emerald-200' : 'border-rose-800 bg-rose-950/30 text-rose-200'}`}>{message.text}</div>
      )}

      {isAdmin && <AiSmokeTestPanel />}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {implemented.map((s) => {
          const st = STATUS_STYLE[s.status] ?? STATUS_STYLE.idle;
          const quotaPct = s.quota_limit && s.quota_remaining !== null ? Math.max(0, Math.min(100, (s.quota_remaining / s.quota_limit) * 100)) : null;
          const never = !s.last_success_at;
          return (
            <div key={s.id} className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 space-y-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-sm font-bold text-white">{s.name}</h2>
                  <p className="text-[11px] text-slate-400 mt-0.5">{s.description}</p>
                </div>
                <span className={`flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-mono whitespace-nowrap ${st.cls}`}>
                  <st.Icon className={`h-3 w-3 ${s.status === 'running' ? 'animate-spin' : ''}`} /> {st.label}
                </span>
              </div>

              <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-[11px]">
                <div><dt className="text-slate-500">Records collected</dt><dd className="font-mono text-white text-sm">{num(s.records_total)}</dd></div>
                <div><dt className="text-slate-500">Last successful sync</dt><dd className="font-mono text-slate-200">{never ? 'never' : timeAgo(s.last_success_at)}</dd></div>
                <div><dt className="text-slate-500">Next scheduled run</dt><dd className="font-mono text-slate-200">{s.enabled ? (s.next_run_at ? timeAgo(s.next_run_at) : 'when scheduler runs') : '—'}</dd></div>
                <div><dt className="text-slate-500">Interval</dt><dd className="font-mono text-slate-200">{s.interval_minutes >= 60 ? `${s.interval_minutes / 60}h` : `${s.interval_minutes}m`}</dd></div>
                <div><dt className="text-slate-500">API requests today</dt><dd className="font-mono text-slate-200">{s.requests_today} <span className="text-slate-500">({s.errors_today} errors, {s.rate_limited_today} rate-limited)</span></dd></div>
                <div>
                  <dt className="text-slate-500">Upstream quota</dt>
                  <dd className="font-mono text-slate-200">
                    {s.quota_limit === null ? 'not reported yet' : `${s.quota_remaining ?? '?'} / ${s.quota_limit}`}
                    {quotaPct !== null && <div className="mt-1 h-1 rounded bg-slate-800"><div className="h-1 rounded bg-cyan-500" style={{ width: `${quotaPct}%` }} /></div>}
                  </dd>
                </div>
              </dl>

              {s.last_run && (
                <p className="text-[11px] text-slate-400 font-mono border-t border-slate-800 pt-3">
                  Last run ({s.last_run.trigger}): {s.last_run.status} · fetched {s.last_run.fetched} · {s.last_run.inserted} new · {s.last_run.duplicates} duplicates · {s.last_run.errors} errors
                </p>
              )}
              {never && s.enabled && <p className="text-[11px] text-amber-300/90">Enabled but has never completed a sync. Collection starts when the scheduler is activated or an administrator runs a manual sync.</p>}
              {s.last_error && <p className="text-[11px] text-rose-300 break-words"><AlertTriangle className="inline h-3 w-3 mr-1" />{s.last_error}</p>}
              {s.license_note && <p className="text-[10px] text-slate-500 leading-snug">Licence/usage: {s.license_note}</p>}

              {isAdmin && (
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <button
                    disabled={!!busy || !s.enabled}
                    onClick={() => sync(s.id)}
                    className="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-2.5 py-1.5 text-[11px] text-slate-100 hover:bg-slate-700 disabled:opacity-40 cursor-pointer"
                  >
                    <RefreshCw className={`h-3 w-3 ${busy === `sync:${s.id}` ? 'animate-spin' : ''}`} /> Sync now
                  </button>
                  <button
                    disabled={!!busy}
                    onClick={() => act(`toggle:${s.id}`, () => adminSetSource(s.id, !s.enabled).then(() => undefined))}
                    className="rounded-lg border border-slate-700 px-2.5 py-1.5 text-[11px] text-slate-300 hover:bg-slate-800 disabled:opacity-40 cursor-pointer"
                  >
                    {s.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <select
                    disabled={!!busy}
                    value={s.interval_minutes}
                    onChange={(e) => act(`interval:${s.id}`, () => adminSetSource(s.id, undefined, Number(e.target.value)).then(() => undefined))}
                    className="rounded-lg border border-slate-700 bg-slate-900 px-2 py-1.5 text-[11px] text-slate-300"
                  >
                    {[15, 30, 60, 120, 180, 360, 720, 1440].map((m) => <option key={m} value={m}>every {m >= 60 ? `${m / 60}h` : `${m}m`}</option>)}
                  </select>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="space-y-3">
        <h2 className="text-sm font-bold text-white">Not connected — and why</h2>
        <p className="text-xs text-slate-400 max-w-3xl">These sources are deliberately not collected. No scraping or workaround is used; each needs the access described below first.</p>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {skipped.map((s) => (
            <div key={s.id} className="rounded-2xl border border-slate-800/80 bg-slate-950/60 p-5 space-y-2 text-[11px]">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold text-slate-200">{s.name}</h3>
                <span className="flex items-center gap-1 rounded-full border border-slate-700 bg-slate-900 px-2 py-0.5 text-[10px] font-mono text-slate-400"><Ban className="h-3 w-3" /> Not connected</span>
              </div>
              <p className="text-slate-300"><span className="text-slate-500">Why skipped: </span>{s.skip_reason}</p>
              <p className="text-slate-300"><span className="text-slate-500">Access restriction: </span>{s.access_restriction}</p>
              <p className="text-slate-300"><span className="text-slate-500">Official API exists: </span>{s.official_api ? 'Yes' : 'No'}</p>
              <p className="text-slate-300"><span className="text-slate-500">To integrate legally: </span>{s.integration_requirements}</p>
              {s.docs_url && <a href={s.docs_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-cyan-400 hover:text-cyan-300">Official documentation <ExternalLink className="h-3 w-3" /></a>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
