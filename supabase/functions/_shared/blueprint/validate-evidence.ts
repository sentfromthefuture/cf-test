// Tier T6 (model level): where the blueprint cites evidence and which basis each claim may carry.
//
// This is STRUCTURAL evidence validation. It checks the shape of references, which basis a path allows, and the willingness-to-pay and
// market-sizing rules that can be decided from the document alone. It does NOT prove that a cited excerpt says what a claim says, that a
// name or number appears in the evidence, or that any evidence exists. Grounding checks (evidence contract section 5.3) need the evidence
// pack and belong to a later phase. This module never invents evidence records, URLs or citations.
import { BASIS_BY_ROLE, NOT_ESTIMATED_TEXT, WTP_MIN_EXCERPTS } from './constants.ts';
import type { Basis, BlueprintModelOutputV1, Claim } from './contract.ts';
import { Ctx } from './validate-core.ts';
import type { ClaimRole } from './constants.ts';

export interface ClaimSite {
  /** JSON Pointer to the Claim object. */
  path: string;
  claim: Claim;
  role: ClaimRole;
  /** For alternative_shortfall: the alternative's kind. For willingness_to_pay_summary: the status. */
  condition?: string;
}

export interface RefSite {
  /** JSON Pointer to the single id inside an evidence_refs / metric_refs / excerpt_refs list. */
  path: string;
  id: string;
}

/**
 * Every field typed Claim in the contract (evidence contract section 5.2 lists the same 16 locations). A test cross-checks this list against a
 * generic scan for Claim-shaped objects, so a Claim added to the contract without being listed here fails loudly.
 */
export function claimSites(m: BlueprintModelOutputV1): ClaimSite[] {
  const sites: ClaimSite[] = [];
  const add = (path: string, claim: Claim, role: ClaimRole, condition?: string): void => { sites.push({ path, claim, role, condition }); };
  const o = m.opportunity;
  add('/opportunity/verdict_rationale', o.verdict_rationale, 'verdict_rationale');
  add('/opportunity/problem_statement', o.problem_statement, 'problem_statement');
  add('/opportunity/affected_users', o.affected_users, 'affected_users');
  o.current_alternatives.forEach((a, i) => add(`/opportunity/current_alternatives/${i}/how_it_falls_short`, a.how_it_falls_short, 'alternative_shortfall', a.kind));
  o.thesis.forEach((t, i) => add(`/opportunity/thesis/${i}`, t, 'thesis'));
  o.counter_thesis.forEach((t, i) => add(`/opportunity/counter_thesis/${i}`, t, 'counter_thesis'));
  m.market_evidence.demand_signals.forEach((s, i) => add(`/market_evidence/demand_signals/${i}/interpretation`, s.interpretation, 'demand_interpretation'));
  add('/market_evidence/willingness_to_pay/summary', m.market_evidence.willingness_to_pay.summary, 'willingness_to_pay_summary', m.market_evidence.willingness_to_pay.status);
  m.personas.forEach((p, i) => {
    p.frustrations.forEach((f, k) => add(`/personas/${i}/frustrations/${k}`, f, 'persona_frustration'));
    add(`/personas/${i}/current_workaround`, p.current_workaround, 'persona_workaround');
  });
  add('/product/positioning', m.product.positioning, 'product_statement');
  add('/product/value_proposition', m.product.value_proposition, 'product_statement');
  add('/product/differentiation', m.product.differentiation, 'product_statement');
  m.mvp.features.forEach((f, i) => add(`/mvp/features/${i}/justification`, f.justification, 'feature_justification'));
  add('/commercial/business_model', m.commercial.business_model, 'business_model');
  m.commercial.pricing_hypotheses.forEach((h, i) => add(`/commercial/pricing_hypotheses/${i}/statement`, h.statement, 'pricing_statement'));
  add('/commercial/market_sizing/statement', m.commercial.market_sizing.statement, 'market_sizing_statement');
  m.risks.risks.forEach((r, i) => add(`/risks/risks/${i}/claim`, r.claim, 'risk_claim'));
  return sites;
}

/** Every place that cites an evidence id: Claim.evidence_refs plus the metric_refs and excerpt_refs of each demand signal. */
export function refSites(m: BlueprintModelOutputV1): RefSite[] {
  const refs: RefSite[] = [];
  for (const site of claimSites(m)) site.claim.evidence_refs.forEach((id, i) => refs.push({ path: `${site.path}/evidence_refs/${i}`, id }));
  m.market_evidence.demand_signals.forEach((s, i) => {
    s.metric_refs.forEach((id, k) => refs.push({ path: `/market_evidence/demand_signals/${i}/metric_refs/${k}`, id }));
    s.excerpt_refs.forEach((id, k) => refs.push({ path: `/market_evidence/demand_signals/${i}/excerpt_refs/${k}`, id }));
  });
  return refs;
}

/** Claim count per basis, recomputed from the document (never taken from the model or from a stored report). */
export function countClaimsByBasis(m: BlueprintModelOutputV1): Record<Basis, number> {
  const counts: Record<Basis, number> = { verified_evidence: 0, ai_recommendation: 0, hypothesis: 0, unknown: 0 };
  for (const site of claimSites(m)) counts[site.claim.basis]++;
  return counts;
}

/** The basis values a site may carry (evidence contract section 5.2, including the two documented conditions). */
function allowedBases(site: ClaimSite): readonly Basis[] {
  if (site.role === 'alternative_shortfall' && site.condition === 'named_in_evidence') return ['verified_evidence', ...BASIS_BY_ROLE.alternative_shortfall];
  if (site.role === 'willingness_to_pay_summary' && site.condition === 'evidenced') return ['verified_evidence'];
  return BASIS_BY_ROLE[site.role];
}

export interface EvidenceRuleOptions {
  /**
   * Ids the backend actually showed the model (for example E01-E05 and M01-M05). When given, every cited id must be in this set. Without it the
   * model-level validator can only check that ids are well-formed and inside the issued ranges; resolution against the real pack is a later phase.
   */
  knownEvidenceIds?: ReadonlySet<string>;
}

/** Tier T6 for the model-owned document. Runs only on a structurally valid, integrity-checked document. */
export function checkEvidenceRules(c: Ctx, m: BlueprintModelOutputV1, options: EvidenceRuleOptions = {}): void {
  for (const site of claimSites(m)) {
    if (!allowedBases(site).includes(site.claim.basis)) {
      c.err('basis_not_allowed', `${site.path}/basis`, 'This basis is not allowed for this field.');
    }
  }

  // Willingness to pay (contract section 3.2, evidence contract section 6): "evidenced" needs verified_evidence citing at least two distinct
  // excerpts. Whether those excerpts carry a willingness-to-pay quote can only be checked against the evidence index (assembled blueprint).
  const wtp = m.market_evidence.willingness_to_pay;
  if (wtp.status === 'evidenced') {
    const excerpts = new Set(wtp.summary.evidence_refs.filter((id) => id.startsWith('E')));
    if (excerpts.size < WTP_MIN_EXCERPTS) {
      c.err('wtp_rule_violation', '/market_evidence/willingness_to_pay/summary/evidence_refs', `Willingness to pay may be "evidenced" only when the summary cites at least ${WTP_MIN_EXCERPTS} different excerpts (E##).`);
    }
  }

  // Market sizing (evidence contract section 6): in v1 the only valid state is not_estimated with the canonical statement.
  const ms = m.commercial.market_sizing;
  if (ms.status !== 'not_estimated') {
    c.err('market_sizing_rule_violation', '/commercial/market_sizing/status', 'In contract v1 market sizing must be "not_estimated"; the "hypothesis" value is reserved.');
  } else if (ms.statement.text !== NOT_ESTIMATED_TEXT) {
    c.err('market_sizing_rule_violation', '/commercial/market_sizing/statement/text', 'When market sizing is "not_estimated" the statement must be the canonical text.');
  }

  if (options.knownEvidenceIds) {
    const known = options.knownEvidenceIds;
    for (const ref of refSites(m)) {
      if (!known.has(ref.id)) c.err('evidence_ref_unresolved', ref.path, 'This evidence id was not among the items shown to the model.');
    }
  }
}
