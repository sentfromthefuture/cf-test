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
}

export interface BotScout {
  id: string;
  name: string;
  role: string;
  platform: string;
  target: string;
  activeScans: number;
  status: 'active' | 'analyzing' | 'generating' | 'verifying' | 'idle';
  speed: string;
  lastFinding: string;
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
