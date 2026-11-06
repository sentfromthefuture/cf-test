import { supabase } from '../lib/supabase';
import React, { useState } from 'react';
import { 
  Sparkles, 
  Send, 
  Code2, 
  Download, 
  Copy, 
  Check, 
  Layers, 
  ShieldCheck, 
  DollarSign, 
  TrendingUp, 
  Swords, 
  RotateCcw, 
  Zap,
  Info,
  Calendar,
  Globe,
  Sliders,
  FileCheck
} from 'lucide-react';

export const AiGeneratorView: React.FC<{ activePlan: string; onOpenPricing: () => void; industries?: string[] }> = ({ activePlan, onOpenPricing, industries = [] }) => {
  const [industry, setIndustry] = useState('Retail & Commerce');
  const [country, setCountry] = useState('United States & Global');
  const [difficulty, setDifficulty] = useState('Medium (2-4 weeks)');
  const [budget, setBudget] = useState('$1,000 - $3,000 (Lean MVP)');
  const [technology, setTechnology] = useState('React + Vite + Supabase + Cloudflare Pages');
  const [businessModel, setBusinessModel] = useState('B2B Tiered SaaS ($49 - $299/mo)');
  const [customTopic, setCustomTopic] = useState('');

  const [loading, setLoading] = useState(false);
  const [loadingStep, setLoadingStep] = useState(0);
  const [generatedBrief, setGeneratedBrief] = useState<any | null>(null);
  const [copied, setCopied] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const industryOptions = Array.from(new Set([...industries, 'Retail & Commerce', 'Real Estate & PropTech', 'Freelance & Agency Ops', 'Hospitality & Food Ops', 'Field Services & Trades', 'Regulatory & AI Governance', 'Healthcare & Wellness', 'Developer Tools & DevOps'])).sort((a, b) => a.localeCompare(b));

  const steps = [
    'Reviewing collected public discussions...',
    'Clustering recurring complaints into root-cause bottlenecks...',
    'Comparing observed signals and evidence gaps...',
    'Drafting product, technical and validation hypotheses...',
  ];

  const handleGenerate = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    setLoading(true);
    setErrorMsg(null);
    setGeneratedBrief(null);
    setLoadingStep(0);

    const stepInterval = setInterval(() => {
      setLoadingStep((prev) => {
        if (prev < steps.length - 1) return prev + 1;
        return prev;
      });
    }, 1100);

    try {
      const { data: auth } = await supabase.auth.getSession();
      const res = await fetch('/api/generate-brief', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(auth.session ? { Authorization: `Bearer ${auth.session.access_token}` } : {}) },
        body: JSON.stringify({
          industry,
          country,
          difficulty,
          budget,
          technology,
          businessModel,
          customTopic,
        }),
      });

      const data = await res.json();
      clearInterval(stepInterval);
      if (!res.ok) {
        setErrorMsg(data.error || 'Not allowed');
        return;
      }
      if (data && data.brief) {
        setGeneratedBrief(data.brief);
      } else {
        throw new Error('No brief returned');
      }
    } catch (err: any) {
      console.error('Error generating brief:', err);
      clearInterval(stepInterval);
      setGeneratedBrief(null);
      setErrorMsg(err?.message || 'The brief could not be generated. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  const copyMarkdown = () => {
    if (!generatedBrief) return;
    const text = `# Project Brief: ${generatedBrief.productName}
**Tagline:** ${generatedBrief.tagline}
**AI hypothesis score:** ${generatedBrief.opportunityScore}/100
**Research status:** ${generatedBrief.researchStatus || 'Not specified'}
**Market-size hypothesis:** ${generatedBrief.marketSizeTAM}
**Year-one revenue scenario (not forecast):** ${generatedBrief.estMonthlyRevenueYear1}

## Problem Statement
${generatedBrief.problemStatement}

## Target ICP
- **Role:** ${generatedBrief.targetICP?.role}
- **Company Size:** ${generatedBrief.targetICP?.companySize}
- **Budget hypothesis:** ${generatedBrief.targetICP?.annualBudget}
- **Core Frustration:** ${generatedBrief.targetICP?.coreFrustration}

## Suggested MVP Feature Scope (hypothesis)
### Core Features:
${generatedBrief.mvpScope?.coreFeatures?.map((f: string) => `- ${f}`).join('\n')}

### Out of Scope (Post-MVP):
${generatedBrief.mvpScope?.outOfScope?.map((f: string) => `- ${f}`).join('\n')}

## Technical Architecture Blueprint
- **Frontend:** ${generatedBrief.architectureSpec?.frontend}
- **Backend:** ${generatedBrief.architectureSpec?.backend}
- **Database:** ${generatedBrief.architectureSpec?.database}
- **Integrations:** ${generatedBrief.architectureSpec?.keyIntegrations?.join(', ')}
- **Data Model:** ${generatedBrief.architectureSpec?.dataModelSummary}

## Monetization & Pricing
${generatedBrief.pricingTiers?.map((t: any) => `### ${t.tier} (${t.price})\n${t.features?.map((f: string) => `- ${f}`).join('\n')}`).join('\n\n')}

## Suggested Validation Plan
${generatedBrief.gtmStrategy?.map((s: any) => `- **${s.phase}:** ${s.action}`).join('\n')}

## Research Basis
${generatedBrief.researchBasis?.clusters?.map((cluster: any) => `- ${cluster.title}: ${cluster.independentDiscussions} discussions across ${cluster.sourceCount} sources; confidence ${cluster.confidence}`).join('\n') || 'No research clusters attached.'}

## Source Evidence
${generatedBrief.researchBasis?.evidence?.map((item: any) => `- ${item.source}: ${item.title} — ${item.url} (licence: ${item.license})`).join('\n') || 'No source evidence attached.'}

Commercial estimates, proposed pricing and product recommendations are hypotheses requiring independent validation.
`;
    if (!navigator.clipboard?.writeText) return;
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    }).catch(() => setCopied(false));
  };

  if (activePlan === 'Free' || activePlan === 'Starter') {
    return (
      <div className="rounded-2xl border border-amber-500/30 bg-slate-900/60 p-8 text-center space-y-3">
        <h2 className="text-base font-bold text-white">AI opportunity briefs</h2>
        <p className="text-xs text-slate-400">Generating development-ready briefs is included in the Pro and Business plans.</p>
        <button onClick={onOpenPricing} className="rounded-lg bg-amber-500 px-4 py-2 text-xs font-bold text-slate-950 hover:bg-amber-400 cursor-pointer">View plans</button>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Title */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800 pb-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-xl sm:text-2xl font-bold text-white flex items-center gap-2">
              <Sparkles className="h-5 w-5 text-cyan-400" />
              AI Opportunity Generator
            </h1>
            <span className="rounded bg-gradient-to-r from-cyan-500 to-blue-500 px-2 py-0.5 text-xs font-mono font-bold text-white shadow-xs">
              GEMINI AI
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Filter market demand and synthesize development-ready project briefs (PRD, MVP spec, architecture, pricing).
          </p>
        </div>
      </div>

      {/* Generator Filter Form */}
      <form onSubmit={handleGenerate} className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 md:p-6 space-y-5 shadow-xl">
        <div className="flex items-center justify-between border-b border-slate-800 pb-3">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-2">
            <Sliders className="h-4 w-4 text-cyan-400" />
            Market Filters & Parameters
          </span>
          <span className="text-xs text-slate-400 hidden sm:inline">
            Synthesizes real-time complaint data into actionable PRDs
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 text-xs">
          {/* Industry */}
          <div className="space-y-1.5">
            <label className="font-semibold text-slate-300">1. Target Industry</label>
            <select
              value={industry}
              onChange={(e) => setIndustry(e.target.value)}
              className="w-full rounded-xl border border-slate-800 bg-slate-950 p-2.5 text-white focus:border-cyan-500 focus:outline-none"
            >
              {industryOptions.map((option) => <option key={option} value={option}>{option}</option>)}
            </select>
          </div>

          {/* Geography / Country */}
          <div className="space-y-1.5">
            <label className="font-semibold text-slate-300">2. Target Country / Market</label>
            <select
              value={country}
              onChange={(e) => setCountry(e.target.value)}
              className="w-full rounded-xl border border-slate-800 bg-slate-950 p-2.5 text-white focus:border-cyan-500 focus:outline-none"
            >
              <option value="United States & Global">United States & Global</option>
              <option value="European Union & UK">European Union & UK</option>
              <option value="Canada & Australia">Canada & Australia</option>
              <option value="Latin America">Latin America</option>
              <option value="Asia-Pacific (SG, AU, IN)">Asia-Pacific</option>
            </select>
          </div>

          {/* Technical Difficulty */}
          <div className="space-y-1.5">
            <label className="font-semibold text-slate-300">3. Technical Difficulty</label>
            <select
              value={difficulty}
              onChange={(e) => setDifficulty(e.target.value)}
              className="w-full rounded-xl border border-slate-800 bg-slate-950 p-2.5 text-white focus:border-cyan-500 focus:outline-none"
            >
              <option value="Low (Solo 1-2 weeks)">Low (Solo Dev 1-2 Weeks)</option>
              <option value="Medium (2-4 weeks)">Medium (Full-Stack 2-4 Weeks)</option>
              <option value="High (Multi-Month Enterprise)">High (Multi-Month Enterprise)</option>
            </select>
          </div>

          {/* Build Budget */}
          <div className="space-y-1.5">
            <label className="font-semibold text-slate-300">4. Target Build Budget</label>
            <select
              value={budget}
              onChange={(e) => setBudget(e.target.value)}
              className="w-full rounded-xl border border-slate-800 bg-slate-950 p-2.5 text-white focus:border-cyan-500 focus:outline-none"
            >
              <option value="<$1,000 (Micro-budget bootstrap)">&lt; $1,000 (Bootstrap Solo)</option>
              <option value="$1,000 - $3,000 (Lean MVP)">$1,000 - $3,000 (Lean MVP)</option>
              <option value="$5,000+ (Funded Studio)">$5,000+ (Funded Studio / Agency)</option>
            </select>
          </div>

          {/* Technology Stack */}
          <div className="space-y-1.5">
            <label className="font-semibold text-slate-300">5. Preferred Technology</label>
            <select
              value={technology}
              onChange={(e) => setTechnology(e.target.value)}
              className="w-full rounded-xl border border-slate-800 bg-slate-950 p-2.5 text-white focus:border-cyan-500 focus:outline-none"
            >
              <option value="React + Vite + Supabase + Cloudflare Pages">React + Vite + Supabase + Cloudflare Pages</option>
              <option value="Next.js + PostgreSQL + Tailwind">Next.js + PostgreSQL + Tailwind</option>
              <option value="React + Node.js + Express + Redis">React + Node.js + Express + Redis</option>
              <option value="Python / FastAPI + Vector DB">Python / FastAPI + Vector DB</option>
              <option value="Mobile PWA / React Native + Twilio">Mobile PWA / React Native + Twilio</option>
              <option value="Chrome Extension + Serverless API">Chrome Extension + Serverless API</option>
            </select>
          </div>

          {/* Business Model */}
          <div className="space-y-1.5">
            <label className="font-semibold text-slate-300">6. Desired Business Model</label>
            <select
              value={businessModel}
              onChange={(e) => setBusinessModel(e.target.value)}
              className="w-full rounded-xl border border-slate-800 bg-slate-950 p-2.5 text-white focus:border-cyan-500 focus:outline-none"
            >
              <option value="B2B Tiered SaaS ($49 - $299/mo)">B2B Tiered SaaS ($49 - $299/mo)</option>
              <option value="Freemium + Flat Fee per Transaction">Freemium + Transaction / Door Fee</option>
              <option value="Usage-based Metered API">Usage-based Metered API</option>
              <option value="Annual Enterprise Contract ($5k-$20k)">Annual Enterprise Contract ($5k+)</option>
            </select>
          </div>
        </div>

        {/* Optional Custom Problem Focus */}
        <div className="space-y-1.5 text-xs">
          <label className="font-semibold text-slate-300 flex items-center justify-between">
            <span>Optional Custom Focus / Specific Complaint Guidance:</span>
            <span className="text-[11px] text-slate-500 font-normal">Leave blank for automatic top trending bottleneck</span>
          </label>
          <input
            type="text"
            placeholder="e.g. 'independent cafe food inventory' or 'plumber missed phone calls during emergencies'..."
            value={customTopic}
            onChange={(e) => setCustomTopic(e.target.value)}
            className="w-full rounded-xl border border-slate-800 bg-slate-950 p-2.5 text-white placeholder-slate-500 focus:border-cyan-500 focus:outline-none"
          />
        </div>

        {/* Submit */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-2">
          <span className="text-xs text-slate-400 flex items-center gap-1.5">
            <ShieldCheck className="h-4 w-4 text-emerald-400" />
            Uses collected clusters and source-linked evidence where available. Commercial estimates remain hypotheses.
          </span>
          <button
            type="submit"
            disabled={loading}
            className="flex items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-cyan-500 to-blue-600 px-6 py-2.5 text-xs font-bold text-white shadow-lg shadow-cyan-500/25 hover:from-cyan-400 hover:to-blue-500 disabled:opacity-50 transition-all cursor-pointer"
          >
            {loading ? (
              <>
                <Sparkles className="h-4 w-4 animate-spin" />
                Synthesizing Opportunity PRD...
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4" />
                Generate Development PRD
              </>
            )}
          </button>
        </div>
      </form>

      {errorMsg && (
        <div role="alert" className="rounded-xl border border-rose-900/70 bg-rose-950/30 px-4 py-3 text-xs text-rose-200">
          <strong className="block mb-1">Brief generation stopped</strong>
          {errorMsg}
        </div>
      )}

      {/* Loading Progress State */}
      {loading && (
        <div className="rounded-2xl border border-cyan-800/80 bg-slate-900/90 p-8 text-center space-y-4 animate-pulse">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-cyan-950 border border-cyan-500/50 text-cyan-400 shadow-xl shadow-cyan-500/20">
            <Sparkles className="h-7 w-7 animate-spin" />
          </div>
          <div>
            <h3 className="text-base font-bold text-white mb-1">
              Autonomous Market Intelligence Synthesis Active
            </h3>
            <p className="text-xs text-cyan-300 font-mono">
              {steps[loadingStep]}
            </p>
          </div>
          <div className="w-full max-w-md mx-auto bg-slate-950 h-2 rounded-full overflow-hidden border border-slate-800">
            <div
              className="bg-gradient-to-r from-cyan-500 to-blue-500 h-full transition-all duration-500"
              style={{ width: `${((loadingStep + 1) / steps.length) * 100}%` }}
            ></div>
          </div>
        </div>
      )}

      {/* Generated PRD Output */}
      {generatedBrief && !loading && (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 md:p-8 space-y-6 shadow-2xl animate-fade-in">
          {/* Header */}
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-5">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <span className="rounded bg-cyan-950 px-2 py-0.5 text-xs font-mono font-bold text-cyan-300 border border-cyan-800">
                  AI-GENERATED PRODUCT HYPOTHESIS
                </span>
                <span className="text-xs font-mono text-emerald-400">
                  AI hypothesis score: {generatedBrief.opportunityScore}/100
                </span>
              </div>
              <h2 className="text-2xl font-black text-white">
                {generatedBrief.productName}
              </h2>
              <p className="text-xs text-cyan-300 font-medium mt-0.5">
                "{generatedBrief.tagline}"
              </p>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={copyMarkdown}
                className="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3.5 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-700 hover:text-white transition-all cursor-pointer"
              >
                {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5 text-slate-400" />}
                {copied ? 'Copied' : 'Copy PRD'}
              </button>
            </div>
          </div>

          {generatedBrief.researchBasis?.clusters?.length > 0 && (
        <section className="rounded-2xl border border-slate-700 bg-slate-950/70 p-5 md:p-6 space-y-4">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-800 pb-3">
            <div>
              <h3 className="text-sm font-bold text-white">Research basis</h3>
              <p className="text-xs text-slate-400 mt-1">Actual DemandRadar clusters used as context for this AI-generated brief.</p>
            </div>
            <span className="text-xs text-slate-400">{generatedBrief.researchBasis.clusters.length} clusters · {generatedBrief.researchBasis.evidence?.length ?? 0} source records</span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {generatedBrief.researchBasis.clusters.map((cluster: any) => (
              <div key={cluster.id} className="rounded-xl border border-slate-800 bg-slate-900/70 p-3 space-y-2">
                <div className="flex items-start justify-between gap-3">
                  <h4 className="text-xs font-semibold text-white">{cluster.title}</h4>
                  <span className="shrink-0 rounded border border-slate-700 px-2 py-0.5 text-[10px] text-slate-300 capitalize">{cluster.confidence} confidence</span>
                </div>
                <p className="text-[11px] text-slate-400">{cluster.industry || 'Industry unclassified'}{cluster.useCase ? ` · ${cluster.useCase}` : ''}</p>
                <div className="flex flex-wrap gap-2 text-[10px] text-slate-300">
                  <span>{Number(cluster.independentDiscussions || 0).toLocaleString()} discussions</span>
                  <span>·</span><span>{cluster.sourceCount} sources</span>
                  <span>·</span><span>{cluster.growthRate == null ? 'Growth n/a' : `${cluster.growthRate > 0 ? '+' : ''}${cluster.growthRate}% growth`}</span>
                </div>
                <p className="text-[10px] text-slate-500">Sources: {(cluster.sources || []).join(', ') || 'not recorded'}</p>
                <p className="text-[10px] text-slate-500">WTP evidence signals: {cluster.willingnessToPaySignals ?? 0}</p>
                {Object.keys(cluster.competitorsNamed || {}).length > 0 && (
                  <p className="text-[10px] text-slate-500">Alternatives mentioned: {Object.entries(cluster.competitorsNamed).map(([name, count]) => `${name} (${count})`).join(', ')}</p>
                )}
              </div>
            ))}
          </div>
          {generatedBrief.researchBasis.evidence?.length > 0 && (
            <div className="space-y-2">
              <h4 className="text-xs font-semibold text-slate-200">Original discussions</h4>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {generatedBrief.researchBasis.evidence.slice(0, 8).map((item: any, index: number) => (
                  <a key={`${item.url}-${index}`} href={item.url} target="_blank" rel="noreferrer" className="rounded-lg border border-slate-800 bg-slate-900/60 p-3 hover:border-slate-600">
                    <span className="block text-[11px] font-medium text-slate-200">{item.title || item.clusterTitle}</span>
                    <span className="mt-1 block text-[10px] text-slate-500">{item.source} · {item.license} · {item.analysisMethod} analysis</span>
                    {item.attribution && <span className="mt-1 block text-[10px] text-slate-500">Attribution: {item.attribution}</span>}
                    {item.excerpt && <span className="mt-1 block text-[10px] leading-relaxed text-slate-400">{item.excerpt}</span>}
                  </a>
                ))}
              </div>
            </div>
          )}
          <p className="text-[10px] text-slate-500 border-t border-slate-800 pt-3">Discussion volume and growth describe observed public conversations, not proven purchase demand. Market size, revenue, pricing, competitor interpretation and the proposed solution are AI hypotheses requiring independent validation.</p>
        </section>
      )}

      {/* Quick Metrics Banner */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
            <div className="rounded-xl bg-slate-950 p-3 border border-slate-800">
              <span className="text-[10px] text-slate-400 block mb-0.5">Market-size hypothesis</span>
              <span className="font-mono text-sm font-bold text-white">{generatedBrief.marketSizeTAM}</span>
            </div>
            <div className="rounded-xl bg-slate-950 p-3 border border-slate-800">
              <span className="text-[10px] text-slate-400 block mb-0.5">Year-one revenue scenario · not forecast</span>
              <span className="font-mono text-sm font-bold text-emerald-400">{generatedBrief.estMonthlyRevenueYear1}</span>
            </div>
            <div className="rounded-xl bg-slate-950 p-3 border border-slate-800">
              <span className="text-[10px] text-slate-400 block mb-0.5">Target Build Difficulty</span>
              <span className="font-mono text-sm font-bold text-cyan-300">{difficulty}</span>
            </div>
            <div className="rounded-xl bg-slate-950 p-3 border border-slate-800">
              <span className="text-[10px] text-slate-400 block mb-0.5">Target Business Model</span>
              <span className="font-mono text-sm font-bold text-amber-300">{businessModel.split(' ')[0]}</span>
            </div>
          </div>

          {/* Section 1: Problem & Target ICP */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            <div className="rounded-xl bg-slate-950 p-4 border border-slate-800 space-y-2">
              <h4 className="font-bold text-white uppercase tracking-wider text-[11px] flex items-center gap-1.5">
                <FileCheck className="h-3.5 w-3.5 text-cyan-400" />
                Problem Statement & Market Friction
              </h4>
              <p className="text-slate-300 leading-relaxed">
                {generatedBrief.problemStatement}
              </p>
            </div>

            <div className="rounded-xl bg-slate-950 p-4 border border-slate-800 space-y-2">
              <h4 className="font-bold text-white uppercase tracking-wider text-[11px] flex items-center gap-1.5">
                <Info className="h-3.5 w-3.5 text-amber-400" />
                Target customer hypothesis (ICP)
              </h4>
              <div className="space-y-1 text-slate-300">
                <div><strong>Role:</strong> {generatedBrief.targetICP?.role}</div>
                <div><strong>Company Size:</strong> {generatedBrief.targetICP?.companySize}</div>
                <div><strong>Budget hypothesis:</strong> {generatedBrief.targetICP?.annualBudget}</div>
                <div className="text-amber-300/90 text-[11px]">
                  <strong>Core Frustration:</strong> {generatedBrief.targetICP?.coreFrustration}
                </div>
              </div>
            </div>
          </div>

          {/* Section 2: 3-Week MVP Feature Specification */}
          <div className="rounded-xl bg-slate-950 p-5 border border-slate-800 space-y-3 text-xs">
            <h4 className="font-bold text-white uppercase tracking-wider text-[11px] flex items-center gap-1.5">
              <Zap className="h-3.5 w-3.5 text-cyan-400" />
              Suggested MVP Scope · hypothesis
            </h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-400">
                  Must-Have Core MVP Features:
                </span>
                <ul className="space-y-1.5">
                  {generatedBrief.mvpScope?.coreFeatures?.map((f: string, idx: number) => (
                    <li key={idx} className="flex items-start gap-2 text-slate-300">
                      <span className="text-emerald-400 font-bold">✓</span>
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className="space-y-2">
                <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  Out of Scope for v1 (Build Post-Launch):
                </span>
                <ul className="space-y-1.5">
                  {generatedBrief.mvpScope?.outOfScope?.map((f: string, idx: number) => (
                    <li key={idx} className="flex items-start gap-2 text-slate-500">
                      <span>✕</span>
                      <span>{f}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </div>

          {/* Section 3: Technical Architecture & Pricing Tiers */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
            {/* Tech Architecture */}
            <div className="rounded-xl bg-slate-950 p-4 border border-slate-800 space-y-3">
              <h4 className="font-bold text-white uppercase tracking-wider text-[11px] flex items-center gap-1.5">
                <Code2 className="h-3.5 w-3.5 text-purple-400" />
                Technical Architecture Blueprint
              </h4>
              <div className="space-y-1.5 font-mono text-[11px] text-slate-300">
                <div><span className="text-slate-500">Frontend:</span> {generatedBrief.architectureSpec?.frontend}</div>
                <div><span className="text-slate-500">Backend:</span> {generatedBrief.architectureSpec?.backend}</div>
                <div><span className="text-slate-500">Database:</span> {generatedBrief.architectureSpec?.database}</div>
                <div><span className="text-slate-500">Integrations:</span> {generatedBrief.architectureSpec?.keyIntegrations?.join(', ')}</div>
                <div className="text-[10px] text-slate-400 font-sans mt-2 pt-2 border-t border-slate-800">
                  {generatedBrief.architectureSpec?.dataModelSummary}
                </div>
              </div>
            </div>

            {/* Pricing Tiers */}
            <div className="rounded-xl bg-slate-950 p-4 border border-slate-800 space-y-3">
              <h4 className="font-bold text-white uppercase tracking-wider text-[11px] flex items-center gap-1.5">
                <DollarSign className="h-3.5 w-3.5 text-emerald-400" />
                Illustrative Pricing Hypotheses
              </h4>
              <div className="space-y-2">
                {generatedBrief.pricingTiers?.map((tier: any, idx: number) => (
                  <div key={idx} className="rounded-lg bg-slate-900/60 p-2.5 border border-slate-800 flex items-center justify-between">
                    <div>
                      <span className="font-bold text-white">{tier.tier}</span>
                      <p className="text-[10px] text-slate-400">{tier.features?.[0]}</p>
                    </div>
                    <span className="font-mono font-bold text-emerald-400 text-xs">
                      {tier.price}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Section 4: Go-To-Market Sprint Plan */}
          <div className="rounded-xl bg-slate-950 p-4 border border-slate-800 space-y-2 text-xs">
            <h4 className="font-bold text-white uppercase tracking-wider text-[11px] flex items-center gap-1.5">
              <Calendar className="h-3.5 w-3.5 text-blue-400" />
              Suggested Validation Plan · not a forecast
            </h4>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-1">
              {generatedBrief.gtmStrategy?.map((gtm: any, idx: number) => (
                <div key={idx} className="rounded-lg bg-slate-900/60 p-3 border border-slate-800 space-y-1">
                  <span className="font-mono text-cyan-400 font-bold text-[10px]">{gtm.phase}</span>
                  <p className="text-slate-300 text-[11px] leading-relaxed">{gtm.action}</p>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
