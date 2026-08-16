import { and, desc, eq, sql } from 'drizzle-orm';
import type {
  ControlEnvelope,
  EnrollmentTokenDto,
  JobKind,
  StopReason,
  WorkerDto,
  WorkerStatus,
} from '@mac/protocol';
import { PROTOCOL_VERSION, WORKER_TOKEN_PREFIX, ENROLLMENT_TOKEN_PREFIX } from '@mac/protocol';
import { db, type DbHandle } from '../db/client.js';
import { runs, workerEnrollmentTokens, workers } from '../db/schema.js';
import type { WorkerRow } from '../db/schema.js';
import { AppError } from '../http/errors.js';
import { generateToken, hashToken, tokenDisplayPrefix } from '../lib/crypto.js';
import { record, SYSTEM_ACTOR, type Actor } from './audit.js';
import { getSettings } from './settings.js';

/**
 * Worker identity and liveness.
 *
 * Two-stage credentialing keeps the long-lived secret off the provisioning
 * path: an admin mints a single-use, expiring enrollment token; the worker
 * exchanges it once for a worker token that only ever exists in plaintext at
 * that moment. Both are stored as SHA-256 hashes.
 */

export const toWorkerDto = (row: WorkerRow, isLive: boolean): WorkerDto => ({
  id: row.id,
  name: row.name,
  status: row.status as WorkerStatus,
  capabilities: Array.isArray(row.capabilities) ? (row.capabilities as string[]) : [],
  lastHeartbeatAt: row.lastHeartbeatAt?.toISOString() ?? null,
  currentRunId: row.currentRunId,
  version: row.version,
  platform: row.platform,
  tokenPrefix: row.tokenPrefix,
  registeredAt: row.registeredAt?.toISOString() ?? null,
  isLive,
});

/** A worker is live if its last heartbeat is within interval + grace. */
export function isWorkerLive(row: WorkerRow, intervalSeconds: number, graceSeconds: number, now = new Date()): boolean {
  if (row.status === 'disabled') return false;
  if (!row.lastHeartbeatAt) return false;
  return now.getTime() - row.lastHeartbeatAt.getTime() <= (intervalSeconds + graceSeconds) * 1000;
}

// ---------------------------------------------------------------------------
// Enrollment
// ---------------------------------------------------------------------------

export async function createEnrollmentToken(
  input: { label: string; expiresInHours: number },
  actor: Actor,
): Promise<EnrollmentTokenDto> {
  const token = generateToken(ENROLLMENT_TOKEN_PREFIX);
  const expiresAt = new Date(Date.now() + input.expiresInHours * 3600 * 1000);

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(workerEnrollmentTokens)
      .values({ label: input.label.trim(), tokenHash: hashToken(token), expiresAt, createdBy: actor.id })
      .returning();
    if (!row) throw new AppError(500, 'ENROLLMENT_TOKEN_FAILED', 'Could not create enrollment token.');

    await record(tx, {
      actor,
      eventType: 'worker.enrollment_token_created',
      metadata: { label: row.label, expiresAt: expiresAt.toISOString() },
    });

    return {
      id: row.id,
      label: row.label,
      // The only moment the plaintext exists outside the worker.
      token,
      expiresAt: expiresAt.toISOString(),
      usedAt: null,
      createdAt: row.createdAt.toISOString(),
    };
  });
}

export async function listEnrollmentTokens(): Promise<EnrollmentTokenDto[]> {
  const rows = await db
    .select()
    .from(workerEnrollmentTokens)
    .orderBy(desc(workerEnrollmentTokens.createdAt))
    .limit(50);
  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    expiresAt: r.expiresAt.toISOString(),
    usedAt: r.usedAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  }));
}

export interface RegistrationResult {
  workerId: string;
  workerToken: string;
}

export async function registerWorker(
  enrollmentToken: string,
  input: { name: string; capabilities: JobKind[]; version: string; platform: string },
): Promise<RegistrationResult> {
  const tokenHash = hashToken(enrollmentToken);

  return db.transaction(async (tx) => {
    const [enrollment] = await tx
      .select()
      .from(workerEnrollmentTokens)
      .where(eq(workerEnrollmentTokens.tokenHash, tokenHash))
      .for('update')
      .limit(1);

    // One message for every failure mode, so a caller cannot probe which
    // tokens exist.
    const invalid = AppError.unauthorized('Invalid, expired or already-used enrollment token.');
    if (!enrollment) throw invalid;
    if (enrollment.usedAt) throw invalid;
    if (enrollment.expiresAt.getTime() <= Date.now()) throw invalid;

    const workerToken = generateToken(WORKER_TOKEN_PREFIX);
    const name = input.name.trim();

    // Re-registration under an existing name rotates that worker's token
    // rather than failing, so rebuilding a VM does not require manual cleanup.
    const [existing] = await tx.select().from(workers).where(eq(workers.name, name)).limit(1);

    let workerRow: WorkerRow | undefined;
    if (existing) {
      if (existing.status === 'disabled') {
        throw AppError.forbidden('That worker has been disabled by an administrator.');
      }
      [workerRow] = await tx
        .update(workers)
        .set({
          capabilities: input.capabilities,
          version: input.version,
          platform: input.platform,
          tokenHash: hashToken(workerToken),
          tokenPrefix: tokenDisplayPrefix(workerToken),
          status: 'registered',
          currentRunId: null,
          registeredAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(workers.id, existing.id))
        .returning();
    } else {
      [workerRow] = await tx
        .insert(workers)
        .values({
          name,
          capabilities: input.capabilities,
          version: input.version,
          platform: input.platform,
          tokenHash: hashToken(workerToken),
          tokenPrefix: tokenDisplayPrefix(workerToken),
          status: 'registered',
        })
        .returning();
    }
    if (!workerRow) throw new AppError(500, 'WORKER_REGISTER_FAILED', 'Could not register worker.');

    await tx
      .update(workerEnrollmentTokens)
      .set({ usedAt: new Date(), usedByWorkerId: workerRow.id })
      .where(eq(workerEnrollmentTokens.id, enrollment.id));

    await record(tx, {
      actor: { type: 'worker', id: workerRow.id, label: workerRow.name },
      eventType: 'worker.registered',
      context: { workerId: workerRow.id },
      metadata: {
        name: workerRow.name,
        capabilities: input.capabilities,
        version: input.version,
        platform: input.platform,
        reRegistration: Boolean(existing),
        enrollmentLabel: enrollment.label,
      },
    });

    return { workerId: workerRow.id, workerToken };
  });
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

export async function resolveWorkerToken(token: string): Promise<WorkerRow | null> {
  const [row] = await db.select().from(workers).where(eq(workers.tokenHash, hashToken(token))).limit(1);
  if (!row || row.status === 'disabled') return null;
  return row;
}

// ---------------------------------------------------------------------------
// Heartbeat and liveness
// ---------------------------------------------------------------------------

export async function recordHeartbeat(
  worker: WorkerRow,
  input: { status: 'idle' | 'busy'; currentRunId: string | null },
): Promise<WorkerStatus> {
  const now = new Date();
  const wasOffline = worker.status === 'offline';

  // A worker that believes it is busy is trusted only insofar as the run agrees
  // it is assigned; otherwise the control plane's view wins.
  const nextStatus: WorkerStatus = input.status === 'busy' && input.currentRunId ? 'busy' : 'idle';

  await db.transaction(async (tx) => {
    await tx
      .update(workers)
      .set({ lastHeartbeatAt: now, status: nextStatus, currentRunId: input.currentRunId, updatedAt: now })
      .where(eq(workers.id, worker.id));

    // Heartbeats themselves are never audited — that would be thousands of rows
    // a day and would drown the trail. Only the online transition is.
    if (wasOffline) {
      await record(tx, {
        actor: { type: 'worker', id: worker.id, label: worker.name },
        eventType: 'worker.online',
        context: { workerId: worker.id },
        metadata: { recoveredAfterOffline: true },
      });
    }
  });

  return nextStatus;
}

/**
 * Marks silent workers offline. Run by the heartbeat sweeper.
 *
 * Note what this deliberately does NOT do: it does not fail the run a missing
 * worker was executing. A forty-second network blip must not destroy real work,
 * and spec §26 lists no such stop condition. The run stays `running` with a
 * visible "worker offline" indicator, and an operator decides.
 */
export async function markStaleWorkersOffline(now = new Date()): Promise<string[]> {
  const settings = await getSettings();
  const cutoff = new Date(now.getTime() - (settings.heartbeatIntervalSeconds + settings.heartbeatGraceSeconds) * 1000);

  const stale = await db
    .select()
    .from(workers)
    .where(
      and(
        sql`${workers.status} <> 'offline'`,
        sql`${workers.status} <> 'disabled'`,
        sql`(${workers.lastHeartbeatAt} IS NULL AND ${workers.registeredAt} < ${cutoff})
            OR ${workers.lastHeartbeatAt} < ${cutoff}`,
      ),
    );

  const ids: string[] = [];
  for (const worker of stale) {
    await db.transaction(async (tx) => {
      await tx.update(workers).set({ status: 'offline', updatedAt: now }).where(eq(workers.id, worker.id));
      await record(tx, {
        actor: SYSTEM_ACTOR,
        eventType: 'worker.offline',
        context: { workerId: worker.id, runId: worker.currentRunId },
        metadata: {
          name: worker.name,
          lastHeartbeatAt: worker.lastHeartbeatAt?.toISOString() ?? null,
          hadRunInFlight: Boolean(worker.currentRunId),
        },
      });
    });
    ids.push(worker.id);
  }
  return ids;
}

// ---------------------------------------------------------------------------
// Control envelope
// ---------------------------------------------------------------------------

/**
 * Built for EVERY worker-facing response, not just heartbeats.
 *
 * That is the mechanism by which a stop reaches a worker promptly: the worker
 * uploads logs roughly once a second, so cancellation latency is bounded by the
 * log interval rather than by the ten-second heartbeat.
 */
export async function buildControlEnvelope(
  workerId: string,
  handle: DbHandle = db,
): Promise<ControlEnvelope> {
  const settings = await getSettings(handle);

  const [pending] = await handle
    .select({ id: runs.id, stopReason: runs.stopReason })
    .from(runs)
    .where(
      and(
        eq(runs.workerId, workerId),
        sql`${runs.cancelRequestedAt} IS NOT NULL`,
        sql`${runs.status} IN ('running', 'blocked', 'self_review')`,
      ),
    )
    .limit(1);

  return {
    protocolVersion: PROTOCOL_VERSION,
    serverTime: new Date().toISOString(),
    heartbeatIntervalSeconds: settings.heartbeatIntervalSeconds,
    cancelRequested: Boolean(pending),
    cancelRunId: pending?.id ?? null,
    cancelReason: (pending?.stopReason as StopReason | null) ?? null,
  };
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function listWorkers(now = new Date()): Promise<WorkerDto[]> {
  const settings = await getSettings();
  const rows = await db.select().from(workers).orderBy(desc(workers.registeredAt));
  return rows.map((r) =>
    toWorkerDto(r, isWorkerLive(r, settings.heartbeatIntervalSeconds, settings.heartbeatGraceSeconds, now)),
  );
}

export async function getWorker(id: string, now = new Date()): Promise<WorkerDto> {
  const settings = await getSettings();
  const [row] = await db.select().from(workers).where(eq(workers.id, id)).limit(1);
  if (!row) throw AppError.notFound('Worker');
  return toWorkerDto(row, isWorkerLive(row, settings.heartbeatIntervalSeconds, settings.heartbeatGraceSeconds, now));
}

export async function setWorkerEnabled(id: string, enabled: boolean, actor: Actor): Promise<WorkerDto> {
  const [row] = await db
    .update(workers)
    .set({ status: enabled ? 'offline' : 'disabled', updatedAt: new Date() })
    .where(eq(workers.id, id))
    .returning();
  if (!row) throw AppError.notFound('Worker');

  await db.transaction(async (tx) => {
    await record(tx, {
      actor,
      eventType: enabled ? 'worker.online' : 'worker.offline',
      context: { workerId: id },
      metadata: { administrativeAction: enabled ? 'enabled' : 'disabled' },
    });
  });

  return getWorker(id);
}
