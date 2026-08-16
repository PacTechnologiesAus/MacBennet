import { describe, expect, it, vi } from 'vitest';
import { MAX_LOG_MESSAGE_CHARS } from '@mac/protocol';
import { LogBuffer } from '../src/log-buffer.js';

describe('LogBuffer', () => {
  it('assigns a monotonic sequence, which is what makes retries idempotent', () => {
    const buffer = new LogBuffer();
    buffer.append('one');
    buffer.append('two');
    buffer.append('three');

    expect(buffer.peekBatch().map((e) => e.seq)).toEqual([0, 1, 2]);
    expect(buffer.highestSeq).toBe(2);
  });

  it('splits a multi-line message into separate entries', () => {
    const buffer = new LogBuffer();
    buffer.append('line one\nline two\nline three');
    expect(buffer.peekBatch().map((e) => e.message)).toEqual(['line one', 'line two', 'line three']);
  });

  it('truncates an oversized line rather than letting it be rejected wholesale', () => {
    const buffer = new LogBuffer();
    buffer.append('x'.repeat(MAX_LOG_MESSAGE_CHARS + 5000));

    const [entry] = buffer.peekBatch();
    expect(entry!.message.length).toBeLessThanOrEqual(MAX_LOG_MESSAGE_CHARS);
    expect(entry!.message).toContain('[truncated]');
  });

  it('keeps entries until they are explicitly confirmed', () => {
    const buffer = new LogBuffer();
    buffer.append('a');
    buffer.append('b');

    // Peeking must not consume: an unconfirmed batch has to survive a failed
    // upload, or a network blip silently loses the operator's log.
    expect(buffer.peekBatch()).toHaveLength(2);
    expect(buffer.pendingCount).toBe(2);

    buffer.confirm(2);
    expect(buffer.pendingCount).toBe(0);
  });

  it('drops the oldest lines when full and says so, rather than truncating silently', () => {
    const buffer = new LogBuffer(3, 100);
    for (const message of ['1', '2', '3', '4', '5']) buffer.append(message);

    const batch = buffer.peekBatch();
    const messages = batch.map((e) => e.message);

    expect(messages).toContain('4');
    expect(messages).toContain('5');
    expect(messages).not.toContain('1');
    // A short log with no explanation is worse than one that admits the gap.
    expect(messages.some((m) => m.includes('log line(s) dropped'))).toBe(true);
  });

  it('reports the drop marker only once per overflow episode', () => {
    const buffer = new LogBuffer(2, 100);
    for (const message of ['1', '2', '3', '4']) buffer.append(message);

    const first = buffer.peekBatch().filter((e) => e.message.includes('dropped'));
    expect(first).toHaveLength(1);

    buffer.confirm(buffer.pendingCount);
    buffer.append('later');
    expect(buffer.peekBatch().filter((e) => e.message.includes('dropped'))).toHaveLength(0);
  });

  it('respects the batch size so one flush cannot exceed the server limit', () => {
    const buffer = new LogBuffer(1000, 5);
    for (let i = 0; i < 20; i += 1) buffer.append(`line ${i}`);
    expect(buffer.peekBatch()).toHaveLength(5);
  });

  it('flushes in batches until empty', async () => {
    const buffer = new LogBuffer(1000, 5);
    for (let i = 0; i < 12; i += 1) buffer.append(`line ${i}`);

    const send = vi.fn().mockResolvedValue(undefined);
    const result = await buffer.flush(send);

    expect(send).toHaveBeenCalledTimes(3); // 5 + 5 + 2
    expect(result.sent).toBe(12);
    expect(result.remaining).toBe(0);
  });

  it('retains everything when the upload fails, so nothing is lost', async () => {
    const buffer = new LogBuffer();
    buffer.append('important output');

    const send = vi.fn().mockRejectedValue(new Error('network down'));
    await expect(buffer.flush(send)).rejects.toThrow('network down');

    expect(buffer.pendingCount).toBe(1);
    expect(buffer.peekBatch()[0]!.message).toBe('important output');
  });

  it('re-sends the identical sequence numbers after a failure', async () => {
    const buffer = new LogBuffer();
    buffer.append('a');
    buffer.append('b');

    const failing = vi.fn().mockRejectedValue(new Error('nope'));
    await buffer.flush(failing).catch(() => undefined);

    const succeeding = vi.fn().mockResolvedValue(undefined);
    await buffer.flush(succeeding);

    // Same seq values as the first attempt — which is precisely why the server
    // can deduplicate on (run_id, seq) instead of double-writing the log.
    expect(succeeding.mock.calls[0]![0].map((e: { seq: number }) => e.seq)).toEqual([0, 1]);
  });
});
