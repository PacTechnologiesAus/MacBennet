import type { MondayBoard, MondayItem } from '@mac/protocol';

/**
 * The monday.com client interface (Sprint 3 §5.2).
 *
 * ---------------------------------------------------------------------------
 * WHAT IS ABSENT IS THE POINT
 *
 * Spec §17 says Mac must not autonomously alter commercial priorities,
 * deadlines or customer commitments. The Sprint 3 brief adds: no deleting
 * items, no deleting boards, no modifying unrelated users, no restructuring
 * boards.
 *
 * None of those is a rule enforced somewhere below. There is no `setDueDate`,
 * no `setPriority`, no `deleteItem`, no `deleteBoard`, no `createBoard`, no
 * `moveItem`, no `updateUser`, and — deliberately — no generic
 * `changeColumnValue` through which any of them could be reached. They are
 * capabilities that do not exist.
 *
 * A future administrative task that genuinely needs one adds a method here,
 * which is a reviewable code change rather than a configuration toggle. That is
 * the same property the job allowlist has, for the same reason.
 * ---------------------------------------------------------------------------
 */

export interface MondayClient {
  readonly name: 'graphql' | 'fake';

  isAvailable(): Promise<{ available: boolean; reason?: string }>;

  // --- Reads ---------------------------------------------------------------

  getBoard(boardId: string): Promise<MondayBoard | null>;
  listItems(boardId: string, options?: { groupIds?: string[]; limit?: number }): Promise<MondayItem[]>;
  getItem(itemId: string): Promise<MondayItem | null>;
  /** Free-text updates on an item — a source class for investigation (§6). */
  listUpdates(itemId: string, limit?: number): Promise<Array<{ id: string; body: string; createdAt: string }>>;

  // --- Writes: exactly five, and no more -----------------------------------

  /** Assigns the item to Mac's own monday identity. Never to anyone else. */
  assignToMac(input: { itemId: string; boardId: string; columnId: string; macUserId: string }): Promise<void>;
  setStatus(input: { itemId: string; boardId: string; columnId: string; label: string }): Promise<void>;
  postUpdate(input: { itemId: string; body: string }): Promise<{ updateId: string | null }>;
  setPullRequestLink(input: {
    itemId: string;
    boardId: string;
    columnId: string;
    url: string;
    title: string;
  }): Promise<void>;
}

/** Raised when the provider refuses or fails. Retryable unless stated. */
export class MondayApiError extends Error {
  override readonly name = 'MondayApiError';
  constructor(
    message: string,
    readonly retryable: boolean = true,
    readonly status?: number,
  ) {
    super(message);
  }
}
