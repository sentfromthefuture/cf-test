// Content policy for model-written strings (evidence contract section 5.1 step 9, reliability document tier T7):
//   - no URL                  (`no_urls`)
//   - no SQL-like statement   (`no_executable_sql`)
//   - no executable content   (script tags, code fences, shell pipelines)
//
// IMPORTANT - what this is and is not.
// The documents say "no SQL-like statement" without listing patterns, so the patterns below are a Phase A2 choice. This is LEXICAL detection:
// it looks for statement-shaped text in a normalised copy of the string. It will miss obfuscated, split, encoded or paraphrased content, and
// it can reject innocent prose that happens to look like a statement. It reduces the chance that a blueprint carries something that looks
// executable; it is NOT a complete security guarantee. The real safeguards are structural: the database design is a closed set of enums and
// plain-language fields, nothing in this module executes anything, and a later phase must never run a string from a blueprint as SQL.
//
// Detection returns fixed finding codes only. It never returns, logs or echoes the offending text.
import { URL_PATTERN } from './constants.ts';

export type ContentFinding = 'url' | 'sql' | 'executable';

/** A string kind decides how strict the scan is. */
export type TextKind =
  | 'text'    // ordinary descriptive prose
  | 'expr';   // a field the contract says is described in words and must never be an expression: defaults, check rules, partial conditions, RLS rules

// Invisible characters that could be used to split a keyword (soft hyphen, zero-width spaces and joiners, directional marks, word joiner, BOM).
const INVISIBLE = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g;

/** NFKC-fold (full-width letters become ASCII), drop invisible characters and collapse whitespace. */
export function normaliseForScan(text: string): string {
  return text.normalize('NFKC').replace(INVISIBLE, '').replace(/\s+/g, ' ');
}

const GENERIC_SCHEME = /\b[a-z][a-z0-9+.-]{1,15}:\/\/\S/i;

const DDL_OBJECT = '(?:table|index|view|function|procedure|policy|trigger|extension|schema|type|sequence|role|database|domain|publication|rule)';
const PRIVILEGE = '(?:all|select|insert|update|delete|usage|execute|create|references|trigger|truncate)';

const SQL_PATTERNS: readonly RegExp[] = [
  // Data definition: "create table", "alter policy", "drop index", "create or replace function" ...
  new RegExp(`\\b(?:create|alter|drop|truncate)\\s+(?:or\\s+replace\\s+)?(?:(?:temp|temporary|unique|materialized|unlogged|global|local)\\s+)*${DDL_OBJECT}\\b`, 'i'),
  // Data manipulation
  /\binsert\s+into\b/i,
  /\bdelete\s+from\b/i,
  /\bupdate\s+[\w."]+\s+set\b/i,
  /\bselect\s+(?:\*|distinct\b|count\s*\(|[\w."]+(?:\s*,\s*[\w."]+)+\s+from\b)/i,
  /\bselect\b[^;]{0,200}?\bfrom\s+[\w."]+\s*(?:where|join|group by|order by|limit|having|union)\b/i,
  /\bunion\s+(?:all\s+)?select\b/i,
  // Privileges, session and transaction control, procedural code
  new RegExp(`\\bgrant\\s+${PRIVILEGE}\\b[^;]{0,120}?\\bto\\b`, 'i'),
  new RegExp(`\\brevoke\\s+${PRIVILEGE}\\b[^;]{0,120}?\\bfrom\\b`, 'i'),
  /\bset\s+(?:local\s+|session\s+)?role\b/i,
  /\bexecute\s+(?:immediate|format)\b/i,
  /\b(?:begin|commit|rollback)\s*;/i,
  /\$\$|\$[a-z_][a-z0-9_]*\$/i,
  /\blanguage\s+(?:plpgsql|sql)\b|\bplpgsql\b/i,
  // Stacked statements, comment markers, classic injection shapes
  /;\s*(?:select|insert|update|delete|drop|create|alter|grant|revoke|truncate|begin|commit|rollback)\b/i,
  /\/\*|\*\//,
  /\b(?:or|and)\s+(?:'[^']*'|\d+)\s*=\s*(?:'[^']*'|\d+)/i,
  // Server-side functions and platform helpers that act or read
  /\b(?:pg_sleep|pg_read_file|pg_read_binary_file|pg_ls_dir|lo_import|lo_export|dblink|xp_cmdshell)\b/i,
  /\bauth\.(?:uid|jwt|role)\s*\(|\bcurrent_setting\s*\(/i,
  // Policy clauses
  /\b(?:using|with check)\s*\(/i,
];

const EXECUTABLE_PATTERNS: readonly RegExp[] = [
  /<\s*\/?\s*(?:script|iframe|object|embed)\b/i,
  /\bjavascript\s*:|\bdata\s*:\s*text\/html/i,
  /\bon(?:error|load|click|mouseover)\s*=/i,
  /```/,
  /\b(?:curl|wget)\b[^|]{0,200}\|\s*(?:ba|z)?sh\b/i,
  /\brm\s+-[a-z]*r[a-z]*f?\b|\bsudo\s+\w/i,
  /\beval\s*\(/i,
];

// Stricter checks for fields that must be plain language and never an expression.
const EXPRESSION_PATTERNS: readonly RegExp[] = [
  /::/,                                  // type cast
  /;/,                                   // statement separator
  /--/,                                  // line comment
  /[A-Za-z0-9_]\(/,                      // function call such as now() or gen_random_uuid()
  /[<>=]|!=/,                            // comparison or assignment operators
  /\|\|/,                                // concatenation
  /`/,                                   // quoted code
];

/**
 * Returns the distinct finding codes for one string (empty when clean). `kind` 'expr' adds the expression patterns, which are reported as 'sql'.
 * The input is never modified and never returned.
 */
export function scanText(text: string, kind: TextKind = 'text'): ContentFinding[] {
  const findings: ContentFinding[] = [];
  const t = normaliseForScan(text);
  if (URL_PATTERN.test(t) || GENERIC_SCHEME.test(t)) findings.push('url');
  if (SQL_PATTERNS.some((re) => re.test(t)) || (kind === 'expr' && EXPRESSION_PATTERNS.some((re) => re.test(t)))) findings.push('sql');
  if (EXECUTABLE_PATTERNS.some((re) => re.test(t))) findings.push('executable');
  return findings;
}
