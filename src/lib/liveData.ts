import { supabase } from './supabase';
import { EvidenceQuote, Opportunity, OpportunityLevel } from '../types';

// Live data comes only from Supabase SECURITY DEFINER functions (dr_*): raw tables are never readable from the browser,
// and no privileged key exists in this bundle. Every call fails soft so the app still renders if the backend is not deployed.

export interface SourceInfo {
  id: string;
  name: string;
  description: string | null;
  availability: 'implemented' | 'skipped';
  enabled: boolean;
  status: 'idle' | 'running' | 'error' | 'disabled' | 'unavailable' | 'stalled';
  interval_minutes: number;
  records_total: number;
  last_run_at: string | null;
  last_success_at: string | null;
  next_run_at: string | null;
  last_error: string | null;
  quota_limit: number | null;
  quota_remaining: number | null;
  quota_reset_at: string | null;
  license_note: string | null;
  skip_reason: string | null;
  access_restriction: string | null;
  official_api: boolean | null;
  integration_requirements: string | null;
  docs_url: string | null;
  requests_today: number;
  errors_today: number;
  rate_limited_today: number;
  last_run: { status: string; fetched: number; inserted: number; duplicates: number; errors: number; finished_at: string | null; trigger: string } | null;
}

export interface Overview {
  records_total: number;
  records_24h: number;
  records_prev_24h: number;
  problems_total: number;
  problems_24h: number;
  pending_analysis: number;
  clusters_total: number;
  clusters_multi_source: number;
  clusters_summarised: number;
  implemented_sources: number;
  enabled_sources: number;
  last_collection_at: string | null;
  by_source: Array<{ source_id: string; name: string; records: number }>;
  top_industry: { industry: string; unique_discussions: number } | null;
  fastest_growing: { id: string; title: string; growth_rate: number } | null;
  industries: Array<{ industry: string; clusters: number; unique_discussions: number }>;
}

export interface Activity {
  daily: Array<{ day: string; source_id: string; records: number }>;
  runs: Array<{ day: string; runs: number; errors: number }>;
}

export interface RecentSignal {
  record_id: string;
  source_id: string;
  title: string | null;
  url: string;
  published_at: string | null;
  problem_statement: string | null;
  signal_type: string;
  industry: string | null;
  analysis_method: 'llm' | 'heuristic';
  cluster_id: string | null;
  analyzed_at: string;
}

interface ScoreComponent { value: number | null; weight: number; basis: string }
export interface ClusterRow {
  id: string;
  title: string;
  industry: string | null;
  use_case: string | null;
  members_count: number;
  unique_discussions: number;
  source_count: number;
  sources: string[];
  source_first_seen: Record<string, string>;
  spreading: boolean;
  engagement_total: number;
  first_seen_at: string | null;
  last_seen_at: string | null;
  recent_discussions: number;
  prior_discussions: number;
  growth_rate: number | null;
  severity_avg: number | null;
  wtp_signals: number;
  competitors: Record<string, number>;
  scores: { formula?: string; components?: Record<string, ScoreComponent> };
  composite_score: number | null;
  confidence: 'low' | 'medium' | 'high';
  summary: null | {
    title?: string; problem_description?: string; target_persona?: string; existing_solutions?: string[];
    why_current_solutions_fall_short?: string; proposed_solution?: string; suggested_features?: string[];
    monetization_hypothesis?: string; development_feasibility?: number; caveats?: string;
  };
  summarized_at: string | null;
}

async function rpc<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw new Error(error.message);
  return data as T;
}

export const fetchSources = () => rpc<SourceInfo[]>('dr_public_sources');
export const fetchOverview = () => rpc<Overview>('dr_overview');
export const fetchActivity = (days = 14) => rpc<Activity>('dr_activity', { p_days: days });
export const fetchRecentSignals = (limit = 20, offset = 0) => rpc<RecentSignal[]>('dr_recent_signals', { p_limit: limit, p_offset: offset });
export const fetchClusters = (o: { limit?: number; offset?: number; minDiscussions?: number; minSources?: number; order?: 'score' | 'growth' | 'discussions' | 'recent'; industry?: string | null } = {}) =>
  rpc<{ total: number; items: ClusterRow[] }>('dr_clusters_list', {
    p_limit: o.limit ?? 50, p_offset: o.offset ?? 0, p_industry: o.industry ?? null,
    p_min_sources: o.minSources ?? 1, p_order: o.order ?? 'score', p_min_discussions: o.minDiscussions ?? 1,
  });
export const fetchIsAdmin = async () => {
  try { return (await rpc<boolean>('dr_is_admin')) === true; } catch { return false; }
};
export const adminSetSource = (source: string, enabled?: boolean, intervalMinutes?: number) =>
  rpc<null>('dr_admin_set_source', { p_source: source, p_enabled: enabled ?? null, p_interval: intervalMinutes ?? null });

export interface SyncResult {
  sources: Array<{ id: string; status: string; stats: { fetched: number; inserted: number; duplicates: number; errors: number }; error: string | null }>;
  analysis: { analysed: number; problems: number; method: string } | null;
}
/** Manual sync: the Edge Function re-verifies that the caller is an admin; this button is only a convenience. */
export async function triggerSync(source?: string): Promise<SyncResult> {
  const { data, error } = await supabase.functions.invoke('collect', { body: source ? { source } : {} });
  if (error) {
    // Surface the function's own message (e.g. "unauthorized") instead of a generic one.
    let detail = error.message || 'sync failed';
    const ctx = (error as { context?: Response }).context;
    if (ctx && typeof ctx.json === 'function') {
      try {
        const j = await ctx.json();
        if (j?.error) detail = `${j.error}${j.detail ? `: ${j.detail}` : ''}`;
      } catch { /* keep generic message */ }
    } else if (/failed to send a request/i.test(detail)) {
      detail = 'Could not reach the collect function (not deployed, blocked by the browser, or offline).';
    }
    throw new Error(detail);
  }
  return data as SyncResult;
}

export async function fetchEvidence(clusterId: string): Promise<EvidenceQuote[]> {
  const rows = await rpc<Array<{ source_id: string; kind: string; title: string | null; excerpt: string | null; url: string; engagement: Record<string, number>; license: string; attribution: string | null; analysis_method: 'llm' | 'heuristic' }>>('dr_cluster_evidence', { p_cluster: clusterId, p_limit: 20 });
  return rows.map((r) => ({
    source: SOURCE_LABELS[r.source_id] ?? r.source_id,
    author: r.attribution ?? 'Author hidden (not stored)',
    quote: (r.excerpt || r.title || '').trim(),
    upvotes: Math.round(Object.values(r.engagement ?? {}).reduce((a, b) => a + (Number(b) || 0), 0)),
    url: r.url, license: r.license, attribution: r.attribution ?? undefined, analysisMethod: r.analysis_method,
  }));
}

export const SOURCE_LABELS: Record<string, string> = { github: 'GitHub', hackernews: 'Hacker News', stackexchange: 'Stack Exchange' };

const wtpLabel = (n: number): Opportunity['willingnessToPay'] => (n <= 0 ? 'Low' : n === 1 ? 'Moderate' : n <= 3 ? 'High' : n <= 5 ? 'Very High' : 'Extreme');

function levelFor(score: number, confidence: ClusterRow['confidence']): OpportunityLevel {
  if (confidence === 'low') return 'Emerging'; // thin evidence can never be rated Critical/High
  return score >= 75 ? 'Critical' : score >= 60 ? 'High' : score >= 40 ? 'Medium' : 'Emerging';
}

/** Maps a measured cluster to the existing Opportunity shape. Nothing is invented: unknowns are blank or flagged. */
export function clusterToOpportunity(c: ClusterRow): Opportunity {
  const comp = c.scores?.components ?? {};
  const v = (k: string) => comp[k]?.value ?? 0;
  const basis = (k: string) => comp[k]?.basis ?? 'insufficient_data';
  const s = c.summary;
  const feas = s?.development_feasibility;
  const competitors = Object.entries(c.competitors ?? {}).map(([name, n]) => ({
    name: name.replace(/\b\w/g, (m) => m.toUpperCase()),
    weakness: `Named as a current option in ${n} independent discussion${n === 1 ? '' : 's'}`,
    pricing: 'Not collected',
  }));
  const growthLabel = c.growth_rate === null ? 'Insufficient data' : `${c.growth_rate > 0 ? '+' : ''}${c.growth_rate}%`;
  return {
    id: c.id,
    title: s?.title || c.title,
    category: c.industry ?? 'Other',
    discussions: c.unique_discussions,
    growth: growthLabel,
    growthRate: c.growth_rate ?? 0,
    opportunityLevel: levelFor(c.composite_score ?? 0, c.confidence),
    urgency: Math.round(v('painIntensity')),
    willingnessToPay: wtpLabel(c.wtp_signals),
    estACV: 'Not estimated',
    country: 'Global (English-language public sources)',
    difficulty: feas ? (feas >= 4 ? 'Low' : feas === 3 ? 'Medium' : 'High') : 'Medium',
    budget: 'Not estimated',
    technology: 'Not assessed',
    businessModel: s?.monetization_hypothesis ?? 'Not yet generated',
    scores: {
      problemFrequency: v('problemFrequency'), demandGrowth: v('demandGrowth'), painIntensity: v('painIntensity'),
      willingnessToPay: v('willingnessToPay'), competitionGap: v('competitionGap'), developmentFeasibility: v('developmentFeasibility'),
      compositeScore: Math.round(c.composite_score ?? 0),
    },
    targetPersona: s?.target_persona ?? 'Not yet summarised',
    problemDescription: s?.problem_description ?? c.title,
    existingFails: s?.why_current_solutions_fall_short ?? 'Not yet analysed',
    proposedSolution: s?.proposed_solution ?? 'Not yet generated',
    suggestedFeatures: s?.suggested_features ?? [],
    monetization: s?.monetization_hypothesis ?? 'Not yet generated',
    competitors,
    evidence: [],
    live: {
      clusterId: c.id, uniqueDiscussions: c.unique_discussions, sourceCount: c.source_count, sources: c.sources, spreading: c.spreading,
      confidence: c.confidence, engagementTotal: c.engagement_total, wtpEvidenceCount: c.wtp_signals, growthPct: c.growth_rate,
      recentDiscussions: c.recent_discussions, priorDiscussions: c.prior_discussions, firstSeen: c.first_seen_at, lastSeen: c.last_seen_at,
      severityAvg: c.severity_avg,
      basis: {
        problemFrequency: basis('problemFrequency'), demandGrowth: basis('demandGrowth'), painIntensity: basis('painIntensity'),
        willingnessToPay: basis('willingnessToPay'), competitionGap: basis('competitionGap'), developmentFeasibility: basis('developmentFeasibility'),
      },
      aiSummarised: !!s, scoreFormula: c.scores?.formula ?? '', competitorsNamed: c.competitors ?? {},
    },
  };
}

export const BASIS_LABEL: Record<string, { text: string; className: string }> = {
  measured: { text: 'Measured', className: 'text-emerald-300 border-emerald-800 bg-emerald-950/40' },
  evidence_count: { text: 'Evidence count', className: 'text-emerald-300 border-emerald-800 bg-emerald-950/40' },
  derived: { text: 'Derived from mentions', className: 'text-sky-300 border-sky-800 bg-sky-950/40' },
  ai_estimate: { text: 'AI estimate', className: 'text-amber-300 border-amber-800 bg-amber-950/40' },
  insufficient_data: { text: 'Insufficient data', className: 'text-slate-400 border-slate-700 bg-slate-900' },
};

export const timeAgo = (iso: string | null | undefined): string => {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  const abs = Math.abs(ms);
  const fmt = abs < 60_000 ? `${Math.round(abs / 1000)}s` : abs < 3_600_000 ? `${Math.round(abs / 60_000)}m` : abs < 86_400_000 ? `${Math.round(abs / 3_600_000)}h` : `${Math.round(abs / 86_400_000)}d`;
  return ms >= 0 ? `${fmt} ago` : `in ${fmt}`;
};
