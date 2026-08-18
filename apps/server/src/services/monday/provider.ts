import type { MondayBoardRow } from '../../db/schema.js';
import { config } from '../../config.js';
import type { MondayClient } from './client.js';
import { FakeMondayClient } from './fake.js';
import { MondayGraphqlClient } from './graphql.js';

/**
 * Which monday.com client the control plane uses (Sprint 3 §25).
 *
 * Resolved once and cached, because the real client holds a token and a column
 * map and there is no reason to rebuild it per request.
 *
 * The fake is not a testing-only convenience — it is the default. A deployment
 * with no monday.com token gets an inert provider rather than a crash, so
 * everything else in the night shift still works and the UI can say the
 * integration is not configured.
 */

let override: MondayClient | null = null;
let cached: MondayClient | null = null;

/** Test seam. Also used to swap in a fake for a dry run. */
export function setMondayClient(client: MondayClient | null): void {
  override = client;
  cached = null;
}

export async function getMondayClient(): Promise<MondayClient> {
  if (override) return override;
  if (cached) return cached;

  cached = config.monday.token
    ? new MondayGraphqlClient({ token: config.monday.token })
    : new FakeMondayClient();
  return cached;
}

/**
 * A client that knows how to read THIS board's columns.
 *
 * The GraphQL client needs the column map to turn raw column values into Mac's
 * vocabulary; the fake already stores items in that vocabulary and ignores it.
 * Doing this per board rather than globally is what allows two projects to use
 * boards with completely different column layouts.
 */
export async function clientForBoard(board: MondayBoardRow): Promise<MondayClient> {
  const client = await getMondayClient();
  if (!(client instanceof MondayGraphqlClient)) return client;

  return client.withColumnMap({
    status: board.statusColumnId,
    priority: board.priorityColumnId,
    assignee: board.assigneeColumnId,
    dueDate: board.dueDateColumnId,
    dependency: board.dependencyColumnId,
    nightShiftFlag: board.nightShiftFlagColumnId,
    itemType: board.itemTypeColumnId,
    size: board.sizeColumnId,
  });
}

/** Mac's own monday identity, from configuration or from the board mapping. */
export function macUserIdFor(board: MondayBoardRow): string | null {
  return board.macUserId ?? config.monday.macUserId ?? null;
}
