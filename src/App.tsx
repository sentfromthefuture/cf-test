import React, { useState, useEffect } from 'react';
import { Navbar } from './components/Navbar';
import { LandingView } from './components/LandingView';
import { AccountView } from './components/AccountView';
import { DashboardView } from './components/DashboardView';
import { ProblemExplorerView } from './components/ProblemExplorerView';
import { OpportunityIntelligenceView } from './components/OpportunityIntelligenceView';
import { TrendAnalyticsView } from './components/TrendAnalyticsView';
import { AiGeneratorView } from './components/AiGeneratorView';
import { ScoringCalculatorModal } from './components/ScoringCalculatorModal';
import { DataSourcesView } from './components/DataSourcesView';
import { ResearchActivityView } from './components/ResearchActivityView';
import { PricingModal } from './components/PricingModal';
import { PaymentModal } from './components/PaymentModal';
import { supabase } from './lib/supabase';
import { canOpenOpportunity } from './lib/access';
import { Opportunity, ScoringWeights, PricingTier } from './types';
import { Activity, clusterToOpportunity, ClusterRow, fetchActivity, fetchClusters, fetchEvidence, fetchIsAdmin, fetchOverview, fetchRecentSignals, fetchSources, Overview, RecentSignal, SourceInfo } from './lib/liveData';
import { INITIAL_OPPORTUNITIES, DEFAULT_WEIGHTS, calculateCustomScore } from './data/mockData';
import { Radar, Database, Sliders, Crown, FlaskConical } from 'lucide-react';

export type LiveStatus = 'loading' | 'unavailable' | 'ready';

/** Weighted mean over the components that actually have data (same rule the database uses for the stored composite). */
const recompute = (opp: Opportunity, w: ScoringWeights): number => {
  if (!opp.live) return calculateCustomScore(opp.scores, w);
  const keys = ['problemFrequency', 'demandGrowth', 'painIntensity', 'willingnessToPay', 'competitionGap', 'developmentFeasibility'] as const;
  let acc = 0, wsum = 0;
  for (const k of keys) {
    if (opp.live.basis[k] === 'insufficient_data') continue;
    acc += w[k] * opp.scores[k];
    wsum += w[k];
  }
  return wsum > 0 ? Math.round(acc / wsum) : 0;
};

export default function App() {
  const [currentTab, setTabState] = useState<string>(() => new URLSearchParams(window.location.search).get('tab') === 'account' ? 'account' : 'landing');
  // Keep in-app navigation in browser history for Android and browser Back.
  const navigateToTab = React.useCallback((tab: string) => {
    if (tab === currentTab) return;
    window.history.pushState({ ...(window.history.state ?? {}), demandRadarTab: tab }, '', window.location.href);
    setTabState(tab);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [currentTab]);
  useEffect(() => {
    if (window.history.state?.demandRadarTab !== currentTab) {
      window.history.replaceState({ ...(window.history.state ?? {}), demandRadarTab: currentTab }, '', window.location.href);
    }
  }, [currentTab]);
  useEffect(() => {
    const handlePopState = (event: PopStateEvent) => {
      const previousTab = event.state?.demandRadarTab;
      if (typeof previousTab === 'string') setTabState(previousTab);
    };
    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);
  const [weights, setWeights] = useState<ScoringWeights>(DEFAULT_WEIGHTS);
  const [opportunities, setOpportunities] = useState<Opportunity[]>(INITIAL_OPPORTUNITIES);
  const [selectedOpportunity, setSelectedOpportunity] = useState<Opportunity>(INITIAL_OPPORTUNITIES[0]);
  // ---- live collection data (real database queries; demo opportunities are only a labelled fallback)
  const [liveStatus, setLiveStatus] = useState<LiveStatus>('loading');
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [activity, setActivity] = useState<Activity | null>(null);
  const [recent, setRecent] = useState<RecentSignal[]>([]);
  const [emerging, setEmerging] = useState<ClusterRow[]>([]);
  const [isDemo, setIsDemo] = useState(true);
  const [isAdmin, setIsAdmin] = useState(false);
  const [activePlan, setActivePlan] = useState<PricingTier>('Free');
  const [signedIn, setSignedIn] = useState(false);
  const [isAuthOpen, setIsAuthOpen] = useState(false);

  // Subscription and usage are read through the authenticated server endpoint.
  // RLS is enabled on billing tables without client policies, so never query them directly here.
  useEffect(() => {
    let alive = true;
    const load = async (accessToken?: string): Promise<PricingTier> => {
      if (!accessToken) return 'Free';
      const response = await fetch('/api/account', { headers: { Authorization: `Bearer ${accessToken}` }, cache: 'no-store' });
      if (!response.ok) return 'Free';
      const account: any = await response.json();
      return (['Starter', 'Pro', 'Business'].includes(account.plan) ? account.plan : 'Free') as PricingTier;
    };
    const sync = async (uid?: string, accessToken?: string) => {
      setSignedIn(!!uid);
      if (uid) navigateToTab((tab) => tab === 'landing' ? 'dashboard' : tab);
      let plan = await load(accessToken);
      const returning = new URLSearchParams(window.location.search).has('checkout');
      for (let i = 0; uid && accessToken && returning && plan === 'Free' && i < 10; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        plan = await load(accessToken);
      }
      if (alive) setActivePlan(plan);
    };
    supabase.auth.getSession().then(({ data }) => sync(data.session?.user.id, data.session?.access_token));
    const { data: sub } = supabase.auth.onAuthStateChange((event, s) => {
      sync(s?.user.id, s?.access_token);
      if (event === 'PASSWORD_RECOVERY') setIsAuthOpen(true);
    });
    return () => { alive = false; sub.subscription.unsubscribe(); };
  }, []);

  const weightsRef = React.useRef(weights);
  weightsRef.current = weights;

  const loadLive = React.useCallback(async () => {
    const [src, ov, act, rec, clusters, emerg] = await Promise.allSettled([
      fetchSources(), fetchOverview(), fetchActivity(14), fetchRecentSignals(10, 0),
      fetchClusters({ minDiscussions: 2, limit: 50, order: 'score' }), fetchClusters({ minDiscussions: 2, limit: 5, order: 'growth' }),
    ]);
    if (src.status === 'rejected' && ov.status === 'rejected') { setLiveStatus('unavailable'); return; }
    if (src.status === 'fulfilled') setSources(src.value);
    if (ov.status === 'fulfilled') setOverview(ov.value);
    if (act.status === 'fulfilled') setActivity(act.value);
    if (rec.status === 'fulfilled') setRecent(rec.value);
    if (emerg.status === 'fulfilled') setEmerging(emerg.value.items);
    setLiveStatus('ready');
    if (clusters.status === 'fulfilled' && clusters.value.items.length > 0) {
      const live = clusters.value.items.map(clusterToOpportunity).map((o) => ({ ...o, scores: { ...o.scores, compositeScore: recompute(o, weightsRef.current) } }));
      setOpportunities(live);
      setSelectedOpportunity((cur) => live.find((o) => o.id === cur.id) ?? live[0]);
      setIsDemo(false);
    } else {
      setOpportunities(INITIAL_OPPORTUNITIES);
      setSelectedOpportunity((cur) => INITIAL_OPPORTUNITIES.find((o) => o.id === cur.id) ?? INITIAL_OPPORTUNITIES[0]);
      setIsDemo(true);
    }
  }, []);

  useEffect(() => {
    loadLive();
    const t = setInterval(() => { if (document.visibilityState === 'visible') loadLive(); }, 60_000);
    return () => clearInterval(t);
  }, [loadLive]);

  useEffect(() => { if (signedIn) fetchIsAdmin().then(setIsAdmin); else setIsAdmin(false); }, [signedIn]);

  // Source excerpts for a live cluster are loaded on demand (sign-in required server-side).
  useEffect(() => {
    const opp = selectedOpportunity;
    if (!signedIn || !opp.live || opp.evidence.length > 0) return;
    let alive = true;
    fetchEvidence(opp.live.clusterId).then((evidence) => {
      if (alive) setSelectedOpportunity((cur) => (cur.id === opp.id ? { ...cur, evidence } : cur));
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [selectedOpportunity.id, signedIn]);

  // Modals
  const [isScoringOpen, setIsScoringOpen] = useState(false);
  const [isPricingOpen, setIsPricingOpen] = useState(false);
  const [isPaymentOpen, setIsPaymentOpen] = useState(false);
  const [checkoutTier, setCheckoutTier] = useState<PricingTier>('Pro');

  // Sync opportunity score updates when weights change
  const handleUpdateWeights = (newWeights: ScoringWeights) => {
    setWeights(newWeights);
    const updated = opportunities.map((opp) => {
      const newScore = recompute(opp, newWeights);
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
  const openSources = () => { navigateToTab('sources'); window.scrollTo({ top: 0, behavior: 'smooth' }); };
  const handleSelectOpportunity = (opp: Opportunity) => {
    if (!canOpenOpportunity(activePlan, opp, opportunities)) { setIsPricingOpen(true); return; }
    setSelectedOpportunity(opp);
    navigateToTab('intelligence');
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
        onOpenSources={openSources}
        liveSummary={liveStatus === 'ready' && overview ? { enabledSources: overview.enabled_sources, implementedSources: overview.implemented_sources, records: overview.records_total, lastCollectionAt: overview.last_collection_at } : null}
        explorerBadge={liveStatus === 'ready' && !isDemo ? String(opportunities.length) : undefined}
      />

      {/* Main Content Area */}
      <main className="flex-1 mx-auto w-full max-w-7xl px-4 py-6 sm:px-6">
        {currentTab === 'account' && <AccountView signedIn={signedIn} activePlan={activePlan} overview={overview} sources={sources} onSignIn={() => setIsAuthOpen(true)} onOpenPricing={() => setIsPricingOpen(true)} onOpenAuth={() => setIsAuthOpen(true)} />}
        {currentTab === 'landing' && <LandingView records={overview?.records_total ?? null} clusters={overview?.clusters_total ?? null} sources={overview?.enabled_sources ?? null} collectionReady={liveStatus === 'ready'} onExplore={() => navigateToTab('dashboard')} onOpenPricing={() => setIsPricingOpen(true)} onSignIn={() => setIsAuthOpen(true)} />}
        {isDemo && ['dashboard', 'explorer', 'intelligence', 'trends'].includes(currentTab) && (
          <div className="mb-4 flex flex-col sm:flex-row sm:items-center gap-2 rounded-xl border border-amber-700/50 bg-amber-950/30 px-4 py-3 text-xs text-amber-200">
            <FlaskConical className="h-4 w-4 shrink-0" />
            <p className="flex-1">
              <strong>Demo data.</strong>{' '}
              {liveStatus === 'unavailable'
                ? 'The collection backend is not connected, so the opportunities, trends and evidence shown are illustrative samples, not collected from real sources.'
                : liveStatus === 'loading'
                  ? 'Loading collected data…'
                  : `No problem cluster has two or more independent discussions yet${overview ? ` (${overview.records_total.toLocaleString()} records collected so far)` : ''}. Opportunities, trends and evidence below are illustrative samples, not collected data.`}
            </p>
            <button onClick={openSources} className="rounded-lg border border-amber-700/60 px-2.5 py-1 font-semibold hover:bg-amber-900/40 cursor-pointer whitespace-nowrap">Data Sources</button>
          </div>
        )}
        {currentTab === 'dashboard' && (
          <DashboardView
            opportunities={opportunities}
            liveStatus={liveStatus}
            overview={overview}
            sources={sources}
            isDemo={isDemo}
            onSelectOpportunity={handleSelectOpportunity}
            onNavigateTab={setCurrentTab}
            onOpenSources={openSources}
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
          <TrendAnalyticsView activePlan={activePlan} onOpenPricing={() => setIsPricingOpen(true)} isDemo={isDemo} overview={overview} />
        )}

        {currentTab === 'activity' && (
          <ResearchActivityView status={liveStatus} overview={overview} activity={activity} recent={recent} emerging={emerging} onOpenSources={openSources} />
        )}

        {currentTab === 'sources' && (
          <DataSourcesView sources={sources} status={liveStatus} isAdmin={isAdmin} signedIn={signedIn} onRefresh={loadLive} onOpenAuth={() => setIsAuthOpen(true)} />
        )}

        {currentTab === 'ai-generator' && (
          <AiGeneratorView activePlan={activePlan} onOpenPricing={() => setIsPricingOpen(true)} industries={overview?.industries.map((item) => item.industry) ?? []} />
        )}
      </main>

      {/* Modals */}
      <ScoringCalculatorModal
        isOpen={isScoringOpen}
        onClose={() => setIsScoringOpen(false)}
        weights={weights}
        onUpdateWeights={handleUpdateWeights}
      />

      <PricingModal
        isOpen={isPricingOpen}
        onClose={() => setIsPricingOpen(false)}
        activePlan={activePlan}
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
      <PaymentModal isOpen={isAuthOpen} onClose={() => setIsAuthOpen(false)} selectedTier="Free" authOnly activePlan={activePlan} onOpenPricing={() => { setIsAuthOpen(false); setIsPricingOpen(true); }} />
      <button
        onClick={() => signedIn ? navigateToTab('account') : setIsAuthOpen(true)}
        className="fixed bottom-4 right-4 z-40 rounded-full border border-slate-700 bg-slate-100 px-4 py-2 text-xs font-semibold text-slate-950 shadow-lg hover:bg-white cursor-pointer"
      >
        {signedIn ? 'Account settings' : 'Sign in'}
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
                Evidence-linked problem research for software builders, indie developers, and venture studios.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <button
                onClick={openSources}
                className="flex items-center gap-1.5 rounded-lg border border-slate-800 bg-slate-900/60 px-3 py-1.5 text-xs text-slate-300 hover:text-white hover:border-slate-700 transition-colors cursor-pointer"
              >
                <Database className="h-3.5 w-3.5 text-cyan-400" />
                Data Sources
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
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 text-[11px] text-slate-500">
            <div>
              <span className="text-slate-300 font-semibold block mb-1">Developer Economics</span>
              <p>
                DemandRadar organises public discussions into research leads. Use the evidence to decide what deserves customer interviews and validation.
              </p>
            </div>

            <div>
              <span className="text-slate-300 font-semibold block mb-1">Accumulated Data Advantage</span>
              <p>
                {liveStatus === 'ready' && overview
                  ? `${overview.records_total.toLocaleString()} public discussions collected so far (${overview.problems_total.toLocaleString()} classified as problem signals) from ${overview.by_source.filter((s) => s.records > 0).map((s) => s.name).join(', ') || 'no source yet'}. Every record links back to its original source.`
                  : 'A source-linked repository of public discussions and the problems extracted from them. Collection status is shown on the Data Sources tab.'}
              </p>
            </div>

            <div>
              <span className="text-slate-300 font-semibold block mb-1">Research scope</span>
              <p>
                Current research coverage depends on the sources enabled in the Data Sources workspace. Coverage is shown transparently rather than implied.
              </p>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pt-4 border-t border-slate-900/80 text-[10px] text-slate-600">
            <span>© 2026 DemandRadar Systems. Collectors use official public APIs only, within each platform's terms and quotas.</span>
            <span className="font-mono text-slate-500">{overview ? `${overview.pending_analysis.toLocaleString()} records awaiting analysis` : 'collection status: not connected'}</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
