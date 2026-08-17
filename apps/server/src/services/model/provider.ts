import type {
  ModelCompletionRequest,
  ModelCompletionResult,
  ModelProvider,
  ModelProviderName,
} from '@mac/protocol';
import { config } from '../../config.js';
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

  async complete(request: ModelCompletionRequest): Promise<ModelCompletionResult> {
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 60_000);

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

  const name: ModelProviderName = settings.modelProvider;
  if (name === 'anthropic' && config.model.apiKey) {
    return new AnthropicModelProvider({ apiKey: config.model.apiKey, model: config.model.name });
  }
  return new NullModelProvider();
}
