// Cloudflare Pages Function for POST /api/generate-brief

interface Env {
  GEMINI_API_KEY?: string;
  SUPABASE_SERVICE_KEY: string;
}

const SB_URL = 'https://wgoiukbgrdyjvfpqaipp.supabase.co';
const SB_KEY = 'sb_publishable_B4fokBi_LoR1Pe8o39kTQA_REnB2KbK';
// Access rules: briefs allowed per user per UTC day. Free gets a small taste, capped across ALL free users.
const DAILY_LIMITS: Record<string, number> = { Free: 1, Starter: 2, Pro: 5, Business: 20 };
const FREE_POOL_PER_DAY = 50;

export const onRequestPost = async (context: { request: Request; env: Env }) => {
  const deny = (error: string, status: number) =>
    new Response(JSON.stringify({ error }), { status, headers: { 'Content-Type': 'application/json' } });
  try {
    const token = (context.request.headers.get('Authorization') || '').replace(/^Bearer /, '');
    if (!token) return deny('Sign in to generate briefs.', 401);
    const u = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SB_KEY, Authorization: `Bearer ${token}` } });
    if (!u.ok) return deny('Session expired. Please sign in again.', 401);
    const user: any = await u.json();

    const svc = { apikey: context.env.SUPABASE_SERVICE_KEY, Authorization: `Bearer ${context.env.SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' };
    const subRes = await fetch(`${SB_URL}/rest/v1/subscriptions?user_id=eq.${user.id}&select=plan,status,current_period_end`, { headers: svc });
    const sub: any = subRes.ok ? (await subRes.json())[0] : null;
    const live = sub && (sub.status === 'active' || (sub.status === 'cancelled' && sub.current_period_end && new Date(sub.current_period_end) > new Date()));
    const plan: string = live ? sub.plan : 'Free';
    const limit = DAILY_LIMITS[plan];

    const q = await fetch(`${SB_URL}/rest/v1/rpc/consume_brief`, { method: 'POST', headers: svc, body: JSON.stringify({ p_user: user.id, p_limit: limit, ...(plan === 'Free' ? { p_pool: FREE_POOL_PER_DAY } : {}) }) });
    if (!q.ok) return deny('Could not check your usage. Please try again.', 503);
    if ((await q.json()) !== true) return deny(plan === 'Free' ? 'Free briefs are used up for now (1 per day, shared across free users). Try again tomorrow or upgrade for more.' : `Daily limit reached (${limit} briefs per day on ${plan}). It resets at midnight UTC.`, 429);

    const body: any = await context.request.json();
    const { industry, country, difficulty, budget, technology, businessModel, customTopic } = body;
    const apiKey = context.env.GEMINI_API_KEY;

    if (apiKey) {
      const prompt = `You are DemandRadar's Principal Product Architect.
Synthesize a comprehensive, development-ready Software Opportunity Brief / PRD for:
- Industry: ${industry || 'SMB Operations'}
- Region: ${country || 'Global'}
- Difficulty: ${difficulty || 'Medium'}
- Budget: ${budget || '$1,000 - $3,000'}
- Tech: ${technology || 'Next.js + Postgres'}
- Model: ${businessModel || 'B2B SaaS'}
- Focus: ${customTopic || 'Top emerging software bottleneck'}

Respond strictly with valid JSON conforming to:
{
  "productName": "string",
  "tagline": "string",
  "opportunityScore": 88,
  "marketSizeTAM": "string",
  "estMonthlyRevenueYear1": "string",
  "problemStatement": "string",
  "targetICP": {
    "role": "string",
    "companySize": "string",
    "annualBudget": "string",
    "coreFrustration": "string"
  },
  "scoreBreakdown": {
    "problemFrequency": 90,
    "demandGrowth": 85,
    "painIntensity": 92,
    "willingnessToPay": 88,
    "competitionGap": 84,
    "developmentFeasibility": 86
  },
  "competitorMatrix": [
    { "name": "string", "pricing": "string", "vulnerability": "string", "ourWedge": "string" },
    { "name": "string", "pricing": "string", "vulnerability": "string", "ourWedge": "string" }
  ],
  "mvpScope": {
    "coreFeatures": ["string", "string", "string"],
    "outOfScope": ["string", "string"]
  },
  "pricingTiers": [
    { "tier": "Starter", "price": "$29/mo", "features": ["string", "string"] },
    { "tier": "Pro", "price": "$79/mo", "features": ["string", "string"] }
  ],
  "architectureSpec": {
    "frontend": "string",
    "backend": "string",
    "database": "string",
    "keyIntegrations": ["string", "string"],
    "dataModelSummary": "string"
  },
  "gtmStrategy": [
    { "phase": "Week 1", "action": "string" },
    { "phase": "Week 2", "action": "string" }
  ]
}`;

      const geminiRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { responseMimeType: 'application/json' },
          }),
        }
      );

      if (geminiRes.ok) {
        const geminiData: any = await geminiRes.json();
        const rawText = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (rawText) {
          const parsed = JSON.parse(rawText);
          return new Response(JSON.stringify({ success: true, brief: parsed }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }
    }

    // Fallback if API key not yet set in Cloudflare or direct local execution
    const fallbackBrief = {
      productName: `SyncRadar: ${industry || 'Commerce'} Bridge`,
      tagline: 'Autonomous data reconciliation engine for growing business operators.',
      opportunityScore: 88,
      marketSizeTAM: '$4.2B Addressable Market',
      estMonthlyRevenueYear1: '$15,000 - $38,000 MRR',
      problemStatement: `Operators in ${industry || 'target niche'} are losing hours every week resolving ghost records and manual errors.`,
      targetICP: {
        role: 'Operations Director / Lead Developer',
        companySize: '5-50 Employees',
        annualBudget: '$2,400/yr software budget',
        coreFrustration: 'Fragmented spreadsheets and legacy systems failing to sync in real-time.'
      },
      scoreBreakdown: {
        problemFrequency: 90,
        demandGrowth: 86,
        painIntensity: 92,
        willingnessToPay: 88,
        competitionGap: 84,
        developmentFeasibility: 85
      },
      competitorMatrix: [
        { name: 'Incumbent Legacy Suite', pricing: '$400/mo', vulnerability: 'Ancient APIs and long setup delays', ourWedge: '5-minute self-serve onboarding' },
        { name: 'Generic No-Code Zapier', pricing: '$49/mo', vulnerability: 'No audit logs or financial reconciliation logic', ourWedge: 'Idempotent transactional safety ledger' }
      ],
      mvpScope: {
        coreFeatures: [
          'Instant webhook ingestion with automated payload deduplication',
          'Conflict-resolution rules engine',
          'Real-time discrepancy alerts to Slack and WhatsApp',
          'Self-service tenant onboarding portal'
        ],
        outOfScope: ['Complex on-premise Active Directory sync', 'Custom ERP migrations in v1']
      },
      pricingTiers: [
        { tier: 'Starter', price: '$29/mo', features: ['Up to 5,000 sync events', 'Single workspace', 'Email support'] },
        { tier: 'Growth', price: '$79/mo', features: ['Up to 50,000 sync events', 'Real-time Slack webhooks', 'Priority queue'] }
      ],
      architectureSpec: {
        frontend: `${technology || 'React + Tailwind'} with optimistic UI updates`,
        backend: 'Cloudflare Pages Functions / Node.js Express',
        database: 'PostgreSQL or Cloudflare D1 with transactional guarantees',
        keyIntegrations: ['Stripe / PayPal Billing', 'SendGrid / Twilio Alerts'],
        dataModelSummary: 'Tenants, Integrations, EventLogs, Reconciliations, and AlertRules tables.'
      },
      gtmStrategy: [
        { phase: 'Week 1', action: 'Direct outreach to top 50 authors of complaining Reddit/X threads identified by Scout bots' },
        { phase: 'Week 2', action: 'Publish interactive Cost of Manual Errors calculator to drive inbound traffic' }
      ]
    };

    return new Response(JSON.stringify({ success: true, brief: fallbackBrief }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || 'Generation failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
