import React from 'react';
import { ArrowRight, Radar, Search, Layers3, ChartNoAxesCombined, ShieldCheck, Database, Sparkles, CircleDot } from 'lucide-react';

interface LandingViewProps {
  records: number | null;
  clusters: number | null;
  sources: number | null;
  collectionReady: boolean;
  onExplore: () => void;
  onOpenPricing: () => void;
  onSignIn: () => void;
}

const pillars = [
  { icon: Search, title: 'Find recurring problems', body: 'Explore issues people discuss across public developer and community sources, grouped into recurring themes.' },
  { icon: Layers3, title: 'See the evidence', body: 'Open a problem dossier to inspect discussion volume, source coverage, growth signals and original links.' },
  { icon: ChartNoAxesCombined, title: 'Compare opportunities', body: 'Use transparent scoring components and trend context to decide which ideas deserve validation.' },
  { icon: Sparkles, title: 'Turn research into a brief', body: 'Generate a product and validation brief grounded in matching collected research—not fabricated market numbers.' },
];

export const LandingView: React.FC<LandingViewProps> = ({ records, clusters, sources, collectionReady, onExplore, onOpenPricing, onSignIn }) => (
  <div className="mx-auto max-w-7xl space-y-20 pb-10">
    <section className="relative overflow-hidden rounded-3xl border border-slate-800 bg-[#101317] px-6 py-14 sm:px-10 lg:px-16 lg:py-20">
      <div className="pointer-events-none absolute -right-24 -top-24 h-80 w-80 rounded-full border border-slate-700/50" />
      <div className="pointer-events-none absolute -right-10 -top-10 h-52 w-52 rounded-full border border-slate-700/40" />
      <div className="relative max-w-3xl space-y-7">
        <div className="inline-flex items-center gap-2 rounded-full border border-slate-700 bg-slate-900/80 px-3 py-1.5 text-[11px] font-medium tracking-wide text-slate-300">
          <span className={collectionReady ? 'h-1.5 w-1.5 rounded-full bg-emerald-400' : 'h-1.5 w-1.5 rounded-full bg-slate-500'} />
          MARKET RESEARCH FROM PUBLIC DISCUSSIONS
        </div>
        <h1 className="max-w-3xl text-4xl font-semibold leading-[1.08] tracking-tight text-white sm:text-5xl lg:text-6xl">
          Build what people are already asking for.
        </h1>
        <p className="max-w-2xl text-base leading-7 text-slate-300 sm:text-lg">
          DemandRadar turns public conversations into organised problem intelligence—so founders can investigate demand before committing to a build.
        </p>
        <div className="flex flex-col gap-3 sm:flex-row">
          <button onClick={onExplore} className="inline-flex items-center justify-center gap-2 rounded-xl bg-slate-100 px-5 py-3 text-sm font-semibold text-slate-950 hover:bg-white">
            Explore research <ArrowRight size={16} />
          </button>
          <button onClick={onOpenPricing} className="rounded-xl border border-slate-700 bg-slate-900/70 px-5 py-3 text-sm font-medium text-slate-200 hover:border-slate-500 hover:bg-slate-800">
            View plans
          </button>
          <button onClick={onSignIn} className="rounded-xl px-4 py-3 text-sm text-slate-400 hover:text-white">
            Sign in
          </button>
        </div>
        <p className="text-xs text-slate-500">Signals are research leads, not proof of market demand or a guarantee of product success.</p>
      </div>
      <div className="relative mt-12 grid grid-cols-1 gap-3 border-t border-slate-800 pt-6 sm:grid-cols-3">
        <div><div className="text-2xl font-semibold tabular-nums text-white">{records === null ? '—' : records.toLocaleString()}</div><div className="mt-1 text-xs text-slate-500">Public records collected</div></div>
        <div><div className="text-2xl font-semibold tabular-nums text-white">{clusters === null ? '—' : clusters.toLocaleString()}</div><div className="mt-1 text-xs text-slate-500">Problem clusters identified</div></div>
        <div><div className="text-2xl font-semibold tabular-nums text-white">{sources === null ? '—' : sources.toLocaleString()}</div><div className="mt-1 text-xs text-slate-500">Sources currently enabled</div></div>
      </div>
    </section>

    <section className="space-y-8">
      <div className="max-w-2xl space-y-3">
        <p className="text-[11px] font-semibold uppercase tracking-[.2em] text-slate-500">A clearer path from signal to decision</p>
        <h2 className="text-2xl font-semibold tracking-tight text-white sm:text-3xl">Research first. Validate next. Build with context.</h2>
        <p className="text-sm leading-6 text-slate-400">A practical workspace for discovering recurring friction, understanding its evidence and deciding what to test with real users.</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {pillars.map((p, i) => { const Icon = p.icon; return <article key={p.title} className="rounded-2xl border border-slate-800 bg-[#111418] p-5">
          <div className="mb-5 flex h-10 w-10 items-center justify-center rounded-xl border border-slate-700 bg-slate-900 text-slate-200"><Icon size={18} /></div>
          <div className="mb-2 text-[10px] font-mono text-slate-600">0{i + 1}</div>
          <h3 className="mb-2 text-sm font-semibold text-white">{p.title}</h3>
          <p className="text-xs leading-6 text-slate-400">{p.body}</p>
        </article>; })}
      </div>
    </section>

    <section className="grid gap-8 rounded-2xl border border-slate-800 bg-[#101317] p-6 sm:p-8 lg:grid-cols-[1fr_auto] lg:items-center">
      <div className="max-w-2xl space-y-3">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-400"><ShieldCheck size={15} /> Evidence over hype</div>
        <h2 className="text-xl font-semibold text-white">Know what the data says—and what it doesn’t.</h2>
        <p className="text-sm leading-6 text-slate-400">We distinguish collected facts from AI estimates and commercial hypotheses. Source links let you inspect the underlying conversations and make your own judgement.</p>
      </div>
      <button onClick={onExplore} className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-600 px-5 py-3 text-sm font-semibold text-white hover:bg-slate-800">Open the workspace <ArrowRight size={16} /></button>
    </section>
    <div className="flex flex-wrap items-center justify-center gap-5 text-[11px] text-slate-600">
      <span className="inline-flex items-center gap-1.5"><Radar size={13} /> DemandRadar</span>
      <span className="inline-flex items-center gap-1.5"><Database size={13} /> Public-source research</span>
      <span className="inline-flex items-center gap-1.5"><CircleDot size={13} /> Evidence-linked insights</span>
    </div>
  </div>
);
