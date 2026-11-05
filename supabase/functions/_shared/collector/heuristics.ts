// Cheap, deterministic text signals. Used (a) to skip obvious non-problems before spending LLM tokens,
// (b) as the clearly-labelled fallback analyser when no LLM key is configured,
// (c) to ground-check LLM claims (willingness-to-pay quotes, competitor names must appear in the source text).

export const INDUSTRIES = [
  'Developer Tools & DevOps', 'Data & Analytics', 'Finance & Payments', 'Productivity & Collaboration', 'Security & Compliance',
  'Retail & Commerce', 'Healthcare & Wellness', 'Hospitality & Food Ops', 'Real Estate & PropTech', 'Education',
  'Field Services & Trades', 'Freelance & Agency Ops', 'Other',
] as const;
export type Industry = (typeof INDUSTRIES)[number];

const COMPLAINT = /\b(frustrat\w*|annoy\w*|painful|pain point|terrible|awful|hate|sucks?|broken|doesn'?t work|does not work|can'?t (?:figure|find|get)|unable to|too (?:slow|expensive|complicated|complex)|waste of time|nightmare|tedious|manual(?:ly)?|workaround|struggl\w*)\b/i;
const REQUEST = /\b(feature request|would be (?:great|nice|useful)|wish (?:there was|i could|it could)|it would be nice|please add|missing (?:feature|support)|no (?:way|option) to|lack of|should support|need(?:s)? (?:a|an|to be able)|is there (?:a|any) (?:tool|way|app|service|software|library)|looking for (?:a|an|something)|alternative to|any (?:tool|app|software|recommendations?)|how do you (?:handle|manage|track|deal))\b/i;
const WTP = /\b(would pay|willing to pay|i'?d pay|we'?d pay|happy to pay|paying for|pay(?:ing)? (?:\$|€|£)\s?\d+|\$\s?\d+\s?(?:\/|per)\s?(?:mo|month|year|user|seat)|budget for|worth paying|take my money|subscription)\b/i;

export function problemSignalScore(text: string): number {
  let s = 0;
  if (COMPLAINT.test(text)) s += 1;
  if (REQUEST.test(text)) s += 1;
  if (/\?\s*$/m.test(text) && /\b(how|why|best way|any way|anyone)\b/i.test(text)) s += 0.5;
  return s;
}

export function hasWtpPattern(text: string): boolean {
  return WTP.test(text);
}

export function classifySignalType(text: string): 'complaint' | 'feature_request' | 'unmet_need' | 'question' | 'other' {
  if (/\b(feature request|please add|wish (?:there was|i could|it could)|would be (?:great|nice|useful)|it would be nice|should support)\b/i.test(text)) return 'feature_request';
  if (/\b(is there (?:a|any)|looking for|alternative to|any (?:tool|app|software)|no (?:way|option) to|need(?:s)? (?:a|an))\b/i.test(text)) return 'unmet_need';
  if (COMPLAINT.test(text)) return 'complaint';
  if (/\?/.test(text)) return 'question';
  return 'other';
}

const INDUSTRY_KEYWORDS: Array<[Industry, RegExp]> = [
  ['Finance & Payments', /\b(invoice|invoicing|payment|payments|stripe|paypal|bank|accounting|bookkeeping|tax|payroll|crypto|fintech|mobile money)\b/i],
  ['Healthcare & Wellness', /\b(patient|clinic|hospital|health|medical|ehr|telehealth|fitness|therapy|pharmacy)\b/i],
  ['Hospitality & Food Ops', /\b(restaurant|menu|kitchen|hotel|lodge|cafe|catering|pos system|reservation)\b/i],
  ['Real Estate & PropTech', /\b(landlord|tenant|property|real estate|rental|lease|mortgage)\b/i],
  ['Retail & Commerce', /\b(e-?commerce|shopify|inventory|checkout|storefront|retail|merchant|woocommerce)\b/i],
  ['Education', /\b(student|teacher|classroom|course|lms|curriculum|tutor|school)\b/i],
  ['Security & Compliance', /\b(security|vulnerab\w*|gdpr|hipaa|soc ?2|compliance|audit|pentest|encryption)\b/i],
  ['Data & Analytics', /\b(dashboard|analytics|csv|spreadsheet|etl|data pipeline|bi tool|report(?:ing)?|excel)\b/i],
  ['Field Services & Trades', /\b(contractor|plumb\w*|hvac|electrician|dispatch|field service|work order)\b/i],
  ['Freelance & Agency Ops', /\b(freelanc\w*|agency|client work|proposal|time tracking|timesheet)\b/i],
  ['Productivity & Collaboration', /\b(calendar|notes?|task manager|todo|project management|slack|meeting|workflow|notion)\b/i],
  ['Developer Tools & DevOps', /\b(api|sdk|cli|deploy\w*|docker|kubernetes|ci\/cd|github|git|compiler|framework|library|plugin|terraform|debug\w*|linter|ide)\b/i],
];

/** Keyword-based and deliberately conservative: needs two distinct keyword hits from one industry, otherwise 'Other'. */
export function guessIndustry(text: string): Industry {
  let best: Industry = 'Other';
  let bestHits = 1;
  for (const [name, re] of INDUSTRY_KEYWORDS) {
    const hits = new Set((text.toLowerCase().match(new RegExp(re.source, 'gi')) ?? []).map((m) => m.toLowerCase())).size;
    if (hits > bestHits) {
      best = name;
      bestHits = hits;
    }
  }
  return best;
}

/** Normalise for tolerant substring checks. */
function norm(s: string): string {
  return s.toLowerCase().replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"').replace(/\s+/g, ' ').trim();
}

/** A quoted piece of evidence is only accepted if it really occurs in the source text (blocks hallucinated quotes). */
export function quoteIsGrounded(quote: string | null | undefined, sourceText: string): boolean {
  if (!quote) return false;
  const q = norm(quote).replace(/[.…]+$/, '');
  return q.length >= 6 && norm(sourceText).includes(q);
}

export function groundedCompetitors(names: unknown, sourceText: string): string[] {
  if (!Array.isArray(names)) return [];
  const hay = norm(sourceText);
  const out: string[] = [];
  for (const n of names) {
    if (typeof n !== 'string') continue;
    const name = n.trim();
    if (name.length < 2 || name.length > 60) continue;
    if (hay.includes(norm(name)) && !out.some((x) => x.toLowerCase() === name.toLowerCase())) out.push(name);
    if (out.length >= 8) break;
  }
  return out;
}

export function cleanStatement(text: string, max = 240): string {
  const t = text.replace(/\s+/g, ' ').replace(/^(ask hn|show hn|\[?feature(?: request)?\]?|\[?bug\]?)\s*[:\-]\s*/i, '').trim();
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + '…';
}
