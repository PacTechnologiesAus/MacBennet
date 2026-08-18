#!/usr/bin/env node
/**
 * A fake Claude Code CLI.
 *
 * It speaks the same newline-delimited stream-json the real CLI emits — the
 * shapes were taken from real output captured from Claude Code 2.1.233 — so the
 * adapter can be tested against every event type, including the awkward ones
 * (malformed lines, non-JSON noise, a process that dies mid-session) without
 * spending a single token.
 *
 * The scenario is chosen by FAKE_CLAUDE_SCENARIO. Everything else about the
 * invocation — argv, cwd, stdin protocol — is exactly what the real adapter
 * sends, so a change to the adapter's contract breaks these tests.
 */

const scenario = process.env.FAKE_CLAUDE_SCENARIO ?? 'success';
const sessionId = '11111111-2222-3333-4444-555555555555';

const emit = (object) => process.stdout.write(`${JSON.stringify(object)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

if (process.argv.includes('--version')) {
  process.stdout.write('2.1.233 (Claude Code)\n');
  process.exit(0);
}

if (process.argv[2] === 'auth' && process.argv[3] === 'status') {
  process.stdout.write(
    JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' }) + '\n',
  );
  process.exit(0);
}

// Collect answers arriving on stdin, exactly as the adapter delivers them.
const answers = [];
let stdinBuffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  stdinBuffer += chunk;
  let index = stdinBuffer.indexOf('\n');
  while (index !== -1) {
    const line = stdinBuffer.slice(0, index).trim();
    stdinBuffer = stdinBuffer.slice(index + 1);
    if (line) {
      try {
        answers.push(JSON.parse(line));
      } catch {
        answers.push({ raw: line });
      }
    }
    index = stdinBuffer.indexOf('\n');
  }
});

const waitForAnswer = async (afterCount, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (answers.length <= afterCount && Date.now() < deadline) await sleep(20);
  return answers[afterCount];
};

const RESULT_USAGE = {
  usage: {
    input_tokens: 4,
    cache_creation_input_tokens: 27_042,
    cache_read_input_tokens: 85_882,
    output_tokens: 228,
    service_tier: 'standard',
  },
  total_cost_usd: 0.1914486,
  modelUsage: { 'claude-sonnet-5': { inputTokens: 4, outputTokens: 228, costUSD: 0.1914486 } },
};

async function main() {
  emit({ type: 'system', subtype: 'init', session_id: sessionId, cwd: process.cwd(), model: 'claude-sonnet-5', version: '2.1.233', tools: ['Read', 'Edit', 'Bash'] });

  // The real CLI emits plenty of noise that is not a session event. The adapter
  // must tolerate it rather than crash on it.
  process.stdout.write('some non-JSON warning from a plugin\n');
  process.stdout.write('{ this is not valid json\n');

  emit({
    type: 'rate_limit_event',
    rate_limit_info: { status: 'allowed', resetsAt: 1786904400, rateLimitType: 'five_hour', overageStatus: 'rejected' },
    session_id: sessionId,
  });

  if (scenario === 'crash') {
    // Dies without a result event, as a killed or OOM'd CLI would.
    process.exit(3);
  }

  emit({
    type: 'assistant',
    message: {
      model: 'claude-sonnet-5',
      role: 'assistant',
      content: [{ type: 'text', text: 'Reading the brief and the existing selector.' }],
    },
    session_id: sessionId,
  });

  emit({
    type: 'assistant',
    message: {
      model: 'claude-sonnet-5',
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/repo/src/DeviceSelector.tsx' } }],
    },
    session_id: sessionId,
  });

  emit({
    type: 'user',
    message: { role: 'user', content: [{ tool_use_id: 'toolu_1', type: 'tool_result', content: 'file contents' }] },
    session_id: sessionId,
  });

  if (scenario === 'question') {
    // A turn with no tool call whose text is a question — how the real CLI
    // surfaces a request for a decision.
    emit({
      type: 'assistant',
      message: {
        model: 'claude-sonnet-5',
        role: 'assistant',
        content: [{ type: 'text', text: 'Should the device list be sorted alphabetically when displayed?' }],
      },
      session_id: sessionId,
    });

    // Index 1, not 0: message 0 is the adapter's opening prompt carrying the
    // brief. The answer is the next thing to arrive on stdin.
    const answer = await waitForAnswer(1);
    const text = answer?.message?.content?.[0]?.text ?? '';

    emit({
      type: 'assistant',
      message: { model: 'claude-sonnet-5', role: 'assistant', content: [{ type: 'text', text: `Understood. Received: ${text.slice(0, 120)}` }] },
      session_id: sessionId,
    });
  }

  if (scenario === 'long') {
    // Long enough to be cancelled mid-flight.
    for (let i = 0; i < 200; i += 1) {
      emit({
        type: 'assistant',
        message: { model: 'claude-sonnet-5', role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Edit', input: { file_path: `/repo/file-${i}.ts` } }] },
        session_id: sessionId,
      });
      await sleep(100);
    }
  }

  emit({
    type: 'assistant',
    message: {
      model: 'claude-sonnet-5',
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'toolu_2', name: 'Edit', input: { file_path: '/repo/src/DeviceSelector.tsx' } }],
    },
    session_id: sessionId,
  });

  if (scenario === 'failure') {
    emit({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      session_id: sessionId,
      result: 'The model could not complete the task: the repository is in a conflicted state.',
      ...RESULT_USAGE,
    });
    process.exit(1);
  }

  if (scenario === 'provider-500') {
    emit({
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      session_id: sessionId,
      result: 'API Error: 500 Internal server error. This is a server-side issue, usually temporary.',
      ...RESULT_USAGE,
    });
    process.exit(1);
  }

  if (scenario === 'result-question') {
    const question =
      'I have inspected the repository and I need one decision from you before editing.\n\n' +
      '## The question\n\nDoes the external system round each line or only the final total?';
    emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: sessionId,
      result: question,
      ...RESULT_USAGE,
    });

    // Index 1: the opening brief is message 0; Mac's decision is message 1.
    const answer = await waitForAnswer(1);
    const text = answer?.message?.content?.[0]?.text ?? '';
    emit({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: sessionId,
      result: `Stopped without changing the money rule. Received: ${text.slice(0, 160)}`,
      ...RESULT_USAGE,
    });
    process.exit(0);
  }

  emit({
    type: 'result',
    subtype: 'success',
    is_error: false,
    session_id: sessionId,
    num_turns: 4,
    duration_ms: 5755,
    result: 'Added multi-device selection to DeviceSelector and the devices route, with a reducer test.',
    ...RESULT_USAGE,
  });

  process.exit(0);
}

main().catch((err) => {
  process.stderr.write(`fake-claude failed: ${err.message}\n`);
  process.exit(2);
});
