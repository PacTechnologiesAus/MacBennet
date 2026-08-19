import { and, desc, eq, gte, inArray, sql } from 'drizzle-orm';
import { isDeliveringRunStatus, type MessageEvidence, type RunStatus } from '@mac/protocol';
import { db } from '../db/client.js';
import {
  approvalRequests,
  nightShifts,
  projects,
  runAcceptance,
  runArtefacts,
  runAssumptions,
  runBlockers,
  runs,
  tasks,
} from '../db/schema.js';
import { emptyMessageEvidence } from '@mac/protocol';
import { record, type Actor } from './audit.js';
import { contextRefFor } from './company-context/service.js';

/**
 * Answering "what did you do last night?" (Phase 4 Part G §26).
 *
 * ---------------------------------------------------------------------------
 * A MODEL MAY CLASSIFY THE QUESTION. IT MAY NEVER SUPPLY THE ANSWER.
 *
 * The brief: "Answers should come from authoritative task/run/audit data rather
 * than model invention."
 *
 * That is enforced by shape, not by instruction. Every function below takes
 * ROWS and returns a SENTENCE. There is no model client imported into this
 * file, no prompt, and no code path through which a plausible-sounding night
 * could be described. If the rows say nothing happened, the answer says nothing
 * happened.
 *
 * The failure this prevents is specific and it is the worst one available: a
 * fluent, confident, entirely invented account of a night's work, delivered to
 * somebody who has no reason to doubt it and no easy way to check. Mac
 * inventing a finding is caught by `classifyFindings`; Mac inventing a STATUS
 * would be caught by nothing, because status is what people check other things
 * against.
 *
 * "I do not have that recorded" is a complete answer, and it is the one this
 * module gives whenever the data does not support a better one.
 * ---------------------------------------------------------------------------
 */

export const STATUS_QUERY_KINDS = [
  'last_night',
  'blocking',
  'needs_approval',
  'working_on',
  'task_finished',
  'assumptions',
  'company_context',
  'overview',
] as const;
export type StatusQueryKind = (typeof STATUS_QUERY_KINDS)[number];

export interface StatusAnswer {
  kind: StatusQueryKind;
  text: string;
  /** What the answer was read from, so a reader can go and check it. */
  evidence: MessageEvidence;
}

// ---------------------------------------------------------------------------
// Which question is being asked
// ---------------------------------------------------------------------------

const QUERY_CUES: Array<{ kind: StatusQueryKind; patterns: RegExp[] }> = [
  {
    kind: 'last_night',
    patterns: [
      /\blast night\b/i,
      /\bovernight\b/i,
      /\bwhat (did|have) you (do|done|been doing)\b/i,
      /\bthis morning\b/i,
    ],
  },
  {
    kind: 'blocking',
    patterns: [/\bblock(ing|ed|er|ers)\b/i, /\bstuck\b/i, /\bwaiting on\b/i, /\bheld up\b/i],
  },
  {
    kind: 'needs_approval',
    patterns: [
      /\bneeds? (my |your )?(approval|sign[- ]?off)\b/i,
      /\bwaiting (on|for) (my |your )?(approval|decision)\b/i,
      /\bapprove\b.{0,20}\?/i,
      /\boutstanding approvals?\b/i,
    ],
  },
  {
    kind: 'working_on',
    patterns: [/\bworking on\b/i, /\bwhat are you (up to|doing)\b/i, /\bin progress\b/i, /\brunning (now|currently)\b/i],
  },
  {
    kind: 'task_finished',
    patterns: [/\bdid .{0,30}(finish|complete|run|work|land)\b/i, /\bis .{0,30}(done|finished|complete)\b/i],
  },
  {
    kind: 'assumptions',
    patterns: [/\bassumption/i, /\bwhat did you assume\b/i],
  },
  {
    kind: 'company_context',
    patterns: [/\bcompany context\b/i, /\bcontext (revision|version|sha)\b/i, /\bwhich (policy|handbook)\b/i],
  },
];

export function classifyStatusQuery(text: string): StatusQueryKind {
  const body = text ?? '';
  for (const cue of QUERY_CUES) {
    if (cue.patterns.some((pattern) => pattern.test(body))) return cue.kind;
  }
  return 'overview';
}

// ---------------------------------------------------------------------------
// Answering
// ---------------------------------------------------------------------------

export interface StatusQueryContext {
  /** Narrows the answer where the conversation is about one task. */
  taskId?: string | null;
  projectId?: string | null;
}

export async function answerStatusQuery(
  question: string,
  context: StatusQueryContext,
  actor: Actor,
): Promise<StatusAnswer> {
  const kind = classifyStatusQuery(question);
  const answer = await buildAnswer(kind, question, context);

  await db.transaction(async (tx) => {
    await record(tx, {
      actor,
      eventType: 'status.query_answered',
      context: { projectId: context.projectId ?? null, taskId: context.taskId ?? null },
      metadata: {
        kind,
        // The question's LENGTH and the answer's shape, not their text: Part I
        // §32 asks that high-volume audit rows not carry full message payloads.
        questionLength: question.length,
        runsCited: answer.evidence.runIds.length,
        artefactsCited: answer.evidence.artefactIds.length,
      },
    });
  });

  return answer;
}

async function buildAnswer(
  kind: StatusQueryKind,
  question: string,
  context: StatusQueryContext,
): Promise<StatusAnswer> {
  switch (kind) {
    case 'last_night':
      return lastNight(context);
    case 'blocking':
      return blocking(context);
    case 'needs_approval':
      return needsApproval(context);
    case 'working_on':
      return workingOn(context);
    case 'task_finished':
      return taskFinished(question, context);
    case 'assumptions':
      return assumptions(context);
    case 'company_context':
      return companyContext(context);
    case 'overview':
      return overview(context);
  }
}

const evidence = (over: Partial<MessageEvidence> = {}): MessageEvidence => ({ ...emptyMessageEvidence(), ...over });

/**
 * What happened on the most recent shift.
 *
 * Reads the shift row and the runs attached to it, rather than "runs since
 * midnight" — a shift that started at 22:00 and ended at 06:00 spans two dates,
 * and answering by calendar day would silently split it.
 */
async function lastNight(context: StatusQueryContext): Promise<StatusAnswer> {
  const [shift] = await db.select().from(nightShifts).orderBy(desc(nightShifts.startedAt)).limit(1);

  if (!shift) {
    return {
      kind: 'last_night',
      text: 'I have no night shift on record. Night shift may not have run yet on this deployment.',
      evidence: evidence(),
    };
  }

  const shiftRuns = await db
    .select({
      id: runs.id,
      status: runs.status,
      acceptanceState: runs.acceptanceState,
      summary: runs.summary,
      taskTitle: tasks.title,
      projectName: projects.name,
    })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(eq(runs.nightShiftId, shift.id))
    .orderBy(runs.createdAt);

  const artefacts = await db
    .select({ id: runArtefacts.id, title: runArtefacts.title })
    .from(runArtefacts)
    .where(inArray(runArtefacts.runId, shiftRuns.length ? shiftRuns.map((r) => r.id) : ['00000000-0000-0000-0000-000000000000']));

  const started = shift.startedAt.toISOString();
  const lines: string[] = [
    `The last shift started ${started} and is ${shift.status}.`,
  ];

  if (shiftRuns.length === 0) {
    lines.push('No runs were started. Nothing was eligible, or nothing was approved for autonomous work.');
    return { kind: 'last_night', text: lines.join(' '), evidence: evidence() };
  }

  const delivered = shiftRuns.filter((r) => isDeliveringRunStatus(r.status as RunStatus));
  const withGaps = shiftRuns.filter((r) => r.status === 'completed_with_gaps');
  const failed = shiftRuns.filter((r) => r.status === 'failed');

  lines.push(`${shiftRuns.length} run(s): ${delivered.length} delivered, ${failed.length} failed.`);
  if (withGaps.length) {
    // Named separately, because this is the whole point of the state existing:
    // "delivered" that quietly included "with required criteria unmet" would be
    // the misreport Phase 4 was built to stop.
    lines.push(`${withGaps.length} of those delivered with required acceptance criteria unmet.`);
  }

  for (const run of shiftRuns) {
    lines.push(`\n• ${run.projectName} — ${run.taskTitle}: ${run.status}${run.summary ? ` — ${run.summary}` : ''}`);
  }
  if (artefacts.length) {
    lines.push(`\nArtefacts produced: ${artefacts.map((a) => a.title).join('; ')}.`);
  }

  return {
    kind: 'last_night',
    text: lines.join(' ').trim(),
    evidence: evidence({ runIds: shiftRuns.map((r) => r.id), artefactIds: artefacts.map((a) => a.id) }),
  };
}

async function blocking(context: StatusQueryContext): Promise<StatusAnswer> {
  const conditions = [
    eq(runBlockers.resolved, false),
    context.taskId ? eq(runs.taskId, context.taskId) : undefined,
    context.projectId ? eq(tasks.projectId, context.projectId) : undefined,
  ].filter(Boolean);

  const rows = await db
    .select({
      id: runBlockers.id,
      description: runBlockers.description,
      runId: runBlockers.runId,
      taskTitle: tasks.title,
      projectName: projects.name,
      raisedAt: runBlockers.createdAt,
    })
    .from(runBlockers)
    .innerJoin(runs, eq(runs.id, runBlockers.runId))
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(...conditions))
    .orderBy(desc(runBlockers.createdAt))
    .limit(20);

  if (rows.length === 0) {
    return { kind: 'blocking', text: 'Nothing is blocked at the moment.', evidence: evidence() };
  }

  const lines = rows.map(
    (row) => `• ${row.projectName} — ${row.taskTitle}: ${row.description} (raised ${row.raisedAt.toISOString()})`,
  );

  return {
    kind: 'blocking',
    text: `${rows.length} open blocker(s):\n${lines.join('\n')}`,
    evidence: evidence({ runIds: rows.map((r) => r.runId) }),
  };
}

async function needsApproval(context: StatusQueryContext): Promise<StatusAnswer> {
  const rows = await db
    .select({
      code: approvalRequests.code,
      title: approvalRequests.title,
      risk: approvalRequests.risk,
      taskTitle: tasks.title,
      projectName: projects.name,
      requestedAt: approvalRequests.requestedAt,
    })
    .from(approvalRequests)
    .innerJoin(tasks, eq(tasks.id, approvalRequests.taskId))
    .innerJoin(projects, eq(projects.id, approvalRequests.projectId))
    .where(
      context.taskId
        ? and(eq(approvalRequests.state, 'pending'), eq(approvalRequests.taskId, context.taskId))
        : eq(approvalRequests.state, 'pending'),
    )
    .orderBy(desc(approvalRequests.requestedAt))
    .limit(20);

  if (rows.length === 0) {
    return { kind: 'needs_approval', text: 'Nothing is waiting on your approval.', evidence: evidence() };
  }

  const lines = rows.map(
    (row) => `• ${row.code} — ${row.title} (${row.projectName}, ${row.risk} risk, raised ${row.requestedAt.toISOString()})`,
  );

  return {
    kind: 'needs_approval',
    // The codes are the actionable part: replying with one is how a decision
    // binds, so an answer that omitted them would be advice you cannot act on.
    text: `${rows.length} approval(s) outstanding:\n${lines.join('\n')}\n\nReply with a code to decide one.`,
    evidence: evidence(),
  };
}

async function workingOn(context: StatusQueryContext): Promise<StatusAnswer> {
  const active: RunStatus[] = ['queued', 'running', 'blocked', 'self_review', 'ready_for_human_review'];

  const rows = await db
    .select({
      id: runs.id,
      status: runs.status,
      progressStage: runs.progressStage,
      progressPercent: runs.progressPercent,
      taskTitle: tasks.title,
      projectName: projects.name,
    })
    .from(runs)
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(
      context.projectId
        ? and(inArray(runs.status, active), eq(tasks.projectId, context.projectId))
        : inArray(runs.status, active),
    )
    .orderBy(desc(runs.updatedAt))
    .limit(20);

  if (rows.length === 0) {
    return { kind: 'working_on', text: 'Nothing is running at the moment.', evidence: evidence() };
  }

  const lines = rows.map(
    (row) =>
      `• ${row.projectName} — ${row.taskTitle}: ${row.status}` +
      `${row.progressStage ? ` (${row.progressStage}${row.progressPercent !== null ? `, ${row.progressPercent}%` : ''})` : ''}`,
  );

  return {
    kind: 'working_on',
    text: `${rows.length} run(s) in flight:\n${lines.join('\n')}`,
    evidence: evidence({ runIds: rows.map((r) => r.id) }),
  };
}

/**
 * "Did task Y finish?"
 *
 * Matches the question text against task titles rather than asking a model to
 * resolve the reference. A wrong match here would answer about the wrong work,
 * so ambiguity is reported rather than resolved — the same discipline the
 * approval binding uses, for the same reason.
 */
async function taskFinished(question: string, context: StatusQueryContext): Promise<StatusAnswer> {
  const terms = (question.match(/[A-Za-z0-9][A-Za-z0-9-]{2,}/g) ?? [])
    .map((t) => t.toLowerCase())
    .filter((t) => !['did', 'task', 'the', 'finish', 'complete', 'run', 'done', 'work', 'yet'].includes(t));

  if (context.taskId) {
    return describeTask(context.taskId);
  }
  if (terms.length === 0) {
    return {
      kind: 'task_finished',
      text: 'Which task do you mean? Name it or open it and ask there.',
      evidence: evidence(),
    };
  }

  const candidates = await db
    .select({ id: tasks.id, title: tasks.title })
    .from(tasks)
    .where(sql`lower(${tasks.title}) LIKE ANY (${sql.raw(`ARRAY[${terms.map((t) => `'%${t.replace(/'/g, "''")}%'`).join(',')}]`)})`)
    .limit(5);

  if (candidates.length === 0) {
    return { kind: 'task_finished', text: 'I have no task on record matching that.', evidence: evidence() };
  }
  if (candidates.length > 1) {
    return {
      kind: 'task_finished',
      text: `That could be any of: ${candidates.map((c) => c.title).join('; ')}. Which one?`,
      evidence: evidence(),
    };
  }

  return describeTask(candidates[0]!.id);
}

async function describeTask(taskId: string): Promise<StatusAnswer> {
  const [task] = await db
    .select({ title: tasks.title, status: tasks.status, projectName: projects.name })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(eq(tasks.id, taskId))
    .limit(1);
  if (!task) return { kind: 'task_finished', text: 'I have no such task on record.', evidence: evidence() };

  const taskRuns = await db
    .select({
      id: runs.id,
      status: runs.status,
      acceptanceState: runs.acceptanceState,
      summary: runs.summary,
      completedAt: runs.completedAt,
    })
    .from(runs)
    .where(eq(runs.taskId, taskId))
    .orderBy(desc(runs.createdAt))
    .limit(5);

  if (taskRuns.length === 0) {
    return {
      kind: 'task_finished',
      text: `"${task.title}" (${task.projectName}) is ${task.status} and has had no runs.`,
      evidence: evidence(),
    };
  }

  const latest = taskRuns[0]!;
  const gapNote =
    latest.acceptanceState === 'gaps'
      ? ' It delivered, but not everything the approved criteria required — see the acceptance section on the run.'
      : '';

  return {
    kind: 'task_finished',
    text:
      `"${task.title}" (${task.projectName}): the most recent run is ${latest.status}` +
      `${latest.completedAt ? `, finished ${latest.completedAt.toISOString()}` : ''}.` +
      `${latest.summary ? ` ${latest.summary}` : ''}${gapNote}`,
    evidence: evidence({ runIds: [latest.id] }),
  };
}

async function assumptions(context: StatusQueryContext): Promise<StatusAnswer> {
  const since = new Date(Date.now() - 7 * 24 * 3_600_000);

  const rows = await db
    .select({
      statement: runAssumptions.statement,
      confidence: runAssumptions.confidence,
      runId: runAssumptions.runId,
      taskTitle: tasks.title,
    })
    .from(runAssumptions)
    .innerJoin(runs, eq(runs.id, runAssumptions.runId))
    .innerJoin(tasks, eq(tasks.id, runs.taskId))
    .where(
      context.taskId
        ? and(eq(runs.taskId, context.taskId), gte(runAssumptions.createdAt, since))
        : gte(runAssumptions.createdAt, since),
    )
    .orderBy(runAssumptions.confidence)
    .limit(20);

  if (rows.length === 0) {
    return { kind: 'assumptions', text: 'I have not recorded any assumptions in the last week.', evidence: evidence() };
  }

  // Lowest confidence first: those are the ones spec §6 says to flag, and the
  // ones a human is most likely to want to overturn.
  const lines = rows.map(
    (row) => `• ${row.statement} (${Math.round(Number(row.confidence ?? 0) * 100)}% — ${row.taskTitle})`,
  );

  return {
    kind: 'assumptions',
    text: `${rows.length} assumption(s), least confident first:\n${lines.join('\n')}`,
    evidence: evidence({ runIds: Array.from(new Set(rows.map((r) => r.runId))) }),
  };
}

async function companyContext(context: StatusQueryContext): Promise<StatusAnswer> {
  if (context.taskId) {
    const [run] = await db
      .select({ id: runs.id, revisionId: runs.companyContextRevisionId })
      .from(runs)
      .where(eq(runs.taskId, context.taskId))
      .orderBy(desc(runs.createdAt))
      .limit(1);

    if (run?.revisionId) {
      const ref = await contextRefFor(run.revisionId);
      return {
        kind: 'company_context',
        text: ref
          ? `The most recent run on this task used PAC company context ${ref.shortSha} (context version ${ref.contextVersion}).`
          : 'The most recent run on this task recorded a context revision I can no longer resolve.',
        evidence: evidence({ runIds: [run.id] }),
      };
    }
  }

  const [recent] = await db
    .select({ id: runs.id, revisionId: runs.companyContextRevisionId })
    .from(runs)
    .where(sql`${runs.companyContextRevisionId} IS NOT NULL`)
    .orderBy(desc(runs.createdAt))
    .limit(1);

  if (!recent?.revisionId) {
    return {
      kind: 'company_context',
      text: 'No run on record is bound to a company-context revision. Company context may not be enabled here.',
      evidence: evidence(),
    };
  }

  const ref = await contextRefFor(recent.revisionId);
  return {
    kind: 'company_context',
    text: ref
      ? `The most recent run bound to company context used ${ref.shortSha} (context version ${ref.contextVersion}).`
      : 'The most recent run recorded a context revision I can no longer resolve.',
    evidence: evidence({ runIds: [recent.id] }),
  };
}

/** The catch-all: a short position statement built from counts. */
async function overview(context: StatusQueryContext): Promise<StatusAnswer> {
  const [active] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(runs)
    .where(inArray(runs.status, ['queued', 'running', 'blocked', 'self_review'] satisfies RunStatus[]));

  const [pendingApprovals] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(approvalRequests)
    .where(eq(approvalRequests.state, 'pending'));

  const [openBlockers] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(runBlockers)
    .where(eq(runBlockers.resolved, false));

  const [gapRuns] = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(runAcceptance)
    .where(eq(runAcceptance.state, 'gaps'));

  return {
    kind: 'overview',
    text: [
      `${Number(active?.count ?? 0)} run(s) in flight.`,
      `${Number(pendingApprovals?.count ?? 0)} approval(s) outstanding.`,
      `${Number(openBlockers?.count ?? 0)} open blocker(s).`,
      `${Number(gapRuns?.count ?? 0)} run(s) delivered with unmet acceptance criteria.`,
      'Ask about last night, blockers, approvals, or a specific task for detail.',
    ].join(' '),
    evidence: evidence(),
  };
}
