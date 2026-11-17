// The fixed metric catalogue M01-M16 (evidence contract section 3.2) with the documented rounding and bucketing.
//
// One rendering, three consumers. `buildMetricCatalogue` produces the rounded values ONCE. The model-facing pack, the canonical pack
// (cache identity) and the backend evidence index are all built from that single result, so they cannot disagree
// (section 3.2: "the model, the cache key and the stored index all use the same rounded value").
//
// A metric whose value is unavailable is still listed, with value null and class insufficient_data, so the model can see it is missing.
// A metric with class ai_estimate or insufficient_data can never support a verified_evidence claim (section 3.3); that is enforced in
// evidence-grounding.ts from the class stored here.
import type { MetricClass, MetricEvidence } from './contract.ts';
import {
  COMPONENT_BASIS_TO_CLASS, COUNT_BUCKETS, METRIC_LABELS, METRIC_NAMES, METRIC_VALUE_MAX_ITEMS, ROUNDING, SCORE_COMPONENT_KEYS, metricId,
} from './evidence-constants.ts';
import type { CountBucket } from './evidence-constants.ts';
import type { ValidCluster } from './evidence-input.ts';
import { compareStrings } from './evidence-text.ts';
import type { PackMetric } from './evidence-types.ts';

/**
 * Rounds to the nearest multiple of `step`. A value exactly halfway rounds AWAY FROM ZERO (2.5 with step 5 gives 5; -2.5 gives -5).
 * CHOICE: the documents say "nearest" without a tie rule. Rounding the magnitude keeps positive and negative growth symmetrical.
 * Negative zero is normalised to 0 so a value never renders as "-0".
 */
export function roundToStep(x: number, step: number): number {
  const out = Math.sign(x) * Math.round(Math.abs(x) / step) * step;
  return out === 0 ? 0 : out;
}

/** Evidence contract section 3.2: the bucket label for M07 and M08. The count must be a whole number of at least 0. */
export function bucketCount(n: number): CountBucket {
  if (!Number.isInteger(n) || n < 0) throw new RangeError('bucketCount expects a whole number of at least 0');
  if (n === 0) return COUNT_BUCKETS[0];
  if (n <= 2) return COUNT_BUCKETS[1];
  if (n <= 5) return COUNT_BUCKETS[2];
  if (n <= 10) return COUNT_BUCKETS[3];
  return COUNT_BUCKETS[4];
}

export interface MetricCatalogue {
  metrics: PackMetric[];
  /** Metric ids whose value had to be shortened to the A2 limit (only M10 can be). */
  value_truncated: string[];
}

const cloneValue = <T>(v: T): T => (v !== null && typeof v === 'object' ? (JSON.parse(JSON.stringify(v)) as T) : v);

/** A mapping built with defineProperty so a competitor called "__proto__" becomes an ordinary entry instead of changing the prototype. */
function toMapping(entries: readonly [string, number][]): Record<string, number> {
  const o: Record<string, number> = {};
  for (const [k, n] of entries) Object.defineProperty(o, k, { value: n, enumerable: true, writable: true, configurable: true });
  return o;
}

/** Builds M01..M16 in order. The input has already been validated, so every value here is well formed. */
export function buildMetricCatalogue(cluster: ValidCluster): MetricCatalogue {
  const rows: { value: MetricEvidence['value']; evidence_class: MetricClass }[] = [];
  const truncated: string[] = [];

  // M01-M02, M04: exact counts (measured). Growth, confidence and sources follow the order of the catalogue table.
  rows.push({ value: cluster.unique_discussions, evidence_class: 'measured' });                       // M01 unique_discussions
  rows.push({ value: cluster.source_count, evidence_class: 'measured' });                             // M02 source_count
  rows.push(cluster.growth_rate === null                                                              // M03 growth_rate_pct
    ? { value: null, evidence_class: 'insufficient_data' }
    : { value: roundToStep(cluster.growth_rate, ROUNDING.growthRatePctStep), evidence_class: 'derived' });
  rows.push({ value: cluster.wtp_signals, evidence_class: 'measured' });                              // M04 wtp_signal_count
  rows.push({ value: cluster.confidence, evidence_class: 'derived' });                                // M05 cluster_confidence
  // M06: the set of sources, de-duplicated and sorted so the order of the database array cannot change the pack.
  rows.push({ value: [...new Set(cluster.sources)].sort(compareStrings), evidence_class: 'measured' }); // M06 sources
  rows.push({ value: bucketCount(cluster.recent_discussions), evidence_class: 'measured' });          // M07 recent_discussions
  rows.push({ value: bucketCount(cluster.prior_discussions), evidence_class: 'measured' });           // M08 prior_discussions
  rows.push(cluster.severity_avg === null                                                             // M09 severity_avg (AI estimate)
    ? { value: null, evidence_class: 'insufficient_data' }
    : { value: roundToStep(cluster.severity_avg, ROUNDING.severityStep), evidence_class: 'ai_estimate' });

  // M10: name -> number of discussions naming it. Sorted by name for a stable key order. If there are more entries than the A2 limit, the
  // ones with the most discussions are kept (ties by name), then listed by name. CHOICE: the documents give no limit, A2 does.
  const byCountThenName = [...cluster.competitors].sort((a, b) => (b[1] - a[1]) || compareStrings(a[0], b[0]));
  const kept = byCountThenName.slice(0, METRIC_VALUE_MAX_ITEMS);
  if (kept.length < byCountThenName.length) truncated.push(metricId(10));
  rows.push({ value: toMapping(kept.sort((a, b) => compareStrings(a[0], b[0]))), evidence_class: 'measured' }); // M10 competitor_mentions

  // M11-M16: the six score components, each with the component's own basis. A missing component, or one with no value, is insufficient_data.
  SCORE_COMPONENT_KEYS.forEach((_key, i) => {
    const comp = cluster.components[i];
    if (comp === null || comp.value === null) rows.push({ value: null, evidence_class: 'insufficient_data' });
    else rows.push({ value: roundToStep(comp.value, ROUNDING.scoreComponentStep), evidence_class: COMPONENT_BASIS_TO_CLASS[comp.basis] });
  });

  const metrics: PackMetric[] = rows.map((r, i) => ({
    id: metricId(i + 1), name: METRIC_NAMES[i], label: METRIC_LABELS[i], value: r.value, evidence_class: r.evidence_class,
  }));
  return { metrics, value_truncated: truncated };
}

/** Independent copy of a metric's value (list and mapping values are copied) so the pack and the index never share mutable state. */
export const copyMetricValue = (v: MetricEvidence['value']): MetricEvidence['value'] => cloneValue(v);
