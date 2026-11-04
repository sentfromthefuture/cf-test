import React, { useState } from 'react';
import { 
  X, 
  Check, 
  Sparkles, 
  Crown, 
  Lock, 
  TrendingUp, 
  Zap, 
  Shield, 
  Calculator,
  ArrowRight
} from 'lucide-react';
import { PricingTier } from '../types';

interface PricingModalProps {
  isOpen: boolean;
  onClose: () => void;
  activePlan: PricingTier;
  onSelectPlan: (plan: PricingTier) => void;
  onOpenCheckout: (tier: PricingTier) => void;
}

export const PricingModal: React.FC<PricingModalProps> = ({
  isOpen,
  onClose,
  activePlan,
  onSelectPlan,
  onOpenCheckout,
}) => {
  const [simSubscribers, setSimSubscribers] = useState<number>(1000);
  const [simPrice, setSimPrice] = useState<number>(29);

  if (!isOpen) return null;

  const tiers: {
    tier: PricingTier;
    price: string;
    period: string;
    badge?: string;
    highlight?: boolean;
    description: string;
    features: { text: string; included: boolean }[];
  }[] = [
    {
      tier: 'Free',
      price: '$0',
      period: 'forever',
      description: 'Discover high-level trends and basic problem descriptions across communities.',
      features: [
        { text: 'Browse public opportunities', included: true },
        { text: 'Basic problem descriptions', included: true },
        { text: 'Top 3 opportunity rankings', included: true },
        { text: 'Historical demand trend graphs', included: false },
        { text: 'Full competitor vulnerability matrix', included: false },
        { text: 'Development-ready PRD specifications', included: false },
        { text: 'Export research (Markdown / JSON)', included: false },
        { text: 'Autonomous scout bot custom alerts', included: false },
      ],
    },
    {
      tier: 'Starter',
      price: '$9',
      period: 'per month',
      description: 'Ideal for solo developers testing initial ideas and exploring historical demand.',
      features: [
        { text: 'Browse all opportunities', included: true },
        { text: 'Basic problem descriptions', included: true },
        { text: 'Full opportunity rankings', included: true },
        { text: 'Historical demand trend graphs', included: true },
        { text: 'Limited competitor analysis', included: true },
        { text: 'Development-ready PRD specifications', included: false },
        { text: 'Export research (Markdown / JSON)', included: false },
        { text: 'Autonomous scout bot custom alerts', included: false },
      ],
    },
    {
      tier: 'Pro',
      price: '$29',
      period: 'per month',
      badge: 'MOST POPULAR',
      highlight: true,
      description: 'The standard intelligence suite for serious indie hackers and startup founders.',
      features: [
        { text: 'Browse all opportunities', included: true },
        { text: 'Full problem & persona profiles', included: true },
        { text: 'Complete opportunity rankings & scores', included: true },
        { text: 'Full historical demand graphs & charts', included: true },
        { text: 'Full competitor vulnerability analysis', included: true },
        { text: 'Development-ready 3-week MVP specs', included: true },
        { text: 'Export research (Markdown / JSON / PRD)', included: true },
        { text: 'Weekly emerging problem digest', included: true },
      ],
    },
    {
      tier: 'Business',
      price: '$79',
      period: 'per month',
      badge: 'VENTURE & AGENCIES',
      description: 'Built for software agencies, venture studios, and product discovery teams.',
      features: [
        { text: 'Everything in Pro tier', included: true },
        { text: 'Direct REST API access to problem database', included: true },
        { text: 'Custom keyword & sub-reddit tracking bots', included: true },
        { text: 'Raw sentiment & discussion dumps', included: true },
        { text: 'White-label client presentation briefs', included: true },
        { text: 'Priority Gemini PRD generation queue', included: true },
        { text: 'Multi-seat team workspace (5 seats)', included: true },
        { text: 'Physical business & supply-chain signals', included: true },
      ],
    },
  ];

  const projectedMRR = simSubscribers * simPrice;
  const projectedARR = projectedMRR * 12;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in">
      <div className="relative w-full max-w-5xl rounded-2xl border border-slate-800 bg-slate-900 shadow-2xl overflow-hidden flex flex-col max-h-[92vh]">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-slate-800 px-6 py-4 bg-slate-950/70">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-950 border border-amber-800/80 text-amber-400">
              <Crown className="h-5 w-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base font-bold text-white">DemandRadar Monetization & Gating</h2>
                <span className="rounded bg-cyan-950 px-2 py-0.5 text-[10px] font-mono text-cyan-300 border border-cyan-800">
                  Business Model Engine
                </span>
              </div>
              <p className="text-xs text-slate-400">
                You're not selling software development. You're selling validated market insight.
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white transition-colors cursor-pointer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {/* Economics of Insight callout */}
          <div className="rounded-xl border border-amber-500/30 bg-gradient-to-r from-amber-950/30 via-slate-900 to-cyan-950/30 p-4">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
              <div className="space-y-1">
                <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-400">
                  <Zap className="h-3.5 w-3.5" />
                  The Economic Thesis
                </span>
                <h3 className="text-sm font-bold text-white">
                  Why Developers Gladly Pay $29/Month
                </h3>
                <p className="text-xs text-slate-300 max-w-2xl">
                  Developers waste 3-6 months and $10k+ building tools nobody wants. One single validated human problem with verified willingness-to-pay easily justifies a $29 subscription.
                </p>
              </div>

              {/* Quick switch simulator */}
              <div className="bg-slate-950/80 p-3 rounded-lg border border-slate-800 shrink-0 text-right">
                <div className="text-[11px] text-slate-400 mb-1">Simulate Current App Session:</div>
                <div className="flex items-center gap-1.5">
                  {(['Free', 'Starter', 'Pro', 'Business'] as PricingTier[]).map((tier) => (
                    <button
                      key={tier}
                      onClick={() => onSelectPlan(tier)}
                      className={`px-2.5 py-1 rounded text-xs font-semibold transition-all cursor-pointer ${
                        activePlan === tier
                          ? 'bg-amber-500 text-slate-950 shadow-sm'
                          : 'bg-slate-900 text-slate-400 hover:text-white border border-slate-800'
                      }`}
                    >
                      {tier}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* Pricing Grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {tiers.map((t) => {
              const isCurrent = activePlan === t.tier;
              return (
                <div
                  key={t.tier}
                  className={`rounded-xl border p-4 flex flex-col justify-between transition-all ${
                    t.highlight
                      ? 'border-cyan-500 bg-slate-900/90 shadow-lg shadow-cyan-500/10 ring-1 ring-cyan-500/30'
                      : isCurrent
                      ? 'border-amber-500/80 bg-slate-900/80'
                      : 'border-slate-800 bg-slate-950/60 hover:border-slate-700'
                  }`}
                >
                  <div>
                    {/* Badge */}
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-xs font-bold uppercase tracking-wider text-slate-300">{t.tier}</span>
                      {t.badge && (
                        <span className="rounded bg-cyan-950 text-cyan-300 px-2 py-0.5 text-[9px] font-mono font-bold border border-cyan-800">
                          {t.badge}
                        </span>
                      )}
                    </div>

                    <div className="flex items-baseline gap-1 mb-2">
                      <span className="text-2xl font-black font-mono text-white">{t.price}</span>
                      <span className="text-xs text-slate-400">/{t.period}</span>
                    </div>

                    <p className="text-xs text-slate-400 mb-4 min-h-[36px]">{t.description}</p>

                    {/* Features list */}
                    <div className="border-t border-slate-800/80 pt-3 space-y-2 text-xs">
                      {t.features.map((feat, idx) => (
                        <div key={idx} className="flex items-start gap-2">
                          {feat.included ? (
                            <Check className="h-3.5 w-3.5 text-cyan-400 shrink-0 mt-0.5" />
                          ) : (
                            <Lock className="h-3.5 w-3.5 text-slate-600 shrink-0 mt-0.5" />
                          )}
                          <span className={feat.included ? 'text-slate-300' : 'text-slate-600'}>
                            {feat.text}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>

                  <div className="mt-5 pt-3 border-t border-slate-800/60 space-y-1.5">
                    <button
                      onClick={() => {
                        if (t.tier === 'Free') {
                          onSelectPlan(t.tier);
                        } else {
                          onOpenCheckout(t.tier);
                        }
                      }}
                      className={`w-full py-2 px-3 rounded-lg text-xs font-bold transition-all cursor-pointer ${
                        isCurrent
                          ? 'bg-emerald-950 text-emerald-300 border border-emerald-700 cursor-default'
                          : t.highlight
                          ? 'bg-cyan-500 text-slate-950 hover:bg-cyan-400 font-bold shadow-md shadow-cyan-500/20'
                          : 'bg-slate-800 text-slate-200 hover:bg-slate-700'
                      }`}
                    >
                      {isCurrent ? 'Active Plan' : t.tier === 'Free' ? 'Switch to Free' : `Subscribe (${t.price}/mo)`}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Interactive MRR Projection Calculator */}
          <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4">
            <div className="flex items-center gap-2 mb-3">
              <Calculator className="h-4 w-4 text-cyan-400" />
              <h4 className="text-xs font-bold uppercase tracking-wider text-white">
                Platform Economics: Subscription Revenue Calculator
              </h4>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-center">
              <div>
                <div className="flex justify-between text-xs text-slate-400 mb-1">
                  <span>Subscribers</span>
                  <span className="font-mono text-cyan-400 font-bold">{simSubscribers.toLocaleString()}</span>
                </div>
                <input
                  type="range"
                  min={100}
                  max={10000}
                  step={100}
                  value={simSubscribers}
                  onChange={(e) => setSimSubscribers(parseInt(e.target.value, 10))}
                  className="w-full accent-cyan-400 h-1.5 bg-slate-800 rounded-lg cursor-pointer"
                />
              </div>

              <div>
                <div className="flex justify-between text-xs text-slate-400 mb-1">
                  <span>Average Subscription Price</span>
                  <span className="font-mono text-amber-400 font-bold">${simPrice}/mo</span>
                </div>
                <input
                  type="range"
                  min={9}
                  max={79}
                  step={10}
                  value={simPrice}
                  onChange={(e) => setSimPrice(parseInt(e.target.value, 10))}
                  className="w-full accent-amber-400 h-1.5 bg-slate-800 rounded-lg cursor-pointer"
                />
              </div>

              <div className="rounded-lg bg-slate-900 border border-slate-800 p-3 text-center sm:text-right">
                <span className="text-[10px] text-slate-400 uppercase tracking-wider block">Estimated Annual Run-Rate</span>
                <div className="text-xl font-mono font-black text-emerald-400">
                  ${projectedARR.toLocaleString()} <span className="text-xs font-sans text-slate-400 font-normal">/yr</span>
                </div>
                <span className="text-[11px] font-mono text-cyan-300">
                  (${projectedMRR.toLocaleString()} MRR)
                </span>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-slate-800 px-6 py-3 bg-slate-950 flex items-center justify-between text-xs text-slate-400">
          <span>Stripe Checkout integration ready for deployment</span>
          <button
            onClick={onClose}
            className="rounded-lg bg-slate-800 px-4 py-1.5 text-xs font-medium text-white hover:bg-slate-700 transition-colors cursor-pointer"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
};
