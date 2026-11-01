import { BotScout, Opportunity, ScoringWeights } from '../types';

export const DEFAULT_WEIGHTS: ScoringWeights = {
  problemFrequency: 25,
  demandGrowth: 20,
  painIntensity: 20,
  willingnessToPay: 15,
  competitionGap: 10,
  developmentFeasibility: 10,
};

export const INITIAL_BOTS: BotScout[] = [
  { id: 'bot-1', name: 'Reddit Scout', role: 'Finds people discussing problems', platform: 'Reddit', target: 'r/smallbusiness, r/entrepreneur, r/sysadmin', activeScans: 1420, status: 'active', speed: '48 scans/min', lastFinding: 'Struggling with multi-location stock synchronization' },
  { id: 'bot-2', name: 'Facebook Scout', role: 'Monitors accessible public discussions', platform: 'Public Groups', target: 'Landlord & Property Ops, HVAC Techs', activeScans: 890, status: 'active', speed: '32 scans/min', lastFinding: 'Manual rent collection reconciliation headaches' },
  { id: 'bot-3', name: 'X Scout', role: 'Identifies complaints and emerging trends', platform: 'X / Twitter', target: '#saasfail, #freelancepain, "why is there no tool for"', activeScans: 3120, status: 'active', speed: '115 scans/min', lastFinding: 'Unpaid invoice chasing automated reminders missing WhatsApp' },
  { id: 'bot-4', name: 'Developer Scout', role: 'Monitors developer communities', platform: 'GitHub & StackOverflow', target: 'Discussions, Issues tagged "feature-abandoned"', activeScans: 2200, status: 'active', speed: '64 scans/min', lastFinding: 'Dockerized microservice log correlation costs skyrocketing' },
  { id: 'bot-5', name: 'Review Scout', role: 'Analyses complaints about existing products', platform: 'G2, Capterra, Trustpilot', target: '1-3 star reviews on incumbent ERP/CRM software', activeScans: 1850, status: 'active', speed: '52 scans/min', lastFinding: 'Toast POS add-on fee fatigue among independent cafes' },
  { id: 'bot-6', name: 'Startup Scout', role: 'Tracks newly emerging competitors', platform: 'ProductHunt & YC DB', target: 'Weekly product launches with high pivot rates', activeScans: 740, status: 'active', speed: '24 scans/min', lastFinding: 'Niche dispatch software gap for septic & grease trap operators' },
  { id: 'bot-7', name: 'Trend Scout', role: 'Identifies rapidly growing problems', platform: 'Google Trends & Discourse', target: 'Surge search queries matching "alternative to"', activeScans: 1610, status: 'active', speed: '58 scans/min', lastFinding: 'Rising compliance overhead for EU AI Act documentation' },
  { id: 'bot-8', name: 'Opportunity Analyst', role: 'Evaluates commercial potential', platform: 'Analysis Engine', target: 'Willingness-to-pay signals and unit economics', activeScans: 980, status: 'analyzing', speed: '36 clusters/min', lastFinding: 'Verified ACV $1,200/yr willingness for contractor permit tracking' },
  { id: 'bot-9', name: 'Idea Generator', role: 'Converts problems into software ideas', platform: 'Synthesis Hub', target: 'Micro-SaaS & workflow automation blueprints', activeScans: 620, status: 'generating', speed: '18 briefs/min', lastFinding: 'Generated autonomous WhatsApp invoice chaser for Latin America' },
  { id: 'bot-10', name: 'Research Auditor', role: 'Checks evidence and removes duplicate findings', platform: 'Verification Gate', target: 'Semantic deduplication & source quotation veracity', activeScans: 1290, status: 'verifying', speed: '80 verifications/min', lastFinding: 'Consolidated 48 redundant inventory complaints into Cluster #DR-409' },
];

export const INITIAL_OPPORTUNITIES: Opportunity[] = [
  {
    id: 'opp-1',
    title: 'Inventory Synchronizer for Independent Multi-Location Retailers',
    category: 'Retail & Commerce',
    discussions: 4200,
    growth: '+35%',
    growthRate: 35,
    opportunityLevel: 'Critical',
    urgency: 88,
    willingnessToPay: 'Very High',
    estACV: '$1,800/yr',
    country: 'United States & UK',
    difficulty: 'Medium',
    budget: '$1,000 - $3,000',
    technology: 'Next.js + Postgres + Shopify/Square Sync',
    businessModel: 'B2B Tiered SaaS',
    scores: {
      problemFrequency: 92,
      demandGrowth: 86,
      painIntensity: 94,
      willingnessToPay: 90,
      competitionGap: 82,
      developmentFeasibility: 85,
      compositeScore: 89,
    },
    targetPersona: 'Owners of 2-5 boutique apparel, gift, or specialty retail locations running both POS and online stores.',
    problemDescription: 'Retailers face stockouts and double-selling because modern POS systems (Square, Lightspeed, Shopify POS) fail to reliably reconcile in-store returns, damaged stock, and multi-warehouse transfers without manual spreadsheet updates.',
    existingFails: 'Enterprise ERPs like NetSuite cost $25k+/yr and require consultants; low-end sync apps suffer from 15-minute polling delays leading to accidental stockouts on high-demand items.',
    proposedSolution: 'Event-driven real-time multi-location inventory ledger with two-way webhook reconciliation and mobile barcode reconciliation app.',
    suggestedFeatures: [
      'Sub-second bidirectional stock sync across POS and e-commerce carts',
      'One-tap damaged/returned goods quarantine scanner (iOS/Android camera)',
      'Automated inter-store inventory rebalancing suggestions based on local sell-through',
      'Instant stockout guard that holds cart reservations across platforms'
    ],
    monetization: 'Tiered based on locations: $79/mo (up to 2 locations), $149/mo (up to 5 locations), $299/mo (enterprise custom ERP sync).',
    competitors: [
      { name: 'Katana Cloud', weakness: 'Built for manufacturing, lacks agile retail POS sync', pricing: '$179/mo+' },
      { name: 'Cin7', weakness: 'Bloated UI, steep 6-week onboarding curve, frequent API timeout disconnects', pricing: '$349/mo+' },
      { name: 'Stocky (Shopify)', weakness: 'Locked only to Shopify POS, no multi-channel marketplace support', pricing: 'Included in Shopify Advanced' }
    ],
    evidence: [
      { source: 'r/smallbusiness', author: 'u/BoutiqueOpsGuy', quote: 'I just lost $800 yesterday because Square sold a leather jacket in-store that had been purchased 4 minutes earlier on Shopify. I spend 2 hours every night reconciling CSVs.', upvotes: 214 },
      { source: 'G2 Review on Lightspeed', author: 'Apparel Store Owner (UK)', quote: 'The multi-store transfer module is an absolute nightmare. Inventory goes missing in transit digitally and support takes 5 days to resolve ghost quantities.', upvotes: 98 },
      { source: 'X / Twitter', author: '@AustinRetailer', quote: 'Why is there no simple $99/mo tool that just keeps 3 retail stores in sync without trying to be an entire enterprise ERP nightmare?', upvotes: 147 }
    ]
  },
  {
    id: 'opp-2',
    title: 'Automated Rent Arrears Escalator & WhatsApp Dispute Ledger',
    category: 'Real Estate & PropTech',
    discussions: 2800,
    growth: '+22%',
    growthRate: 22,
    opportunityLevel: 'High',
    urgency: 84,
    willingnessToPay: 'High',
    estACV: '$960/yr',
    country: 'United States, UK, Canada',
    difficulty: 'Low',
    budget: '<$1,000',
    technology: 'Node.js + Twilio WhatsApp + Stripe ACH',
    businessModel: 'Freemium + Flat Fee per Door',
    scores: {
      problemFrequency: 84,
      demandGrowth: 78,
      painIntensity: 88,
      willingnessToPay: 82,
      competitionGap: 86,
      developmentFeasibility: 92,
      compositeScore: 84,
    },
    targetPersona: 'Independent self-managing landlords with 3 to 20 rental units and small property managers.',
    problemDescription: 'Tenants ignore formal emails; chasing late payments through awkward phone calls causes emotional friction and delayed cash flows. Existing rent tools lack compliant, respectful automated messaging channels.',
    existingFails: 'AppFolio and Buildium charge minimum portfolio monthly fees ($280/mo minimum) out of reach for small landlords; Venmo/Zelle lack lease tracking, fee compounding, or legal notice generation.',
    proposedSolution: 'Automated rent collection assistant that orchestrates polite reminders via SMS and WhatsApp, automatically waives or triggers late fees, and generates legally compliant notice-to-cure letters with certified proof.',
    suggestedFeatures: [
      'Multi-channel polite escalation sequence (WhatsApp, SMS, Email)',
      'Direct ACH split-deposit with 0-fee tenant incentives',
      'Automated tenant maintenance request holdback deduction ledger',
      'One-click state-compliant legal 3-day notice generation with audit trail'
    ],
    monetization: '$4 per unit/month or $29/mo flat for up to 10 doors. Optional 1% instant tenant cash advance fee.',
    competitors: [
      { name: 'TurboTenant', weakness: 'Heavy emphasis on screening; payment follow-up is purely passive email', pricing: '$8.25/mo/unit' },
      { name: 'Avail', weakness: 'Slow 5-day bank transfers unless paying high premium tier', pricing: '$7/unit/mo' },
      { name: 'Zillow Rental Manager', weakness: 'No customizable arrears communication, rigid fee policies', pricing: 'Free / ad-supported' }
    ],
    evidence: [
      { source: 'Facebook Landlord Network', author: 'Marcus D.', quote: 'I have 7 duplexes. Chasing 4 different tenants every month on WhatsApp is draining my soul. I feel like a debt collector instead of a property investor.', upvotes: 176 },
      { source: 'r/realestateinvesting', author: 'u/MidwestDuplexes', quote: 'Tenants do not open emails. The moment I send a WhatsApp reminder with the direct payment link, 90% pay within 1 hour. Why does no rental software do this natively?', upvotes: 341 }
    ]
  },
  {
    id: 'opp-3',
    title: 'Autonomous Client Unpaid Invoice Recovery Engine',
    category: 'Freelance & Agency Ops',
    discussions: 1900,
    growth: '+18%',
    growthRate: 18,
    opportunityLevel: 'High',
    urgency: 91,
    willingnessToPay: 'Very High',
    estACV: '$600/yr',
    country: 'Global',
    difficulty: 'Low',
    budget: '<$1,000',
    technology: 'Next.js + Stripe/Wise API + SendGrid',
    businessModel: 'Subscription + Success Fee',
    scores: {
      problemFrequency: 86,
      demandGrowth: 74,
      painIntensity: 95,
      willingnessToPay: 88,
      competitionGap: 80,
      developmentFeasibility: 94,
      compositeScore: 86,
    },
    targetPersona: 'Freelance software developers, design agencies, video editors, and solo consultants billing $5k-$30k/month.',
    problemDescription: 'Freelancers spend 10+ hours a month politely badgering clients for overdue payments. They fear damaging client relationships by being too aggressive, yet suffer personal cash crunches from 60-90 day net terms.',
    existingFails: 'QuickBooks and FreshBooks send robotic emails that go straight to the spam folder or accounting black holes, with zero escalation or smart follow-up.',
    proposedSolution: 'AI-assisted empathetic "Virtual CFO" agent that connects to your accounting system, crafts personalized, context-aware nudge sequences, and facilitates instant partial payment plans.',
    suggestedFeatures: [
      'Two-way sync with QuickBooks, Xero, Stripe Invoicing, and Harvest',
      'AI tone calibrated from "gentle check-in" to "pre-collections formal demand"',
      'One-click split payment link generation (50% now, 50% in 14 days)',
      'Client payment reliability score calculated from public business health data'
    ],
    monetization: '$19/mo base subscription + 1.5% fee on invoices recovered past 30 days overdue.',
    competitors: [
      { name: 'Collbox', weakness: 'Only connects to third-party collection agencies taking 30-40% cut', pricing: '25-45% contingency fee' },
      { name: 'FreshBooks Built-in Reminders', weakness: 'Static automated text that clients immediately ignore', pricing: 'Included in $30/mo plan' }
    ],
    evidence: [
      { source: 'X / Twitter', author: '@alex_devbuilds', quote: 'I have $22,000 in outstanding invoices across 3 enterprise clients that are 45 days late. The awkwardness of asking for my own earned money is the worst part of freelancing.', upvotes: 820 },
      { source: 'r/freelance', author: 'u/PixelCrafterUK', quote: 'Every time I threaten legal action I lose the client. If an automated third-party "billing system" handled it impersonally, my relationships would be preserved.', upvotes: 495 }
    ]
  },
  {
    id: 'opp-4',
    title: 'Predictable Food Waste & Prep Estimator for Independent Kitchens',
    category: 'Hospitality & Food Ops',
    discussions: 1400,
    growth: '+28%',
    growthRate: 28,
    opportunityLevel: 'Critical',
    urgency: 89,
    willingnessToPay: 'High',
    estACV: '$2,400/yr',
    country: 'US, UK, Australia, Germany',
    difficulty: 'Medium',
    budget: '$2,000 - $5,000',
    technology: 'Python / FastAPI + React + Weather & Local Events API',
    businessModel: 'B2B SaaS ($199/mo)',
    scores: {
      problemFrequency: 80,
      demandGrowth: 85,
      painIntensity: 92,
      willingnessToPay: 86,
      competitionGap: 88,
      developmentFeasibility: 79,
      compositeScore: 85,
    },
    targetPersona: 'Independent head chefs, kitchen managers, and cafe owners throwing away 10-18% of perishable food weekly.',
    problemDescription: 'Kitchen prep sheets are calculated with gut feel. Unexpected rainy days, sports games, or holiday weekends cause massive spoilage or early 86ing of high-margin specials.',
    existingFails: 'Enterprise kitchen intelligence (Winnow, Leanpath) requires $10,000 weighing scale hardware installations that small bistros cannot afford.',
    proposedSolution: 'Lightweight software-only prep guide that ingests POS sales history, combines it with weather forecast and local ticketed events, and prints morning prep sheet recommendations.',
    suggestedFeatures: [
      'Zero-hardware integration with Toast, Clover, Square POS',
      'Dynamic ingredient-level batch prep recommendation calculated at 6 AM',
      'Local event & rain adjustment multiplier',
      'Daily waste audit log with camera-based receipt or scrap scanning'
    ],
    monetization: '$149/mo per restaurant location with a guaranteed 30-day ROI promise (saves $600+/mo in food waste).',
    competitors: [
      { name: 'Leanpath', weakness: 'Requires bulky physical camera scale hardware costing $8,000+', pricing: '$250/mo + hardware' },
      { name: 'MarketMan', weakness: 'Focuses on supplier purchasing, cumbersome daily inventory counting required', pricing: '$179/mo' }
    ],
    evidence: [
      { source: 'r/KitchenConfidential', author: 'u/ChefTonyB', quote: 'Threw out 40lbs of prep salmon because an unpredicted rainstorm cleared the patio. Our margins are 4%. This waste literally wipes out our entire week profit.', upvotes: 620 },
      { source: 'Review Scout on Toast Add-ons', author: 'Bistro Manager (Denver)', quote: 'Toast tells me what I sold, but nobody tells my morning prep cooks what to chop. We need an intelligent morning prep sheet.', upvotes: 112 }
    ]
  },
  {
    id: 'opp-5',
    title: 'Emergency Trade Dispatch & Quoting Engine for Solo Contractors',
    category: 'Field Services & Trades',
    discussions: 1250,
    growth: '+14%',
    growthRate: 14,
    opportunityLevel: 'Medium',
    urgency: 96,
    willingnessToPay: 'Very High',
    estACV: '$1,200/yr',
    country: 'United States & Canada',
    difficulty: 'Medium',
    budget: '$1,500 - $4,000',
    technology: 'React Native / PWA + Twilio Voice AI + Stripe',
    businessModel: 'B2B SaaS ($99/mo)',
    scores: {
      problemFrequency: 76,
      demandGrowth: 72,
      painIntensity: 95,
      willingnessToPay: 94,
      competitionGap: 78,
      developmentFeasibility: 80,
      compositeScore: 82,
    },
    targetPersona: 'Solo plumbers, emergency electricians, and HVAC technicians who work in crawlspaces all day.',
    problemDescription: 'Tradespeople miss high-value emergency calls while under a sink or on a roof. Homeowners call down the list of plumbers on Google; the first one to answer gets the $600 job.',
    existingFails: 'ServiceTitan is built for 50-truck fleets and costs $500+/truck/mo; answering services cost $300/mo and have zero technical understanding of plumbing emergencies.',
    proposedSolution: 'AI emergency voice dispatcher that qualifies the leak, captures video/photo via instant SMS link, calculates base callout fee, and reserves the slot directly on technician calendar.',
    suggestedFeatures: [
      'Instant AI call screening with plumbing/electrical emergency ontology',
      'Homeowner video upload link sent via SMS during the call',
      'Geofenced calendar slotting preventing technician zigzag driving',
      'Pre-authorized emergency dispatch deposit via Apple Pay / Google Pay'
    ],
    monetization: '$99/mo per technician + $5 per captured emergency booking.',
    competitors: [
      { name: 'Housecall Pro', weakness: 'Rigid mobile app, no intelligent autonomous call qualification', pricing: '$79-$169/mo' },
      { name: 'ServiceTitan', weakness: 'Prohibitively expensive, requires annual contracts and dedicated office staff', pricing: '$400+/mo/user' }
    ],
    evidence: [
      { source: 'r/Plumbing', author: 'u/MasterPipeFitter', quote: 'I am under a slab with dirty hands. My phone rings 8 times. Each missed call is a $400 emergency job going to the next guy on Google Maps.', upvotes: 489 },
      { source: 'Facebook Tradesman Community', author: 'Dave K. (Plumber)', quote: 'Hired an answering service for $350/mo. They scheduled a non-emergency faucet drip on a Sunday afternoon with emergency rates without telling the customer.', upvotes: 215 }
    ]
  },
  {
    id: 'opp-6',
    title: 'EU AI Act Compliance & Model Risk Governance Auditor',
    category: 'Regulatory & Enterprise AI',
    discussions: 3400,
    growth: '+64%',
    growthRate: 64,
    opportunityLevel: 'Critical',
    urgency: 92,
    willingnessToPay: 'Extreme',
    estACV: '$8,000/yr',
    country: 'European Union & US Exporters',
    difficulty: 'High',
    budget: '$5,000+',
    technology: 'Next.js + Python AST Parser + Compliance Vector DB',
    businessModel: 'B2B Compliance SaaS',
    scores: {
      problemFrequency: 88,
      demandGrowth: 98,
      painIntensity: 90,
      willingnessToPay: 96,
      competitionGap: 89,
      developmentFeasibility: 72,
      compositeScore: 89,
    },
    targetPersona: 'SaaS CTOs, compliance officers, and European startups integrating LLMs into user-facing products.',
    problemDescription: 'Companies are terrified of severe EU fines (up to €35M or 7% of turnover) for high-risk AI classification, lack of technical documentation, and non-transparent training datasets.',
    existingFails: 'Vanta and Drata only cover SOC2 and ISO27001; specialized legal audit firms charge €40,000 for static PDF assessments that become outdated on the next code commit.',
    proposedSolution: 'Continuous CI/CD AI compliance scanner that automatically audits prompt pipelines, training data provenance, bias mitigation benchmarks, and exports EU-conforming technical dossiers.',
    suggestedFeatures: [
      'GitHub Action that scans LLM system prompts and pipeline fallbacks',
      'Automated Annex IV Technical Documentation generator',
      'Model risk classification wizard (Prohibited, High, Limited, Minimal)',
      'Continuous prompt drift & hallucination benchmark logging'
    ],
    monetization: '$499/mo for startups (up to 3 models), $1,499/mo for mid-market, custom enterprise plans.',
    competitors: [
      { name: 'Credo AI', weakness: 'Targeted strictly at Fortune 500, sales-assisted enterprise contracts only', pricing: '$30k/yr+' },
      { name: 'Drata / Vanta', weakness: 'Zero automated deep inspection of LLM prompts, embeddings, or agentic pipelines', pricing: '$10k/yr+' }
    ],
    evidence: [
      { source: 'Developer Scout / GitHub', author: 'open-source maintainer', quote: 'Our legal team asked us for an Annex IV dossier for our customer support agent. None of us engineers have any idea how to format this without a 200-page manual.', upvotes: 310 },
      { source: 'X / Twitter', author: '@saas_founder_berlin', quote: 'Compliance used to be SOC2. Now every European enterprise RFP asks for full AI Act safety filings. We need automated compliance or deals are stalling.', upvotes: 540 }
    ]
  },
  {
    id: 'opp-7',
    title: 'Dental & Specialist Patient No-Show Dynamic Re-Engagement Protocol',
    category: 'Healthcare & Wellness',
    discussions: 1820,
    growth: '+19%',
    growthRate: 19,
    opportunityLevel: 'High',
    urgency: 87,
    willingnessToPay: 'High',
    estACV: '$2,100/yr',
    country: 'US, Canada, UK',
    difficulty: 'Medium',
    budget: '$1,500 - $3,500',
    technology: 'EHR Webhooks + Twilio Conversational SMS + React',
    businessModel: 'B2B SaaS ($179/mo)',
    scores: {
      problemFrequency: 82,
      demandGrowth: 77,
      painIntensity: 91,
      willingnessToPay: 89,
      competitionGap: 80,
      developmentFeasibility: 84,
      compositeScore: 84,
    },
    targetPersona: 'Dental office managers and private medical practices losing $150k/year to empty treatment chairs.',
    problemDescription: 'Patients ghost appointments or cancel 2 hours prior. Staff make manual phone calls while greeting patients in clinic; unfilled chair hours permanently destroy clinic EBITDA.',
    existingFails: 'Generic reminder systems (Solutionreach, Weave) send dumb confirmation blasts 24 hours in advance, but do not autonomously backfill sudden cancellations with standby lists.',
    proposedSolution: 'Automated rapid-standby SMS dispatcher that instantly messages waitlisted patients the second a cancellation occurs, filling vacant surgery slots within 6 minutes.',
    suggestedFeatures: [
      'Bidirectional EHR sync (Dentrix, Eaglesoft, Open Dental)',
      'Sub-5 minute waitlist bidding broadcast',
      'Dynamic incentive waiver for last-minute same-day fills',
      'Patient reliability predictive scoring'
    ],
    monetization: '$179/mo base + $15 per recovered appointment that would have gone unfilled.',
    competitors: [
      { name: 'Weave', weakness: 'Heavy phone hardware bundled, minimal automated waitlist auto-fill', pricing: '$350/mo' },
      { name: 'Klara', weakness: 'Focused on telemedicine messaging rather than surgical chair utilization', pricing: '$250/mo' }
    ],
    evidence: [
      { source: 'r/Dentistry', author: 'u/ToothFairyDDS', quote: 'Had three hygiene cancellations today alone. That is $600 lost that I still have to pay my hygienist for. My front desk was too slammed on phones to call the waitlist.', upvotes: 382 },
      { source: 'Review Scout', author: 'Clinic Administrator (Texas)', quote: 'Standard SMS reminders tell you they canceled, but leave you holding the bag with an empty chair. We need an Uber-like dispatch for our waitlist.', upvotes: 140 }
    ]
  }
];

export const HISTORICAL_DEMAND_TRENDS = [
  { month: 'May', retail: 2100, proptech: 1450, freelance: 1100, foodOps: 780, compliance: 820 },
  { month: 'Jun', retail: 2450, proptech: 1680, freelance: 1250, foodOps: 890, compliance: 1100 },
  { month: 'Jul', retail: 2900, proptech: 1950, freelance: 1420, foodOps: 990, compliance: 1480 },
  { month: 'Aug', retail: 3350, proptech: 2200, freelance: 1600, foodOps: 1120, compliance: 2050 },
  { month: 'Sep', retail: 3800, proptech: 2510, freelance: 1780, foodOps: 1280, compliance: 2790 },
  { month: 'Oct', retail: 4200, proptech: 2800, freelance: 1900, foodOps: 1400, compliance: 3400 },
];

export const PLATFORM_DISTRIBUTION = [
  { platform: 'Reddit', share: 38, count: '18,590 discussions', color: '#ff4500' },
  { platform: 'X / Twitter', share: 26, count: '12,720 complaints', color: '#1da1f2' },
  { platform: 'Developer / GitHub', share: 16, count: '7,820 issues & discussions', color: '#6366f1' },
  { platform: 'G2 & Review Sites', share: 11, count: '5,380 1-3 star reviews', color: '#10b981' },
  { platform: 'FB Groups & Forums', share: 9, count: '4,410 operator threads', color: '#f59e0b' },
];

export const INDUSTRY_BREAKDOWN = [
  { name: 'Retail & Commerce', count: 4200, percentage: 28, growth: '+35%' },
  { name: 'Regulatory & AI Governance', count: 3400, percentage: 23, growth: '+64%' },
  { name: 'Real Estate & PropTech', count: 2800, percentage: 19, growth: '+22%' },
  { name: 'Freelance & Agency Ops', count: 1900, percentage: 13, growth: '+18%' },
  { name: 'Healthcare & Wellness', count: 1820, percentage: 12, growth: '+19%' },
  { name: 'Hospitality & Food Ops', count: 1400, percentage: 9, growth: '+28%' },
  { name: 'Field Services & Trades', count: 1250, percentage: 8, growth: '+14%' },
];

export const GEOGRAPHIC_DISTRIBUTION = [
  { region: 'North America (US & CA)', percentage: 54, volume: '26,400 discussions' },
  { region: 'Europe (UK, DE, FR, EU)', percentage: 28, volume: '13,700 discussions' },
  { region: 'Asia-Pacific (AU, SG, IN)', percentage: 12, volume: '5,870 discussions' },
  { region: 'Latin America & Others', percentage: 6, volume: '2,950 discussions' },
];

export function calculateCustomScore(scores: Opportunity['scores'], weights: ScoringWeights): number {
  const totalWeight =
    weights.problemFrequency +
    weights.demandGrowth +
    weights.painIntensity +
    weights.willingnessToPay +
    weights.competitionGap +
    weights.developmentFeasibility;

  if (totalWeight === 0) return 0;

  const raw =
    (scores.problemFrequency * weights.problemFrequency) +
    (scores.demandGrowth * weights.demandGrowth) +
    (scores.painIntensity * weights.painIntensity) +
    (scores.willingnessToPay * weights.willingnessToPay) +
    (scores.competitionGap * weights.competitionGap) +
    (scores.developmentFeasibility * weights.developmentFeasibility);

  return Math.round(raw / totalWeight);
}
