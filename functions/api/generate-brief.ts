// Cloudflare Pages Function for POST /api/generate-brief

interface Env {
  GEMINI_API_KEY?: string;
  SUPABASE_SERVICE_KEY: string;
}

const SB_URL = 'https://wgoiukbgrdyjvfpqaipp.supabase.co';
const SB_KEY = 'sb_publishable_B4fokBi_LoR1Pe8o39kTQA_REnB2KbK';
// Access rules: PRD generation is a Pro/Business feature. Briefs allowed per user per UTC day.
const DAILY_LIMITS: Record<string, number> = { Pro: 5, Business: 20 };


/** Select real, source-linked research from the collector tables. Never synthesize a fake fallback dataset. */
async function loadResearchContext(svc: Record<string, string>, industry: string, customTopic: string) {
  const params = new URLSearchParams({
    select: 'id,title,industry,use_case,unique_discussions,source_count,sources,recent_discussions,prior_discussions,growth_rate,wtp_signals,competitors,scores,confidence,summary,summarized_at',
    members_count: 'gt.0',
    order: 'composite_score.desc.nullslast',
    limit: '100',
  });
  const response = await fetch(`${SB_URL}/rest/v1/dr_clusters?${params.toString()}`, { headers: svc });
  if (!response.ok) throw new Error('Could not load collected research from Supabase.');
  const rows: any[] = await response.json();
  const normalize = (value: unknown) => String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const industryTokens = normalize(industry).split(' ').filter((token) => token.length > 2);
  const topicTokens = normalize(customTopic).split(' ').filter((token) => token.length > 2);
  const matching = rows.filter((row) => {
    const rowIndustry = normalize(row.industry);
    const haystack = normalize([row.title, row.use_case, row.summary?.title, row.summary?.problem_description].join(' '));
    const industryMatch = !industryTokens.length || industryTokens.some((token) => rowIndustry.includes(token));
    const topicMatch = !topicTokens.length || topicTokens.some((token) => haystack.includes(token));
    return industryMatch && topicMatch;
  }).slice(0, 8);
  if (!matching.length) return { clusters: [], evidence: [] };

  const ids = matching.map((row) => row.id);
  const inFilter = `in.(${ids.join(',')})`;
  const membersParams = new URLSearchParams({
    select: 'cluster_id,record_id,dr_raw_records(source_id,title,excerpt,url,license,attribution,published_at)',
    cluster_id: inFilter,
    limit: '80',
  });
  const signalsParams = new URLSearchParams({
    select: 'cluster_id,record_id,problem_statement,signal_type,wtp_evidence,analysis_method',
    cluster_id: inFilter,
    is_problem: 'eq.true',
    limit: '80',
  });
  const [membersResponse, signalsResponse] = await Promise.all([
    fetch(`${SB_URL}/rest/v1/dr_cluster_members?${membersParams.toString()}`, { headers: svc }),
    fetch(`${SB_URL}/rest/v1/dr_problem_signals?${signalsParams.toString()}`, { headers: svc }),
  ]);
  if (!membersResponse.ok || !signalsResponse.ok) throw new Error('Could not load source evidence for the selected research.');
  const [members, signals]: [any[], any[]] = await Promise.all([membersResponse.json(), signalsResponse.json()]);
  const clusterById = new Map(matching.map((row) => [row.id, row]));
  const signalByRecord = new Map(signals.map((signal) => [signal.record_id, signal]));
  const evidence = members.map((member) => {
    const record = member.dr_raw_records ?? {};
    const signal = signalByRecord.get(member.record_id) ?? {};
    const cluster = clusterById.get(member.cluster_id);
    return {
      clusterTitle: cluster?.title ?? 'Research cluster',
      source: record.source_id ?? 'unknown',
      title: record.title ?? '',
      excerpt: record.excerpt ?? '',
      url: record.url ?? '',
      license: record.license ?? 'not stated',
      attribution: record.attribution ?? '',
      publishedAt: record.published_at ?? null,
      problemStatement: signal.problem_statement ?? '',
      signalType: signal.signal_type ?? 'unknown',
      willingnessToPayEvidence: signal.wtp_evidence === true,
      analysisMethod: signal.analysis_method ?? 'unknown',
    };
  }).filter((item) => item.url).slice(0, 30);
  return {
    clusters: matching.map((row) => ({
      id: row.id, title: row.title, industry: row.industry, useCase: row.use_case,
      independentDiscussions: row.unique_discussions, sourceCount: row.source_count, sources: row.sources,
      recentDiscussions: row.recent_discussions, priorDiscussions: row.prior_discussions,
      growthRate: row.growth_rate, willingnessToPaySignals: row.wtp_signals,
      competitorsNamed: row.competitors, scoreComponents: row.scores, confidence: row.confidence,
      aiSummary: row.summary, summarizedAt: row.summarized_at,
    })),
    evidence,
  };
}

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
    const limit = live ? DAILY_LIMITS[sub.plan] : undefined;
    if (!limit) return deny('PRD generation is included in the Pro and Business plans.', 403);

    const q = await fetch(`${SB_URL}/rest/v1/rpc/consume_brief`, { method: 'POST', headers: svc, body: JSON.stringify({ p_user: user.id, p_limit: limit }) });
    if (!q.ok) return deny('Could not check your usage. Please try again.', 503);
    if ((await q.json()) !== true) return deny(`Daily limit reached (${limit} briefs per day on ${sub.plan}). It resets at midnight UTC.`, 429);

    const body: any = await context.request.json();
    const { industry, country, difficulty, budget, technology, businessModel, customTopic } = body;
    const apiKey = context.env.GEMINI_API_KEY;
    if (!apiKey) return deny('AI generation is not configured. Add GEMINI_API_KEY to the Cloudflare Pages environment; no synthetic brief will be returned.', 503);

    let researchContext: { clusters: any[]; evidence: any[] };
    try {
      researchContext = await loadResearchContext(svc, String(industry || ''), String(customTopic || ''));
    } catch (researchError: any) {
      return deny(researchError?.message || 'Could not load collected research.', 503);
    }
    if (!researchContext.clusters.length) {
      return deny('No matching collected research was found for these filters. Try another industry or remove the custom focus after more data has been collected.', 422);
    }

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
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${apiKey}`,
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
          parsed.researchBasis = researchContext;
          parsed.researchStatus = 'live_collected_research';
          return new Response(JSON.stringify({ success: true, brief: parsed }), {
            headers: { 'Content-Type': 'application/json' },
          });
        }
      }
    }

    return deny('The AI provider did not return a usable brief. Please retry shortly; no synthetic result was substituted.', 502);
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message || 'Generation failed' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
};
