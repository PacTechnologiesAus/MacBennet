import { z } from 'zod';

/**
 * monday.com (Sprint 3 §5, spec §17).
 *
 * monday.com is the *visible* source of truth for engineering work in progress.
 * It is not Mac's source of truth for his own lifecycle: a status change on a
 * board does not start, approve or stop a run. What Mac writes there is a
 * projection of state he already owns and has already audited.
 *
 * The shape of this file encodes spec §17's prohibitions. Mac must not alter
 * commercial priorities, deadlines or customer commitments — so there is no
 * `setDueDate`, no `setPriority`, no `deleteItem`, no `createBoard`, and no
 * generic `changeColumnValue` through which any of them could be expressed.
 * Those are not rules the code has to remember; they are capabilities that do
 * not exist.
 */

// ---------------------------------------------------------------------------
// What Mac reads
// ---------------------------------------------------------------------------

export const mondayColumnValueSchema = z.object({
  id: z.string().max(120),
  type: z.string().max(60),
  text: z.string().max(4000).nullable().default(null),
  value: z.unknown().optional(),
});
export type MondayColumnValue = z.infer<typeof mondayColumnValueSchema>;

export const mondayItemSchema = z.object({
  id: z.string().min(1).max(60),
  boardId: z.string().min(1).max(60),
  groupId: z.string().max(120).nullable().default(null),
  name: z.string().max(500),
  url: z.string().max(1000).nullable().default(null),
  state: z.string().max(40).nullable().default(null),
  /** Raw label text, e.g. "Working on it". Mapped to meaning by the board row. */
  status: z.string().max(200).nullable().default(null),
  priority: z.string().max(200).nullable().default(null),
  /** monday user ids currently assigned. Empty means unassigned. */
  assigneeIds: z.array(z.string().max(60)).max(50).default([]),
  dueDate: z.string().max(40).nullable().default(null),
  description: z.string().max(20_000).nullable().default(null),
  /** Item ids this one depends on, from the board's dependency column. */
  dependsOn: z.array(z.string().max(60)).max(50).default([]),
  /** True when the board requires an explicit per-item night-shift flag and it is set. */
  nightShiftFlag: z.boolean().default(false),
  /** Free-text size/type columns, used by effort estimation and the type allowlist. */
  itemType: z.string().max(120).nullable().default(null),
  sizeLabel: z.string().max(120).nullable().default(null),
  updatedAt: z.string().nullable().default(null),
  columns: z.array(mondayColumnValueSchema).max(120).default([]),
});
export type MondayItem = z.infer<typeof mondayItemSchema>;

export const mondayBoardSchema = z.object({
  id: z.string().min(1).max(60),
  name: z.string().max(300),
  groups: z.array(z.object({ id: z.string().max(120), title: z.string().max(300) })).max(200).default([]),
  columns: z
    .array(z.object({ id: z.string().max(120), title: z.string().max(300), type: z.string().max(60) }))
    .max(300)
    .default([]),
});
export type MondayBoard = z.infer<typeof mondayBoardSchema>;

// ---------------------------------------------------------------------------
// What Mac writes
// ---------------------------------------------------------------------------

/**
 * The complete set of writes Mac can perform.
 *
 * A closed enum for the same reason `JOB_KINDS` is: adding one is a visible,
 * reviewable code change rather than a configuration toggle, and the outbox can
 * be exhaustively switched over it.
 */
export const MONDAY_WRITE_KINDS = [
  'assign_to_mac',
  'set_status',
  'post_update',
  'post_blocker',
  'attach_pull_request',
] as const;
export const mondayWriteKindSchema = z.enum(MONDAY_WRITE_KINDS);
export type MondayWriteKind = z.infer<typeof mondayWriteKindSchema>;

/**
 * Which of Mac's states a status write means.
 *
 * Mac speaks in his own vocabulary and the board row translates it into that
 * board's labels. Otherwise every call site would have to know what a
 * particular customer's board calls "in progress", and one of them would get it
 * wrong.
 */
export const MONDAY_STATUS_INTENTS = ['in_progress', 'blocked', 'ready_for_review', 'done'] as const;
export const mondayStatusIntentSchema = z.enum(MONDAY_STATUS_INTENTS);
export type MondayStatusIntent = z.infer<typeof mondayStatusIntentSchema>;

export const MONDAY_WRITE_STATUSES = ['pending', 'sending', 'delivered', 'failed', 'refused', 'dead'] as const;
export const mondayWriteStatusSchema = z.enum(MONDAY_WRITE_STATUSES);
export type MondayWriteStatus = z.infer<typeof mondayWriteStatusSchema>;

/**
 * Columns Mac may write to.
 *
 * The guard checks a resolved column id against exactly these three roles on
 * the board row. The due-date and priority column ids are stored precisely so
 * that a write aimed at them can be RECOGNISED and refused, rather than merely
 * being absent from the allowlist by luck.
 */
export const MONDAY_WRITABLE_COLUMN_ROLES = ['status', 'assignee', 'pull_request'] as const;
export const mondayWritableColumnRoleSchema = z.enum(MONDAY_WRITABLE_COLUMN_ROLES);
export type MondayWritableColumnRole = z.infer<typeof mondayWritableColumnRoleSchema>;

export const MONDAY_PROHIBITED_COLUMN_ROLES = ['priority', 'due_date'] as const;

/** The default label vocabulary, matching monday.com's own out-of-the-box board. */
export const DEFAULT_MONDAY_STATUS_LABELS: Record<MondayStatusIntent, string> = {
  in_progress: 'Working on it',
  blocked: 'Stuck',
  ready_for_review: 'Awaiting Testing',
  done: 'Done',
};

export const mondayStatusLabelsSchema = z.object({
  in_progress: z.string().min(1).max(200),
  blocked: z.string().min(1).max(200),
  ready_for_review: z.string().min(1).max(200),
  done: z.string().min(1).max(200),
});
export type MondayStatusLabels = z.infer<typeof mondayStatusLabelsSchema>;

/**
 * How monday.com priority text maps onto a sortable rank.
 *
 * Lower sorts first, matching `PRIORITY_RANK`. Unrecognised text sorts after
 * everything recognised rather than before it: an unknown priority must never
 * jump the queue.
 */
export const MONDAY_PRIORITY_RANK: Record<string, number> = {
  critical: 0,
  urgent: 0,
  highest: 0,
  high: 1,
  medium: 2,
  normal: 2,
  low: 3,
  lowest: 4,
};
export const MONDAY_PRIORITY_RANK_UNKNOWN = 5;

export function mondayPriorityRank(label: string | null | undefined): number {
  if (!label) return MONDAY_PRIORITY_RANK_UNKNOWN;
  const key = label.trim().toLowerCase();
  return MONDAY_PRIORITY_RANK[key] ?? MONDAY_PRIORITY_RANK_UNKNOWN;
}
