// Cloudflare Pages Function for GET /api/bots
export const onRequestGet = async () => {
  const bots = [
    { id: 'bot-1', name: 'Reddit Scout', role: 'Finds people discussing problems', platform: 'Reddit', target: 'r/smallbusiness, r/entrepreneur', activeScans: 1420, status: 'active', speed: '48 scans/min', lastFinding: 'Struggling with multi-location stock synchronization' },
    { id: 'bot-2', name: 'Facebook Scout', role: 'Monitors accessible public discussions', platform: 'Public Groups', target: 'Landlord & Property Ops', activeScans: 890, status: 'active', speed: '32 scans/min', lastFinding: 'Manual rent collection reconciliation headaches' },
    { id: 'bot-3', name: 'X Scout', role: 'Identifies complaints and emerging trends', platform: 'X / Twitter', target: '#saasfail, #freelancepain', activeScans: 3120, status: 'active', speed: '115 scans/min', lastFinding: 'Unpaid invoice chasing automated reminders missing WhatsApp' },
    { id: 'bot-4', name: 'Developer Scout', role: 'Monitors developer communities', platform: 'GitHub & StackOverflow', target: 'Issues tagged feature-abandoned', activeScans: 2200, status: 'active', speed: '64 scans/min', lastFinding: 'Dockerized microservice log correlation costs skyrocketing' },
    { id: 'bot-5', name: 'Review Scout', role: 'Analyses complaints about existing products', platform: 'G2, Capterra, Trustpilot', target: '1-3 star reviews on incumbent software', activeScans: 1850, status: 'active', speed: '52 scans/min', lastFinding: 'Toast POS add-on fee fatigue among independent cafes' },
    { id: 'bot-6', name: 'Startup Scout', role: 'Tracks newly emerging competitors', platform: 'ProductHunt & YC DB', target: 'Weekly product launches with high pivot rates', activeScans: 740, status: 'active', speed: '24 scans/min', lastFinding: 'Niche dispatch software gap for septic & grease trap operators' },
    { id: 'bot-7', name: 'Trend Scout', role: 'Identifies rapidly growing problems', platform: 'Google Trends & Discourse', target: 'Surge search queries matching alternative to', activeScans: 1610, status: 'active', speed: '58 scans/min', lastFinding: 'Rising compliance overhead for EU AI Act documentation' },
    { id: 'bot-8', name: 'Opportunity Analyst', role: 'Evaluates commercial potential', platform: 'Analysis Engine', target: 'Willingness-to-pay signals', activeScans: 980, status: 'analyzing', speed: '36 clusters/min', lastFinding: 'Verified ACV $1,200/yr willingness for contractor permit tracking' },
    { id: 'bot-9', name: 'Idea Generator', role: 'Converts problems into software ideas', platform: 'Synthesis Hub', target: 'Micro-SaaS & workflow automation', activeScans: 620, status: 'generating', speed: '18 briefs/min', lastFinding: 'Generated autonomous WhatsApp invoice chaser for Latin America' },
    { id: 'bot-10', name: 'Research Auditor', role: 'Checks evidence and removes duplicate findings', platform: 'Verification Gate', target: 'Semantic deduplication & source quotation veracity', activeScans: 1290, status: 'verifying', speed: '80 verifications/min', lastFinding: 'Consolidated 48 redundant inventory complaints into Cluster #DR-409' },
  ];

  return new Response(
    JSON.stringify({
      totalBots: bots.length,
      activeBots: bots.length,
      scansPerMinute: 529,
      discussionsIndexed24h: 48920,
      clustersFormed24h: 342,
      bots,
    }),
    {
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=60',
      },
    }
  );
};
