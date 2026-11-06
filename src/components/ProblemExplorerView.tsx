import React, { useState, useMemo } from 'react';
import { 
  Search, 
  Filter, 
  ArrowUpDown, 
  ArrowUpRight, 
  Flame, 
  Layers, 
  LayoutGrid, 
  Table as TableIcon, 
  SlidersHorizontal,
  ChevronRight,
  TrendingUp,
  AlertCircle,
  ExternalLink,
  Crown
} from 'lucide-react';
import { Opportunity, PricingTier } from '../types';

interface ProblemExplorerViewProps {
  opportunities: Opportunity[];
  onSelectOpportunity: (opp: Opportunity) => void;
  activePlan: PricingTier;
  onOpenPricing: () => void;
}

export const ProblemExplorerView: React.FC<ProblemExplorerViewProps> = ({
  opportunities,
  onSelectOpportunity,
  activePlan,
  onOpenPricing,
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('All');
  const [selectedLevel, setSelectedLevel] = useState<string>('All');
  const [sortBy, setSortBy] = useState<'score' | 'growth' | 'discussions' | 'urgency'>('score');
  const [viewMode, setViewMode] = useState<'table' | 'grid'>('table');

  // Derive filter options from the loaded dataset so new live industries are never hidden.
  const categories = ['All', ...Array.from(new Set(opportunities.map((item) => item.category).filter(Boolean))).sort((x, y) => x.localeCompare(y))];

  const filtered = useMemo(() => {
    return opportunities.filter(item => {
      const matchSearch =
        item.title.toLowerCase().includes(searchTerm.toLowerCase()) ||
        item.problemDescription.toLowerCase().includes(searchTerm.toLowerCase()) ||
        item.targetPersona.toLowerCase().includes(searchTerm.toLowerCase()) ||
        item.category.toLowerCase().includes(searchTerm.toLowerCase());

      const matchCategory = selectedCategory === 'All' || item.category === selectedCategory;
      const matchLevel = selectedLevel === 'All' || item.opportunityLevel === selectedLevel;

      return matchSearch && matchCategory && matchLevel;
    }).sort((a, b) => {
      if (sortBy === 'score') return b.scores.compositeScore - a.scores.compositeScore;
      if (sortBy === 'growth') return b.growthRate - a.growthRate;
      if (sortBy === 'discussions') return b.discussions - a.discussions;
      if (sortBy === 'urgency') return b.urgency - a.urgency;
      return 0;
    });
  }, [opportunities, searchTerm, selectedCategory, selectedLevel, sortBy]);

  // Free plan: only the 3 highest-scoring opportunities are listed.
  const topFree = useMemo(
    () => new Set([...opportunities].sort((a, b) => b.scores.compositeScore - a.scores.compositeScore).slice(0, 3).map((o) => o.id)),
    [opportunities]
  );
  const visible = activePlan === 'Free' ? filtered.filter((o) => topFree.has(o.id)) : filtered;

  // Compute summary stats for the active filter set
  const totalDiscussions = filtered.reduce((acc, curr) => acc + curr.discussions, 0);
  const avgGrowth = filtered.length > 0 ? Math.round(filtered.reduce((acc, curr) => acc + curr.growthRate, 0) / filtered.length) : 0;

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Page Title & Stats */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-5">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl sm:text-2xl font-bold text-white">Problem Explorer</h1>
            <span className="rounded bg-slate-800 px-2 py-0.5 text-xs font-mono text-cyan-300 border border-slate-700">
              {filtered.length} Clusters Found
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Search and compare problem clusters. Live records retain source links and distinguish measured evidence from AI estimates.
          </p>
        </div>

        {/* Live Filter Summary Pills */}
        <div className="flex items-center gap-3">
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2 text-xs">
            <span className="text-[10px] text-slate-400 uppercase tracking-wider block">Discussions in matching clusters</span>
            <span className="font-mono font-bold text-white">{totalDiscussions.toLocaleString()}</span>
          </div>
          <div className="rounded-xl border border-slate-800 bg-slate-900/60 px-3 py-2 text-xs">
            <span className="text-[10px] text-slate-400 uppercase tracking-wider block">Average cluster growth</span>
            <span className="font-mono font-bold text-slate-200">{avgGrowth > 0 ? '+' : ''}{avgGrowth}%</span>
          </div>
          <div className="flex rounded-lg border border-slate-800 bg-slate-900 p-1">
            <button
              onClick={() => setViewMode('table')}
              className={`p-1.5 rounded transition-all cursor-pointer ${
                viewMode === 'table' ? 'bg-slate-800 text-cyan-400' : 'text-slate-500 hover:text-slate-300'
              }`}
              title="Table View"
            >
              <TableIcon className="h-4 w-4" />
            </button>
            <button
              onClick={() => setViewMode('grid')}
              className={`p-1.5 rounded transition-all cursor-pointer ${
                viewMode === 'grid' ? 'bg-slate-800 text-cyan-400' : 'text-slate-500 hover:text-slate-300'
              }`}
              title="Grid Card View"
            >
              <LayoutGrid className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      {/* Search & Filter Controls */}
      <div className="space-y-3">
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-500" />
            <input
              type="text"
              placeholder="Search problems, keywords, software gaps (e.g. inventory, rent, invoice, plumbing)..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full rounded-xl border border-slate-800 bg-slate-900/80 pl-10 pr-4 py-2.5 text-xs text-white placeholder-slate-500 focus:border-cyan-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
            />
            {searchTerm && (
              <button
                onClick={() => setSearchTerm('')}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-400 hover:text-white"
              >
                Clear
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            <div className="flex items-center gap-1 bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-300">
              <ArrowUpDown className="h-3.5 w-3.5 text-slate-400" />
              <span className="text-slate-400 hidden sm:inline">Sort:</span>
              <select
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as any)}
                className="bg-transparent text-white focus:outline-none cursor-pointer"
              >
                <option value="score">Opportunity Score</option>
                <option value="growth">Demand Growth (%)</option>
                <option value="discussions">Discussions Volume</option>
                <option value="urgency">Urgency Rating</option>
              </select>
            </div>

            <div className="flex items-center gap-1 bg-slate-900 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-300">
              <span className="text-slate-400 hidden sm:inline">Impact:</span>
              <select
                value={selectedLevel}
                onChange={(e) => setSelectedLevel(e.target.value)}
                className="bg-transparent text-white focus:outline-none cursor-pointer"
              >
                <option value="All">All Impact Levels</option>
                <option value="Critical">Critical</option>
                <option value="High">High</option>
                <option value="Medium">Medium</option>
              </select>
            </div>
          </div>
        </div>

        {/* Category Filter Chips */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 no-scrollbar text-xs">
          {categories.map((cat) => (
            <button
              key={cat}
              onClick={() => setSelectedCategory(cat)}
              className={`shrink-0 px-3 py-1.5 rounded-lg border transition-all cursor-pointer ${
                selectedCategory === cat
                  ? 'border-cyan-500 bg-cyan-950/70 text-cyan-300 font-semibold shadow-xs'
                  : 'border-slate-800 bg-slate-900/60 text-slate-400 hover:border-slate-700 hover:text-slate-200'
              }`}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* Free Plan Limit Notice (Educational Paywall Hook) */}
      {activePlan === 'Free' && (
        <div className="rounded-xl border border-amber-500/30 bg-amber-950/20 p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-2 text-slate-300">
            <Crown className="h-4 w-4 text-amber-400 shrink-0" />
            <span>
              <strong>Free Plan Preview:</strong> Displaying high-signal opportunities. Upgrade to <strong>Pro ($29/mo)</strong> to unlock historical demand graphs, source-backed alternatives research, and AI-generated product briefs.
            </span>
          </div>
          <button
            onClick={onOpenPricing}
            className="rounded-lg bg-amber-500/20 border border-amber-500/50 px-3 py-1 text-xs font-semibold text-amber-300 hover:bg-amber-500/30 shrink-0 transition-colors cursor-pointer"
          >
            Upgrade to Pro
          </button>
        </div>
      )}

      {/* Table View */}
      {viewMode === 'table' ? (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 overflow-hidden shadow-lg">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="border-b border-slate-800 bg-slate-950/80 text-slate-400 font-mono text-[11px]">
                  <th className="py-3 px-4 font-normal">Identified Problem / Cluster</th>
                  <th className="py-3 px-3 font-normal">Industry</th>
                  <th className="py-3 px-3 font-normal">Discussions</th>
                  <th className="py-3 px-3 font-normal">Demand Growth</th>
                  <th className="py-3 px-3 font-normal">Willingness to Pay</th>
                  <th className="py-3 px-3 font-normal">Opp. Score</th>
                  <th className="py-3 px-4 font-normal text-right">Research Dossier</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/60 text-slate-300">
                {visible.map((item) => (
                  <tr
                    key={item.id}
                    onClick={() => onSelectOpportunity(item)}
                    className="hover:bg-slate-800/50 transition-colors cursor-pointer group"
                  >
                    <td className="py-3 px-4">
                      <div className="font-bold text-white group-hover:text-cyan-300 transition-colors">
                        {item.title}
                      </div>
                      <p className="text-[11px] text-slate-400 line-clamp-1 mt-0.5">
                        {item.problemDescription}
                      </p>
                    </td>

                    <td className="py-3 px-3 text-slate-300">
                      <span className="rounded bg-slate-950 px-2 py-0.5 text-[10px] font-mono border border-slate-800">
                        {item.category}
                      </span>
                    </td>

                    <td className="py-3 px-3 font-mono text-slate-300">
                      {item.discussions.toLocaleString()}
                    </td>

                    <td className="py-3 px-3 font-mono font-bold text-emerald-400">
                      {item.growth}
                    </td>

                    <td className="py-3 px-3">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-[10px] font-mono font-semibold ${
                        item.willingnessToPay === 'Extreme' || item.willingnessToPay === 'Very High'
                          ? 'bg-amber-950 text-amber-300 border border-amber-800/60'
                          : 'bg-slate-800 text-slate-300'
                      }`}>
                        {item.willingnessToPay}
                      </span>
                    </td>

                    <td className="py-3 px-3">
                      <div className="flex items-center gap-2">
                        <div className="w-12 h-2 bg-slate-800 rounded-full overflow-hidden">
                          <div
                            className={`h-full rounded-full ${
                              item.scores.compositeScore >= 85 ? 'bg-cyan-400' : 'bg-blue-400'
                            }`}
                            style={{ width: `${item.scores.compositeScore}%` }}
                          ></div>
                        </div>
                        <span className="font-mono font-bold text-white">
                          {item.scores.compositeScore}
                        </span>
                      </div>
                    </td>

                    <td className="py-3 px-4 text-right">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onSelectOpportunity(item);
                        }}
                        className="inline-flex items-center gap-1 rounded-lg bg-slate-800 px-3 py-1 text-xs font-semibold text-cyan-300 group-hover:bg-cyan-600 group-hover:text-white transition-all"
                      >
                        Inspect
                        <ArrowUpRight className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        /* Card Grid View */
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {visible.map((item) => (
            <div
              key={item.id}
              onClick={() => onSelectOpportunity(item)}
              className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 space-y-4 hover:border-cyan-500/50 hover:bg-slate-900/90 transition-all cursor-pointer flex flex-col justify-between group"
            >
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-cyan-400 bg-slate-950 px-2 py-0.5 rounded border border-slate-800">
                    {item.category}
                  </span>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-slate-400 font-mono">Score:</span>
                    <span className="font-mono font-black text-sm text-cyan-300 bg-cyan-950 px-2 py-0.5 rounded border border-cyan-800">
                      {item.scores.compositeScore}
                    </span>
                  </div>
                </div>

                <h3 className="text-sm font-bold text-white group-hover:text-cyan-300 transition-colors">
                  {item.title}
                </h3>

                <p className="text-xs text-slate-400 line-clamp-3 leading-relaxed">
                  {item.problemDescription}
                </p>

                <div className="grid grid-cols-3 gap-2 pt-2 border-t border-slate-800/80 text-center text-xs">
                  <div className="rounded-lg bg-slate-950 p-2 border border-slate-800/60">
                    <span className="text-[10px] text-slate-400 block">Discussions</span>
                    <span className="font-mono font-bold text-slate-200">{item.discussions.toLocaleString()}</span>
                  </div>
                  <div className="rounded-lg bg-slate-950 p-2 border border-slate-800/60">
                    <span className="text-[10px] text-slate-400 block">Growth</span>
                    <span className="font-mono font-bold text-emerald-400">{item.growth}</span>
                  </div>
                  <div className="rounded-lg bg-slate-950 p-2 border border-slate-800/60">
                    <span className="text-[10px] text-slate-400 block">ACV hypothesis</span>
                    <span className="font-mono font-bold text-amber-300">{item.estACV}</span>
                  </div>
                </div>
              </div>

              <div className="pt-3 border-t border-slate-800/60 flex items-center justify-between text-xs">
                <span className="text-slate-400 text-[11px]">
                  Urgency: <strong>{item.urgency}/100</strong>
                </span>
                <span className="text-cyan-400 font-semibold group-hover:translate-x-0.5 transition-transform flex items-center gap-1">
                  Full Dossier →
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
