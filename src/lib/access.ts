import { Opportunity, PricingTier } from '../types';

// Free plan: only the 3 highest-scoring opportunities can be opened.
export const canOpenOpportunity = (plan: PricingTier, opp: Opportunity, all: Opportunity[]) =>
  plan !== 'Free' || [...all].sort((a, b) => b.scores.compositeScore - a.scores.compositeScore).slice(0, 3).some((o) => o.id === opp.id);
