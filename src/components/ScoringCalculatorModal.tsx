import React from 'react';
import { X, Sliders, RotateCcw, Check, Sparkles, AlertCircle, Info } from 'lucide-react';
import { ScoringWeights } from '../types';
import { DEFAULT_WEIGHTS } from '../data/mockData';

interface ScoringCalculatorModalProps {
  isOpen: boolean;
  onClose: () => void;
  weights: ScoringWeights;
  onUpdateWeights: (newWeights: ScoringWeights) => void;
}

export const ScoringCalculatorModal: React.FC<ScoringCalculatorModalProps> = ({
  isOpen,
  onClose,
  weights,
  onUpdateWeights,
}) => {
  if (!isOpen) return null;

  const totalWeight =
    weights.problemFrequency +
    weights.demandGrowth +
    weights.painIntensity +
    weights.willingnessToPay +
    weights.competitionGap +
    weights.developmentFeasibility;

  const metrics = [
    {
      key: 'problemFrequency' as keyof ScoringWeights,
      label: 'Problem Frequency',
      desc: 'Raw volume of independent recurring discussions across GitHub, Hacker News and Stack Exchange',
      color: 'from-blue-500 to-cyan-500',
    },
    {
      key: 'demandGrowth' as keyof ScoringWeights,
      label: 'Demand Growth Rate',
      desc: 'Month-over-month acceleration in complaints and search queries',
      color: 'from-emerald-500 to-teal-500',
    },
    {
      key: 'painIntensity' as keyof ScoringWeights,
      label: 'Pain Intensity',
      desc: 'Emotional urgency, financial loss rate, and operational disruption level',
      color: 'from-rose-500 to-pink-500',
    },
    {
      key: 'willingnessToPay' as keyof ScoringWeights,
      label: 'Willingness to Pay',
      desc: 'Verifiable signals of budget allocation, commercial intent, and pricing elasticity',
      color: 'from-amber-500 to-yellow-500',
    },
    {
      key: 'competitionGap' as keyof ScoringWeights,
      label: 'Competition Gap',
      desc: 'Weakness, bloat, or absence of incumbents addressing this specific wedge',
      color: 'from-purple-500 to-indigo-500',
    },
    {
      key: 'developmentFeasibility' as keyof ScoringWeights,
      label: 'Development Feasibility',
      desc: 'Realistic time-to-MVP for a small engineering team or solo builder (1-4 weeks)',
      color: 'from-sky-500 to-blue-600',
    },
  ];

  const presets = [
    {
      name: 'Default Balanced',
      desc: 'DemandRadar standard commercial model',
      weights: DEFAULT_WEIGHTS,
    },
    {
      name: 'Solo Bootstrapper',
      desc: 'Favors quick MVP feasibility & immediate willingness to pay',
      weights: {
        problemFrequency: 15,
        demandGrowth: 15,
        painIntensity: 25,
        willingnessToPay: 20,
        competitionGap: 10,
        developmentFeasibility: 30, // Solo can ship fast!
      },
    },
    {
      name: 'Venture Scale',
      desc: 'Favors massive recurring volume & hyper-growth curves',
      weights: {
        problemFrequency: 30,
        demandGrowth: 30,
        painIntensity: 15,
        willingnessToPay: 15,
        competitionGap: 5,
        developmentFeasibility: 5,
      },
    },
    {
      name: 'High-ACV B2B',
      desc: 'Maximizes commercial willingness to pay & acute enterprise pain',
      weights: {
        problemFrequency: 15,
        demandGrowth: 15,
        painIntensity: 30,
        willingnessToPay: 30,
        competitionGap: 5,
        developmentFeasibility: 5,
      },
    },
  ];

  const handleChange = (key: keyof ScoringWeights, value: number) => {
    onUpdateWeights({
      ...weights,
      [key]: value,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in">
      <div className="relative w-full max-w-2xl rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4 bg-slate-950/60">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-cyan-950 border border-cyan-800/60 text-cyan-400">
              <Sliders className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white flex items-center gap-2">
                Opportunity Scoring Algorithm
                <span className="text-xs font-mono font-normal text-cyan-400 bg-cyan-950/80 px-2 py-0.5 rounded border border-cyan-800">
                  Formula Engine
                </span>
              </h2>
              <p className="text-xs text-slate-400">
                Transparent 6-factor commercial evaluation algorithm. Calibrate to your team profile.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white transition-colors"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {/* Formula summary */}
          <div className="rounded-xl border border-cyan-900/40 bg-cyan-950/20 p-4">
            <div className="flex items-start gap-3">
              <Info className="h-4 w-4 text-cyan-400 shrink-0 mt-0.5" />
              <div className="text-xs text-slate-300 space-y-1">
                <p className="font-semibold text-cyan-300">
                  Transparent Weighted Evidence Formula:
                </p>
                <p className="font-mono text-[11px] text-slate-400 bg-slate-950/80 p-2 rounded border border-slate-800/80">
                  Score = (Freq × {weights.problemFrequency} + Growth × {weights.demandGrowth} + Pain × {weights.painIntensity} + WTP × {weights.willingnessToPay} + Comp × {weights.competitionGap} + Feasibility × {weights.developmentFeasibility}) ÷ {totalWeight}
                </p>
                <p className="text-[11px] text-slate-400">
                  Total weight sum: <strong className={totalWeight === 100 ? 'text-emerald-400 font-mono' : 'text-amber-400 font-mono'}>{totalWeight}%</strong> {totalWeight !== 100 && '(auto-normalized to 100-point scale)'}
                </p>
              </div>
            </div>
          </div>

          {/* Quick Preset Buttons */}
          <div>
            <label className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2 block">
              Strategy Presets
            </label>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {presets.map((preset) => {
                const isSelected = JSON.stringify(weights) === JSON.stringify(preset.weights);
                return (
                  <button
                    key={preset.name}
                    onClick={() => onUpdateWeights(preset.weights)}
                    className={`text-left p-2.5 rounded-lg border text-xs transition-all cursor-pointer ${
                      isSelected
                        ? 'border-cyan-500 bg-cyan-950/60 text-white shadow-sm'
                        : 'border-slate-800 bg-slate-950/50 text-slate-300 hover:border-slate-700 hover:bg-slate-800/50'
                    }`}
                  >
                    <div className="font-semibold flex items-center justify-between">
                      {preset.name}
                      {isSelected && <Check className="h-3 w-3 text-cyan-400" />}
                    </div>
                    <div className="text-[10px] text-slate-400 mt-1 line-clamp-2">
                      {preset.desc}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Sliders */}
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <label className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                Calibrate Metric Weights
              </label>
              <button
                onClick={() => onUpdateWeights(DEFAULT_WEIGHTS)}
                className="flex items-center gap-1 text-[11px] text-cyan-400 hover:text-cyan-300 cursor-pointer"
              >
                <RotateCcw className="h-3 w-3" />
                Reset to Default
              </button>
            </div>

            {metrics.map((metric) => {
              const val = weights[metric.key];
              return (
                <div key={metric.key} className="rounded-xl border border-slate-800/80 bg-slate-950/40 p-3.5 space-y-2">
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="text-xs font-bold text-slate-200">{metric.label}</span>
                      <p className="text-[11px] text-slate-400">{metric.desc}</p>
                    </div>
                    <span className="font-mono text-sm font-bold text-cyan-400 bg-slate-900 border border-slate-800 px-2 py-0.5 rounded">
                      {val}%
                    </span>
                  </div>

                  <div className="flex items-center gap-3">
                    <input
                      type="range"
                      min={0}
                      max={50}
                      step={5}
                      value={val}
                      onChange={(e) => handleChange(metric.key, parseInt(e.target.value, 10))}
                      className="w-full accent-cyan-400 h-1.5 bg-slate-800 rounded-lg cursor-pointer"
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-slate-800 px-6 py-4 bg-slate-950 flex items-center justify-between">
          <p className="text-[11px] text-slate-400 flex items-center gap-1.5">
            <Sparkles className="h-3.5 w-3.5 text-cyan-400" />
            Rankings recalculate across the entire database in real-time.
          </p>
          <button
            onClick={onClose}
            className="rounded-lg bg-cyan-600 px-4 py-2 text-xs font-semibold text-white hover:bg-cyan-500 shadow-md shadow-cyan-600/20 transition-all cursor-pointer"
          >
            Apply Algorithm
          </button>
        </div>
      </div>
    </div>
  );
};
