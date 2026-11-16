// The backend-owned half of ProductBlueprintV1: `meta`, `evidence_index` and `verification` (product-blueprint-v1.md section 3.9), and the
// consistency checks between those and the model-owned document.
//
// Backend-owned strings are validated for shape and length but are NOT scanned by the content policy: that policy is for text the model wrote
// (a URL is legitimate in `evidence_index[*].url`, which comes from the database). Nothing here proves that evidence is real; it checks that
// the stored record is internally consistent.
import {
  ANALYSIS_METHOD, BASIS, CAP, EVIDENCE_EXCERPT_MAX_ID, EVIDENCE_METRIC_MAX_ID, EVIDENCE_SUFFICIENCY, FORMAT, GENERATION_MODE, BLUEPRINT_SCHEMA_VERSION,
  METRIC_CATALOGUE_NAMES, METRIC_CLASS, METRIC_NAME, PASS_NAME, REPAIR_ACTION, SAFEGUARDS, TEAM_SIZE, BUDGET_BAND, PREFERRED_STACK, BUSINESS_MODEL_HINT,
  TARGET_REGION, VERIFICATION_CHECK_NAME, VERIFICATION_STATUS, WTP_MIN_EXCERPTS, ACCEPTED_VERIFICATION_STATUS, ESTIMATE_DISCLAIMER, FIXED_DISCLAIMERS,
  REQUIRED_VERIFICATION_CHECKS,
} from './constants.ts';
import type { Range } from './constants.ts';
import type { Basis, ProductBlueprintV1 } from './contract.ts';
import {
  at, Ctx, fBool, fEnum, hasKey, isRec, readEvidenceId, readList, readNumber, readObject, readString, Rec,
} from './validate-core.ts';
import { countClaimsByBasis, claimSites, refSites } from './validate-evidence.ts';

const SG = SAFEGUARDS;
const COUNTER: Range = { min: 0, max: SG.maxCounter };

// ---------------------------------------------------------------------------------------------------------------------------------
// Small readers for backend-owned values
// ---------------------------------------------------------------------------------------------------------------------------------

const bText = (c: Ctx, path: string, v: unknown, max: number): void => { readString(c, path, v, max, 'text', false); };

/** Runs `read` unless the value is the allowed null. */
function readNullable(v: unknown, read: () => void): void {
  if (v !== null) read();
}

function readSha(c: Ctx, path: string, v: unknown): void {
  if (typeof v !== 'string') { c.err('invalid_type', path, 'Expected a string.'); return; }
  if (!FORMAT.sha256Hex.test(v)) c.err('invalid_format', path, 'Expected a SHA-256 value written as 64 hexadecimal characters.');
}

const daysIn = (year: number, month: number): number => [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];

/** ISO 8601 date-time with a zone designator, checked for calendar validity (no 31 February, no hour 24). */
function readIsoDateTime(c: Ctx, path: string, v: unknown): void {
  if (typeof v !== 'string') { c.err('invalid_type', path, 'Expected a string.'); return; }
  const m = FORMAT.isoDateTime.exec(v);
  const ok = m !== null
    && Number(m[2]) >= 1 && Number(m[2]) <= 12 && Number(m[3]) >= 1 && Number(m[3]) <= daysIn(Number(m[1]), Number(m[2]))
    && Number(m[4]) <= 23 && Number(m[5]) <= 59 && Number(m[6]) <= 59;
  if (!ok) c.err('invalid_format', path, 'Expected an ISO 8601 date and time with a time zone, for example 2026-01-31T09:30:00Z.');
}

function readUrl(c: Ctx, path: string, v: unknown): void {
  if (typeof v !== 'string') { c.err('invalid_type', path, 'Expected a string.'); return; }
  if (v.length > SG.backendUrl || !FORMAT.httpUrl.test(v)) c.err('invalid_format', path, `Expected an http(s) URL of at most ${SG.backendUrl} characters.`);
}

function readPointer(c: Ctx, path: string, v: unknown): void {
  if (typeof v !== 'string') { c.err('invalid_type', path, 'Expected a string.'); return; }
  if (v.length === 0 || v.length > CAP.default || !FORMAT.jsonPointer.test(v)) c.err('invalid_format', path, 'Expected a non-empty JSON Pointer (RFC 6901).');
}

const fS = (c: Ctx, o: Rec, p: string, k: string, max: number): void => { if (hasKey(o, k)) bText(c, at(p, k), o[k], max); };
const fNullableS = (c: Ctx, o: Rec, p: string, k: string, max: number): void => { if (hasKey(o, k)) readNullable(o[k], () => bText(c, at(p, k), o[k], max)); };
const fInt = (c: Ctx, o: Rec, p: string, k: string, r: Range = COUNTER): void => { if (hasKey(o, k)) readNumber(c, at(p, k), o[k], r, true); };

// ---------------------------------------------------------------------------------------------------------------------------------
// meta
// ---------------------------------------------------------------------------------------------------------------------------------

function readPass(c: Ctx, p: string, v: unknown): void {
  const o = readObject(c, p, v, ['pass', 'cache_id', 'input_hash', 'served_model', 'provider', 'finish_reason', 'prompt_tokens', 'completion_tokens', 'reasoning_tokens', 'reported_cost_usd', 'duration_ms', 'from_cache']);
  if (!o) return;
  fEnum(c, o, p, 'pass', PASS_NAME);
  fNullableS(c, o, p, 'cache_id', SG.backendShortText);
  if (hasKey(o, 'input_hash')) readSha(c, at(p, 'input_hash'), o.input_hash);
  fNullableS(c, o, p, 'served_model', SG.backendShortText);
  fNullableS(c, o, p, 'provider', SG.backendShortText);
  fNullableS(c, o, p, 'finish_reason', SG.backendShortText);
  fInt(c, o, p, 'prompt_tokens');
  fInt(c, o, p, 'completion_tokens');
  if (hasKey(o, 'reasoning_tokens')) readNullable(o.reasoning_tokens, () => readNumber(c, at(p, 'reasoning_tokens'), o.reasoning_tokens, COUNTER, true));
  if (hasKey(o, 'reported_cost_usd')) readNullable(o.reported_cost_usd, () => readNumber(c, at(p, 'reported_cost_usd'), o.reported_cost_usd, { min: 0, max: SG.maxCounter }));
  fInt(c, o, p, 'duration_ms');
  fBool(c, o, p, 'from_cache');
}

function readMeta(c: Ctx, p: string, v: unknown): void {
  const o = readObject(c, p, v, ['blueprint_id', 'cluster_id', 'generated_at', 'contract_version', 'prompt_version', 'config_version', 'requested_model', 'generation_mode', 'passes', 'request_params', 'evidence_pack', 'disclaimers']);
  if (!o) return;
  fS(c, o, p, 'blueprint_id', SG.backendShortText);
  fS(c, o, p, 'cluster_id', SG.backendShortText);
  if (hasKey(o, 'generated_at')) readIsoDateTime(c, at(p, 'generated_at'), o.generated_at);
  if (hasKey(o, 'contract_version')) {
    if (typeof o.contract_version !== 'string') c.err('invalid_type', at(p, 'contract_version'), 'Expected a string.');
    else if (o.contract_version !== BLUEPRINT_SCHEMA_VERSION) c.err('invalid_literal', at(p, 'contract_version'), 'The contract version is not supported.');
  }
  if (hasKey(o, 'prompt_version')) {
    if (typeof o.prompt_version !== 'string') c.err('invalid_type', at(p, 'prompt_version'), 'Expected a string.');
    else if (!FORMAT.promptVersion.test(o.prompt_version)) c.err('invalid_format', at(p, 'prompt_version'), 'The prompt version has an invalid format.');
  }
  if (hasKey(o, 'config_version')) {
    if (typeof o.config_version !== 'string') c.err('invalid_type', at(p, 'config_version'), 'Expected a string.');
    else if (!FORMAT.configVersion.test(o.config_version)) c.err('invalid_format', at(p, 'config_version'), 'Expected a config version such as bp1.p1.s1, optionally followed by +suffix.');
  }
  if (hasKey(o, 'requested_model')) {
    if (typeof o.requested_model !== 'string') c.err('invalid_type', at(p, 'requested_model'), 'Expected a string.');
    else if (!FORMAT.freeModelSlug.test(o.requested_model)) c.err('invalid_format', at(p, 'requested_model'), 'The requested model must be an explicit :free slug.');
  }
  fEnum(c, o, p, 'generation_mode', GENERATION_MODE);
  if (hasKey(o, 'passes')) readList(c, at(p, 'passes'), o.passes, SG.passes, (item, ip) => readPass(c, ip, item));
  const rp = hasKey(o, 'request_params') ? readObject(c, at(p, 'request_params'), o.request_params, ['team_size', 'budget_band', 'preferred_stack', 'business_model_hint', 'target_region']) : undefined;
  if (rp) {
    const q = at(p, 'request_params');
    fEnum(c, rp, q, 'team_size', TEAM_SIZE);
    fEnum(c, rp, q, 'budget_band', BUDGET_BAND);
    fEnum(c, rp, q, 'preferred_stack', PREFERRED_STACK);
    fEnum(c, rp, q, 'business_model_hint', BUSINESS_MODEL_HINT);
    fEnum(c, rp, q, 'target_region', TARGET_REGION);
  }
  const ep = hasKey(o, 'evidence_pack') ? readObject(c, at(p, 'evidence_pack'), o.evidence_pack, ['excerpt_count', 'metric_count', 'pack_sha256', 'truncated', 'sufficiency', 'sufficiency_reasons']) : undefined;
  if (ep) {
    const q = at(p, 'evidence_pack');
    fInt(c, ep, q, 'excerpt_count', { min: 0, max: EVIDENCE_EXCERPT_MAX_ID });
    fInt(c, ep, q, 'metric_count', { min: 0, max: EVIDENCE_METRIC_MAX_ID });
    if (hasKey(ep, 'pack_sha256')) readSha(c, at(q, 'pack_sha256'), ep.pack_sha256);
    fBool(c, ep, q, 'truncated');
    fEnum(c, ep, q, 'sufficiency', EVIDENCE_SUFFICIENCY);
    if (hasKey(ep, 'sufficiency_reasons')) readList(c, at(q, 'sufficiency_reasons'), ep.sufficiency_reasons, SG.backendList, (item, ip) => bText(c, ip, item, SG.backendShortText));
  }
  if (hasKey(o, 'disclaimers')) {
    // Fixed backend text: an entry must be one of the documented disclaimers, exactly, and may not repeat. Arbitrary text is rejected.
    const seen = new Set<string>();
    readList(c, at(p, 'disclaimers'), o.disclaimers, SG.backendList, (item, ip) => {
      if (typeof item !== 'string') { c.err('invalid_type', ip, 'Expected a string.'); return; }
      if (!FIXED_DISCLAIMERS.includes(item)) { c.err('disclaimer_not_allowed', ip, 'Disclaimers are fixed backend text; this entry is not one of the documented disclaimers.'); return; }
      if (seen.has(item)) c.err('duplicate_item', ip, 'The list repeats an entry.');
      seen.add(item);
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// evidence_index
// ---------------------------------------------------------------------------------------------------------------------------------

function readMetricValue(c: Ctx, path: string, v: unknown): void {
  if (v === null || typeof v === 'boolean' || typeof v === 'number') return; // numbers are finite: the snapshot turns NaN/Infinity into an invalid marker
  if (typeof v === 'string') { bText(c, path, v, SG.backendShortText); return; }
  if (Array.isArray(v)) { readList(c, path, v, { min: 0, max: SG.metricValueListItems }, (item, ip) => bText(c, ip, item, SG.backendShortText)); return; }
  if (isRec(v)) {
    const keys = Object.keys(v);
    if (keys.length > SG.metricValueListItems) c.err('list_too_long', path, `The mapping allows at most ${SG.metricValueListItems} entries.`);
    const bad = keys.filter((k) => typeof v[k] !== 'number' || k.length === 0 || k.length > 100).length;
    if (bad > 0) c.err('invalid_type', path, `${bad} entr${bad === 1 ? 'y is' : 'ies are'} not a short name with a numeric value.`);
    return;
  }
  c.err('invalid_type', path, 'Expected a string, number, boolean, null, list of strings or a mapping of names to numbers.');
}

function readEvidenceEntry(c: Ctx, p: string, v: unknown): void {
  if (!isRec(v)) { c.err('invalid_type', p, 'Expected an object.'); return; }
  const kind = hasKey(v, 'kind') ? v.kind : undefined;
  const common = ['id', 'kind', 'cited_by'];
  let o: Rec | undefined;
  if (kind === 'discussion_excerpt') {
    o = readObject(c, p, v, [...common, 'record_id', 'source_id', 'url', 'title', 'excerpt', 'content_sha256', 'published_at', 'license', 'attribution', 'analysis_method', 'has_wtp_quote']);
    if (!o) return;
    fS(c, o, p, 'record_id', SG.backendShortText);
    fS(c, o, p, 'source_id', SG.backendShortText);
    if (hasKey(o, 'url')) readUrl(c, at(p, 'url'), o.url);
    fNullableS(c, o, p, 'title', SG.backendText);
    fS(c, o, p, 'excerpt', CAP.excerpt);
    if (hasKey(o, 'content_sha256')) readSha(c, at(p, 'content_sha256'), o.content_sha256);
    if (hasKey(o, 'published_at')) { const published = o.published_at; readNullable(published, () => readIsoDateTime(c, at(p, 'published_at'), published)); }
    fS(c, o, p, 'license', SG.backendText);
    fNullableS(c, o, p, 'attribution', SG.backendText);
    fEnum(c, o, p, 'analysis_method', ANALYSIS_METHOD);
    fBool(c, o, p, 'has_wtp_quote');
  } else if (kind === 'cluster_metric') {
    o = readObject(c, p, v, [...common, 'cluster_id', 'name', 'label', 'value', 'evidence_class']);
    if (!o) return;
    fS(c, o, p, 'cluster_id', SG.backendShortText);
    fEnum(c, o, p, 'name', METRIC_NAME);
    fS(c, o, p, 'label', SG.backendShortText);
    if (hasKey(o, 'value')) readMetricValue(c, at(p, 'value'), o.value);
    fEnum(c, o, p, 'evidence_class', METRIC_CLASS);
  } else {
    c.err(hasKey(v, 'kind') ? 'invalid_enum' : 'missing_required_field', at(p, 'kind'), hasKey(v, 'kind') ? 'The kind is not one of the allowed values.' : 'A required field is missing.');
    return;
  }
  if (!o) return;
  if (hasKey(o, 'id')) readEvidenceId(c, at(p, 'id'), o.id, 'any');
  if (hasKey(o, 'cited_by')) {
    const seen = new Set<string>();
    readList(c, at(p, 'cited_by'), o.cited_by, SG.citedBy, (item, ip) => {
      readPointer(c, ip, item);
      if (typeof item === 'string') {
        if (seen.has(item)) c.err('duplicate_item', ip, 'The list repeats an entry.');
        seen.add(item);
      }
    });
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------
// verification
// ---------------------------------------------------------------------------------------------------------------------------------

function readVerification(c: Ctx, p: string, v: unknown): void {
  const o = readObject(c, p, v, ['status', 'checks', 'repairs', 'claim_counts', 'ref_count', 'unresolved_refs']);
  if (!o) return;
  fEnum(c, o, p, 'status', VERIFICATION_STATUS);
  if (hasKey(o, 'checks')) {
    const seen = new Set<string>();
    readList(c, at(p, 'checks'), o.checks, SG.checks, (item, ip) => {
      const k = readObject(c, ip, item, ['check', 'passed'], ['detail']);
      if (!k) return;
      const name = fEnum(c, k, ip, 'check', VERIFICATION_CHECK_NAME);
      if (name !== undefined) {
        if (seen.has(name)) c.err('duplicate_item', at(ip, 'check'), 'This check is listed more than once.');
        seen.add(name);
      }
      fBool(c, k, ip, 'passed');
      fS(c, k, ip, 'detail', CAP.default);
    });
  }
  if (hasKey(o, 'repairs')) {
    readList(c, at(p, 'repairs'), o.repairs, SG.repairs, (item, ip) => {
      const r = readObject(c, ip, item, ['path', 'action', 'reason']);
      if (!r) return;
      if (hasKey(r, 'path')) { if (r.path === '') { /* the document root is a valid pointer for a whole-document repair */ } else readPointer(c, at(ip, 'path'), r.path); }
      fEnum(c, r, ip, 'action', REPAIR_ACTION);
      fS(c, r, ip, 'reason', CAP.default);
    });
  }
  if (hasKey(o, 'claim_counts')) {
    const cc = readObject(c, at(p, 'claim_counts'), o.claim_counts, BASIS);
    if (cc) for (const b of BASIS) fInt(c, cc, at(p, 'claim_counts'), b);
  }
  fInt(c, o, p, 'ref_count');
  if (hasKey(o, 'unresolved_refs') && o.unresolved_refs !== 0) {
    if (typeof o.unresolved_refs !== 'number') c.err('invalid_type', at(p, 'unresolved_refs'), 'Expected the number 0.');
    else c.err('invalid_literal', at(p, 'unresolved_refs'), 'A stored blueprint has no unresolved references; this must be 0.');
  }
}

/** Structure of the three backend-owned sections. `root` is the structurally validated document root. */
export function readBackendStructure(c: Ctx, root: Rec): void {
  if (hasKey(root, 'meta')) readMeta(c, '/meta', root.meta);
  if (hasKey(root, 'evidence_index')) readList(c, '/evidence_index', root.evidence_index, SG.evidenceIndexEntries, (item, ip) => readEvidenceEntry(c, ip, item));
  if (hasKey(root, 'verification')) readVerification(c, '/verification', root.verification);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Consistency of the assembled blueprint (runs on a structurally valid, integrity-checked document)
// ---------------------------------------------------------------------------------------------------------------------------------

export function checkAssembled(c: Ctx, bp: ProductBlueprintV1): void {
  // Phase A2 is rejection-only: a stored blueprint is "verified", records no repairs, and carries every documented check, each passed.
  if (bp.verification.status !== ACCEPTED_VERIFICATION_STATUS) {
    c.err('verification_status_not_allowed', '/verification/status', 'In Phase A2 a stored blueprint must have verification status "verified"; "verified_with_repairs" is not accepted.');
  }
  if (bp.verification.repairs.length > 0) {
    c.err('verification_repairs_not_allowed', '/verification/repairs', 'Repairs are not accepted in Phase A2: invalid output is rejected, never repaired.');
  }
  const checkCount = new Map<string, number>();
  bp.verification.checks.forEach((k, i) => {
    checkCount.set(k.check, (checkCount.get(k.check) ?? 0) + 1);
    if (!k.passed) c.err('verification_check_failed', `/verification/checks/${i}/passed`, 'A stored blueprint cannot contain a failed verification check.');
  });
  for (const required of REQUIRED_VERIFICATION_CHECKS) {
    if (!checkCount.has(required)) c.err('verification_check_missing', '/verification/checks', `The required verification check "${required}" is missing.`);
  }

  // Disclaimers are fixed text (each entry was matched against the documented wording); the estimate label is required.
  if (!bp.meta.disclaimers.includes(ESTIMATE_DISCLAIMER)) {
    c.err('disclaimer_missing', '/meta/disclaimers', 'The documented estimate disclaimer is required in the blueprint metadata.');
  }

  // generation_mode and the pass records tell the same story (section 7 "Reading the example").
  const names = bp.meta.passes.map((p) => p.pass);
  const distinct = new Set(names);
  const passesOk = bp.meta.generation_mode === 'single_pass'
    ? names.length === 1 && names[0] === 'single'
    : names.length === 3 && distinct.size === 3 && ['A', 'B', 'C'].every((n) => distinct.has(n as (typeof PASS_NAME)[number]));
  if (!passesOk) c.err('meta_inconsistent', '/meta/passes', 'The pass records do not match the generation mode: single_pass has one pass "single"; sectioned has passes A, B and C.');

  // evidence_index: unique ids, id letter agrees with kind, metric ids carry their catalogue name.
  const byId = new Map<string, number>();
  bp.evidence_index.forEach((e, i) => {
    if (byId.has(e.id)) c.err('duplicate_identifier', `/evidence_index/${i}/id`, 'This identifier is already used by an earlier item in the same list.');
    else byId.set(e.id, i);
    if ((e.id[0] === 'E') !== (e.kind === 'discussion_excerpt')) c.err('evidence_index_mismatch', `/evidence_index/${i}/kind`, 'The id letter and the kind disagree: E## is a discussion excerpt, M## a cluster metric.');
    if (e.kind === 'cluster_metric' && e.id[0] === 'M') {
      const expected = METRIC_CATALOGUE_NAMES[Number(e.id.slice(1)) - 1];
      if (expected !== undefined && e.name !== expected) c.err('evidence_index_mismatch', `/evidence_index/${i}/name`, 'This metric id has a fixed meaning in the catalogue and the name does not match it.');
    }
  });
  // Every cluster metric belongs to the cluster this blueprint was generated for.
  bp.evidence_index.forEach((e, i) => {
    if (e.kind === 'cluster_metric' && e.cluster_id !== bp.meta.cluster_id) {
      c.err('evidence_index_mismatch', `/evidence_index/${i}/cluster_id`, 'A cluster metric must belong to the cluster named in meta.cluster_id.');
    }
  });
  const excerptEntries = bp.evidence_index.filter((e) => e.kind === 'discussion_excerpt').length;
  const metricEntries = bp.evidence_index.length - excerptEntries;
  if (bp.meta.evidence_pack.excerpt_count !== excerptEntries) c.err('evidence_index_mismatch', '/meta/evidence_pack/excerpt_count', 'The excerpt count does not match the number of excerpts in the evidence index.');
  if (bp.meta.evidence_pack.metric_count !== metricEntries) c.err('evidence_index_mismatch', '/meta/evidence_pack/metric_count', 'The metric count does not match the number of metrics in the evidence index.');

  // Every cited id resolves to an index entry.
  const refs = refSites(bp);
  for (const ref of refs) if (!byId.has(ref.id)) c.err('evidence_ref_unresolved', ref.path, 'This evidence id is not in the evidence index.');

  // A verified_evidence claim needs a supporting-grade item (excerpt, or metric of class measured/derived) among its references.
  for (const site of claimSites(bp)) {
    if (site.claim.basis !== 'verified_evidence') continue;
    const supported = site.claim.evidence_refs.some((id) => {
      const e = byId.has(id) ? bp.evidence_index[byId.get(id) as number] : undefined;
      return e !== undefined && (e.kind === 'discussion_excerpt' || e.evidence_class === 'measured' || e.evidence_class === 'derived');
    });
    if (!supported) c.err('verified_claim_unsupported', `${site.path}/evidence_refs`, 'A verified_evidence claim must cite at least one supporting-grade item: an excerpt, or a metric of class measured or derived.');
  }

  // Willingness to pay "evidenced": at least two distinct cited excerpts must carry a willingness-to-pay quote.
  const wtp = bp.market_evidence.willingness_to_pay;
  if (wtp.status === 'evidenced') {
    const flagged = new Set(wtp.summary.evidence_refs.filter((id) => {
      const e = byId.has(id) ? bp.evidence_index[byId.get(id) as number] : undefined;
      return e !== undefined && e.kind === 'discussion_excerpt' && e.has_wtp_quote;
    }));
    if (flagged.size < WTP_MIN_EXCERPTS) c.err('wtp_rule_violation', '/market_evidence/willingness_to_pay/summary/evidence_refs', `Willingness to pay may be "evidenced" only when at least ${WTP_MIN_EXCERPTS} cited excerpts carry a willingness-to-pay quote.`);
  }

  // cited_by lists exactly the places that cite each item.
  const expectedCites = new Map<string, Set<string>>();
  for (const ref of refs) {
    if (!expectedCites.has(ref.id)) expectedCites.set(ref.id, new Set());
    (expectedCites.get(ref.id) as Set<string>).add(ref.path);
  }
  bp.evidence_index.forEach((e, i) => {
    const want = expectedCites.get(e.id) ?? new Set<string>();
    const have = new Set(e.cited_by);
    const missing = [...want].filter((p) => !have.has(p)).length;
    const extra = [...have].filter((p) => !want.has(p)).length;
    if (missing > 0 || extra > 0) c.err('evidence_index_mismatch', `/evidence_index/${i}/cited_by`, `cited_by does not match the places that cite this item (${missing} missing, ${extra} not found).`);
  });

  // The verification report's counts are recomputed from the document; a stored count is never trusted.
  const counts = countClaimsByBasis(bp);
  for (const b of BASIS as readonly Basis[]) {
    if (bp.verification.claim_counts[b] !== counts[b]) c.err('verification_mismatch', `/verification/claim_counts/${b}`, 'The stored claim count does not match the claims in the document.');
  }
  if (bp.verification.ref_count !== refs.length) c.err('verification_mismatch', '/verification/ref_count', 'The stored reference count does not match the references in the document.');

  // Limited evidence restricts the verdict (evidence contract section 3.6). No rule is applied for "insufficient": the documents do not define one.
  if (bp.meta.evidence_pack.sufficiency === 'limited' && bp.opportunity.verdict !== 'validate_first' && bp.opportunity.verdict !== 'insufficient_evidence') {
    c.err('verdict_not_allowed_for_sufficiency', '/opportunity/verdict', 'With limited evidence the verdict may only be validate_first or insufficient_evidence.');
  }
}

