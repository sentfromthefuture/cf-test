// Test utilities for the AI engines. All payloads are SYNTHETIC, shaped after OpenRouter's published OpenAPI schema for
// POST /api/alpha/decisions and /api/v1/chat/completions. No real request is ever made: these tests prove parsing, validation, caching
// and orchestration logic, not model quality, API availability or live behaviour.
import { HttpClient } from '../types.ts';
import { PendingRecord } from '../ai.ts';

export interface Call { url: string; body: any; headers: Record<string, string> }

/** HttpClient whose responses are scripted. The handler may throw HttpError/RateLimitError to simulate failures. */
export function scriptedHttp(handler: (call: Call, n: number) => unknown | Promise<unknown>) {
  const calls: Call[] = [];
  let extraRequests = 0;
  let limited = 0;
  const http: HttpClient = {
    async getJson() { throw new Error('unexpected GET in an AI test'); },
    async postJson<T>(url: string, body: unknown, opts?: { headers?: Record<string, string> }) {
      const call: Call = { url, body, headers: opts?.headers ?? {} };
      calls.push(call);
      return { data: (await handler(call, calls.length)) as T, headers: new Headers(), status: 200 };
    },
    holdUntil() {},
    usage: () => ({ requests: calls.length + extraRequests, errors: 0, rateLimited: limited }),
  };
  return { http, calls, simulateRetry: () => { extraRequests++; }, simulateRateLimitResponse: () => { limited++; } };
}

export const pending = (id: string, over: Partial<PendingRecord> = {}): PendingRecord => ({
  id, source_id: 'github', kind: 'issue', title: `Need a better way to ${id}`,
  excerpt: `It is really frustrating that there is no tool for ${id}. I wish there was one.`,
  categories: ['label:feature request'], engagement: { score: 3 }, content_hash: `hash-${id}`, language: 'en', ...over,
});

/** A VALID Decisions response (shape from the OpenAPI example). Override pieces to build invalid ones. */
export function decisionsBody(o: { noul?: unknown; answers?: Record<string, unknown>; annotations?: unknown; usage?: unknown; extra?: Record<string, unknown> } = {}) {
  return {
    id: 'gen-dec-test', model: 'parallel/decisions-fast-20261106', provider: 'Parallel',
    answers: {
      is_problem: { type: 'noul', noul: o.noul ?? 0.93 },
      signal_type: { type: 'choice', choice: 'unmet_need', probabilities: { complaint: 0.05, feature_request: 0.15, unmet_need: 0.7, question: 0.05, other: 0.05 }, confidence: 0.7 },
      industry: { type: 'choice', choice: 'Hospitality & Food Ops', probabilities: { 'Hospitality & Food Ops': 0.8, Other: 0.2 }, confidence: 0.8 },
      severity: { type: 'score', score: 2.4, legend: { '0': 'Minor annoyance', '2': 'Significant recurring pain' }, probabilities: { '0': 0, '1': 0.1, '2': 0.5, '3': 0.4, '4': 0 }, confidence: 0.6 },
      ...(o.answers ?? {}),
    },
    annotations: o.annotations ?? [
      { type: 'url_citation', url_citation: { url: 'https://docs.example.net/guide?utm_source=a', title: 'A guide', content: 'Some supporting text.' } },
    ],
    usage: o.usage ?? { input_tokens: 420, output_tokens: 66, cost: 0 },
    ...(o.extra ?? {}),
  };
}

export const FREE_ENV = { DECISIONS_ENABLED: 'true', OPENROUTER_API_KEY: 'sk-or-v1-test-key-not-real' };
