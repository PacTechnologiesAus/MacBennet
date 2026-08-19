import { describe, expect, it } from 'vitest';
import { config } from '../../src/config.js';
import { AnthropicModelProvider, OpenAIModelProvider, buildProvider } from '../../src/services/model/provider.js';

/**
 * The timeout the factory hands to a real provider.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS TEST EXISTS
 *
 * The first real research run on the commissioned VM failed six times in a row
 * with `AbortError: This operation was aborted` inside
 * `AnthropicModelProvider.complete`. Nothing was wrong with the model, the key
 * or the prompt. `buildProvider()` constructed the provider without a
 * `timeoutMs` at all, so every call silently used the 60-second fallback — and
 * a step carrying a 9,855-character task description plus seven Company
 * documents, asked for up to 3,000 tokens, does not answer inside a minute.
 *
 * No existing test could have caught it. The whole suite runs against
 * ScriptedModelProvider, which answers instantly, so a one-minute ceiling and a
 * five-minute one are indistinguishable everywhere except against a real API.
 *
 * So this asserts the wiring rather than the behaviour: that the configured
 * value actually reaches the object. A test that only checked "a slow call
 * aborts eventually" would have passed happily while the bug was live.
 * ---------------------------------------------------------------------------
 */
describe('the model call timeout reaches the provider', () => {
  it('gives a constructed Anthropic provider the configured timeout, not the fallback', () => {
    const provider = buildProvider('anthropic');

    // Only meaningful when a key is configured; otherwise the factory correctly
    // returns the null provider and there is nothing to assert.
    if (!(provider instanceof AnthropicModelProvider)) {
      expect(config.model.apiKey).toBeFalsy();
      return;
    }

    expect(provider.timeoutMs).toBe(config.model.timeoutMs);
  });

  it('gives a constructed OpenAI provider the configured timeout', () => {
    const provider = buildProvider('openai');

    if (!(provider instanceof OpenAIModelProvider)) {
      expect(config.model.openaiApiKey).toBeFalsy();
      return;
    }

    expect(provider.timeoutMs).toBe(config.model.timeoutMs);
  });

  it('defaults to a ceiling a real research step can actually finish inside', () => {
    // 60s was the old hardcoded value and is the specific thing that broke.
    // This is deliberately a floor rather than an equality: raising the default
    // later is fine, silently returning to a minute is not.
    expect(config.model.timeoutMs).toBeGreaterThan(60_000);
  });

  it('still honours an explicitly supplied timeout, including a short one', () => {
    // Cancellation and per-call ceilings must remain expressible; the fix
    // changed where the value comes from, not whether it can be set.
    const fast = new AnthropicModelProvider({ apiKey: 'k', model: 'm', timeoutMs: 1_500 });
    expect(fast.timeoutMs).toBe(1_500);
  });

  it('falls back to 60s only when nothing is supplied at all', () => {
    // The fallback is not wrong in itself — it is the safety net for a direct
    // construction in a test. What was wrong was the factory relying on it.
    const bare = new AnthropicModelProvider({ apiKey: 'k', model: 'm' });
    expect(bare.timeoutMs).toBe(60_000);
  });
});
