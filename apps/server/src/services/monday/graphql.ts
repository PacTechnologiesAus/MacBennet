import type { MondayBoard, MondayItem } from '@mac/protocol';
import { mondayItemSchema } from '@mac/protocol';
import { MondayApiError, type MondayClient } from './client.js';

/**
 * The real monday.com client (Sprint 3 §5.2).
 *
 * `fetch` only — no SDK, no new dependency, and no generated client whose
 * surface would quietly include the mutations this file deliberately does not
 * implement.
 *
 * The API token lives in the control plane's configuration and nowhere else: it
 * is never sent to the worker, never written to the database, and cannot appear
 * in a sandboxed agent's environment, which is built from empty.
 */

const API_URL = 'https://api.monday.com/v2';
/** Pinned, so a silent server-side version bump cannot change parsing. */
const API_VERSION = '2024-10';

export interface GraphqlClientOptions {
  token: string;
  apiUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

interface ColumnMap {
  dependency: string | null;
  nightShiftFlag: string | null;
  itemType: string | null;
  size: string | null;
  status: string | null;
  priority: string | null;
  assignee: string | null;
  dueDate: string | null;
}

export class MondayGraphqlClient implements MondayClient {
  readonly name = 'graphql' as const;

  /** How raw columns map onto Mac's vocabulary. Set per board before reading. */
  #columns: ColumnMap = {
    dependency: null,
    nightShiftFlag: null,
    itemType: null,
    size: null,
    status: null,
    priority: null,
    assignee: null,
    dueDate: null,
  };

  /**
   * `#` rather than a TypeScript parameter property, because this object holds
   * the API token. A `private readonly options` is an ordinary enumerable field
   * at runtime, so `(client as any).options.token` — or anything that
   * `JSON.stringify`s a client into a log line — would have handed it over.
   */
  readonly #options: GraphqlClientOptions;

  constructor(options: GraphqlClientOptions) {
    this.#options = options;
  }

  withColumnMap(map: Partial<ColumnMap>): MondayGraphqlClient {
    // `#` members are reachable across instances of the SAME class, which is
    // exactly the access this needs and no more.
    const clone = new MondayGraphqlClient(this.#options);
    clone.#columns = { ...this.#columns, ...map };
    return clone;
  }

  async isAvailable(): Promise<{ available: boolean; reason?: string }> {
    if (!this.#options.token) return { available: false, reason: 'No monday.com API token is configured.' };
    try {
      const data = await this.#query<{ me: { id: string; name: string } }>('query { me { id name } }');
      return data.me?.id ? { available: true } : { available: false, reason: 'The token did not resolve to a user.' };
    } catch (err) {
      return { available: false, reason: (err as Error).message };
    }
  }

  // --- Reads ---------------------------------------------------------------

  async getBoard(boardId: string): Promise<MondayBoard | null> {
    const data = await this.#query<{ boards: Array<RawBoard> }>(
      `query ($ids: [ID!]) {
         boards (ids: $ids) {
           id name
           groups { id title }
           columns { id title type }
         }
       }`,
      { ids: [boardId] },
    );

    const board = data.boards?.[0];
    if (!board) return null;
    return {
      id: String(board.id),
      name: board.name,
      groups: (board.groups ?? []).map((g) => ({ id: g.id, title: g.title })),
      columns: (board.columns ?? []).map((c) => ({ id: c.id, title: c.title, type: c.type })),
    };
  }

  async listItems(boardId: string, options: { groupIds?: string[]; limit?: number } = {}): Promise<MondayItem[]> {
    const data = await this.#query<{ boards: Array<{ items_page: { items: RawItem[] } }> }>(
      `query ($ids: [ID!], $limit: Int!) {
         boards (ids: $ids) {
           items_page (limit: $limit) {
             items {
               id name state updated_at url
               group { id }
               column_values { id type text value }
             }
           }
         }
       }`,
      { ids: [boardId], limit: Math.min(options.limit ?? 100, 500) },
    );

    const items = (data.boards?.[0]?.items_page?.items ?? []).map((raw) => this.#toItem(raw, boardId));
    if (!options.groupIds?.length) return items;
    return items.filter((i) => i.groupId !== null && options.groupIds!.includes(i.groupId));
  }

  async getItem(itemId: string): Promise<MondayItem | null> {
    const data = await this.#query<{ items: RawItem[] }>(
      `query ($ids: [ID!]) {
         items (ids: $ids) {
           id name state updated_at url
           board { id }
           group { id }
           column_values { id type text value }
         }
       }`,
      { ids: [itemId] },
    );

    const raw = data.items?.[0];
    return raw ? this.#toItem(raw, String(raw.board?.id ?? '')) : null;
  }

  async listUpdates(itemId: string, limit = 20): Promise<Array<{ id: string; body: string; createdAt: string }>> {
    const data = await this.#query<{ items: Array<{ updates: Array<{ id: string; text_body: string; created_at: string }> }> }>(
      `query ($ids: [ID!], $limit: Int!) {
         items (ids: $ids) { updates (limit: $limit) { id text_body created_at } }
       }`,
      { ids: [itemId], limit: Math.min(limit, 100) },
    );

    return (data.items?.[0]?.updates ?? []).map((u) => ({
      id: String(u.id),
      body: u.text_body ?? '',
      createdAt: u.created_at,
    }));
  }

  // --- Writes --------------------------------------------------------------

  async assignToMac(input: { itemId: string; boardId: string; columnId: string; macUserId: string }): Promise<void> {
    await this.#changeColumn(input.boardId, input.itemId, input.columnId, {
      personsAndTeams: [{ id: Number(input.macUserId), kind: 'person' }],
    });
  }

  async setStatus(input: { itemId: string; boardId: string; columnId: string; label: string }): Promise<void> {
    await this.#changeColumn(input.boardId, input.itemId, input.columnId, { label: input.label });
  }

  async postUpdate(input: { itemId: string; body: string }): Promise<{ updateId: string | null }> {
    const data = await this.#query<{ create_update: { id: string } }>(
      `mutation ($itemId: ID!, $body: String!) {
         create_update (item_id: $itemId, body: $body) { id }
       }`,
      { itemId: input.itemId, body: input.body },
    );
    return { updateId: data.create_update?.id ? String(data.create_update.id) : null };
  }

  async setPullRequestLink(input: {
    itemId: string;
    boardId: string;
    columnId: string;
    url: string;
    title: string;
  }): Promise<void> {
    await this.#changeColumn(input.boardId, input.itemId, input.columnId, { url: input.url, text: input.title });
  }

  /**
   * Deliberately PRIVATE — as an ECMAScript `#` field, not a TypeScript one.
   *
   * monday.com's API is one generic `change_column_value` mutation, which is
   * exactly the shape this integration must not expose: a public method taking
   * any column id and any value would make every prohibition in spec §17 a rule
   * somebody has to remember. The five public methods above are the whole
   * surface, and the guard checks the column id before any of them gets here.
   *
   * Sprint 3.1 commissioning found this written as `private async changeColumn`,
   * which TypeScript erases: the method sat on the prototype and
   * `(client as any).changeColumn(boardId, itemId, dueDateColumnId, …)` would
   * have moved a customer's deadline, past the guard, with no compile error at
   * the call site to argue about in review. `#` is enforced by the runtime — the
   * name is not on the prototype and there is no cast that reaches it — so
   * "the generic mutation is private" is now a property of the program rather
   * than a convention its authors agreed to keep.
   */
  async #changeColumn(
    boardId: string,
    itemId: string,
    columnId: string,
    value: Record<string, unknown>,
  ): Promise<void> {
    await this.#query(
      `mutation ($boardId: ID!, $itemId: ID!, $columnId: String!, $value: JSON!) {
         change_column_value (board_id: $boardId, item_id: $itemId, column_id: $columnId, value: $value) { id }
       }`,
      { boardId, itemId, columnId, value: JSON.stringify(value) },
    );
  }

  // -------------------------------------------------------------------------

  async #query<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
    const fetchImpl = this.#options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#options.timeoutMs ?? 30_000);

    try {
      const response = await fetchImpl(this.#options.apiUrl ?? API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: this.#options.token,
          'API-Version': API_VERSION,
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });

      const text = await response.text();
      if (!response.ok) {
        // 4xx is a rejection that will be rejected again; 429 and 5xx are worth
        // retrying. Getting this wrong means either a stuck outbox or a
        // hammered API.
        const retryable = response.status === 429 || response.status >= 500;
        throw new MondayApiError(
          this.#redact(`monday.com returned ${response.status}: ${text.slice(0, 500)}`),
          retryable,
          response.status,
        );
      }

      const parsed = JSON.parse(text) as { data?: T; errors?: Array<{ message: string }> };
      if (parsed.errors?.length) {
        // GraphQL errors arrive with HTTP 200, so this is the only place a
        // failed mutation can be noticed.
        throw new MondayApiError(this.#redact(parsed.errors.map((e) => e.message).join('; ').slice(0, 500)), false, 200);
      }
      if (!parsed.data) throw new MondayApiError('monday.com returned no data.', true);
      return parsed.data;
    } catch (err) {
      if (err instanceof MondayApiError) throw err;
      const message =
        (err as Error).name === 'AbortError' ? 'monday.com timed out.' : this.#redact((err as Error).message);
      throw new MondayApiError(message, true);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Provider responses and transport errors are untrusted and may echo the credential. */
  #redact(message: string): string {
    const token = this.#options.token;
    return token ? message.split(token).join('[REDACTED]') : message;
  }

  /** Maps a raw item onto Mac's vocabulary using the configured column map. */
  #toItem(raw: RawItem, boardId: string): MondayItem {
    const columns = (raw.column_values ?? []).map((c) => ({
      id: c.id,
      type: c.type ?? '',
      text: c.text ?? null,
      value: c.value ?? null,
    }));
    const byId = new Map(columns.map((c) => [c.id, c]));
    const textOf = (id: string | null): string | null => (id ? (byId.get(id)?.text ?? null) : null);

    const assigneeIds = this.#columns.assignee
      ? parsePersonIds(byId.get(this.#columns.assignee)?.value ?? null)
      : [];

    const dependsOn = this.#columns.dependency
      ? (textOf(this.#columns.dependency) ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : [];

    const flagText = textOf(this.#columns.nightShiftFlag);

    return mondayItemSchema.parse({
      id: String(raw.id),
      boardId,
      groupId: raw.group?.id ?? null,
      name: raw.name,
      url: raw.url ?? null,
      state: raw.state ?? null,
      status: textOf(this.#columns.status),
      priority: textOf(this.#columns.priority),
      assigneeIds,
      dueDate: textOf(this.#columns.dueDate),
      // The item body lives on updates, not on a column, so a description is
      // whatever a long-text column holds if one was mapped.
      description: null,
      dependsOn,
      nightShiftFlag: isAffirmative(flagText),
      itemType: textOf(this.#columns.itemType),
      sizeLabel: textOf(this.#columns.size),
      updatedAt: raw.updated_at ?? null,
      columns,
    });
  }
}

/**
 * Whether a flag column reads as "yes".
 *
 * Boards express this differently — a checkbox, a status label, a tag — so the
 * check is on the TEXT and is deliberately narrow: an unrecognised value is not
 * a flag. An item Mac takes overnight has to have been marked deliberately, and
 * "probably yes" is not deliberate.
 */
function isAffirmative(text: string | null): boolean {
  if (!text) return false;
  return ['v', 'yes', 'true', 'checked', 'night shift', 'night-shift', 'mac', 'ready for mac'].includes(
    text.trim().toLowerCase(),
  );
}

function parsePersonIds(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as { personsAndTeams?: Array<{ id: number | string; kind?: string }> };
    return (parsed.personsAndTeams ?? []).filter((p) => p.kind !== 'team').map((p) => String(p.id));
  } catch {
    return [];
  }
}

interface RawBoard {
  id: string | number;
  name: string;
  groups?: Array<{ id: string; title: string }>;
  columns?: Array<{ id: string; title: string; type: string }>;
}

interface RawItem {
  id: string | number;
  name: string;
  state?: string;
  updated_at?: string;
  url?: string;
  board?: { id: string | number };
  group?: { id: string };
  column_values?: Array<{ id: string; type?: string; text?: string | null; value?: string | null }>;
}
