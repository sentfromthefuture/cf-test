export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function truncate(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + '…';
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#x27': "'", '#39': "'", '#x2F': '/' };

/** HTML (Stack Exchange bodies, HN comments) -> plain text. Never rendered as HTML anywhere. */
export function htmlToText(html: string): string {
  return html
    .replace(/<pre[\s\S]*?<\/pre>/gi, ' [code] ')
    .replace(/<code[\s\S]*?<\/code>/gi, ' ')
    .replace(/<(br|\/p|\/li|\/div)\s*\/?>/gi, '\n')
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, '$2')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (ENTITIES[e] !== undefined) return ENTITIES[e];
      if (e.startsWith('#x')) return String.fromCodePoint(parseInt(e.slice(2), 16) || 32);
      if (e.startsWith('#')) return String.fromCodePoint(parseInt(e.slice(1), 10) || 32);
      return m;
    })
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/** GitHub issue bodies are Markdown: drop fenced code, images, HTML comments and link targets. */
export function markdownToText(md: string): string {
  return md
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/(\*\*|__|`)/g, '')
    .replace(/^[#>\-*\s]+/gm, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim();
}

/** Honest language guess: English only when clearly English, otherwise 'und'. The analyser may refine it. */
export function guessLanguage(text: string): string {
  const sample = text.slice(0, 600).toLowerCase();
  if (sample.length < 20) return 'und';
  const ascii = sample.replace(/[^\x00-\x7f]/g, '').length / sample.length;
  const hits = (sample.match(/\b(the|and|is|to|of|for|with|that|this|how|can|not|it|you|we|are|have|but)\b/g) || []).length;
  return ascii > 0.9 && hits >= 3 ? 'en' : 'und';
}

export async function hashAuthor(env: Record<string, string | undefined>, source: string, name: string | undefined | null): Promise<string | null> {
  if (!name) return null;
  const salt = env.AUTHOR_HASH_SALT || 'demandradar';
  return (await sha256Hex(`${salt}:${source}:${name}`)).slice(0, 24);
}

export function isoOrNull(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v * 1000).toISOString();
  if (typeof v === 'string' && !Number.isNaN(Date.parse(v))) return new Date(v).toISOString();
  return null;
}

export function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Sanitise an error message before it is persisted or shown: strip anything that looks like a credential. */
export function safeError(e: unknown): string {
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return msg
    .replace(/(github_pat_|ghp_|gho_|sb_secret_|sb_publishable_|AIza|sk-)[A-Za-z0-9_\-]{8,}/g, '[redacted]')
    .replace(/(key|token|secret|authorization|apikey)=([^&\s]+)/gi, '$1=[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._\-]+/g, 'Bearer [redacted]')
    .slice(0, 400);
}
