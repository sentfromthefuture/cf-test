// Text, ordering and time helpers for evidence preparation.
//
// Determinism rules applied everywhere in Phase A3:
//  - No localeCompare, no Intl, no toLocale*: ordering of strings is by UTF-16 code unit, which is the same in every runtime and locale.
//  - No Date.parse on free-form text: timestamps are parsed by an explicit ISO 8601 reader below.
//  - No dependence on the order of an input array or on object key order: callers sort with total orders built from these comparators.

/** Evidence contract section 3.4 step 5: "whitespace-normalised". Runs of any Unicode white space become one space; the ends are trimmed. */
export const normaliseWhitespace = (s: string): string => s.replace(/\s+/g, ' ').trim();

/** Length in Unicode code points (a surrogate pair counts once). */
export function codePointLength(s: string): number {
  let n = 0;
  for (const _ of s) n++;
  return n;
}

/** Cuts to at most `max` code points, never inside a surrogate pair. Evidence contract section 3.4 step 5. */
export function truncateCodePoints(s: string, max: number): string {
  if (s.length <= max) return s; // at most `max` UTF-16 units is at most `max` code points
  let out = '';
  let n = 0;
  for (const ch of s) {
    if (n === max) break;
    out += ch;
    n++;
  }
  return out;
}

/** Total order on strings by UTF-16 code unit. Locale independent. */
export const compareStrings = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Mirrors the A2 rule (validate-core.ts): control characters other than tab, LF and CR, and unpaired surrogates, are never valid text. */
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/;
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
export const hasDisallowedCharacters = (s: string): boolean => CONTROL_CHARS.test(s) || LONE_SURROGATE.test(s);

// ---------------------------------------------------------------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------------------------------------------------------------

const ISO = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;
const daysIn = (y: number, m: number): number => [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];

/**
 * Reads an ISO 8601 date-time WITH a zone designator and returns epoch milliseconds, or null if the text is not exactly that
 * (or is not a real calendar time, or falls outside years 0000-9999 in UTC). Sub-millisecond digits are dropped (not rounded). Does not use Date.parse.
 */
export function isoToEpochMs(s: string): number | null {
  const m = ISO.exec(s);
  if (!m) return null;
  const [year, month, day, hour, minute, second] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])];
  if (month < 1 || month > 12 || day < 1 || day > daysIn(year, month) || hour > 23 || minute > 59 || second > 59) return null;
  let offsetMinutes = 0;
  const zone = m[8];
  if (zone !== 'Z') {
    const zh = Number(zone.slice(1, 3));
    const zm = Number(zone.slice(4, 6));
    if (zh > 23 || zm > 59) return null;
    offsetMinutes = (zone[0] === '-' ? -1 : 1) * (zh * 60 + zm);
  }
  const ms = m[7] ? Number(m[7].slice(0, 3).padEnd(3, '0')) : 0;
  const d = new Date(0);
  d.setUTCFullYear(year, month - 1, day); // setUTCFullYear, not Date.UTC: years 0-99 must not be mapped to 1900-1999
  d.setUTCHours(hour, minute, second, ms);
  const t = d.getTime() - offsetMinutes * 60_000;
  if (!Number.isFinite(t)) return null;
  // The zone offset can push the UTC instant outside years 0000-9999 (for example 0000-01-01T00:00:00+05:00 is year -0001 in UTC), where
  // toISOString writes an extended year ("-000001-...") that is not a valid index timestamp. Such an instant is rejected.
  const utcYear = new Date(t).getUTCFullYear();
  return utcYear >= 0 && utcYear <= 9999 ? t : null;
}

/** Canonical UTC form used in the evidence index, at second precision as in the documented example: 2026-09-02T08:00:00Z. */
export const epochToIso = (t: number): string => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** "YYYY-MM" in UTC, the only date precision the model sees. */
export const epochToMonth = (t: number): string => new Date(t).toISOString().slice(0, 7);
