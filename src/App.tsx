import React, { useState, useEffect } from 'react';
import { Navbar } from './components/Navbar';
import { DashboardView } from './components/DashboardView';
import { ProblemExplorerView } from './components/ProblemExplorerView';
import { OpportunityIntelligenceView } from './components/OpportunityIntelligenceView';
import { TrendAnalyticsView } from './components/TrendAnalyticsView';
import { AiGeneratorView } from './components/AiGeneratorView';
import { ScoringCalculatorModal } from './components/ScoringCalculatorModal';
import { BotSwarmModal } from './components/BotSwarmModal';
import { PricingModal } from './components/PricingModal';
import { PaymentModal } from './components/PaymentModal';
import { supabase } from './lib/supabase';
import { canOpenOpportunity } from './lib/access';
import { Opportunity, BotScout, ScoringWeights, PricingTier } from './types';
import { INITIAL_OPPORTUNITIES, INITIAL_BOTS, DEFAULT_WEIGHTS, calculateCustomScore } from './data/mockData';
import { Radar, Bot, Sparkles, Sliders, Crown, Layers, ArrowUpRight } from 'lucide-react';

export default function App() {
  const [currentTab, setCurrentTab] = useState<string>('dashboard');
  const [weights, setWeights] = useState<ScoringWeights>(DEFAULT_WEIGHTS);
  const [opportunities, setOpportunities] = useState<Opportunity[]>(INITIAL_OPPORTUNITIES);
  const [selectedOpportunity, setSelectedOpportunity] = useState<Opportunity>(INITIAL_OPPORTUNITIES[0]);
  const [bots, setBots] = useState<BotScout[]>(INITIAL_BOTS);
  const [activePlan, setActivePlan] = useState<PricingTier>('Free');
  const [signedIn, setSignedIn] = useState(false);
  const [isAuthOpen, setIsAuthOpen] = useState(false);

  // The plan comes from the server (Supabase), never from the browser.
  useEffect(() => {
    let alive = true;
    const load = async (uid?: string): Promise<PricingTier> => {
      if (!uid) return 'Free';
      const { data } = await supabase.from('subscriptions').select('plan,status,current_period_end').eq('user_id', uid).maybeSingle();
      const live = data && (data.status === 'active' || (data.status === 'cancelled' && data.current_period_end && new Date(data.current_period_end) > new Date()));
      return (live ? data.plan : 'Free') as PricingTier;
    };
    const sync = async (uid?: string) => {
      setSignedIn(!!uid);
      let plan = await load(uid);
      const returning = new URLSearchParams(window.location.search).has('checkout');
      for (let i = 0; uid && returning && plan === 'Free' && i < 10; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        plan = await load(uid);
      }
      if (alive) setActivePlan(plan);
    };
    supabase.auth.getSession().then(({ data }) => sync(data.session?.user.id));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => { sync(s?.user.id); });
    return () => { alive = false; sub.subscription.unsubscribe(); };
  }, []);

  // Modals
  const [isScoringOpen, setIsScoringOpen] = useState(false);
  const [isBotsOpen, setIsBotsOpen] = useState(false);
  const [isPricingOpen, setIsPricingOpen] = useState(false);
  const [isPaymentOpen, setIsPaymentOpen] = useState(false);
  const [checkoutTier, setCheckoutTier] = useState<PricingTier>('Pro');

  // Sync opportunity score updates when weights change
  const handleUpdateWeights = (newWeights: ScoringWeights) => {
    setWeights(newWeights);
    const updated = opportunities.map((opp) => {
      const newScore = calculateCustomScore(opp.scores, newWeights);
      return {
        ...opp,
        scores: {
          ...opp.scores,
          compositeScore: newScore,
        },
      };
    });
    setOpportunities(updated);
    // Also update selectedOpportunity if present
    const currentSelected = updated.find(o => o.id === selectedOpportunity.id);
    if (currentSelected) {
      setSelectedOpportunity(currentSelected);
    }
  };

  // Select opportunity and switch directly to Intelligence dossier view
  // Free plan: scoring tools, scout bots and all but the top 3 dossiers lead to the pricing screen.
  const openScoring = () => (activePlan === 'Free' ? setIsPricingOpen(true) : setIsScoringOpen(true));
  const openBots = () => (activePlan === 'Free' ? setIsPricingOpen(true) : setIsBotsOpen(true));
  const handleSelectOpportunity = (opp: Opportunity) => {
    if (!canOpenOpportunity(activePlan, opp, opportunities)) { setIsPricingOpen(true); return; }
    setSelectedOpportunity(opp);
    setCurrentTab('intelligence');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col font-sans selection:bg-cyan-500/30 selection:text-cyan-200">
      {/* Top Navbar */}
      <Navbar
        currentTab={currentTab}
        setCurrentTab={setCurrentTab}
        activePlan={activePlan}
        onOpenPricing={() => setIsPricingOpen(true)}
        onOpenScoring={() => openScoring()}
        onOpenBots={() => openBots()}
      />

      {/* Main Content Area */}
      <main className="flex-1 mx-auto w-full max-w-7xl px-4 py-6 sm:px-6">
        {currentTab === 'dashboard' && (
          <DashboardView
            opportunities={opportunities}
            bots={bots}
            onSelectOpportunity={handleSelectOpportunity}
            onNavigateTab={setCurrentTab}
            onOpenBots={() => openBots()}
            onOpenScoring={() => openScoring()}
            activePlan={activePlan}
          />
        )}

        {currentTab === 'explorer' && (
          <ProblemExplorerView
            opportunities={opportunities}
            onSelectOpportunity={handleSelectOpportunity}
            activePlan={activePlan}
            onOpenPricing={() => setIsPricingOpen(true)}
          />
        )}

        {currentTab === 'intelligence' && (
          <OpportunityIntelligenceView
            opportunity={selectedOpportunity}
            allOpportunities={opportunities}
            onSelectOpportunity={(o) => { if (canOpenOpportunity(activePlan, o, opportunities)) setSelectedOpportunity(o); else setIsPricingOpen(true); }}
            activePlan={activePlan}
            onOpenPricing={() => setIsPricingOpen(true)}
            onOpenScoring={() => openScoring()}
            onOpenPayment={(tier) => {
              setCheckoutTier(tier);
              setIsPaymentOpen(true);
            }}
          />
        )}

        {currentTab === 'trends' && (
          <TrendAnalyticsView activePlan={activePlan} onOpenPricing={() => setIsPricingOpen(true)} />
        )}

        {currentTab === 'ai-generator' && (
          <AiGeneratorView activePlan={activePlan} onOpenPricing={() => setIsPricingOpen(true)} />
        )}
      </main>

      {/* Modals */}
      <ScoringCalculatorModal
        isOpen={isScoringOpen}
        onClose={() => setIsScoringOpen(false)}
        weights={weights}
        onUpdateWeights={handleUpdateWeights}
      />

      <BotSwarmModal
        isOpen={isBotsOpen}
        onClose={() => setIsBotsOpen(false)}
        bots={bots}
      />

      <PricingModal
        isOpen={isPricingOpen}
        onClose={() => setIsPricingOpen(false)}
        activePlan={activePlan}
        onSelectPlan={(plan) => {
          setIsPricingOpen(false);
          if (plan !== 'Free') { setCheckoutTier(plan); setIsPaymentOpen(true); }
        }}
        onOpenCheckout={(tier) => {
          setCheckoutTier(tier);
          setIsPricingOpen(false);
          setIsPaymentOpen(true);
        }}
      />

      <PaymentModal
        isOpen={isPaymentOpen}
        onClose={() => setIsPaymentOpen(false)}
        selectedTier={checkoutTier}
      />
      <PaymentModal isOpen={isAuthOpen} onClose={() => setIsAuthOpen(false)} selectedTier="Free" authOnly />
      <button
        onClick={() => setIsAuthOpen(true)}
        className="fixed bottom-4 right-4 z-40 rounded-full border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-200 hover:bg-slate-800 cursor-pointer"
      >
        {signedIn ? 'Account' : 'Sign in'}
      </button>

      {/* Footer & Strategic Business Model Insights */}
      <footer className="border-t border-slate-900 bg-slate-950 py-10 px-4 sm:px-6 mt-12 text-xs text-slate-400">
        <div className="mx-auto max-w-7xl space-y-6">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-6 border-b border-slate-900 pb-6">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                <Radar className="h-4 w-4 text-cyan-400" />
                <span className="font-bold text-white text-sm">DemandRadar</span>
                <span className="text-slate-600">|</span>
                <span className="text-slate-400">Autonomous Market Intelligence Platform</span>
              </div>
              <p className="text-slate-500 max-w-xl">
                Selling validated business opportunities and human problem intelligence to software builders, indie developers, and venture studios.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={() => openBots()}
                className="flex items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-1.5 text-xs text-slate-300 hover:text-white hover:border-slate-700 transition-colors cursor-pointer"
              >
                <Bot className="h-3.5 w-3.5 text-cyan-400" />
                10 Autonomous Bots
              </button>
              <button
                onClick={() => openScoring()}
                className="flex items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-1.5 text-xs text-slate-300 hover:text-white hover:border-slate-700 transition-colors cursor-pointer"
              >
                <Sliders className="h-3.5 w-3.5 text-slate-400" />
                Scoring Engine
              </button>
              <button
                onClick={() => setIsPricingOpen(true)}
                className="flex items-center gap-1.5 rounded-lg border border-amber-500/30 bg-amber-950/20 px-3 py-1.5 text-xs text-amber-300 hover:bg-amber-950/40 transition-colors cursor-pointer"
              >
                <Crown className="h-3.5 w-3.5 text-amber-400" />
                Pricing Tiers
              </button>
              <button
                onClick={() => {
                  setCheckoutTier('Pro');
                  setIsPaymentOpen(true);
                }}
                className="flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-950/30 px-3 py-1.5 text-xs text-emerald-300 hover:bg-emerald-950/50 transition-colors cursor-pointer font-semibold"
              >
                <span>PayPal & Binance Gateway</span>
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 text-[11px] text-slate-500">
            <div>
              <span className="text-slate-300 font-semibold block mb-1">Developer Economics</span>
              <p>
                Developers spend months searching for ideas. DemandRadar continuously researches what people struggle with and sells the intelligence. 1,000 subscribers x $29/mo = $29,000 MRR.
              </p>
            </div>

            <div>
              <span className="text-slate-300 font-semibold block mb-1">Accumulated Data Advantage</span>
              <p>
                A continuously updating repository of 100,000 human problems, 50,000 competitor vulnerabilities, and historical demand shifts across Reddit, X, GitHub, and review portals.
              </p>
            </div>

            <div>
              <span className="text-slate-300 font-semibold block mb-1">Phase 5 Vision</span>
              <p>
                Expanding beyond software into physical businesses, manufacturing, logistics, and services to pinpoint where existing markets are failing globally.
              </p>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pt-4 border-t border-slate-900/80 text-[10px] text-slate-600">
            <span>© 2026 DemandRadar Systems. Autonomous research bots operate under public API compliance.</span>
            <span className="font-mono text-cyan-500/80">Signal-to-Noise Ratio: 99.4% Verified</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
