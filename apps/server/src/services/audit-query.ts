import { and, desc, eq } from 'drizzle-orm';
import type { AuditEventDto, AuditQuery } from '@mac/protocol';
import { db } from '../db/client.js';
import { auditEvents } from '../db/schema.js';

/**
 * Read side of the audit trail. Kept separate from services/audit.ts so that
 * the write module exposes no query surface and the read module exposes no
 * write surface — a small thing, but it makes "append-only" obvious from the
 * shape of the code as well as from the database trigger.
 */
export async function queryAuditEvents(query: AuditQuery): Promise<AuditEventDto[]> {
  const conditions = [];
  if (query.projectId) conditions.push(eq(auditEvents.projectId, query.projectId));
  if (query.taskId) conditions.push(eq(auditEvents.taskId, query.taskId));
  if (query.runId) conditions.push(eq(auditEvents.runId, query.runId));
  if (query.workerId) conditions.push(eq(auditEvents.workerId, query.workerId));
  if (query.eventType) conditions.push(eq(auditEvents.eventType, query.eventType));

  // Ordered by `seq`, not `ts`: events written in one transaction share a
  // clock value, and a tie there would make the trail's order arbitrary.
  const rows = await db
    .select()
    .from(auditEvents)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(auditEvents.seq))
    .limit(query.limit)
    .offset(query.offset);

  return rows.map((r) => ({
    id: r.id,
    seq: Number(r.seq),
    ts: r.ts.toISOString(),
    actorType: r.actorType as AuditEventDto['actorType'],
    actorId: r.actorId,
    actorLabel: r.actorLabel,
    eventType: r.eventType as AuditEventDto['eventType'],
    projectId: r.projectId,
    taskId: r.taskId,
    runId: r.runId,
    workerId: r.workerId,
    metadata: (r.metadata ?? {}) as Record<string, unknown>,
  }));
}

/** Chronological trail for a single run — what the Run Detail screen shows. */
export async function auditTrailForRun(runId: string): Promise<AuditEventDto[]> {
  const events = await queryAuditEvents({ runId, limit: 500, offset: 0 });
  return events.reverse();
}
