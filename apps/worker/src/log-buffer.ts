import type { LogEntry, LogStream } from '@mac/protocol';
import { MAX_LOG_BATCH_ENTRIES, MAX_LOG_MESSAGE_CHARS } from '@mac/protocol';

/**
 * Bounded, sequence-numbered log buffer with batched upload.
 *
 * Three properties matter here:
 *
 *  1. Bounded. A runaway job must not exhaust the worker's memory. On overflow
 *     the oldest lines are dropped and a marker is emitted, so truncation is
 *     visible in the operator's log rather than silent — a silently short log
 *     is worse than an explicitly truncated one.
 *
 *  2. Sequenced. Every line carries a monotonic per-run sequence, and the
 *     server upserts on (runId, seq). That is what makes re-sending a batch
 *     after a network failure idempotent instead of duplicating output.
 *
 *  3. Retained until acknowledged. A batch is only removed from the buffer once
 *     the server has confirmed it, so a failed upload is retried rather than
 *     lost.
 */

const DEFAULT_CAPACITY = 5000;

export interface FlushResult {
  sent: number;
  remaining: number;
}

export class LogBuffer {
  private readonly pending: LogEntry[] = [];
  private nextSeq = 0;
  private droppedSinceMarker = 0;

  constructor(
    private readonly capacity: number = DEFAULT_CAPACITY,
    private readonly batchSize: number = Math.min(200, MAX_LOG_BATCH_ENTRIES),
  ) {}

  get pendingCount(): number {
    return this.pending.length;
  }

  get highestSeq(): number {
    return this.nextSeq - 1;
  }

  append(message: string, stream: LogStream = 'stdout'): void {
    for (const line of String(message).split('\n')) {
      this.push(line, stream);
    }
  }

  private push(message: string, stream: LogStream): void {
    const clamped =
      message.length > MAX_LOG_MESSAGE_CHARS
        ? `${message.slice(0, MAX_LOG_MESSAGE_CHARS - 15)}… [truncated]`
        : message;

    this.pending.push({
      seq: this.nextSeq++,
      ts: new Date().toISOString(),
      stream,
      message: clamped,
    });

    while (this.pending.length > this.capacity) {
      this.pending.shift();
      this.droppedSinceMarker += 1;
    }
  }

  /** The next batch to send, without removing it — removal awaits confirmation. */
  peekBatch(): LogEntry[] {
    if (this.droppedSinceMarker > 0) {
      const dropped = this.droppedSinceMarker;
      this.droppedSinceMarker = 0;

      /*
       * The marker is placed at the FRONT, where the dropped lines were, and
       * deliberately bypasses the capacity check.
       *
       * Appending it through `push` instead would evict another real line to
       * make room, which increments the drop count again and emits a further
       * marker on the next peek — a small cascade that eats the log it is
       * supposed to be annotating. It still takes a real sequence number, so it
       * remains deduplicated on retry like any other line.
       */
      this.pending.unshift({
        seq: this.nextSeq++,
        ts: new Date().toISOString(),
        stream: 'system',
        message: `[${dropped} log line(s) dropped: worker buffer full]`,
      });
    }
    return this.pending.slice(0, this.batchSize);
  }

  /** Called only after the server confirms receipt. */
  confirm(count: number): void {
    this.pending.splice(0, count);
  }

  /**
   * Flushes everything, retrying until the buffer is empty or `send` throws.
   * Returns how many lines were accepted so the caller can log the outcome.
   */
  async flush(send: (entries: LogEntry[]) => Promise<unknown>): Promise<FlushResult> {
    let sent = 0;
    while (this.pending.length > 0) {
      const batch = this.peekBatch();
      if (batch.length === 0) break;
      await send(batch);
      this.confirm(batch.length);
      sent += batch.length;
    }
    return { sent, remaining: this.pending.length };
  }
}
