import React from 'react';
import { 
  Radar, 
  LayoutDashboard, 
  Search, 
  FileText, 
  TrendingUp, 
  Sparkles, 
  Database,
  Activity,
  Sliders, 
  Crown,
  ChevronRight,
  Download
} from 'lucide-react';
import { PricingTier } from '../types';

interface NavbarProps {
  currentTab: string;
  setCurrentTab: (tab: string) => void;
  activePlan: PricingTier;
  onOpenPricing: () => void;
  onOpenScoring: () => void;
  onOpenSources: () => void;
  /** Real collection state: null while unknown / not connected. */
  liveSummary: { enabledSources: number; implementedSources: number; records: number; lastCollectionAt: string | null } | null;
  explorerBadge?: string;
}

export const Navbar: React.FC<NavbarProps> = ({
  currentTab,
  setCurrentTab,
  activePlan,
  onOpenPricing,
  onOpenScoring,
  onOpenSources,
  liveSummary,
  explorerBadge,
}) => {
  const navItems = [
    { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
    { id: 'explorer', label: 'Problem Explorer', icon: Search, badge: explorerBadge },
    { id: 'intelligence', label: 'Opportunity Intelligence', icon: FileText },
    { id: 'trends', label: 'Trend Analytics', icon: TrendingUp },
    { id: 'activity', label: 'Research Activity', icon: Activity },
    { id: 'sources', label: 'Data Sources', icon: Database },
    { id: 'ai-generator', label: 'AI Opportunity Generator', icon: Sparkles, highlight: true },
  ];

  return (
    <header className="sticky top-0 z-40 border-b border-slate-800 bg-slate-950/90 backdrop-blur-md">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 sm:px-6">
        {/* Brand */}
        <div className="flex items-center gap-6">
          <button 
            onClick={() => setCurrentTab('dashboard')} 
            className="flex items-center gap-2.5 text-left group transition-all"
          >
            <div className="relative flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-cyan-500 to-blue-600 shadow-lg shadow-cyan-500/20 group-hover:scale-105 transition-transform">
              <Radar className="h-5 w-5 text-white animate-spin-slow" />
              <span className="absolute -top-1 -right-1 flex h-3 w-3">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500"></span>
              </span>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="text-lg font-bold tracking-tight text-white">Demand<span className="text-cyan-400">Radar</span></span>
                <button onClick={onOpenSources} title="Open Data Sources" aria-label="Open Data Sources" className="cursor-pointer">
                {liveSummary?.lastCollectionAt ? (
                  <span className="rounded bg-cyan-950/80 px-1.5 py-0.5 text-[10px] font-mono font-medium text-cyan-300 border border-cyan-800/60">
                    LIVE DATA
                  </span>
                ) : (
                  <span className="rounded bg-amber-950/60 px-1.5 py-0.5 text-[10px] font-mono font-medium text-amber-300 border border-amber-800/60">
                    {liveSummary ? 'NO DATA YET' : 'DEMO'}
                  </span>
                )}
                </button>
              </div>
              <p className="hidden sm:block text-[11px] text-slate-400 -mt-0.5">
                Discover what the world needs before someone builds it
              </p>
            </div>
          </button>

          {/* Real collection status (no simulated activity) */}
          <button
            onClick={onOpenSources}
            className="hidden lg:flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/80 px-2.5 py-1.5 text-xs text-slate-300 hover:border-cyan-500/50 hover:bg-slate-800/80 transition-all cursor-pointer"
            title="Open Data Sources"
          >
            <Database className="h-3.5 w-3.5 text-cyan-400" />
            {liveSummary ? (
              <>
                <span className="font-mono text-cyan-300 font-semibold">{liveSummary.enabledSources}/{liveSummary.implementedSources} sources enabled</span>
                <span className="text-slate-500">|</span>
                <span className="text-slate-400">{liveSummary.records.toLocaleString()} records</span>
              </>
            ) : (
              <span className="text-slate-400">Collection not connected</span>
            )}
            <ChevronRight className="h-3 w-3 text-slate-500" />
          </button>
        </div>

        {/* Navigation Tabs */}
        <nav className="hidden md:flex items-center gap-1">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = currentTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => setCurrentTab(item.id)}
                className={`flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-medium transition-all cursor-pointer ${
                  isActive
                    ? 'bg-slate-800 text-white shadow-sm border border-slate-700/80'
                    : 'text-slate-400 hover:text-slate-200 hover:bg-slate-900/60'
                } ${item.highlight && !isActive ? 'text-cyan-400 hover:text-cyan-300' : ''}`}
              >
                <Icon className={`h-4 w-4 ${isActive ? 'text-cyan-400' : item.highlight ? 'text-cyan-400' : 'text-slate-400'}`} />
                <span>{item.label}</span>
                {item.badge && (
                  <span className="rounded-full bg-slate-800 border border-slate-700 px-1.5 py-0.2 text-[10px] font-mono text-slate-300">
                    {item.badge}
                  </span>
                )}
                {item.highlight && (
                  <span className="rounded bg-gradient-to-r from-cyan-500 to-blue-500 px-1.5 py-0.2 text-[10px] font-bold text-white shadow-xs">
                    AI
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        {/* Action Controls */}
        <div className="flex items-center gap-2">

          {/* Scoring Algorithm Trigger */}
          <button
            onClick={onOpenScoring}
            className="hidden sm:flex items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-900/80 px-2.5 py-1.5 text-xs text-slate-300 hover:border-slate-700 hover:text-white transition-all cursor-pointer"
            title="Adjust Opportunity Scoring Weights"
          >
            <Sliders className="h-3.5 w-3.5 text-slate-400" />
            <span>Scoring Algorithm</span>
          </button>

          {/* Pricing Tier Selector */}
          <button
            onClick={onOpenPricing}
            className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-all cursor-pointer ${
              activePlan === 'Pro' || activePlan === 'Business'
                ? 'border-amber-500/50 bg-gradient-to-r from-amber-500/20 to-orange-500/10 text-amber-300 hover:border-amber-400'
                : 'border-slate-800 bg-slate-900 text-slate-300 hover:border-slate-700 hover:text-white'
            }`}
          >
            <Crown className={`h-3.5 w-3.5 ${activePlan === 'Pro' || activePlan === 'Business' ? 'text-amber-400' : 'text-slate-400'}`} />
            <span>Plan: <strong className="font-semibold">{activePlan}</strong></span>
          </button>
        </div>
      </div>

      {/* Mobile nav bar row */}
      <div className="flex md:hidden overflow-x-auto border-t border-slate-800/80 bg-slate-950 px-3 py-2 gap-1 no-scrollbar">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = currentTab === item.id;
          return (
            <button
              key={item.id}
              onClick={() => setCurrentTab(item.id)}
              className={`flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-all ${
                isActive
                  ? 'bg-cyan-950/80 text-cyan-300 border border-cyan-800'
                  : 'text-slate-400 hover:bg-slate-900'
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              <span>{item.label}</span>
            </button>
          );
        })}
      </div>
    </header>
  );
};
