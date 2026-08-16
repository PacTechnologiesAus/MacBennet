import type { MondayBoard, MondayItem } from '@mac/protocol';
import { mondayItemSchema } from '@mac/protocol';
import { MondayApiError, type MondayClient } from './client.js';

/**
 * An in-memory monday.com (Sprint 3 §5.2).
 *
 * Used by the entire standard suite. Not a mock in the "records calls and
 * returns undefined" sense — it holds real state and applies real writes, so a
 * test can set a status and then read it back, and a scheduling test can watch
 * an item become ineligible because Mac moved it.
 *
 * It also injects failures on demand, because the outbox's retry behaviour is
 * one of the things that has to be tested and cannot be tested against a
 * provider that always works.
 */
export class FakeMondayClient implements MondayClient {
  readonly name = 'fake' as const;

  private readonly boards = new Map<string, MondayBoard>();
  private readonly items = new Map<string, MondayItem>();
  private readonly updates = new Map<string, Array<{ id: string; body: string; createdAt: string }>>();

  /** Every write, in order. The assertion surface for "what did Mac do?". */
  readonly writes: Array<{ kind: string; itemId: string; detail: Record<string, unknown> }> = [];

  /** Fails the next N write calls, so retry and dead-lettering are testable. */
  failNextWrites = 0;
  /** When set, failures are permanent rather than retryable. */
  failPermanently = false;
  available = true;
  unavailableReason: string | undefined;

  addBoard(board: MondayBoard): void {
    this.boards.set(board.id, board);
  }

  addItem(item: Partial<MondayItem> & { id: string; boardId: string; name: string }): MondayItem {
    const parsed = mondayItemSchema.parse({ ...item });
    this.items.set(parsed.id, parsed);
    return parsed;
  }

  addUpdate(itemId: string, body: string): void {
    const list = this.updates.get(itemId) ?? [];
    list.push({ id: `u${list.length + 1}`, body, createdAt: new Date().toISOString() });
    this.updates.set(itemId, list);
  }

  snapshot(itemId: string): MondayItem | null {
    return this.items.get(itemId) ?? null;
  }

  async isAvailable(): Promise<{ available: boolean; reason?: string }> {
    return this.available
      ? { available: true }
      : { available: false, ...(this.unavailableReason ? { reason: this.unavailableReason } : {}) };
  }

  async getBoard(boardId: string): Promise<MondayBoard | null> {
    this.assertReadable();
    return this.boards.get(boardId) ?? null;
  }

  async listItems(boardId: string, options: { groupIds?: string[]; limit?: number } = {}): Promise<MondayItem[]> {
    this.assertReadable();
    const all = [...this.items.values()].filter((i) => i.boardId === boardId);
    const scoped = options.groupIds?.length
      ? all.filter((i) => i.groupId !== null && options.groupIds!.includes(i.groupId))
      : all;
    return scoped.slice(0, options.limit ?? 200);
  }

  async getItem(itemId: string): Promise<MondayItem | null> {
    this.assertReadable();
    return this.items.get(itemId) ?? null;
  }

  async listUpdates(itemId: string, limit = 20): Promise<Array<{ id: string; body: string; createdAt: string }>> {
    this.assertReadable();
    return (this.updates.get(itemId) ?? []).slice(-limit);
  }

  async assignToMac(input: { itemId: string; boardId: string; columnId: string; macUserId: string }): Promise<void> {
    this.write('assign_to_mac', input.itemId, { columnId: input.columnId, macUserId: input.macUserId });
    const item = this.require(input.itemId);
    this.items.set(item.id, { ...item, assigneeIds: [input.macUserId] });
  }

  async setStatus(input: { itemId: string; boardId: string; columnId: string; label: string }): Promise<void> {
    this.write('set_status', input.itemId, { columnId: input.columnId, label: input.label });
    const item = this.require(input.itemId);
    this.items.set(item.id, { ...item, status: input.label });
  }

  async postUpdate(input: { itemId: string; body: string }): Promise<{ updateId: string | null }> {
    this.write('post_update', input.itemId, { body: input.body });
    this.addUpdate(input.itemId, input.body);
    const list = this.updates.get(input.itemId)!;
    return { updateId: list[list.length - 1]!.id };
  }

  async setPullRequestLink(input: {
    itemId: string;
    boardId: string;
    columnId: string;
    url: string;
    title: string;
  }): Promise<void> {
    this.write('attach_pull_request', input.itemId, { columnId: input.columnId, url: input.url, title: input.title });
    const item = this.require(input.itemId);
    this.items.set(item.id, {
      ...item,
      columns: [
        ...item.columns.filter((c) => c.id !== input.columnId),
        { id: input.columnId, type: 'link', text: input.url },
      ],
    });
  }

  // -------------------------------------------------------------------------

  private assertReadable(): void {
    if (!this.available) {
      throw new MondayApiError(this.unavailableReason ?? 'The fake monday.com provider is unavailable.', true);
    }
  }

  private write(kind: string, itemId: string, detail: Record<string, unknown>): void {
    this.assertReadable();
    if (this.failNextWrites > 0) {
      this.failNextWrites -= 1;
      throw new MondayApiError(
        this.failPermanently ? 'Permanently rejected by the fake provider.' : 'Transient failure from the fake provider.',
        !this.failPermanently,
      );
    }
    this.writes.push({ kind, itemId, detail });
  }

  private require(itemId: string): MondayItem {
    const item = this.items.get(itemId);
    if (!item) throw new MondayApiError(`No such item: ${itemId}`, false, 404);
    return item;
  }
}
