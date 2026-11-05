import React, { useMemo } from 'react';
import { Activity as ActivityIcon, ExternalLink, Sparkles, TrendingUp } from 'lucide-react';
import { Activity, ClusterRow, Overview, RecentSignal, SOURCE_LABELS, timeAgo } from '../lib/liveData';
import type { LiveStatus } from '../App';

interface Props {
  status: LiveStatus;
  overview: Overview | null;
  activity: Activity | null;
  recent: RecentSignal[];
  emerging: ClusterRow[];
  onOpenSources: () => void;
}

const COLORS: Record<string, string> = { github: 'bg-slate-300', hackernews: 'bg-orange-400', stackexchange: 'bg-sky-400' };
const label = (id: string) => SOURCE_LABELS[id] ?? id;

const Kpi = ({ title, value, hint }: { title: string; value: string; hint?: string }) => (
  <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
    <div className="text-xs text-slate-400">{title}</div>
    <div className="text-xl font-black font-mono text-white mt-1">{value}</div>
    {hint && <div className="text-[10px] text-slate-500 mt-1">{hint}</div>}
  </div>
);

export const ResearchActivityView: React.FC<Props> = ({ status, overview, activity, recent, emerging, onOpenSources }) => {
  const days = useMemo(() => {
    const map = new Map<string, Record<string, number>>();
    for (const r of activity?.daily ?? []) {
      const m = map.get(r.day) ?? {};
      m[r.source_id] = (m[r.source_id] ?? 0) + r.records;
      map.set(r.day, m);
    }
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, bySource]) => ({ day, bySource, total: Object.values(bySource).reduce((a, b) => a + b, 0) }));
  }, [activity]);
  const maxDay = Math.max(1, ...days.map((d) => d.total));
  const totalBySource = overview?.by_source ?? [];
  const maxSource = Math.max(1, ...totalBySource.map((s) => s.records));

  if (status !== 'ready' || !overview) {
    return (
      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-8 text-center space-y-3">
        <ActivityIcon className="h-8 w-8 text-slate-600 mx-auto" />
        <p className="text-sm text-slate-300">{status === 'loading' ? 'Loading research activity…' : 'No research activity to show: the collection backend is not reachable.'}</p>
        <button onClick={onOpenSources} className="text-xs text-cyan-400 hover:text-cyan-300 cursor-pointer">Open Data Sources →</button>
      </div>
    );
  }

  const delta = overview.records_prev_24h > 0 ? Math.round(((overview.records_24h - overview.records_prev_24h) / overview.records_prev_24h) * 100) : null;

  return (
    <div className="space-y-6 animate-fade-in">
      <div>
        <h1 className="text-xl font-bold text-white flex items-center gap-2"><ActivityIcon className="h-5 w-5 text-cyan-400" /> Research Activity</h1>
        <p className="text-xs text-slate-400 mt-1">Measured counts from the collection database. “Problem signals” are posts classified as a genuine complaint or unmet need; they are not demand by themselves.</p>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <Kpi title="Records collected" value={overview.records_total.toLocaleString()} hint={`last sync ${timeAgo(overview.last_collection_at)}`} />
        <Kpi title="Collected, last 24h" value={overview.records_24h.toLocaleString()} hint={delta === null ? 'no prior-day baseline' : `${delta >= 0 ? '+' : ''}${delta}% vs previous 24h`} />
        <Kpi title="Problem signals" value={overview.problems_total.toLocaleString()} hint={`${overview.problems_24h} found in last 24h`} />
        <Kpi title="Problem clusters" value={overview.clusters_total.toLocaleString()} hint="similar signals grouped" />
        <Kpi title="Cross-platform" value={overview.clusters_multi_source.toLocaleString()} hint="clusters seen on 2+ platforms" />
        <Kpi title="Awaiting analysis" value={overview.pending_analysis.toLocaleString()} hint="new or changed records" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 rounded-2xl border border-slate-800 bg-slate-900/60 p-5 space-y-3">
          <h2 className="text-sm font-bold text-white">Collection activity (records per day, last 14 days)</h2>
          {days.length === 0 ? (
            <p className="text-xs text-slate-500">Nothing collected in this window.</p>
          ) : (
            <div className="flex items-end gap-1.5 h-40">
              {days.map((d) => (
                <div key={d.day} className="flex-1 flex flex-col justify-end h-full group relative min-w-[10px]" title={`${d.day}: ${d.total}`}>
                  {Object.entries(d.bySource).map(([src, n]) => (
                    <div key={src} className={COLORS[src] ?? 'bg-cyan-400'} style={{ height: `${(n / maxDay) * 100}%` }} />
                  ))}
                  <span className="text-[9px] text-slate-500 text-center mt-1">{d.day.slice(5)}</span>
                </div>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-3 text-[10px] text-slate-400">
            {Object.keys(COLORS).map((k) => <span key={k} className="flex items-center gap-1"><span className={`h-2 w-2 rounded-sm ${COLORS[k]}`} />{label(k)}</span>)}
          </div>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 space-y-3">
          <h2 className="text-sm font-bold text-white">Source distribution (all time)</h2>
          {totalBySource.map((s) => (
            <div key={s.source_id} className="space-y-1">
              <div className="flex justify-between text-[11px] text-slate-300"><span>{s.name}</span><span className="font-mono">{s.records.toLocaleString()}</span></div>
              <div className="h-1.5 rounded bg-slate-800"><div className={`h-1.5 rounded ${COLORS[s.source_id] ?? 'bg-cyan-400'}`} style={{ width: `${(s.records / maxSource) * 100}%` }} /></div>
            </div>
          ))}
          {overview.industries.length > 0 && (
            <div className="pt-3 border-t border-slate-800 space-y-1">
              <h3 className="text-[11px] font-semibold text-slate-400">Industries (unique discussions)</h3>
              {overview.industries.slice(0, 6).map((i) => (
                <div key={i.industry} className="flex justify-between text-[11px] text-slate-300"><span className="truncate pr-2">{i.industry}</span><span className="font-mono">{i.unique_discussions}</span></div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 space-y-3">
          <h2 className="text-sm font-bold text-white flex items-center gap-2"><Sparkles className="h-4 w-4 text-cyan-400" /> Recent discoveries</h2>
          {recent.length === 0 && <p className="text-xs text-slate-500">No problem signals found yet.</p>}
          <ul className="space-y-3">
            {recent.slice(0, 10).map((r) => (
              <li key={r.record_id} className="text-xs border-b border-slate-800/70 pb-3 last:border-0">
                <div className="flex items-center gap-2 text-[10px] font-mono text-slate-400">
                  <span className="rounded bg-slate-800 px-1.5 py-0.5">{label(r.source_id)}</span>
                  <span>{r.signal_type.replace('_', ' ')}</span>
                  <span className={r.analysis_method === 'llm' ? 'text-amber-300' : 'text-slate-500'}>{r.analysis_method === 'llm' ? 'AI-classified' : 'keyword-matched'}</span>
                  <span className="ml-auto">{timeAgo(r.analyzed_at)}</span>
                </div>
                <p className="text-slate-100 mt-1">{r.problem_statement ?? r.title}</p>
                <a href={r.url} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1 text-[11px] text-cyan-400 hover:text-cyan-300 mt-1 truncate max-w-full">
                  <ExternalLink className="h-3 w-3 shrink-0" /> <span className="truncate">{r.title ?? r.url}</span>
                </a>
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 space-y-3">
          <h2 className="text-sm font-bold text-white flex items-center gap-2"><TrendingUp className="h-4 w-4 text-emerald-400" /> Emerging problem clusters</h2>
          {emerging.length === 0 && <p className="text-xs text-slate-500">No cluster has two or more independent discussions yet. Single mentions are not treated as opportunities.</p>}
          <ul className="space-y-3">
            {emerging.map((c) => (
              <li key={c.id} className="text-xs border-b border-slate-800/70 pb-3 last:border-0">
                <p className="text-slate-100 font-medium">{c.summary?.title ?? c.title}</p>
                <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1 text-[10px] font-mono text-slate-400">
                  <span>{c.unique_discussions} discussions</span>
                  <span>{c.sources.map(label).join(' + ')}</span>
                  <span className={c.growth_rate === null ? 'text-slate-500' : c.growth_rate >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                    {c.growth_rate === null ? 'growth: insufficient data' : `growth ${c.growth_rate > 0 ? '+' : ''}${c.growth_rate}%`}
                  </span>
                  {c.spreading && <span className="text-cyan-300">spreading to new platform</span>}
                  <span>confidence: {c.confidence}</span>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
};
