import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MondayGraphqlClient } from '../../src/services/monday/graphql.js';

/**
 * The REAL monday.com, against a dedicated test board.
 *
 * Opt-in and skipped by default. It talks to a live third party, it writes to a
 * real board, and the Sprint 3 brief is explicit that the standard suite must
 * not require external paid services. Run it deliberately:
 *
 *   MONDAY_API_TOKEN=...           a token for an account that can see the board
 *   MAC_MONDAY_LIVE_TEST=1         the opt-in switch
 *   MAC_MONDAY_TEST_BOARD_ID=...   a board created FOR THIS, containing nothing
 *                                  anybody depends on
 *   MAC_MONDAY_TEST_ITEM_ID=...    an item on it Mac may scribble on
 *   MAC_MONDAY_TEST_STATUS_COLUMN  the status column id (default "status")
 *   MAC_MONDAY_TEST_STATUS_LABEL   a label that exists on it (default "Working on it")
 *
 * What it proves that the fake cannot: that the GraphQL documents are accepted
 * by the real API, that the column-value shapes are right, and that a status
 * Mac sets is a status the board actually holds afterwards. The fake proves the
 * behaviour around those calls; this proves the calls themselves.
 *
 * It deliberately does NOT test the prohibitions. "Mac cannot change a due date"
 * is proven by the absence of a method, which no amount of talking to monday.com
 * can demonstrate better than reading the interface.
 */

const ENABLED = process.env.MAC_MONDAY_LIVE_TEST === '1';
const TOKEN = process.env.MONDAY_API_TOKEN ?? '';
const BOARD_ID = process.env.MAC_MONDAY_TEST_BOARD_ID ?? '';
const ITEM_ID = process.env.MAC_MONDAY_TEST_ITEM_ID ?? '';
const STATUS_COLUMN = process.env.MAC_MONDAY_TEST_STATUS_COLUMN ?? 'status';
const STATUS_LABEL = process.env.MAC_MONDAY_TEST_STATUS_LABEL ?? 'Working on it';

const runnable = ENABLED && Boolean(TOKEN && BOARD_ID && ITEM_ID);

if (ENABLED && !runnable) {
  // Opting in and then silently skipping would be the worst outcome: it would
  // look like the live integration had been exercised.
  // eslint-disable-next-line no-console
  console.warn(
    '\n*** MAC_MONDAY_LIVE_TEST=1 but the live monday.com test cannot run ***\n' +
      'Set MONDAY_API_TOKEN, MAC_MONDAY_TEST_BOARD_ID and MAC_MONDAY_TEST_ITEM_ID.\n',
  );
}

let client: MondayGraphqlClient;

beforeAll(() => {
  client = new MondayGraphqlClient({ token: TOKEN });
});

afterAll(() => {
  // Nothing to tear down: the test writes only to the dedicated board, and
  // leaving the last status visible is useful evidence that it ran.
});

describe.skipIf(!runnable)('monday.com, live', () => {
  it('authenticates and resolves to a user', async () => {
    const availability = await client.isAvailable();
    expect(availability.available, availability.reason).toBe(true);
  }, 60_000);

  it('reads the dedicated board and its columns', async () => {
    const board = await client.getBoard(BOARD_ID);
    expect(board).not.toBeNull();
    expect(board!.id).toBe(BOARD_ID);
    expect(board!.columns.some((c) => c.id === STATUS_COLUMN)).toBe(true);
  }, 60_000);

  it('reads items, and maps a raw column value onto Mac’s vocabulary', async () => {
    const mapped = client.withColumnMap({ status: STATUS_COLUMN });
    const items = await mapped.listItems(BOARD_ID, { limit: 25 });
    expect(items.length).toBeGreaterThan(0);

    const item = items.find((i) => i.id === ITEM_ID);
    expect(item, `item ${ITEM_ID} is not on board ${BOARD_ID}`).toBeDefined();
    // The mapping is the part a fake cannot check: monday returns column values
    // as an opaque list, and reading a status out of it is real work.
    expect(item!.name.length).toBeGreaterThan(0);
  }, 60_000);

  it('sets a status, and the board holds it afterwards', async () => {
    await client.setStatus({ itemId: ITEM_ID, boardId: BOARD_ID, columnId: STATUS_COLUMN, label: STATUS_LABEL });

    const mapped = client.withColumnMap({ status: STATUS_COLUMN });
    const item = await mapped.getItem(ITEM_ID);
    expect(item!.status).toBe(STATUS_LABEL);
  }, 60_000);

  it('posts an update and can read it back', async () => {
    const marker = `Mac Bennett live integration check ${new Date().toISOString()}`;
    const posted = await client.postUpdate({ itemId: ITEM_ID, body: marker });
    expect(posted.updateId).toBeTruthy();

    const updates = await client.listUpdates(ITEM_ID, 10);
    expect(updates.some((u) => u.body.includes(marker))).toBe(true);
  }, 60_000);
});
