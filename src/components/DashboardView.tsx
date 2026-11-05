import React from 'react';
import { 
  Radar, 
  Search, 
  TrendingUp, 
  Sparkles, 
  Flame, 
  Layers, 
  ArrowUpRight, 
  Bot, 
  BarChart3, 
  CheckCircle, 
  ShieldAlert, 
  Users, 
  Database,
  ExternalLink,
  ChevronRight,
  Filter,
  DollarSign
} from 'lucide-react';
import { Opportunity, PricingTier } from '../types';
import { Overview, SourceInfo, timeAgo } from '../lib/liveData';
import type { LiveStatus } from '../App';

/** Score cell for live data: never shows 0% for a component that simply has no data, and flags AI estimates. */
const fmtScore = (opp: Opportunity, key: keyof NonNullable<Opportunity['live']>['basis']): string => {
  const basis = opp.live?.basis[key];
  if (basis === 'insufficient_data') return 'n/a';
  return `${opp.scores[key]}%${basis === 'ai_estimate' ? '*' : ''}`;
};

interface DashboardViewProps {
  opportunities: Opportunity[];
  liveStatus: LiveStatus;
  overview: Overview | null;
  sources: SourceInfo[];
  isDemo: boolean;
  onSelectOpportunity: (opp: Opportunity) => void;
  onNavigateTab: (tab: string) => void;
  onOpenSources: () => void;
  onOpenScoring: () => void;
  activePlan: PricingTier;
}

export const DashboardView: React.FC<DashboardViewProps> = ({
  opportunities,
  liveStatus,
  overview,
  sources,
  isDemo,
  onSelectOpportunity,
  onNavigateTab,
  onOpenSources,
  onOpenScoring,
  activePlan,
}) => {
  const topOpportunity = opportunities[0];
  const fastGrowing = [...opportunities].sort((a, b) => b.growthRate - a.growthRate).slice(0, 4);
  const ov = liveStatus === 'ready' ? overview : null;
  const dash = '—';
  const n = (v: number | undefined | null) => (ov && v !== undefined && v !== null ? v.toLocaleString() : dash);
  const delta = ov && ov.records_prev_24h > 0 ? Math.round(((ov.records_24h - ov.records_prev_24h) / ov.records_prev_24h) * 100) : null;
  const sourceNames = sources.filter((x) => x.availability === 'implemented' && x.records_total > 0).map((x) => x.name);

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Hero Banner / Market Intelligence Hook */}
      <div className="relative overflow-hidden rounded-2xl border border-slate-800 bg-gradient-to-br from-slate-900 via-slate-900/90 to-slate-950 p-6 md:p-8 shadow-xl">
        <div className="absolute top-0 right-0 -mt-12 -mr-12 h-64 w-64 rounded-full bg-cyan-500/10 blur-3xl pointer-events-none"></div>
        <div className="absolute bottom-0 left-1/3 -mb-12 h-48 w-48 rounded-full bg-blue-600/10 blur-3xl pointer-events-none"></div>

        <div className="relative z-10 flex flex-col lg:flex-row lg:items-center justify-between gap-6">
          <div className="max-w-3xl space-y-3">
            <div className="inline-flex items-center gap-2 rounded-full border border-cyan-800/80 bg-cyan-950/60 px-3 py-1 text-xs font-mono text-cyan-300">
              <span className="flex h-2 w-2 rounded-full bg-cyan-400 animate-pulse"></span>
              AUTONOMOUS MARKET INTELLIGENCE RADAR
            </div>
            <h1 className="text-2xl sm:text-3xl lg:text-4xl font-extrabold tracking-tight text-white">
              Discover what the world needs <br className="hidden sm:inline" />
              <span className="bg-gradient-to-r from-cyan-400 via-blue-400 to-indigo-400 bg-clip-text text-transparent">
                before someone builds it.
              </span>
            </h1>
            <p className="text-sm text-slate-300 leading-relaxed max-w-2xl">
              Collectors read public discussions from GitHub, Hacker News and Stack Exchange through their official APIs, extract the underlying problems, group repeats across platforms and score each cluster with transparent, evidence-labelled factors.
            </p>
          </div>

          <div className="flex flex-wrap sm:flex-nowrap items-center gap-3 shrink-0">
            <button
              onClick={() => onNavigateTab('ai-generator')}
              className="w-full sm:w-auto flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 px-5 py-3 text-xs font-bold text-white shadow-lg shadow-cyan-500/25 hover:from-cyan-400 hover:to-blue-500 transition-all cursor-pointer"
            >
              <Sparkles className="h-4 w-4" />
              Generate Opportunity PRD
            </button>
            <button
              onClick={() => onNavigateTab('explorer')}
              className="w-full sm:w-auto flex items-center justify-center gap-2 rounded-xl border border-slate-700 bg-slate-800/80 px-4 py-3 text-xs font-semibold text-slate-200 hover:bg-slate-700 hover:text-white transition-all cursor-pointer"
            >
              <Search className="h-4 w-4 text-slate-400" />
              Explore Database{ov ? ` (${ov.clusters_total.toLocaleString()})` : ''}
            </button>
          </div>
        </div>
      </div>

      {/* Primary 6 Metrics Grid from User Brief */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        {/* Metric 1 */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 relative overflow-hidden group hover:border-cyan-500/50 transition-all">
          <div className="flex items-center justify-between text-slate-400 text-xs mb-1">
            <span>Collected (24h)</span>
            <Search className="h-3.5 w-3.5 text-cyan-400" />
          </div>
          <div className="text-xl sm:text-2xl font-black font-mono text-white">{n(ov?.records_24h)}</div>
          <div className="text-[10px] text-slate-400 mt-1 flex items-center gap-0.5 font-medium">
            {!ov ? 'collection not connected' : delta === null ? 'no prior-day baseline yet' : `${delta >= 0 ? '+' : ''}${delta}% vs previous 24h`}
          </div>
        </div>

        {/* Metric 2 */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 relative overflow-hidden group hover:border-blue-500/50 transition-all">
          <div className="flex items-center justify-between text-slate-400 text-xs mb-1">
            <span>Validated Clusters</span>
            <Sparkles className="h-3.5 w-3.5 text-blue-400" />
          </div>
          <div className="text-xl sm:text-2xl font-black font-mono text-white">{isDemo ? dash : opportunities.length.toLocaleString()}</div>
          <div className="text-[10px] text-blue-400 mt-1">
            2+ independent discussions
          </div>
        </div>

        {/* Metric 3 */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 relative overflow-hidden group hover:border-rose-500/50 transition-all">
          <div className="flex items-center justify-between text-slate-400 text-xs mb-1">
            <span>Fastest Growing</span>
            <Flame className="h-3.5 w-3.5 text-rose-400" />
          </div>
          <div className="text-xl sm:text-2xl font-black font-mono text-rose-400">{ov?.fastest_growing ? `${ov.fastest_growing.growth_rate > 0 ? '+' : ''}${ov.fastest_growing.growth_rate}%` : dash}</div>
          <div className="text-[10px] text-slate-400 mt-1 truncate" title={ov?.fastest_growing?.title}>
            {ov?.fastest_growing ? ov.fastest_growing.title : ov ? 'insufficient history to measure growth' : 'collection not connected'}
          </div>
        </div>

        {/* Metric 4 */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 relative overflow-hidden group hover:border-amber-500/50 transition-all">
          <div className="flex items-center justify-between text-slate-400 text-xs mb-1">
            <span>Top Industry</span>
            <BarChart3 className="h-3.5 w-3.5 text-amber-400" />
          </div>
          <div className="text-base sm:text-lg font-bold text-white truncate" title={ov?.top_industry?.industry}>
            {ov?.top_industry?.industry ?? dash}
          </div>
          <div className="text-[10px] text-amber-400 mt-1 font-mono">
            {ov?.top_industry ? `${ov.top_industry.unique_discussions.toLocaleString()} unique discussions` : ov ? 'no clusters yet' : 'collection not connected'}
          </div>
        </div>

        {/* Metric 5 */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 relative overflow-hidden group hover:border-emerald-500/50 transition-all">
          <div className="flex items-center justify-between text-slate-400 text-xs mb-1">
            <span>Problem Signals</span>
            <TrendingUp className="h-3.5 w-3.5 text-emerald-400" />
          </div>
          <div className="text-xl sm:text-2xl font-black font-mono text-emerald-300">{n(ov?.problems_total)}</div>
          <div className="text-[10px] text-slate-400 mt-1">
            complaints &amp; unmet needs (not demand)
          </div>
        </div>

        {/* Metric 6 */}
        <div className="rounded-xl border border-slate-800 bg-slate-900/60 p-4 relative overflow-hidden group hover:border-purple-500/50 transition-all">
          <div className="flex items-center justify-between text-slate-400 text-xs mb-1">
            <span>AI-Summarised</span>
            <Layers className="h-3.5 w-3.5 text-purple-400" />
          </div>
          <div className="text-xl sm:text-2xl font-black font-mono text-white">{n(ov?.clusters_summarised)}</div>
          <div className="text-[10px] text-purple-400 mt-1">
            clusters with an AI brief
          </div>
        </div>
      </div>

      {/* 5-Stage Autonomous Intelligence Engine Pipeline Infographic */}
      <div className="rounded-2xl border border-slate-800 bg-slate-950/70 p-5">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-800/80 pb-3 mb-4">
          <div>
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <span className="flex h-2 w-2 rounded-full bg-cyan-400"></span>
              The 5-Stage Market Intelligence Pipeline
            </h2>
            <p className="text-xs text-slate-400">
              How DemandRadar turns collected public discussions into scored software opportunities. Figures are live database counts.
            </p>
          </div>
          <button
            onClick={onOpenScoring}
            className="text-xs text-cyan-400 hover:text-cyan-300 font-medium flex items-center gap-1 cursor-pointer"
          >
            Inspect Scoring Formula Engine <ChevronRight className="h-3 w-3" />
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
          {[
            {
              step: 'A',
              title: 'Problem Extraction',
              desc: 'Separates genuine complaints, feature requests and unmet needs from ordinary conversation and extracts the underlying problem.',
              metric: ov ? `${ov.records_total.toLocaleString()} records collected` : 'collection not connected',
              color: 'text-blue-400 border-blue-900/50 bg-blue-950/20'
            },
            {
              step: 'B',
              title: 'Clustering',
              desc: 'Groups similar multi-platform complaints into singular identifiable problem clusters.',
              metric: ov ? `${ov.clusters_total.toLocaleString()} clusters (${ov.clusters_multi_source} cross-platform)` : 'collection not connected',
              color: 'text-cyan-400 border-cyan-900/50 bg-cyan-950/20'
            },
            {
              step: 'C',
              title: 'Demand Analysis',
              desc: 'Counts unique discussions, 30-day growth and explicit willingness-to-pay evidence. Mentions alone are never treated as demand.',
              metric: ov ? `${ov.problems_total.toLocaleString()} problem signals` : 'collection not connected',
              color: 'text-emerald-400 border-emerald-900/50 bg-emerald-950/20'
            },
            {
              step: 'D',
              title: 'Competition Analysis',
              desc: 'Lists competitors named inside the discussions. No review-site or pricing data is collected.',
              metric: 'from named mentions only',
              color: 'text-amber-400 border-amber-900/50 bg-amber-950/20'
            },
            {
              step: 'E',
              title: 'Opportunity Scoring',
              desc: 'Generates software solutions, monetization models, and 6-factor composite scores (0-100).',
              metric: ov ? `${ov.clusters_summarised.toLocaleString()} AI-summarised` : 'collection not connected',
              color: 'text-purple-400 border-purple-900/50 bg-purple-950/20'
            },
          ].map((item, idx) => (
            <div
              key={item.step}
              className={`rounded-xl border p-3.5 space-y-2 relative transition-all hover:scale-[1.02] ${item.color}`}
            >
              <div className="flex items-center justify-between">
                <span className="font-mono text-xs font-black px-2 py-0.5 rounded bg-slate-900/80 border border-slate-800 text-slate-200">
                  Stage {item.step}
                </span>
                {idx < 4 && (
                  <span className="hidden md:block text-slate-600 text-xs font-mono">→</span>
                )}
              </div>
              <h3 className="text-xs font-bold text-white">{item.title}</h3>
              <p className="text-[11px] text-slate-300 leading-snug">{item.desc}</p>
              <div className="pt-2 border-t border-slate-800/60 font-mono text-[10px] text-slate-400">
                {item.metric}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Main Content Split: Featured Dossier + Bot Swarm Live Stream */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left 2 Cols: Featured Opportunity Spotlight */}
        <div className="lg:col-span-2 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-bold text-white flex items-center gap-2">
              <Flame className="h-4 w-4 text-rose-400" />
              Highest Rated Opportunity Today
            </h2>
            <span className="rounded bg-rose-950/80 px-2 py-0.5 text-xs font-mono font-bold text-rose-300 border border-rose-800">
              Score: {topOpportunity.scores.compositeScore}/100
            </span>
          </div>

          <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-5 md:p-6 space-y-5 hover:border-slate-700 transition-all">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div>
                <span className="text-xs font-semibold text-cyan-400 uppercase tracking-wider">
                  {topOpportunity.category} • {topOpportunity.country}
                </span>
                <h3 className="text-lg font-bold text-white mt-0.5">
                  {topOpportunity.title}
                </h3>
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <div className="text-right">
                  <div className="text-[10px] text-slate-400 uppercase">Discussion Growth</div>
                  <div className="text-sm font-mono font-bold text-emerald-400">{topOpportunity.growth}</div>
                </div>
                <div className="text-right border-l border-slate-800 pl-2">
                  <div className="text-[10px] text-slate-400 uppercase">Target ACV</div>
                  <div className="text-sm font-mono font-bold text-amber-300">{topOpportunity.estACV}</div>
                </div>
              </div>
            </div>

            {/* Problem & Existing fails */}
            <div className="space-y-2 text-xs leading-relaxed">
              <div className="rounded-xl bg-slate-950/60 p-3.5 border border-slate-800/80">
                <span className="font-semibold text-slate-200 block mb-1">The Human Problem:</span>
                <p className="text-slate-300">{topOpportunity.problemDescription}</p>
              </div>

              <div className="rounded-xl bg-rose-950/20 p-3.5 border border-rose-900/40">
                <span className="font-semibold text-rose-300 block mb-1">What Existing Solutions Fail To Address:</span>
                <p className="text-slate-300">{topOpportunity.existingFails}</p>
              </div>
            </div>

            {/* 6-Factor Score breakdown mini-pills */}
            <div>
              <div className="text-[11px] font-semibold text-slate-400 mb-2 uppercase tracking-wider">
                Opportunity Score Breakdown (6-Factor Algorithm){topOpportunity.live ? ' · * = AI estimate · n/a = insufficient data' : ' · demo values'}
              </div>
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-2 text-center text-xs">
                <div className="rounded-lg bg-slate-950 p-2 border border-slate-800">
                  <div className="text-[10px] text-slate-400">Frequency</div>
                  <div className="font-mono font-bold text-cyan-300">{fmtScore(topOpportunity, 'problemFrequency')}</div>
                </div>
                <div className="rounded-lg bg-slate-950 p-2 border border-slate-800">
                  <div className="text-[10px] text-slate-400">Demand Growth</div>
                  <div className="font-mono font-bold text-emerald-300">{fmtScore(topOpportunity, 'demandGrowth')}</div>
                </div>
                <div className="rounded-lg bg-slate-950 p-2 border border-slate-800">
                  <div className="text-[10px] text-slate-400">Pain Intensity</div>
                  <div className="font-mono font-bold text-rose-300">{fmtScore(topOpportunity, 'painIntensity')}</div>
                </div>
                <div className="rounded-lg bg-slate-950 p-2 border border-slate-800">
                  <div className="text-[10px] text-slate-400">Willingness to Pay</div>
                  <div className="font-mono font-bold text-amber-300">{fmtScore(topOpportunity, 'willingnessToPay')}</div>
                </div>
                <div className="rounded-lg bg-slate-950 p-2 border border-slate-800">
                  <div className="text-[10px] text-slate-400">Comp. Gap</div>
                  <div className="font-mono font-bold text-purple-300">{fmtScore(topOpportunity, 'competitionGap')}</div>
                </div>
                <div className="rounded-lg bg-slate-950 p-2 border border-slate-800">
                  <div className="text-[10px] text-slate-400">Feasibility</div>
                  <div className="font-mono font-bold text-blue-300">{fmtScore(topOpportunity, 'developmentFeasibility')}</div>
                </div>
              </div>
            </div>

            {/* Action Bar */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-3 border-t border-slate-800">
              <span className="text-xs text-slate-400">
                {topOpportunity.live
                  ? <>Identified from <strong>{topOpportunity.live.uniqueDiscussions} independent discussions</strong> across {topOpportunity.live.sources.join(', ')}.</>
                  : <strong className="text-amber-300">Demo data — illustrative sample, not collected from real sources.</strong>}
              </span>
              <button
                onClick={() => onSelectOpportunity(topOpportunity)}
                className="flex items-center justify-center gap-1.5 rounded-xl bg-cyan-600 px-4 py-2 text-xs font-bold text-white hover:bg-cyan-500 shadow-md shadow-cyan-600/20 transition-all cursor-pointer"
              >
                Inspect Opportunity Dossier
                <ArrowUpRight className="h-4 w-4" />
              </button>
            </div>
          </div>

          {/* Fast-Growing Problems Table */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-emerald-400" />
                Fast-Growing Problem Clusters (last 30 days vs prior 30)
              </h3>
              <button
                onClick={() => onNavigateTab('explorer')}
                className="text-xs text-cyan-400 hover:text-cyan-300 cursor-pointer"
              >
                View all →
              </button>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="border-b border-slate-800 text-slate-400 font-mono text-[11px]">
                    <th className="pb-2 font-normal">Identified Problem</th>
                    <th className="pb-2 font-normal">Discussions</th>
                    <th className="pb-2 font-normal">Growth</th>
                    <th className="pb-2 font-normal">Urgency</th>
                    <th className="pb-2 font-normal text-right">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 text-slate-300">
                  {fastGrowing.map((item) => (
                    <tr key={item.id} className="hover:bg-slate-800/40 transition-colors">
                      <td className="py-2.5 pr-2">
                        <div className="font-semibold text-white truncate max-w-xs">{item.title}</div>
                        <div className="text-[10px] text-slate-400">{item.category}</div>
                      </td>
                      <td className="py-2.5 font-mono text-slate-300">
                        {item.discussions.toLocaleString()}
                      </td>
                      <td className="py-2.5 font-mono font-bold text-emerald-400">
                        {item.growth}
                      </td>
                      <td className="py-2.5">
                        <div className="flex items-center gap-1.5">
                          <div className="h-1.5 w-12 bg-slate-800 rounded-full overflow-hidden">
                            <div className="h-full bg-cyan-400 rounded-full" style={{ width: `${item.urgency}%` }}></div>
                          </div>
                          <span className="font-mono text-[10px] text-slate-400">{item.urgency}</span>
                        </div>
                      </td>
                      <td className="py-2.5 text-right">
                        <button
                          onClick={() => onSelectOpportunity(item)}
                          className="text-cyan-400 hover:text-cyan-300 font-semibold text-[11px] cursor-pointer"
                        >
                          Dossier →
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Right Col: Autonomous Scout Swarm Live Telemetry & Accumulated Dataset Advantage */}
        <div className="space-y-4">
          {/* Real collection status */}
          <div className="rounded-2xl border border-slate-800 bg-slate-900/90 p-5 space-y-4">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <Database className="h-4 w-4 text-cyan-400" />
                <h3 className="text-sm font-bold text-white">Collection Sources</h3>
              </div>
              <button onClick={onOpenSources} className="text-[11px] text-cyan-400 hover:text-cyan-300 font-mono cursor-pointer">
                Manage →
              </button>
            </div>

            {liveStatus !== 'ready' && (
              <p className="text-[11px] text-amber-300">{liveStatus === 'loading' ? 'Loading…' : 'Collection backend not connected — no source is running.'}</p>
            )}
            <div className="space-y-3">
              {sources.filter((x) => x.availability === 'implemented').map((src) => (
                <div key={src.id} className="rounded-xl border border-slate-800/80 bg-slate-950/60 p-3 space-y-1 text-xs">
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-white flex items-center gap-1.5">
                      <span className={`h-2 w-2 rounded-full ${src.status === 'idle' && src.last_success_at ? 'bg-emerald-400' : src.status === 'error' ? 'bg-rose-400' : 'bg-slate-600'}`}></span>
                      {src.name}
                    </span>
                    <span className="text-[10px] font-mono text-slate-400">{src.records_total.toLocaleString()} records</span>
                  </div>
                  <div className="flex items-center justify-between text-[10px] text-slate-500 font-mono">
                    <span>{src.last_success_at ? `synced ${timeAgo(src.last_success_at)}` : 'never synced'}</span>
                    <span className="capitalize">{src.status === 'idle' ? (src.enabled ? 'enabled' : 'disabled') : src.status}</span>
                  </div>
                </div>
              ))}
              {sources.filter((x) => x.availability === 'skipped').length > 0 && (
                <p className="text-[10px] text-slate-500">{sources.filter((x) => x.availability === 'skipped').map((x) => x.name).join(', ')}: not connected (access restrictions documented).</p>
              )}
            </div>

            <button
              onClick={onOpenSources}
              className="w-full py-2 rounded-lg border border-slate-800 bg-slate-950 text-xs font-semibold text-slate-300 hover:bg-slate-800 hover:text-white transition-all cursor-pointer text-center"
            >
              Open Data Sources →
            </button>
          </div>

          {/* The Real Competitive Advantage Callout */}
          <div className="rounded-2xl border border-amber-900/40 bg-gradient-to-br from-amber-950/30 to-slate-950 p-5 space-y-3">
            <div className="flex items-center gap-2 text-amber-400">
              <Database className="h-4 w-4" />
              <h4 className="text-xs font-bold uppercase tracking-wider">
                The Real Competitive Advantage
              </h4>
            </div>
            <p className="text-xs text-slate-300 leading-relaxed">
              A continuously updating, source-linked database of human problems{sourceNames.length ? ` (so far from ${sourceNames.join(', ')})` : ''}. Live counts:
            </p>
            <div className="space-y-2 text-xs font-mono text-slate-300 bg-slate-950/80 p-3 rounded-xl border border-slate-800">
              <div className="flex justify-between">
                <span className="text-slate-400">Records collected:</span>
                <span className="text-cyan-300 font-bold">{n(ov?.records_total)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Problem signals:</span>
                <span className="text-amber-300 font-bold">{n(ov?.problems_total)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Cross-platform clusters:</span>
                <span className="text-emerald-300 font-bold">{n(ov?.clusters_multi_source)}</span>
              </div>
            </div>
            <p className="text-[11px] text-slate-400">
              Every cluster links back to its original discussions; measured statistics and AI estimates are labelled separately.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
