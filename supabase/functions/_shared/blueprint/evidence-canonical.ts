// Canonical JSON for the evidence pack: the input of the later cache-key phase (reliability document section 9).
//
// Object keys are sorted by UTF-16 code unit, there is no whitespace, `undefined` object members are skipped, and array order is kept.
// The output is a pure function of the value, so the same pack always gives the same string, whatever order the keys were inserted in.
//
// This is a deliberate copy of the idea in collector/ai-common.ts `canonicalJson` (the blueprint engine stays independent of the collector,
// as A2 did for the free-model slug check). A test asserts the two produce the same string for the pack shapes used here, so the cache
// identity will not silently diverge from the existing one.
//
// This module does NOT hash. SHA-256 is asynchronous in the platform crypto API and belongs to the cache phase, which hashes this string.
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number' && !Number.isFinite(v)) throw new RangeError('canonicalJson: non-finite number');
    const s = JSON.stringify(v);
    if (s === undefined) throw new TypeError('canonicalJson: value is not JSON');
    return s;
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}
