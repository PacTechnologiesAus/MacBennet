import type { AuditEventType, ActorType } from '@mac/protocol';
import { auditEvents } from '../db/schema.js';
import type { DbHandle } from '../db/client.js';

/**
 * The audit trail (spec §27, Step 7).
 *
 * Two rules, both load-bearing:
 *
 *  1. Every meaningful transition writes an event, and writes it in the SAME
 *     transaction as the change it describes. An audit event therefore cannot
 *     be lost while its effect persists, nor describe something that rolled
 *     back. This is why `record` takes a DbHandle rather than reaching for the
 *     pool itself — callers must pass their transaction.
 *
 *  2. Nothing may update or delete an event. There is no such function here,
 *     no route, and — because convention is not a control — a database trigger
 *     that raises on UPDATE, DELETE and TRUNCATE.
 *
 * Deliberately NOT audited: heartbeats, individual log lines, and reads.
 * Auditing those produces volume that makes the trail unreadable, which is the
 * practical failure mode of audit systems.
 */

export interface Actor {
  type: ActorType;
  id: string | null;
  /** Denormalised so the trail stays readable after a user is renamed or removed. */
  label: string;
}

export const SYSTEM_ACTOR: Actor = { type: 'system', id: null, label: 'system' };

export interface AuditContext {
  projectId?: string | null;
  taskId?: string | null;
  runId?: string | null;
  workerId?: string | null;
}

export async function record(
  tx: DbHandle,
  params: {
    actor: Actor;
    eventType: AuditEventType;
    context?: AuditContext;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await tx.insert(auditEvents).values({
    actorType: params.actor.type,
    actorId: params.actor.id,
    actorLabel: params.actor.label,
    eventType: params.eventType,
    projectId: params.context?.projectId ?? null,
    taskId: params.context?.taskId ?? null,
    runId: params.context?.runId ?? null,
    workerId: params.context?.workerId ?? null,
    metadata: params.metadata ?? {},
  });
}

/**
 * Records an event that describes a REJECTED action, on its own connection.
 *
 * `record` writes inside the caller's transaction, which is exactly right for
 * an event describing a change that succeeded — the two commit or roll back
 * together. It is exactly wrong for an event describing a refusal: that
 * transaction is about to roll back, and the audit event would roll back with
 * it, leaving no trace that anything was attempted.
 *
 * Blocked approvals, refused transitions and unauthorised worker access must
 * outlive the failure that produced them, so they are written independently.
 * The insert touches only `audit_events` and takes no lock the caller holds,
 * so there is no deadlock risk against the open transaction.
 */
export async function recordRejection(
  db: { transaction: <T>(fn: (tx: DbHandle) => Promise<T>) => Promise<T> },
  params: {
    actor: Actor;
    eventType: AuditEventType;
    context?: AuditContext;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await db.transaction(async (tx) => {
    await record(tx, params);
  });
}

/**
 * Convenience for the very common "a run changed status" event, which must
 * always carry both ends of the transition so the trail can be replayed.
 */
export async function recordRunTransition(
  tx: DbHandle,
  params: {
    actor: Actor;
    eventType: AuditEventType;
    from: string;
    to: string;
    context: AuditContext;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await record(tx, {
    actor: params.actor,
    eventType: params.eventType,
    context: params.context,
    metadata: { from: params.from, to: params.to, ...params.metadata },
  });
}
