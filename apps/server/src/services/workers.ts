import { and, desc, eq, sql } from 'drizzle-orm';
import type {
  ControlEnvelope,
  EnrollmentTokenDto,
  JobKind,
  SandboxAttestation,
  SandboxKind,
  StopReason,
  WorkerDto,
  WorkerStatus,
} from '@mac/protocol';
import { PROTOCOL_VERSION, ENROLLMENT_TOKEN_PREFIX } from '@mac/protocol';
import { db, type DbHandle } from '../db/client.js';
import { runs, workerEnrollmentTokens, workers } from '../db/schema.js';
import type { WorkerRow } from '../db/schema.js';
import { AppError } from '../http/errors.js';
import { generateToken, hashToken } from '../lib/crypto.js';
import { record, SYSTEM_ACTOR, type Actor } from './audit.js';
import { getSettings } from './settings.js';
import { issueWorkerToken, resolvePresentedToken } from './worker-credentials.js';

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
  sandboxKind: (row.sandboxKind as SandboxKind | null) ?? null,
  sandboxReady: row.sandboxReady,
  sandboxDetail: row.sandboxDetail,
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
  input: {
    name: string;
    capabilities: JobKind[];
    version: string;
    platform: string;
    sandbox?: SandboxAttestation | undefined;
  },
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

    const name = input.name.trim();
    const sandboxPatch = sandboxColumns(input.sandbox);

    // Re-registration under an existing name re-credentials that worker rather
    // than failing, so rebuilding a VM does not require manual cleanup.
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
          status: 'registered',
          currentRunId: null,
          registeredAt: new Date(),
          updatedAt: new Date(),
          ...sandboxPatch,
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
          // Replaced immediately below by `issueWorkerToken`; a placeholder
          // rather than a nullable column so the display prefix is never null.
          tokenPrefix: '(pending)',
          status: 'registered',
          ...sandboxPatch,
        })
        .returning();
    }
    if (!workerRow) throw new AppError(500, 'WORKER_REGISTER_FAILED', 'Could not register worker.');

    /*
     * Enrollment issues with NO overlap: whatever this worker previously held is
     * revoked outright. A re-enrolling worker is either new or being rebuilt,
     * and in both cases the old credential should stop working immediately.
     */
    const issued = await issueWorkerToken(tx, {
      workerId: workerRow.id,
      issuedVia: 'enrollment',
      overlapSeconds: 0,
    });

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
        sandboxKind: input.sandbox?.kind ?? null,
        sandboxReady: input.sandbox?.available ?? false,
      },
    });

    if (input.sandbox) {
      await record(tx, {
        actor: { type: 'worker', id: workerRow.id, label: workerRow.name },
        eventType: 'sandbox.attested',
        context: { workerId: workerRow.id },
        metadata: {
          kind: input.sandbox.kind,
          available: input.sandbox.available,
          version: input.sandbox.version,
          detail: input.sandbox.detail,
          at: 'registration',
        },
      });
    }

    return { workerId: workerRow.id, workerToken: issued.token };
  });
}

/**
 * Maps an attestation onto worker columns.
 *
 * A worker that reports nothing is treated as having NO sandbox, not as
 * unchanged. An older worker that does not know how to attest must not inherit
 * a `sandbox_ready` flag from a previous, better-informed run.
 */
function sandboxColumns(attestation: SandboxAttestation | undefined) {
  return {
    sandboxKind: (attestation?.kind ?? 'none') as SandboxKind,
    sandboxReady: Boolean(attestation?.available),
    sandboxDetail: attestation?.detail ?? null,
    sandboxVersion: attestation?.version ?? null,
  };
}

/**
 * Records a worker's containment capability.
 *
 * Re-attested on every heartbeat rather than trusted from registration: a
 * sandbox that stopped working at 02:00 must stop coding work, not persist as a
 * stale claim on a dashboard. Only CHANGES are audited — attesting the same
 * state every ten seconds would produce the audit volume the trail exists to
 * avoid.
 */
export async function recordSandboxAttestation(
  worker: WorkerRow,
  attestation: SandboxAttestation,
  handle?: DbHandle,
): Promise<{ codingWorkWithheld: boolean }> {
  const settings = await getSettings();
  const changed =
    worker.sandboxKind !== attestation.kind ||
    worker.sandboxReady !== attestation.available ||
    worker.sandboxDetail !== (attestation.detail ?? null);

  const run = async (tx: DbHandle) => {
    await tx
      .update(workers)
      .set({ ...sandboxColumns(attestation), updatedAt: new Date() })
      .where(eq(workers.id, worker.id));

    if (changed) {
      await record(tx, {
        actor: { type: 'worker', id: worker.id, label: worker.name },
        eventType: 'sandbox.attested',
        context: { workerId: worker.id },
        metadata: {
          kind: attestation.kind,
          available: attestation.available,
          version: attestation.version,
          detail: attestation.detail,
          previousKind: worker.sandboxKind,
          previousReady: worker.sandboxReady,
        },
      });
    }
  };

  if (handle) await run(handle);
  else await db.transaction(run);

  return { codingWorkWithheld: settings.requireSandbox && !attestation.available };
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/**
 * Authenticates an operating worker.
 *
 * Sprint 3 moved the acceptance rule into `worker-credentials.ts` so that
 * "which tokens are valid" is defined exactly once, next to the code that
 * issues and revokes them. A revoked token presented here is audited there
 * before this returns null.
 */
export async function resolveWorkerToken(token: string): Promise<WorkerRow | null> {
  const resolved = await resolvePresentedToken(token);
  return resolved?.worker ?? null;
}

// ---------------------------------------------------------------------------
// Heartbeat and liveness
// ---------------------------------------------------------------------------

export async function recordHeartbeat(
  worker: WorkerRow,
  input: { status: 'idle' | 'busy'; currentRunId: string | null; sandbox?: SandboxAttestation | undefined },
): Promise<WorkerStatus> {
  const now = new Date();
  const wasOffline = worker.status === 'offline';

  if (input.sandbox) {
    await recordSandboxAttestation(worker, input.sandbox).catch(() => undefined);
  }

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

  /*
   * The parentheses around the OR are load-bearing.
   *
   * Without them, `A AND B AND (C AND D) OR E` binds as
   * `(A AND B AND C AND D) OR E` — so ANY worker with an old heartbeat matched,
   * including ones already marked offline. The sweeper then re-marked and
   * re-audited the same worker every fifteen seconds: about 5,700 rows a day
   * for one dead VM, which is precisely the audit flooding Sprint 1 set out to
   * avoid when it decided not to audit heartbeats.
   *
   * Found by watching the development log, not by a test — so there is now a
   * test for it as well.
   */
  const stale = await db
    .select()
    .from(workers)
    .where(
      and(
        sql`${workers.status} <> 'offline'`,
        sql`${workers.status} <> 'disabled'`,
        sql`((${workers.lastHeartbeatAt} IS NULL AND ${workers.registeredAt} < ${cutoff})
             OR ${workers.lastHeartbeatAt} < ${cutoff})`,
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

  /*
   * Sprint 3: rotation rides the envelope for exactly the reason cancellation
   * does. The envelope is on EVERY worker-facing response, so the request
   * reaches the worker on whichever call happens next — which is what makes
   * rotating a credential possible without anyone logging into the VM.
   */
  const [workerRow] = await handle
    .select({ rotationRequestedAt: workers.rotationRequestedAt })
    .from(workers)
    .where(eq(workers.id, workerId))
    .limit(1);

  return {
    protocolVersion: PROTOCOL_VERSION,
    serverTime: new Date().toISOString(),
    heartbeatIntervalSeconds: settings.heartbeatIntervalSeconds,
    cancelRequested: Boolean(pending),
    cancelRunId: pending?.id ?? null,
    cancelReason: (pending?.stopReason as StopReason | null) ?? null,
    rotateTokenRequested: Boolean(workerRow?.rotationRequestedAt),
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
