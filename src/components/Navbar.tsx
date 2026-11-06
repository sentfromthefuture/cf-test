import React from 'react';
import { Radar, LayoutDashboard, Search, FileText, TrendingUp, Sparkles, Database, Activity, Sliders, Crown } from 'lucide-react';
import { PricingTier } from '../types';

interface NavbarProps {
  currentTab: string;
  setCurrentTab: (tab: string) => void;
  activePlan: PricingTier;
  onOpenPricing: () => void;
  onOpenScoring: () => void;
  onOpenSources: () => void;
  liveSummary: { enabledSources: number; implementedSources: number; records: number; lastCollectionAt: string | null } | null;
  explorerBadge?: string;
}

export const Navbar: React.FC<NavbarProps> = ({ currentTab, setCurrentTab, activePlan, onOpenPricing, onOpenScoring, onOpenSources, liveSummary, explorerBadge }) => {
  const items = [
    { id: 'landing', label: 'Home', icon: Radar },
    { id: 'dashboard', label: 'Overview', icon: LayoutDashboard },
    { id: 'explorer', label: 'Explore', icon: Search, badge: explorerBadge },
    { id: 'intelligence', label: 'Dossiers', icon: FileText },
    { id: 'trends', label: 'Trends', icon: TrendingUp },
    { id: 'activity', label: 'Activity', icon: Activity },
    { id: 'sources', label: 'Sources', icon: Database },
    { id: 'ai-generator', label: 'Idea studio', icon: Sparkles },
  ];
  return (
    <header className="sticky top-0 z-40 border-b border-slate-800 bg-slate-950/95 backdrop-blur-xl">
      <div className="mx-auto flex max-w-[1440px] items-center justify-between gap-4 px-4 py-3 sm:px-6 lg:px-8">
        <div className="flex min-w-0 items-center gap-3">
          <button onClick={() => setCurrentTab('landing')} aria-label="DemandRadar home" className="flex shrink-0 items-center gap-3 text-left">
            <span className="flex h-9 w-9 items-center justify-center rounded-xl border border-slate-700 bg-slate-900"><Radar className="h-[18px] w-[18px] text-slate-100" /></span>
            <span><span className="block text-[15px] font-semibold tracking-tight text-white">DemandRadar</span><span className="hidden text-[10px] tracking-wide text-slate-500 sm:block">MARKET INTELLIGENCE</span></span>
          </button>
          <button onClick={onOpenSources} className="hidden xl:flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2 text-[11px] text-slate-400 hover:text-white">
            <span className={liveSummary?.lastCollectionAt ? 'h-1.5 w-1.5 rounded-full bg-emerald-400' : 'h-1.5 w-1.5 rounded-full bg-slate-500'} />
            {liveSummary ? <>{liveSummary.records.toLocaleString()} records · {liveSummary.enabledSources}/{liveSummary.implementedSources} sources enabled</> : 'Collection status'}
          </button>
        </div>
        <nav aria-label="Primary navigation" className="hidden lg:flex items-center gap-1">
          {items.map((item) => {
            const Icon = item.icon;
            const active = currentTab === item.id;
            return <button key={item.id} onClick={() => setCurrentTab(item.id)} aria-current={active ? 'page' : undefined} className={active ? 'inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-xs font-medium text-white' : 'inline-flex items-center gap-2 rounded-lg border border-transparent px-3 py-2 text-xs font-medium text-slate-400 hover:border-slate-800 hover:bg-slate-900 hover:text-slate-100'}>
              <Icon className="h-3.5 w-3.5" />{item.label}
              {item.badge && <span className="rounded bg-slate-700 px-1.5 py-0.5 text-[10px]">{item.badge}</span>}
            </button>;
          })}
        </nav>
        <div className="flex shrink-0 items-center gap-2">
          <button onClick={onOpenScoring} title="Adjust scoring weights" aria-label="Adjust scoring weights" className="hidden sm:inline-flex items-center gap-2 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-2 text-xs text-slate-300 hover:border-slate-600 hover:text-white"><Sliders className="h-3.5 w-3.5" /><span className="hidden xl:inline">Scoring</span></button>
          <button onClick={onOpenPricing} className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-100 px-3 py-2 text-xs font-semibold text-slate-950 hover:bg-white"><Crown className="h-3.5 w-3.5" />{activePlan}</button>
        </div>
      </div>
      <nav aria-label="Mobile navigation" className="flex lg:hidden gap-1 overflow-x-auto border-t border-slate-800/80 px-3 py-2">
        {items.map((item) => {
          const Icon = item.icon;
          const active = currentTab === item.id;
          return <button key={item.id} onClick={() => setCurrentTab(item.id)} aria-current={active ? 'page' : undefined} className={active ? 'flex shrink-0 items-center gap-1.5 rounded-lg bg-slate-100 px-3 py-2 text-xs font-medium text-slate-950' : 'flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium text-slate-400 hover:bg-slate-900 hover:text-white'}><Icon className="h-3.5 w-3.5" />{item.label}</button>;
        })}
      </nav>
    </header>
  );
};
