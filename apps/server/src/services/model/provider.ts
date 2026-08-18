import {
  isRealModelProvider,
  MODEL_PROVIDER_REQUIRED,
  type ModelCompletionRequest,
  type ModelCompletionResult,
  type ModelProvider,
  type ModelProviderName,
} from '@mac/protocol';
import { config } from '../../config.js';
import { AppError } from '../../http/errors.js';
import { getSettings } from '../settings.js';

/**
 * Model providers (Sprint 3 §10).
 *
 * Three implementations, and the DEFAULT IS NONE. Determinism is the correct
 * default posture for a system that runs unattended: a model that is off cannot
 * degrade an answer at 03:00, and turning it on is a deliberate, audited
 * settings change.
 */

/** No model. Every caller falls back to its deterministic path. */
export class NullModelProvider implements ModelProvider {
  readonly name = 'none' as const;
  async isAvailable() {
    return { available: false, reason: 'Model assistance is disabled.' };
  }
  async complete(): Promise<ModelCompletionResult> {
    throw new Error('No model provider is configured.');
  }
}

/**
 * A scripted provider for tests, including adversarial ones.
 *
 * The interesting tests are not "does it work" but "what happens when the model
 * fabricates a citation, or claims a confidence, or returns rubbish" — and none
 * of those can be written against a real model, because a real model cannot be
 * made to misbehave on demand.
 */
export class ScriptedModelProvider implements ModelProvider {
  readonly name = 'scripted' as const;
  readonly prompts: string[] = [];

  constructor(private readonly responses: string[]) {}

  async isAvailable() {
    return { available: true };
  }

  async complete(request: ModelCompletionRequest): Promise<ModelCompletionResult> {
    this.prompts.push(request.prompt);
    const text = this.responses.shift() ?? '';
    return {
      text,
      model: 'scripted',
      usage: { inputTokens: request.prompt.length, outputTokens: text.length },
    };
  }
}

/** The real one. `fetch` only; no SDK, no new dependency. */
export class AnthropicModelProvider implements ModelProvider {
  readonly name = 'anthropic' as const;

  constructor(
    private readonly options: { apiKey: string; model: string; fetchImpl?: typeof fetch; timeoutMs?: number },
  ) {}

  async isAvailable() {
    return this.options.apiKey
      ? { available: true }
      : { available: false, reason: 'No ANTHROPIC_API_KEY is configured.' };
  }

  async complete(request: ModelCompletionRequest & { signal?: AbortSignal }): Promise<ModelCompletionResult> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 60_000);
    /*
     * Sprint 3.3: a research step must abort when the run does.
     *
     * Cancellation is part of the provider contract (Sprint 3.3 section 11), and
     * a model call that ignored it would keep a cancelled run billing for up to
     * a minute after an operator pressed stop.
     */
    const onAbort = () => controller.abort();
    request.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const response = await fetchImpl('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': this.options.apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: this.options.model,
          max_tokens: request.maxTokens,
          system: request.system,
          messages: [{ role: 'user', content: request.prompt }],
        }),
        signal: controller.signal,
      });

      const text = await response.text();
      if (!response.ok) throw new Error(`Model provider returned ${response.status}: ${text.slice(0, 300)}`);

      const parsed = JSON.parse(text) as {
        content?: Array<{ type: string; text?: string }>;
        model?: string;
        usage?: { input_tokens?: number; output_tokens?: number };
      };

      return {
        text: (parsed.content ?? [])
          .filter((block) => block.type === 'text')
          .map((block) => block.text ?? '')
          .join(''),
        model: parsed.model ?? this.options.model,
        usage: {
          inputTokens: parsed.usage?.input_tokens ?? null,
          outputTokens: parsed.usage?.output_tokens ?? null,
        },
      };
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
    }
  }
}

/**
 * The second real provider (Sprint 3.3 section 11).
 *
 * `fetch` only, no SDK, no new dependency - the same posture as the Anthropic
 * one, and for the same reason: a vendor SDK is a large amount of code running
 * inside the control plane to save writing thirty lines.
 *
 * Its existence is the point. An interface with one implementation is an
 * assumption; with two it is a seam, and the shape of `ModelProvider` has now
 * been tested against a provider whose response envelope, usage field names and
 * error format are all different.
 */
export class OpenAIModelProvider implements ModelProvider {
  readonly name = 'openai' as const;

  constructor(
    private readonly options: {
      apiKey: string;
      model: string;
      baseUrl?: string;
      fetchImpl?: typeof fetch;
      timeoutMs?: number;
    },
  ) {}

  async isAvailable() {
    return this.options.apiKey ? { available: true } : { available: false, reason: 'No OPENAI_API_KEY is configured.' };
  }

  async complete(request: ModelCompletionRequest & { signal?: AbortSignal }): Promise<ModelCompletionResult> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 60_000);
    const onAbort = () => controller.abort();
    request.signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const response = await fetchImpl(`${this.options.baseUrl ?? 'https://api.openai.com/v1'}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.options.apiKey}`,
        },
        body: JSON.stringify({
          model: this.options.model,
          max_completion_tokens: request.maxTokens,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.prompt },
          ],
          ...(request.expectJson ? { response_format: { type: 'json_object' } } : {}),
        }),
        signal: controller.signal,
      });

      const text = await response.text();
      if (!response.ok) throw new Error(`Model provider returned ${response.status}: ${text.slice(0, 300)}`);

      const parsed = JSON.parse(text) as {
        choices?: Array<{ message?: { content?: string } }>;
        model?: string;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };

      return {
        text: (parsed.choices ?? []).map((choice) => choice.message?.content ?? '').join(''),
        model: parsed.model ?? this.options.model,
        usage: {
          inputTokens: parsed.usage?.prompt_tokens ?? null,
          outputTokens: parsed.usage?.completion_tokens ?? null,
        },
      };
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onAbort);
    }
  }
}

let override: ModelProvider | null = null;

/** Test seam, and the way a dry run swaps in a scripted model. */
export function setModelProvider(provider: ModelProvider | null): void {
  override = provider;
}

/**
 * The provider for right now.
 *
 * Reads settings on every call rather than caching, because turning model
 * assistance off is the sort of thing somebody does in a hurry and it should
 * take effect on the next question rather than on the next restart.
 */
export async function getModelProvider(): Promise<ModelProvider> {
  if (override) return override;

  const settings = await getSettings();
  if (!settings.modelAssistEnabled) return new NullModelProvider();

  return buildProvider(settings.modelProvider);
}

function buildProvider(name: ModelProviderName): ModelProvider {
  if (name === 'anthropic' && config.model.apiKey) {
    return new AnthropicModelProvider({ apiKey: config.model.apiKey, model: config.model.name });
  }
  if (name === 'openai' && config.model.openaiApiKey) {
    return new OpenAIModelProvider({
      apiKey: config.model.openaiApiKey,
      model: config.model.openaiModel,
      baseUrl: config.model.openaiBaseUrl,
    });
  }
  return new NullModelProvider();
}

/**
 * The provider for GENUINE REASONING WORK, or a clear refusal (Sprint 3.3 s10).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE FUNCTION FROM `getModelProvider`
 *
 * The two callers want opposite things from a missing provider.
 *
 *   * `getModelProvider` serves model ASSISTANCE - improving the phrasing of an
 *     answer the deterministic layer already grounded. If no model exists, the
 *     deterministic answer stands. Degrading silently is correct there, and has
 *     been since Sprint 3.
 *
 *   * `requireReasoningProvider` serves RESEARCH. There is no deterministic
 *     fallback for "go and find out what is true". A null provider would return
 *     nothing, the run would complete, and the morning report would say Mac
 *     investigated the question and produced no findings - a false statement
 *     about work that never happened, and the sort of false statement somebody
 *     then acts on.
 *
 * So this one throws, with a code an operator can act on rather than a stack
 * trace. `scripted` counts as real: it returns what it was told to, and that is
 * a genuine answer from the caller's point of view - which is what keeps
 * research testable without a network or a credential.
 * ---------------------------------------------------------------------------
 */
export async function requireReasoningProvider(context: string): Promise<ModelProvider> {
  const provider = override ?? buildProvider((await getSettings()).modelProvider);

  const availability = await provider.isAvailable();
  if (!isRealModelProvider(provider.name) || !availability.available) {
    throw new AppError(
      503,
      MODEL_PROVIDER_REQUIRED,
      `${context} needs a reasoning model and none is configured. ` +
        (availability.reason ?? 'Set a model provider in settings and supply its API key.') +
        ' Mac will not run general work against a null provider: an empty result is indistinguishable, ' +
        'in a report, from an investigation that genuinely found nothing.',
    );
  }
  return provider;
}

/** Whether general work could run right now. Used by eligibility and the UI. */
export async function reasoningProviderAvailable(): Promise<boolean> {
  try {
    await requireReasoningProvider('probe');
    return true;
  } catch {
    return false;
  }
}
