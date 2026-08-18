import type { MondayBoardRow } from '../../db/schema.js';

/**
 * The column write guard (Sprint 3 §5.2).
 *
 * The client interface already has no method that could change a due date or a
 * priority. This is the second, independent check: it validates the resolved
 * column id against the board's declared roles, so if a method were ever added
 * carelessly — or an id were passed from the wrong variable — the write is
 * still refused, by name, with an audit event.
 *
 * The board row stores `dueDateColumnId` and `priorityColumnId` precisely so
 * this function can RECOGNISE an attempt on a commercial field and say what it
 * refused, rather than emitting a generic "not on the allowlist" that tells a
 * reviewer nothing.
 */

export const MONDAY_WRITE_REFUSALS = [
  'column_is_due_date',
  'column_is_priority',
  'column_not_writable',
  'board_not_approved',
  'no_assignee_column',
  'no_pull_request_column',
  'no_mac_identity',
  'status_label_not_configured',
  'completion_not_permitted',
] as const;
export type MondayWriteRefusal = (typeof MONDAY_WRITE_REFUSALS)[number];

export class MondayWriteRefused extends Error {
  override readonly name = 'MondayWriteRefused';
  constructor(
    readonly refusal: MondayWriteRefusal,
    message: string,
    readonly columnId: string | null = null,
  ) {
    super(message);
  }
}

/**
 * May Mac write to this column on this board?
 *
 * Returns nothing and throws on refusal, because there is no useful "partial
 * write" outcome and a boolean return is the shape callers forget to check.
 */
export function assertColumnWritable(board: MondayBoardRow, columnId: string): void {
  if (!board.isApproved) {
    throw new MondayWriteRefused(
      'board_not_approved',
      `Board "${board.name}" is not approved, so Mac may not write to it.`,
      columnId,
    );
  }

  if (board.dueDateColumnId && columnId === board.dueDateColumnId) {
    throw new MondayWriteRefused(
      'column_is_due_date',
      'Refusing to write to the due-date column. Mac does not move deadlines: they are a commitment ' +
        'someone made to a customer, and changing one is not a technical decision.',
      columnId,
    );
  }

  if (board.priorityColumnId && columnId === board.priorityColumnId) {
    throw new MondayWriteRefused(
      'column_is_priority',
      'Refusing to write to the priority column. Commercial priority is a human judgement about what ' +
        'matters to the business, and Mac reads it rather than setting it.',
      columnId,
    );
  }

  const writable = [board.statusColumnId, board.assigneeColumnId, board.pullRequestColumnId].filter(
    (id): id is string => Boolean(id),
  );

  if (!writable.includes(columnId)) {
    throw new MondayWriteRefused(
      'column_not_writable',
      `Column "${columnId}" is not one of the three Mac may write to on this board ` +
        '(status, assignee, pull-request link).',
      columnId,
    );
  }
}

/** The board's own label for one of Mac's status intents. */
export function statusLabelFor(
  board: MondayBoardRow,
  intent: 'in_progress' | 'blocked' | 'ready_for_review' | 'done',
): string {
  const labels = (board.statusLabels ?? {}) as Partial<Record<string, string>>;
  const label = labels[intent];
  if (!label) {
    throw new MondayWriteRefused(
      'status_label_not_configured',
      `This board has no label configured for "${intent}", so Mac does not know what to set.`,
    );
  }

  /*
   * `done` is gated separately from every other intent.
   *
   * Spec §17 lets Mac "mark complete when appropriate"; the Sprint 3 brief
   * narrows that to "where the configured workflow permits". Off by default
   * means Ready for Review is Mac's terminal state until a human decides
   * otherwise, per board — which is the conservative reading, and the one that
   * keeps a person in the loop on the transition that closes work out.
   */
  if (intent === 'done' && !board.mayComplete) {
    throw new MondayWriteRefused(
      'completion_not_permitted',
      `Board "${board.name}" does not permit Mac to mark work complete. Ready for Review is his terminal state here.`,
    );
  }

  return label;
}
