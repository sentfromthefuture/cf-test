export type OpportunityLevel = 'Critical' | 'High' | 'Medium' | 'Emerging';

export interface ScoreBreakdown {
  problemFrequency: number;     // 25%
  demandGrowth: number;         // 20%
  painIntensity: number;        // 20%
  willingnessToPay: number;     // 15%
  competitionGap: number;       // 10%
  developmentFeasibility: number; // 10%
  compositeScore: number;       // 0 - 100
}

export interface CompetitorItem {
  name: string;
  weakness: string;
  pricing: string;
  ourWedge?: string;
}

export interface EvidenceQuote {
  source: string;
  author: string;
  quote: string;
  upvotes: number;
  /** Live evidence only: link back to the original discussion, and the licence/attribution that must accompany the excerpt. */
  url?: string;
  license?: string;
  attribution?: string;
  analysisMethod?: 'llm' | 'heuristic';
}

/** Present only on opportunities built from real collected data (absent on demo data). */
export interface LiveMeta {
  clusterId: string;
  uniqueDiscussions: number;
  sourceCount: number;
  sources: string[];
  spreading: boolean;
  confidence: 'low' | 'medium' | 'high';
  engagementTotal: number;
  wtpEvidenceCount: number;
  growthPct: number | null;
  recentDiscussions: number;
  priorDiscussions: number;
  firstSeen: string | null;
  lastSeen: string | null;
  severityAvg: number | null;
  /** Per score component: measured | ai_estimate | evidence_count | derived | insufficient_data */
  basis: Partial<Record<keyof Omit<ScoreBreakdown, 'compositeScore'>, string>>;
  aiSummarised: boolean;
  scoreFormula: string;
  competitorsNamed: Record<string, number>;
}

export interface Opportunity {
  id: string;
  title: string;
  category: string;
  discussions: number;
  growth: string;
  growthRate: number;
  opportunityLevel: OpportunityLevel;
  urgency: number;
  willingnessToPay: 'Low' | 'Moderate' | 'High' | 'Very High' | 'Extreme';
  estACV: string;
  country: string;
  difficulty: 'Low' | 'Medium' | 'High';
  budget: string;
  technology: string;
  businessModel: string;
  scores: ScoreBreakdown;
  targetPersona: string;
  problemDescription: string;
  existingFails: string;
  proposedSolution: string;
  suggestedFeatures: string[];
  monetization: string;
  competitors: CompetitorItem[];
  evidence: EvidenceQuote[];
  live?: LiveMeta;
}

export type PricingTier = 'Free' | 'Starter' | 'Pro' | 'Business';

export interface ScoringWeights {
  problemFrequency: number;
  demandGrowth: number;
  painIntensity: number;
  willingnessToPay: number;
  competitionGap: number;
  developmentFeasibility: number;
}
