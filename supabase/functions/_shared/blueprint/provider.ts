// Blueprint Engine Phase B2: one strict, non-streaming OpenRouter chat-completions call.
// This module performs no persistence, quota accounting, retries, logging of content, or provider fallback.
// The caller must enforce auth/entitlement/quota before reaching this boundary and cache only validated pass outputs.
import { isFreeModelSlug } from '../collector/ai-common.ts';

export const BLUEPRINT_CHAT_COMPLETIONS_ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';
export const BLUEPRINT_DEFAULT_MODEL = 'baidu/ernie-5.5-flash-preview:free';

export interface BlueprintProviderConfig {
  apiKey: string;
  model: string;
  timeoutMs: number;
  endpoint?: string;
  fetchImpl?: typeof fetch;
}

export interface BlueprintProviderUsage {
  input_tokens: number;
  output_tokens: number;
  reasoning_tokens: number | null;
  reported_cost_usd: number | null;
  served_model: string | null;
  provider: string | null;
  response_id: string | null;
  duration_ms: number;
}

export interface BlueprintProviderResult {
  output: Record<string, unknown>;
  usage: BlueprintProviderUsage;
}

export type BlueprintProviderErrorCode =
  | 'invalid_config'
  | 'timeout'
  | 'network'
  | 'rate_limited'
  | 'provider_unavailable'
  | 'provider_rejected'
  | 'provider_error'
  | 'invalid_response'
  | 'truncated_response';

export type BlueprintProviderFailureReason =
  | 'response_not_json' | 'no_choices' | 'empty_content'
  | 'reasoning_exhausted_budget' | 'truncated_json' | 'no_json'
  | 'not_an_object' | 'provider_error' | 'content_filtered';

export class BlueprintProviderError extends Error {
  constructor(
    public readonly code: BlueprintProviderErrorCode,
    public readonly httpStatus: number | null = null,
    public readonly reason: BlueprintProviderFailureReason | null = null,
    public readonly finishReason: string | null = null,
    public readonly contentChars: number | null = null,
    public readonly reasoningChars: number | null = null,
    public readonly promptTokens: number | null = null,
    public readonly completionTokens: number | null = null,
  ) {
    super(code);
    this.name = 'BlueprintProviderError';
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const nonNegativeInteger = (v: unknown): number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : 0;

const optionalNonNegativeNumber = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;

/** Validate at the boundary. No paid model slug or provider fallback is ever accepted. */
export function blueprintProviderConfigProblem(config: BlueprintProviderConfig): string | null {
  if (!config.apiKey.trim()) return 'OPENROUTER_API_KEY is not set';
  if (!isFreeModelSlug(config.model)) return 'BLUEPRINT_MODEL must be an explicit :free model';
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1_000 || config.timeoutMs > 120_000) {
    return 'BLUEPRINT_PASS_TIMEOUT_MS is outside the supported safety bounds';
  }
  return null;
}

/**
 * Calls exactly one pass. The AbortController remains active through response-body parsing, so the deadline
 * covers the complete response rather than only receipt of response headers. Raw provider text is never
 * included in thrown errors.
 */
export async function callBlueprintProvider(
  config: BlueprintProviderConfig,
  input: { systemPrompt: string; userPayload: unknown; maxTokens: number },
  now: () => number = Date.now,
): Promise<BlueprintProviderResult> {
  if (blueprintProviderConfigProblem(config) !== null) throw new BlueprintProviderError('invalid_config');
  if (!Number.isInteger(input.maxTokens) || input.maxTokens < 1 || input.maxTokens > 32_000) {
    throw new BlueprintProviderError('invalid_config');
  }

  const started = now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  let response: Response;
  let raw: unknown;
  try {
    response = await (config.fetchImpl ?? fetch)(config.endpoint ?? BLUEPRINT_CHAT_COMPLETIONS_ENDPOINT, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json',
        accept: 'application/json',
        'http-referer': 'https://demandradar.app',
        'x-title': 'DemandRadar',
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.1,
        max_tokens: input.maxTokens,
        response_format: { type: 'json_object' },
        provider: { allow_fallbacks: false },
        messages: [
          { role: 'system', content: input.systemPrompt },
          { role: 'user', content: JSON.stringify(input.userPayload) },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      if (response.status === 429) throw new BlueprintProviderError('rate_limited', 429);
      if (response.status >= 500) throw new BlueprintProviderError('provider_unavailable', response.status);
      if (response.status === 401 || response.status === 403 || response.status === 402) {
        throw new BlueprintProviderError('provider_rejected', response.status);
      }
      throw new BlueprintProviderError('provider_error', response.status);
    }

    try {
      raw = await response.json();
    } catch {
      throw new BlueprintProviderError('invalid_response', response.status);
    }
  } catch (error) {
    if (error instanceof BlueprintProviderError) throw error;
    if (controller.signal.aborted) throw new BlueprintProviderError('timeout');
    throw new BlueprintProviderError('network');
  } finally {
    clearTimeout(timer);
  }

  if (!isObject(raw)) throw new BlueprintProviderError('invalid_response', response.status);
  if (raw.error !== undefined && raw.error !== null) throw new BlueprintProviderError('provider_error', response.status);
  const usage = isObject(raw.usage) ? raw.usage : {};
  const completionDetails = isObject(usage.completion_tokens_details) ? usage.completion_tokens_details : {};
  const promptTokens = nonNegativeInteger(usage.prompt_tokens);
  const completionTokens = nonNegativeInteger(usage.completion_tokens);
  const reasoningTokens = nonNegativeInteger(completionDetails.reasoning_tokens);
  const model = typeof raw.model === 'string' ? raw.model.slice(0, 120) : null;
  const provider = typeof raw.provider === 'string' ? raw.provider.slice(0, 80) : null;
  if (!Array.isArray(raw.choices) || !isObject(raw.choices[0])) {
    throw new BlueprintProviderError('invalid_response', response.status, 'no_choices', null, null, null, promptTokens, completionTokens);
  }

  const choice = raw.choices[0];
  const finish = typeof choice.finish_reason === 'string' ? choice.finish_reason : null;
  if (finish === 'length') {
    const msg = isObject(choice.message) ? choice.message : {};
    const content = typeof msg.content === 'string' ? msg.content : '';
    const reasoning = typeof msg.reasoning === 'string' ? msg.reasoning : '';
    const reason = !content.trim() && (reasoning.length > 0 || reasoningTokens > 0)
      ? 'reasoning_exhausted_budget' : 'truncated_json';
    throw new BlueprintProviderError('truncated_response', response.status, reason, finish, content.length, reasoning.length, promptTokens, completionTokens);
  }
  if (finish === 'content_filter') {
    throw new BlueprintProviderError('provider_error', response.status, 'content_filtered', finish, null, null, promptTokens, completionTokens);
  }
  if (finish === 'error') {
    throw new BlueprintProviderError('provider_error', response.status, 'provider_error', finish, null, null, promptTokens, completionTokens);
  }
  if (!isObject(choice.message)) {
    throw new BlueprintProviderError('invalid_response', response.status, 'empty_content', finish, null, null, promptTokens, completionTokens);
  }
  const content = choice.message.content;
  if (typeof content !== 'string' || !content.trim()) {
    const chars = typeof content === 'string' ? content.length : null;
    const type = content === null ? 'null' : typeof content;
    const reason = type === 'null' && (typeof choice.message.reasoning === 'string' || reasoningTokens > 0)
      ? 'reasoning_exhausted_budget' : 'empty_content';
    throw new BlueprintProviderError('invalid_response', response.status, reason, finish, chars,
      typeof choice.message.reasoning === 'string' ? choice.message.reasoning.length : null, promptTokens, completionTokens);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    // Do not expose model text. Record only its length and whether it appears to contain a JSON object.
    const looksLikeJson = content.trim().startsWith('{') || content.includes('{');
    throw new BlueprintProviderError('invalid_response', response.status, looksLikeJson ? 'truncated_json' : 'no_json',
      finish, content.length, null, promptTokens, completionTokens);
  }
  if (!isObject(parsed)) throw new BlueprintProviderError('invalid_response', response.status, 'not_an_object',
    finish, content.length, null, promptTokens, completionTokens);


  const details = isObject(usage.completion_tokens_details) ? usage.completion_tokens_details : {};
  const cost = optionalNonNegativeNumber(usage.cost);
  return {
    output: parsed,
    usage: {
      input_tokens: nonNegativeInteger(usage.prompt_tokens),
      output_tokens: nonNegativeInteger(usage.completion_tokens),
      reasoning_tokens: optionalNonNegativeNumber(details.reasoning_tokens),
      reported_cost_usd: cost,
      served_model: typeof raw.model === 'string' ? raw.model.slice(0, 120) : null,
      provider: typeof raw.provider === 'string' ? raw.provider.slice(0, 80) : null,
      response_id: typeof raw.id === 'string' ? raw.id.slice(0, 120) : null,
      duration_ms: Math.max(0, now() - started),
    },
  };
}
