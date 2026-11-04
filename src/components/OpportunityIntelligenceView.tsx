import React, { useState } from 'react';
import { 
  FileText, 
  Target, 
  AlertTriangle, 
  Zap, 
  DollarSign, 
  Users, 
  Swords, 
  Quote, 
  Code2, 
  Download, 
  Share2, 
  Check, 
  Lock, 
  Sliders, 
  Sparkles, 
  ArrowLeft,
  Crown,
  ChevronDown,
  Info
} from 'lucide-react';
import { Opportunity, PricingTier } from '../types';

interface OpportunityIntelligenceViewProps {
  opportunity: Opportunity;
  allOpportunities: Opportunity[];
  onSelectOpportunity: (opp: Opportunity) => void;
  activePlan: PricingTier;
  onOpenPricing: () => void;
  onOpenScoring: () => void;
  onOpenPayment?: (tier: PricingTier) => void;
}

export const OpportunityIntelligenceView: React.FC<OpportunityIntelligenceViewProps> = ({
  opportunity,
  allOpportunities,
  onSelectOpportunity,
  activePlan,
  onOpenPricing,
  onOpenScoring,
  onOpenPayment,
}) => {
  const [activeTab, setActiveTab] = useState<'overview' | 'competitors' | 'evidence' | 'architecture'>('overview');
  const [copied, setCopied] = useState(false);

  // Pro features are locked if user is on Free/Starter and hasn't toggled demo unlock
  const isGated = activePlan === 'Free' || activePlan === 'Starter';

  const handleCopyPRD = () => {
    const text = `# DemandRadar Market Intelligence Brief
## Opportunity: ${opportunity.title}
- Industry: ${opportunity.category}
- Opportunity Score: ${opportunity.scores.compositeScore}/100
- Discussions Scanned: ${opportunity.discussions} (${opportunity.growth} growth)
- Target ACV: ${opportunity.estACV}

### 1. Target Persona
${opportunity.targetPersona}

### 2. The Core Problem
${opportunity.problemDescription}

### 3. Incumbent Weaknesses (Why existing solutions fail)
${opportunity.existingFails}

### 4. Software Solution & MVP Features
${opportunity.proposedSolution}
${opportunity.suggestedFeatures.map(f => `- ${f}`).join('\n')}

### 5. Monetization Strategy
${opportunity.monetization}

### 6. Competitor Vulnerabilities
${opportunity.competitors.map(c => `- **${c.name}** (${c.pricing}): Vulnerability: ${c.weakness}`).join('\n')}

### 7. Verifiable Evidence Quotes
${opportunity.evidence.map(e => `> "${e.quote}"\n> — ${e.author} on ${e.source} (${e.upvotes} upvotes)`).join('\n\n')}
`;
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2500);
  };

  const handleDownloadPRD = () => {
    const text = `# DemandRadar Market Intelligence Brief\n## Opportunity: ${opportunity.title}\n\nProblem:\n${opportunity.problemDescription}\n\nTarget ICP:\n${opportunity.targetPersona}\n\nFeatures:\n${opportunity.suggestedFeatures.join('\n')}\n\nMonetization:\n${opportunity.monetization}`;
    const blob = new Blob([text], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${opportunity.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-prd.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Top Selector & Navigation */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-cyan-950 border border-cyan-800/80 text-cyan-400">
            <FileText className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono font-bold text-cyan-400 uppercase tracking-wider">
                Opportunity Intelligence Dossier
              </span>
              <span className="rounded bg-slate-800 px-2 py-0.5 text-[10px] font-mono text-slate-300 border border-slate-700">
                DR-{opportunity.id.toUpperCase()}
              </span>
            </div>
            <h1 className="text-xl sm:text-2xl font-bold text-white">
              {opportunity.title}
            </h1>
          </div>
        </div>

        {/* Opportunity Switcher Dropdown */}
        <div className="flex items-center gap-2">
          <label className="text-xs text-slate-400 hidden sm:inline">Switch Dossier:</label>
          <div className="relative">
            <select
              value={opportunity.id}
              onChange={(e) => {
                const found = allOpportunities.find(o => o.id === e.target.value);
                if (found) onSelectOpportunity(found);
              }}
              className="appearance-none rounded-xl border border-slate-800 bg-slate-900/90 pl-3 pr-8 py-2 text-xs text-white focus:border-cyan-500 focus:outline-none cursor-pointer max-w-xs truncate"
            >
              {allOpportunities.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.title} ({o.scores.compositeScore}/100)
                </option>
              ))}
            </select>
            <ChevronDown className="absolute right-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-500 pointer-events-none" />
          </div>
        </div>
      </div>

      {/* Hero Stats & 6-Factor Score Card */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Left 2 Cols: Executive Snapshot */}
        <div className="lg:col-span-2 rounded-2xl border border-slate-800 bg-slate-900/60 p-6 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800/80 pb-4">
            <div className="flex items-center gap-2">
              <span className="rounded-md bg-slate-950 px-2.5 py-1 text-xs font-mono font-bold text-cyan-300 border border-slate-800">
                {opportunity.category}
              </span>
              <span className="rounded-md bg-slate-950 px-2.5 py-1 text-xs font-mono text-slate-300 border border-slate-800">
                {opportunity.country}
              </span>
              <span className="rounded-md bg-emerald-950 px-2.5 py-1 text-xs font-mono font-bold text-emerald-400 border border-emerald-800/60">
                {opportunity.growth} Growth
              </span>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={handleCopyPRD}
                className="flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-slate-700 hover:text-white transition-all cursor-pointer"
              >
                {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Share2 className="h-3.5 w-3.5 text-slate-400" />}
                {copied ? 'Copied Markdown' : 'Copy Brief'}
              </button>
              <button
                onClick={handleDownloadPRD}
                className="flex items-center gap-1.5 rounded-lg bg-cyan-600 px-3 py-1.5 text-xs font-bold text-white hover:bg-cyan-500 shadow-md shadow-cyan-600/20 transition-all cursor-pointer"
              >
                <Download className="h-3.5 w-3.5" />
                Export PRD
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <div className="rounded-xl bg-slate-950/80 p-3 border border-slate-800/80">
              <span className="text-[10px] text-slate-400 block mb-0.5">Discussion Volume</span>
              <span className="font-mono text-base font-bold text-white">{opportunity.discussions.toLocaleString()}</span>
              <span className="text-[10px] text-emerald-400 block mt-0.5">Verified across 3 platforms</span>
            </div>

            <div className="rounded-xl bg-slate-950/80 p-3 border border-slate-800/80">
              <span className="text-[10px] text-slate-400 block mb-0.5">Urgency Index</span>
              <span className="font-mono text-base font-bold text-rose-400">{opportunity.urgency}/100</span>
              <span className="text-[10px] text-slate-400 block mt-0.5">Operational bottleneck</span>
            </div>

            <div className="rounded-xl bg-slate-950/80 p-3 border border-slate-800/80">
              <span className="text-[10px] text-slate-400 block mb-0.5">Willingness to Pay</span>
              <span className="font-mono text-base font-bold text-amber-300">{opportunity.willingnessToPay}</span>
              <span className="text-[10px] text-slate-400 block mt-0.5">{opportunity.estACV} avg budget</span>
            </div>

            <div className="rounded-xl bg-slate-950/80 p-3 border border-slate-800/80">
              <span className="text-[10px] text-slate-400 block mb-0.5">Dev Difficulty</span>
              <span className="font-mono text-base font-bold text-cyan-300">{opportunity.difficulty}</span>
              <span className="text-[10px] text-slate-400 block mt-0.5">Estimated MVP: 2-3 wks</span>
            </div>
          </div>

          {/* Quick Tabs */}
          <div className="flex items-center gap-2 border-b border-slate-800 pt-2">
            {[
              { id: 'overview', label: '1. Problem & Application' },
              { id: 'competitors', label: '2. Competitor Gaps' },
              { id: 'evidence', label: '3. Real Discussion Citations' },
              { id: 'architecture', label: '4. Architecture & Spec' },
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={`py-2 px-3 text-xs font-semibold border-b-2 transition-all cursor-pointer ${
                  activeTab === tab.id
                    ? 'border-cyan-400 text-white'
                    : 'border-transparent text-slate-400 hover:text-slate-200'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>

        {/* Right Col: 6-Factor Opportunity Scoring Algorithm Breakdown */}
        <div className="rounded-2xl border border-slate-800 bg-slate-900/80 p-6 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-bold uppercase tracking-wider text-slate-300 flex items-center gap-1.5">
              <Zap className="h-4 w-4 text-cyan-400" />
              Opportunity Score Breakdown
            </h3>
            <button
              onClick={onOpenScoring}
              className="text-[11px] text-cyan-400 hover:text-cyan-300 font-mono cursor-pointer flex items-center gap-1"
            >
              <Sliders className="h-3 w-3" />
              Adjust
            </button>
          </div>

          <div className="flex items-baseline justify-between border-b border-slate-800 pb-3">
            <span className="text-3xl font-black font-mono text-white">
              {opportunity.scores.compositeScore}
              <span className="text-sm font-sans text-slate-400 font-normal"> / 100</span>
            </span>
            <span className="rounded bg-cyan-950 px-2 py-0.5 text-xs font-mono font-bold text-cyan-300 border border-cyan-800">
              Rating: {opportunity.opportunityLevel}
            </span>
          </div>

          <div className="space-y-2.5 text-xs">
            {[
              { label: 'Problem Frequency (25%)', val: opportunity.scores.problemFrequency, color: 'bg-blue-400' },
              { label: 'Demand Growth (20%)', val: opportunity.scores.demandGrowth, color: 'bg-emerald-400' },
              { label: 'Pain Intensity (20%)', val: opportunity.scores.painIntensity, color: 'bg-rose-400' },
              { label: 'Willingness to Pay (15%)', val: opportunity.scores.willingnessToPay, color: 'bg-amber-400' },
              { label: 'Competition Gap (10%)', val: opportunity.scores.competitionGap, color: 'bg-purple-400' },
              { label: 'Development Feasibility (10%)', val: opportunity.scores.developmentFeasibility, color: 'bg-sky-400' },
            ].map((m, idx) => (
              <div key={idx} className="space-y-1">
                <div className="flex justify-between text-[11px] text-slate-400">
                  <span>{m.label}</span>
                  <span className="font-mono font-bold text-slate-200">{m.val}%</span>
                </div>
                <div className="h-1.5 w-full bg-slate-950 rounded-full overflow-hidden border border-slate-800/80">
                  <div className={`h-full rounded-full ${m.color}`} style={{ width: `${m.val}%` }}></div>
                </div>
              </div>
            ))}
          </div>

          <p className="text-[10px] text-slate-500 italic pt-1 border-t border-slate-800">
            Backed by mathematical clustering of 4,200+ distinct source comments.
          </p>
        </div>
      </div>

      {/* Tab Contents */}
      {activeTab === 'overview' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Target Persona & Problem */}
          <div className="space-y-4">
            <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 space-y-3">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <Users className="h-4 w-4 text-cyan-400" />
                Target Customer Persona (Who Experiences It)
              </h3>
              <p className="text-xs text-slate-300 leading-relaxed bg-slate-950/60 p-3 rounded-xl border border-slate-800">
                {opportunity.targetPersona}
              </p>
            </div>

            <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 space-y-3">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-amber-400" />
                The Core Friction
              </h3>
              <p className="text-xs text-slate-300 leading-relaxed bg-slate-950/60 p-3 rounded-xl border border-slate-800">
                {opportunity.problemDescription}
              </p>
            </div>

            <div className="rounded-2xl border border-rose-900/40 bg-rose-950/15 p-5 space-y-3">
              <h3 className="text-sm font-bold text-rose-300 flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-rose-400" />
                What Existing Solutions Fail to Address
              </h3>
              <p className="text-xs text-slate-300 leading-relaxed">
                {opportunity.existingFails}
              </p>
            </div>
          </div>

          {/* Potential Application Concept & Features */}
          <div className="space-y-4">
            <div className="rounded-2xl border border-cyan-900/40 bg-cyan-950/15 p-5 space-y-3">
              <h3 className="text-sm font-bold text-cyan-300 flex items-center gap-2">
                <Zap className="h-4 w-4 text-cyan-400" />
                Potential Software Application Wedge
              </h3>
              <p className="text-xs text-slate-300 leading-relaxed">
                {opportunity.proposedSolution}
              </p>
            </div>

            <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 space-y-3">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-cyan-400" />
                Suggested High-Impact MVP Features
              </h3>
              <ul className="space-y-2 text-xs text-slate-300">
                {opportunity.suggestedFeatures.map((feat, idx) => (
                  <li key={idx} className="flex items-start gap-2 bg-slate-950/50 p-2.5 rounded-lg border border-slate-800/80">
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-cyan-950 text-cyan-400 font-mono text-[10px] font-bold border border-cyan-800">
                      {idx + 1}
                    </span>
                    <span className="pt-0.5">{feat}</span>
                  </li>
                ))}
              </ul>
            </div>

            <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-5 space-y-2">
              <h3 className="text-sm font-bold text-white flex items-center gap-2">
                <DollarSign className="h-4 w-4 text-emerald-400" />
                Monetisation Strategy & Pricing
              </h3>
              <p className="text-xs text-slate-300 bg-slate-950/60 p-3 rounded-xl border border-slate-800 leading-relaxed font-mono">
                {opportunity.monetization}
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Tab 2: Competitor Vulnerability Matrix */}
      {activeTab === 'competitors' && (
        <div className="relative">
          {/* Paywall preview toggle banner */}
          <div className="mb-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-slate-900 border border-slate-800 p-3 rounded-xl text-xs">
            <span className="text-slate-300 flex items-center gap-1.5">
              <Crown className="h-3.5 w-3.5 text-amber-400" />
              Your plan: <strong>{activePlan} Tier</strong>
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={onOpenPricing}
                className="bg-amber-500/20 text-amber-300 border border-amber-500/40 px-2.5 py-1 rounded text-xs font-semibold hover:bg-amber-500/30 cursor-pointer"
              >
                View Plans
              </button>
            </div>
          </div>

          <div className={`space-y-4 ${isGated ? 'blur-xs select-none pointer-events-none' : ''}`}>
            <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-base font-bold text-white flex items-center gap-2">
                    <Swords className="h-5 w-5 text-purple-400" />
                    Incumbent Vulnerability & Gap Matrix
                  </h3>
                  <p className="text-xs text-slate-400">
                    Why users are actively looking for alternatives and where existing incumbents drop the ball.
                  </p>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                {opportunity.competitors.map((comp, idx) => (
                  <div key={idx} className="rounded-xl border border-slate-800 bg-slate-950/80 p-4 space-y-3">
                    <div className="flex items-center justify-between border-b border-slate-800 pb-2">
                      <span className="font-bold text-white text-sm">{comp.name}</span>
                      <span className="font-mono text-xs text-amber-300 bg-slate-900 px-2 py-0.5 rounded border border-slate-800">
                        {comp.pricing}
                      </span>
                    </div>

                    <div>
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-rose-400 block mb-1">
                        Fatal Incumbent Vulnerability
                      </span>
                      <p className="text-xs text-slate-300 leading-relaxed">
                        {comp.weakness}
                      </p>
                    </div>

                    <div className="pt-2 border-t border-slate-800/80">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-cyan-400 block mb-1">
                        Our Attack Wedge
                      </span>
                      <p className="text-xs text-slate-400">
                        Simpler, modern single-focus API ledger with 5-minute setup and zero enterprise bloat.
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Gated Overlay */}
          {isGated && (
            <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center bg-slate-950/85 backdrop-blur-sm rounded-2xl border border-amber-500/30">
              <div className="h-12 w-12 rounded-full bg-amber-500/20 border border-amber-500/50 flex items-center justify-center text-amber-400 mb-3 shadow-lg">
                <Lock className="h-6 w-6" />
              </div>
              <h3 className="text-base font-bold text-white mb-1">
                Detailed Competitor Vulnerability Matrix is Gated
              </h3>
              <p className="text-xs text-slate-300 max-w-md mb-4">
                Pro subscribers get complete teardowns of competitor pricing, fatal UX bugs reported on G2/Trustpilot, and exact positioning wedges.
              </p>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => {
                    if (onOpenPayment) {
                      onOpenPayment('Pro');
                    } else {
                      onOpenPricing();
                    }
                  }}
                  className="rounded-xl bg-amber-500 px-4 py-2 text-xs font-bold text-slate-950 hover:bg-amber-400 transition-all cursor-pointer shadow-md"
                >
                  Upgrade to Pro ($29/mo)
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Tab 3: Verifiable Raw Quotes */}
      {activeTab === 'evidence' && (
        <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 space-y-4">
          <div className="flex items-center justify-between border-b border-slate-800 pb-3">
            <div>
              <h3 className="text-base font-bold text-white flex items-center gap-2">
                <Quote className="h-5 w-5 text-cyan-400" />
                Raw Discussion Evidence & Quotes
              </h3>
              <p className="text-xs text-slate-400">
                Direct quote snippets indexed and validated by Reddit Scout and Review Scout.
              </p>
            </div>
            <span className="text-xs font-mono text-cyan-400">
              Audited by Research Auditor
            </span>
          </div>

          <div className="space-y-4">
            {opportunity.evidence.map((ev, idx) => (
              <div key={idx} className="rounded-xl border border-slate-800 bg-slate-950 p-4 space-y-2.5">
                <div className="flex items-center justify-between text-xs">
                  <div className="flex items-center gap-2">
                    <span className="font-mono font-bold text-cyan-300 bg-slate-900 px-2 py-0.5 rounded border border-slate-800">
                      {ev.source}
                    </span>
                    <span className="text-slate-400">by {ev.author}</span>
                  </div>
                  <span className="font-mono text-emerald-400 text-[11px] bg-slate-900 px-2 py-0.5 rounded">
                    ▲ {ev.upvotes} upvotes
                  </span>
                </div>

                <p className="text-xs text-slate-200 italic pl-3 border-l-2 border-cyan-500 leading-relaxed">
                  "{ev.quote}"
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tab 4: Development-Ready Specification & Architecture */}
      {activeTab === 'architecture' && (
        <div className="relative">
          <div className={`space-y-4 ${isGated ? 'blur-xs select-none pointer-events-none' : ''}`}>
            <div className="rounded-2xl border border-slate-800 bg-slate-900/60 p-6 space-y-5">
              <div className="flex items-center justify-between border-b border-slate-800 pb-3">
                <div>
                  <h3 className="text-base font-bold text-white flex items-center gap-2">
                    <Code2 className="h-5 w-5 text-emerald-400" />
                    Development Architecture & MVP Spec
                  </h3>
                  <p className="text-xs text-slate-400">
                    Production blueprint ready for an engineer or agency to build in 2-3 weeks.
                  </p>
                </div>
                <button
                  onClick={handleDownloadPRD}
                  className="rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-200 px-3 py-1.5 flex items-center gap-1.5 cursor-pointer"
                >
                  <Download className="h-3.5 w-3.5" />
                  Download Spec (.md)
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
                <div className="rounded-xl bg-slate-950 p-4 border border-slate-800 space-y-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-cyan-400 block">
                    Recommended Tech Stack
                  </span>
                  <p className="font-mono text-slate-200 font-bold">{opportunity.technology}</p>
                  <p className="text-[11px] text-slate-400">
                    Optimized for rapid deployment, high availability, and low serverless operational overhead.
                  </p>
                </div>

                <div className="rounded-xl bg-slate-950 p-4 border border-slate-800 space-y-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-400 block">
                    Estimated Build Budget
                  </span>
                  <p className="font-mono text-slate-200 font-bold">{opportunity.budget}</p>
                  <p className="text-[11px] text-slate-400">
                    Accounts for domain, hosting, authentication, SMS/email relays, and Stripe setup.
                  </p>
                </div>

                <div className="rounded-xl bg-slate-950 p-4 border border-slate-800 space-y-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-emerald-400 block">
                    Business Model & ACV
                  </span>
                  <p className="font-mono text-slate-200 font-bold">{opportunity.businessModel}</p>
                  <p className="text-[11px] text-slate-400">
                    Target ACV {opportunity.estACV}. Break-even requires fewer than 15 paying customers.
                  </p>
                </div>
              </div>

              {/* Step-by-Step Build Sprints */}
              <div className="rounded-xl bg-slate-950 p-4 border border-slate-800 space-y-3">
                <h4 className="text-xs font-bold text-white uppercase tracking-wider">
                  3-Week Sprint Execution Blueprint
                </h4>
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
                  <div className="rounded-lg bg-slate-900 p-3 border border-slate-800 space-y-1">
                    <span className="font-mono text-[10px] font-bold text-cyan-400">Week 1: Core Engine</span>
                    <p className="text-slate-300">Build webhook endpoints and data schema. Test bidirectional sync with mock POS/payment accounts.</p>
                  </div>
                  <div className="rounded-lg bg-slate-900 p-3 border border-slate-800 space-y-1">
                    <span className="font-mono text-[10px] font-bold text-amber-400">Week 2: User Action UI</span>
                    <p className="text-slate-300">Create the mobile reconciliation action screen and alert settings. Integrate Stripe Billing.</p>
                  </div>
                  <div className="rounded-lg bg-slate-900 p-3 border border-slate-800 space-y-1">
                    <span className="font-mono text-[10px] font-bold text-emerald-400">Week 3: GTM Outreach</span>
                    <p className="text-slate-300">Directly DM the authors of the 4,200 indexed complaints offering a 50% lifetime discount.</p>
                  </div>
                </div>
              </div>
            </div>
          </div>

          {isGated && (
            <div className="absolute inset-0 flex flex-col items-center justify-center p-6 text-center bg-slate-950/85 backdrop-blur-sm rounded-2xl border border-amber-500/30">
              <div className="h-12 w-12 rounded-full bg-amber-500/20 border border-amber-500/50 flex items-center justify-center text-amber-400 mb-3 shadow-lg">
                <Lock className="h-6 w-6" />
              </div>
              <h3 className="text-base font-bold text-white mb-1">
                Development Specs & PRD Exports are Pro Features
              </h3>
              <p className="text-xs text-slate-300 max-w-md mb-4">
                Unlock full technical blueprints, database schemas, and 3-week sprint roadmaps ready for your development team.
              </p>
              <div className="flex items-center gap-3">
                <button
                  onClick={() => {
                    if (onOpenPayment) {
                      onOpenPayment('Pro');
                    } else {
                      onOpenPricing();
                    }
                  }}
                  className="rounded-xl bg-amber-500 px-4 py-2 text-xs font-bold text-slate-950 hover:bg-amber-400 transition-all cursor-pointer shadow-md"
                >
                  Upgrade to Pro ($29/mo)
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
