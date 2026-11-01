import React, { useState } from 'react';
import { 
  TrendingUp, 
  BarChart3, 
  Globe2, 
  Share2, 
  Layers, 
  PieChart, 
  Activity, 
  Sparkles, 
  ArrowUpRight, 
  ArrowDownRight,
  Filter,
  Info
} from 'lucide-react';
import { 
  HISTORICAL_DEMAND_TRENDS, 
  INDUSTRY_BREAKDOWN, 
  PLATFORM_DISTRIBUTION, 
  GEOGRAPHIC_DISTRIBUTION 
} from '../data/mockData';

export const TrendAnalyticsView: React.FC = () => {
  const [selectedIndustryMetric, setSelectedIndustryMetric] = useState<'retail' | 'compliance' | 'proptech' | 'foodOps'>('compliance');
  const [hoveredMonth, setHoveredMonth] = useState<number | null>(null);

  // SVG Chart Dimensions for Growth Over Time
  const chartWidth = 600;
  const chartHeight = 220;
  const padding = 35;
  const maxVal = 4500;

  // Compute point coordinates for historical trend
  const getPoints = (key: 'retail' | 'compliance' | 'proptech' | 'foodOps') => {
    return HISTORICAL_DEMAND_TRENDS.map((item, idx) => {
      const x = padding + (idx * (chartWidth - 2 * padding)) / (HISTORICAL_DEMAND_TRENDS.length - 1);
      const val = item[key];
      const y = chartHeight - padding - (val / maxVal) * (chartHeight - 2 * padding);
      return { x, y, val, month: item.month };
    });
  };

  const trendPoints = getPoints(selectedIndustryMetric);
  const pathD = trendPoints.reduce((acc, p, idx) => `${acc} ${idx === 0 ? 'M' : 'L'} ${p.x} ${p.y}`, '');
  const areaD = `${pathD} L ${trendPoints[trendPoints.length - 1].x} ${chartHeight - padding} L ${trendPoints[0].x} ${chartHeight - padding} Z`;

  const matrixItems = [
    { name: 'EU AI Act Governance', demand: 'Very High (3.4k)', comp: 'Low (Niche)', growth: '+64%', type: 'Opportunity Goldmine' },
    { name: 'Multi-Store Inventory Sync', demand: 'Extreme (4.2k)', comp: 'Medium (Bloated ERPs)', growth: '+35%', type: 'Opportunity Goldmine' },
    { name: 'Kitchen Food Waste Prep', demand: 'High (1.4k)', comp: 'Low (Hardware-bound)', growth: '+28%', type: 'Opportunity Goldmine' },
    { name: 'Freelancer Invoice Chaser', demand: 'Moderate (1.9k)', comp: 'High (Many generic apps)', growth: '+18%', type: 'Competitive Crowded' },
    { name: 'Contractor Emergency Dispatch', demand: 'Moderate (1.2k)', comp: 'Low (ServiceTitan too big)', growth: '+14%', type: 'Niche High Margin' },
    { name: 'Generic Todo & Note Apps', demand: 'Declining (-12%)', comp: 'Extreme Saturation', growth: '-12%', type: 'Declining Trap' },
  ];

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Title */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl sm:text-2xl font-bold text-white">Market Trend Analytics</h1>
            <span className="rounded bg-emerald-950 px-2 py-0.5 text-xs font-mono text-emerald-400 border border-emerald-800">
              Surge Verified
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Aggregated longitudinal intelligence across 48,000+ public discussions, review portals, and code repositories.
          </p>
        </div>
        <div className="text-xs text-slate-400 font-mono">
          Updated: Today at 11:50 UTC
        </div>
      </div>

      {/* Grid: 1. Demand Growth Over Time & 2. Platform Breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left 2 Cols: Demand Growth Chart */}
        <div className="lg:col-span-2 rounded-2xl border border-slate-800 bg-slate-900/60 p-5 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-800 pb-3">
            <div>
              <h2 className="text-sm font-bold text-white flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-cyan-400" />
                Demand Growth Over Time (May - October)
              </h2>
              <p className="text-[11px] text-slate-400">Monthly complaint frequency curve by sector</p>
            </div>

            {/* Metric Switcher */}
            <div className="flex items-center gap-1 bg-slate-950 p-1 rounded-lg border border-slate-800 text-xs">
              {[
                { id: 'compliance', label: 'AI Compliance (+64%)' },
                { id: 'retail', label: 'Retail Sync (+35%)' },
                { id: 'proptech', label: 'PropTech (+22%)' },
                { id: 'foodOps', label: 'Food Waste (+28%)' },
              ].map((m) => (
                <button
                  key={m.id}
                  onClick={() => setSelectedIndustryMetric(m.id as any)}
                  className={`px-2 py-1 rounded transition-all cursor-pointer ${
                    selectedIndustryMetric === m.id
                      ? 'bg-cyan-600 text-white font-semibold shadow-xs'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          {/* SVG Line / Area Graph */}
          <div className="relative w-full overflow-hidden bg-slate-950/70 rounded-xl p-3 border border-slate-800/80">
            <svg
              viewBox={`0 0 ${chartWidth} ${chartHeight}`}
              className="w-full h-auto overflow-visible"
            >
              <defs>
                <linearGradient id="trendGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#06b6d4" stopOpacity="0.4" />
                  <stop offset="100%" stopColor="#06b6d4" stopOpacity="0.0" />
                </linearGradient>
              </defs>

              {/* Horizontal Grid lines */}
              {[1000, 2000, 3000, 4000].map((v) => {
                const y = chartHeight - padding - (v / maxVal) * (chartHeight - 2 * padding);
                return (
                  <g key={v}>
                    <line
                      x1={padding}
                      y1={y}
                      x2={chartWidth - padding}
                      y2={y}
                      stroke="#334155"
                      strokeDasharray="3 3"
                      strokeWidth="0.8"
                    />
                    <text
                      x={padding - 6}
                      y={y + 3}
                      fill="#64748b"
                      fontSize="9"
                      fontFamily="monospace"
                      textAnchor="end"
                    >
                      {v}
                    </text>
                  </g>
                );
              })}

              {/* Area Fill */}
              <path d={areaD} fill="url(#trendGradient)" />

              {/* Line */}
              <path
                d={pathD}
                fill="none"
                stroke="#06b6d4"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
              />

              {/* Points */}
              {trendPoints.map((p, idx) => (
                <g key={idx} onMouseEnter={() => setHoveredMonth(idx)} onMouseLeave={() => setHoveredMonth(null)}>
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={hoveredMonth === idx ? 6 : 4}
                    fill="#0f172a"
                    stroke="#22d3ee"
                    strokeWidth="2.5"
                    className="cursor-pointer transition-all"
                  />
                  <text
                    x={p.x}
                    y={chartHeight - 10}
                    fill="#94a3b8"
                    fontSize="10"
                    textAnchor="middle"
                    fontFamily="monospace"
                  >
                    {p.month}
                  </text>
                  {/* Tooltip bubble if hovered */}
                  {hoveredMonth === idx && (
                    <g>
                      <rect
                        x={p.x - 35}
                        y={p.y - 30}
                        width="70"
                        height="20"
                        rx="4"
                        fill="#0284c7"
                      />
                      <text
                        x={p.x}
                        y={p.y - 16}
                        fill="#ffffff"
                        fontSize="10"
                        fontWeight="bold"
                        textAnchor="middle"
                        fontFamily="monospace"
                      >
                        {p.val} talks
                      </text>
                    </g>
                  )}
                </g>
              ))}
            </svg>
          </div>

          <div className="flex items-center justify-between text-xs text-slate-400 pt-1">
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-cyan-400"></span>
              Fastest exponential acceleration: <strong>Regulatory AI Governance (+314% since May)</strong>
            </span>
            <span className="font-mono text-cyan-300">CAGR: +44.2%</span>
          </div>
        </div>

        {/* Right Col: Discussion Volume by Platform */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 space-y-4">
          <div className="border-b border-slate-800 pb-3">
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <Share2 className="h-4 w-4 text-purple-400" />
              Volume by Source Platform
            </h2>
            <p className="text-[11px] text-slate-400">Where people publicly complain about bad software</p>
          </div>

          <div className="space-y-3">
            {PLATFORM_DISTRIBUTION.map((plat) => (
              <div key={plat.platform} className="space-y-1 text-xs">
                <div className="flex justify-between items-center">
                  <span className="font-medium text-slate-200">{plat.platform}</span>
                  <div className="flex items-center gap-2 font-mono">
                    <span className="text-slate-400 text-[11px]">{plat.count}</span>
                    <span className="font-bold text-cyan-300">{plat.share}%</span>
                  </div>
                </div>
                <div className="h-2 w-full bg-slate-950 rounded-full overflow-hidden border border-slate-800">
                  <div
                    className="h-full rounded-full transition-all"
                    style={{
                      width: `${plat.share}%`,
                      backgroundColor: plat.color,
                    }}
                  ></div>
                </div>
              </div>
            ))}
          </div>

          <div className="rounded-xl bg-slate-950/80 p-3 border border-slate-800 text-[11px] text-slate-400 space-y-1">
            <p className="font-semibold text-slate-300">Research Scout Observation:</p>
            <p>Reddit accounts for 38% of unfiltered human pain point discussions, followed by X complaints tagged with competitor handles.</p>
          </div>
        </div>
      </div>

      {/* Grid: 3. Problems by Industry & 4. Problems by Geography */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Industry Breakdown */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 space-y-4">
          <div className="border-b border-slate-800 pb-3">
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <BarChart3 className="h-4 w-4 text-amber-400" />
              Problem Share by Industry
            </h2>
            <p className="text-[11px] text-slate-400">Distribution of indexed complaints across sectors</p>
          </div>

          <div className="space-y-2.5">
            {INDUSTRY_BREAKDOWN.map((ind) => (
              <div key={ind.name} className="space-y-1 text-xs">
                <div className="flex justify-between items-center">
                  <span className="text-slate-300 font-medium">{ind.name}</span>
                  <div className="flex items-center gap-2 font-mono">
                    <span className="text-emerald-400 font-bold">{ind.growth}</span>
                    <span className="text-slate-400 text-[11px]">{ind.count}</span>
                    <span className="text-white font-bold">{ind.percentage}%</span>
                  </div>
                </div>
                <div className="h-1.5 w-full bg-slate-950 rounded-full overflow-hidden border border-slate-800">
                  <div
                    className="h-full bg-gradient-to-r from-amber-500 to-yellow-400 rounded-full"
                    style={{ width: `${ind.percentage * 3.2}%` }}
                  ></div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Geographic Distribution */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 space-y-4">
          <div className="border-b border-slate-800 pb-3">
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <Globe2 className="h-4 w-4 text-blue-400" />
              Geographic Concentration
            </h2>
            <p className="text-[11px] text-slate-400">Where affected business operators and users are located</p>
          </div>

          <div className="space-y-3">
            {GEOGRAPHIC_DISTRIBUTION.map((geo) => (
              <div key={geo.region} className="rounded-xl bg-slate-950/60 p-3 border border-slate-800 space-y-1.5 text-xs">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-white">{geo.region}</span>
                  <span className="font-mono text-cyan-300 font-bold">{geo.percentage}%</span>
                </div>
                <div className="h-1.5 w-full bg-slate-900 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-blue-500 rounded-full"
                    style={{ width: `${geo.percentage}%` }}
                  ></div>
                </div>
                <div className="text-[10px] text-slate-400 font-mono">
                  {geo.volume}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 5. Emerging vs Declining & Competition vs Demand Matrix */}
      <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 space-y-4">
        <div className="border-b border-slate-800 pb-3 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              <Layers className="h-4 w-4 text-emerald-400" />
              Competition vs. Demand Quadrant Matrix
            </h2>
            <p className="text-[11px] text-slate-400">
              The builder's sweet spot: High Market Demand + Low or Vulnerable Incumbent Competition.
            </p>
          </div>
          <span className="text-xs font-mono text-emerald-400 bg-emerald-950 px-2 py-0.5 rounded border border-emerald-800">
            Wedge Opportunity Map
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {matrixItems.map((item, idx) => (
            <div
              key={idx}
              className={`rounded-xl border p-4 space-y-2 text-xs transition-all ${
                item.type === 'Opportunity Goldmine'
                  ? 'border-emerald-500/40 bg-emerald-950/15'
                  : item.type === 'Niche High Margin'
                  ? 'border-cyan-500/40 bg-cyan-950/15'
                  : item.type === 'Competitive Crowded'
                  ? 'border-amber-500/40 bg-amber-950/15'
                  : 'border-rose-500/40 bg-rose-950/15 opacity-70'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="font-bold text-white">{item.name}</span>
                <span className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold ${
                  item.growth.startsWith('+') ? 'bg-emerald-950 text-emerald-300' : 'bg-rose-950 text-rose-300'
                }`}>
                  {item.growth}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2 text-[11px] pt-1">
                <div>
                  <span className="text-slate-400 block text-[10px]">Demand Signal:</span>
                  <span className="font-mono text-slate-200">{item.demand}</span>
                </div>
                <div>
                  <span className="text-slate-400 block text-[10px]">Incumbent Comp:</span>
                  <span className="font-mono text-slate-200">{item.comp}</span>
                </div>
              </div>

              <div className="pt-2 border-t border-slate-800/80 flex items-center justify-between text-[11px]">
                <span className="text-slate-400">Quadrant Status:</span>
                <strong className={
                  item.type === 'Opportunity Goldmine' ? 'text-emerald-300' :
                  item.type === 'Niche High Margin' ? 'text-cyan-300' :
                  item.type === 'Competitive Crowded' ? 'text-amber-300' : 'text-rose-400'
                }>
                  {item.type}
                </strong>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
