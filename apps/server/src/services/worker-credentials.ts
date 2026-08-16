import { and, desc, eq, isNull, or, sql } from 'drizzle-orm';
import { WORKER_TOKEN_PREFIX, type WorkerTokenDto } from '@mac/protocol';
import { db, type DbHandle } from '../db/client.js';
import { workerTokens, workers } from '../db/schema.js';
import type { WorkerRow, WorkerTokenRow } from '../db/schema.js';
import { AppError } from '../http/errors.js';
import { generateToken, hashToken, tokenDisplayPrefix } from '../lib/crypto.js';
import { record, recordRejection, SYSTEM_ACTOR, type Actor } from './audit.js';
import { getSettings } from './settings.js';

/**
 * Worker credentials (Sprint 3 §4).
 *
 * Sprint 1 stored one hash on the worker row and recorded rotation as debt
 * (R-1); Sprint 2 deferred it again (R-2) on the grounds that worker authority
 * had not widened. Sprint 3 widens it — the worker now executes coding agents
 * inside a sandbox and will hold broader operational credentials — so the debt
 * is repaid here.
 *
 * ---------------------------------------------------------------------------
 * WHY A TABLE RATHER THAN A SECOND COLUMN
 *
 * Rotation needs more than one token to be valid at once, briefly. A
 * `token_hash` plus a `previous_token_hash` column would express that, and
 * would then need a third column for the expiry, a fourth for the revocation
 * reason, and would still be unable to answer "what has this worker ever been
 * issued?" — which is the question asked after a credential leaks.
 *
 * Three statuses:
 *
 *   active      the current credential
 *   superseded  replaced, still accepted until `expiresAt` — DELIBERATELY SHORT.
 *               It exists so an in-flight request signed with the old token does
 *               not fail mid-rotation, not so two credentials can coexist.
 *   revoked     rejected immediately, no grace. Presenting one is audited,
 *               because it means a leaked credential is being used.
 * ---------------------------------------------------------------------------
 */

export const toWorkerTokenDto = (row: WorkerTokenRow, now = new Date()): WorkerTokenDto => ({
  id: row.id,
  workerId: row.workerId,
  tokenPrefix: row.tokenPrefix,
  status: row.status as WorkerTokenDto['status'],
  issuedVia: row.issuedVia as WorkerTokenDto['issuedVia'],
  issuedAt: row.issuedAt.toISOString(),
  expiresAt: row.expiresAt?.toISOString() ?? null,
  lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
  revokedAt: row.revokedAt?.toISOString() ?? null,
  revokedReason: row.revokedReason,
  ageHours: Math.max(0, Math.round(((now.getTime() - row.issuedAt.getTime()) / 3_600_000) * 10) / 10),
});

// ---------------------------------------------------------------------------
// Issuing
// ---------------------------------------------------------------------------

export interface IssuedToken {
  /** The only moment the plaintext exists outside the worker. */
  token: string;
  row: WorkerTokenRow;
}

/**
 * Issues a token, optionally leaving the previous one usable for a short window.
 *
 * `overlapSeconds = 0` means the previous token stops working the instant this
 * one is issued — which is what an admin reset and a fresh enrollment both want.
 */
export async function issueWorkerToken(
  tx: DbHandle,
  params: {
    workerId: string;
    issuedVia: 'enrollment' | 'rotation' | 'admin_reset';
    overlapSeconds: number;
    now?: Date;
  },
): Promise<IssuedToken> {
  const now = params.now ?? new Date();
  const token = generateToken(WORKER_TOKEN_PREFIX);

  // Supersede or revoke whatever this worker currently holds. Doing it in the
  // same transaction as the issue is what makes "exactly one active token"
  // true rather than merely usual.
  if (params.overlapSeconds > 0) {
    await tx
      .update(workerTokens)
      .set({
        status: 'superseded',
        supersededAt: now,
        expiresAt: new Date(now.getTime() + params.overlapSeconds * 1000),
      })
      .where(and(eq(workerTokens.workerId, params.workerId), eq(workerTokens.status, 'active')));
  } else {
    await tx
      .update(workerTokens)
      .set({ status: 'revoked', revokedAt: now, revokedReason: 'Replaced without an overlap window.' })
      .where(and(eq(workerTokens.workerId, params.workerId), eq(workerTokens.status, 'active')));
  }

  const [row] = await tx
    .insert(workerTokens)
    .values({
      workerId: params.workerId,
      tokenHash: hashToken(token),
      tokenPrefix: tokenDisplayPrefix(token),
      status: 'active',
      issuedVia: params.issuedVia,
      issuedAt: now,
    })
    .returning();

  if (!row) throw new AppError(500, 'TOKEN_ISSUE_FAILED', 'Could not issue a worker token.');

  await tx
    .update(workers)
    .set({
      tokenPrefix: row.tokenPrefix,
      tokenIssuedAt: now,
      rotationRequestedAt: null,
      ...(params.issuedVia === 'rotation' ? { lastRotatedAt: now } : {}),
      updatedAt: now,
    })
    .where(eq(workers.id, params.workerId));

  return { token, row };
}

// ---------------------------------------------------------------------------
// Resolution (the authentication path)
// ---------------------------------------------------------------------------

export interface TokenResolution {
  worker: WorkerRow;
  token: WorkerTokenRow;
  /** True when the caller is using a token inside its overlap window. */
  superseded: boolean;
}

/**
 * Resolves a presented token to a worker.
 *
 * The acceptance rule is deliberately narrow and written once, here:
 *
 *   accept  status = 'active'
 *   accept  status = 'superseded' AND expires_at > now()
 *   reject  everything else
 *
 * A rejected-but-recognised token is audited before this returns null. That
 * distinction matters: an unrecognised hash is noise (a scan, a typo), while a
 * REVOKED token being presented means a credential that was deliberately killed
 * is still in someone's hands.
 */
export async function resolvePresentedToken(token: string, now = new Date()): Promise<TokenResolution | null> {
  const hash = hashToken(token);

  const [found] = await db
    .select({ token: workerTokens, worker: workers })
    .from(workerTokens)
    .innerJoin(workers, eq(workers.id, workerTokens.workerId))
    .where(eq(workerTokens.tokenHash, hash))
    .limit(1);

  if (!found) return null;
  if (found.worker.status === 'disabled') return null;

  const row = found.token;
  const usable =
    row.status === 'active' ||
    (row.status === 'superseded' && row.expiresAt !== null && row.expiresAt.getTime() > now.getTime());

  if (!usable) {
    // Out of band: this is a read path with no transaction of its own, and the
    // record of a rejected credential must survive regardless.
    await recordRejection(db, {
      actor: { type: 'worker', id: found.worker.id, label: found.worker.name },
      eventType: 'worker.token_rejected',
      context: { workerId: found.worker.id },
      metadata: {
        tokenPrefix: row.tokenPrefix,
        status: row.status,
        expiredAt: row.expiresAt?.toISOString() ?? null,
        revokedAt: row.revokedAt?.toISOString() ?? null,
        reason: row.status === 'revoked' ? 'revoked' : 'overlap_window_expired',
      },
    }).catch(() => undefined);
    return null;
  }

  // Best-effort. A failed touch must never fail an authenticated request.
  void db
    .update(workerTokens)
    .set({ lastUsedAt: now })
    .where(eq(workerTokens.id, row.id))
    .catch(() => undefined);

  return { worker: found.worker, token: row, superseded: row.status === 'superseded' };
}

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

export interface RotationResult {
  token: string;
  previousTokenValidForSeconds: number;
  issuedAt: string;
}

/**
 * The worker replaces its own credential.
 *
 * Authenticated with the token being replaced, so possession of the current
 * credential is what authorises its replacement — the same property that makes
 * two-stage enrollment safe.
 */
export async function rotateWorkerToken(
  worker: WorkerRow,
  input: { reason: 'server_requested' | 'scheduled' | 'worker_initiated' },
): Promise<RotationResult> {
  const settings = await getSettings();
  const overlap = settings.workerTokenOverlapSeconds;

  return db.transaction(async (tx) => {
    const now = new Date();
    const issued = await issueWorkerToken(tx, {
      workerId: worker.id,
      issuedVia: 'rotation',
      overlapSeconds: overlap,
      now,
    });

    await record(tx, {
      actor: { type: 'worker', id: worker.id, label: worker.name },
      eventType: 'worker.token_rotated',
      context: { workerId: worker.id },
      metadata: {
        reason: input.reason,
        newTokenPrefix: issued.row.tokenPrefix,
        overlapSeconds: overlap,
      },
    });

    return {
      token: issued.token,
      previousTokenValidForSeconds: overlap,
      issuedAt: now.toISOString(),
    };
  });
}

/**
 * Asks a worker to rotate.
 *
 * Does NOT invalidate anything. The request rides the control envelope — which
 * is on every worker-facing response — so it reaches the worker on whichever
 * call happens next, and the worker rotates itself. That is what makes rotation
 * possible without anyone logging into the VM, which was the requirement.
 */
export async function requestRotation(
  workerId: string,
  actor: Actor,
  reason: string,
): Promise<void> {
  await db.transaction(async (tx) => {
    const [worker] = await tx.select().from(workers).where(eq(workers.id, workerId)).for('update').limit(1);
    if (!worker) throw AppError.notFound('Worker');
    if (worker.rotationRequestedAt) return; // Idempotent; asking twice is not an error.

    await tx
      .update(workers)
      .set({ rotationRequestedAt: new Date(), updatedAt: new Date() })
      .where(eq(workers.id, workerId));

    await record(tx, {
      actor,
      eventType: 'worker.token_rotation_requested',
      context: { workerId },
      metadata: { reason },
    });
  });
}

/**
 * Revokes every token a worker holds, immediately and with no grace period.
 *
 * The worker will fail its next call and must re-enroll with a fresh
 * single-use enrollment token — which is the correct outcome when a credential
 * is believed compromised, and the reason revocation does not offer an overlap.
 */
export async function revokeWorkerTokens(
  workerId: string,
  input: { reason: string },
  actor: Actor,
): Promise<{ revoked: number }> {
  return db.transaction(async (tx) => {
    const [worker] = await tx.select().from(workers).where(eq(workers.id, workerId)).limit(1);
    if (!worker) throw AppError.notFound('Worker');

    const revoked = await tx
      .update(workerTokens)
      .set({
        status: 'revoked',
        revokedAt: new Date(),
        revokedBy: actor.id,
        revokedReason: input.reason.slice(0, 500),
        expiresAt: null,
      })
      .where(and(eq(workerTokens.workerId, workerId), sql`${workerTokens.status} <> 'revoked'`))
      .returning({ id: workerTokens.id });

    await tx
      .update(workers)
      .set({ rotationRequestedAt: null, updatedAt: new Date() })
      .where(eq(workers.id, workerId));

    await record(tx, {
      actor,
      eventType: 'worker.token_revoked',
      context: { workerId },
      metadata: { reason: input.reason, tokensRevoked: revoked.length, workerName: worker.name },
    });

    return { revoked: revoked.length };
  });
}

// ---------------------------------------------------------------------------
// Age policy
// ---------------------------------------------------------------------------

/**
 * Flags workers whose credential has aged past the configured maximum.
 *
 * Run by the sweeper. It only *requests* rotation; the worker performs it, so a
 * VM that is offline at the moment its token ages out is not locked out — it
 * rotates when it comes back.
 */
export async function requestRotationForAgedTokens(now = new Date()): Promise<string[]> {
  const settings = await getSettings();
  const cutoff = new Date(now.getTime() - settings.workerTokenMaxAgeHours * 3_600_000);

  const stale = await db
    .select({ id: workers.id, name: workers.name, issuedAt: workerTokens.issuedAt })
    .from(workers)
    .innerJoin(
      workerTokens,
      and(eq(workerTokens.workerId, workers.id), eq(workerTokens.status, 'active')),
    )
    .where(
      and(
        isNull(workers.rotationRequestedAt),
        sql`${workers.status} <> 'disabled'`,
        sql`${workerTokens.issuedAt} < ${cutoff}`,
      ),
    );

  const flagged: string[] = [];
  for (const worker of stale) {
    await requestRotation(
      worker.id,
      SYSTEM_ACTOR,
      `Credential is older than the configured maximum of ${settings.workerTokenMaxAgeHours}h.`,
    ).catch(() => undefined);
    flagged.push(worker.id);
  }
  return flagged;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export async function listWorkerTokens(workerId: string, now = new Date()): Promise<WorkerTokenDto[]> {
  const rows = await db
    .select()
    .from(workerTokens)
    .where(eq(workerTokens.workerId, workerId))
    .orderBy(desc(workerTokens.issuedAt))
    .limit(50);
  return rows.map((r) => toWorkerTokenDto(r, now));
}

export async function activeToken(workerId: string, handle: DbHandle = db): Promise<WorkerTokenRow | null> {
  const [row] = await handle
    .select()
    .from(workerTokens)
    .where(and(eq(workerTokens.workerId, workerId), eq(workerTokens.status, 'active')))
    .limit(1);
  return row ?? null;
}

/** True when a worker holds no usable credential at all — it must re-enroll. */
export async function hasUsableToken(workerId: string, now = new Date()): Promise<boolean> {
  const [row] = await db
    .select({ id: workerTokens.id })
    .from(workerTokens)
    .where(
      and(
        eq(workerTokens.workerId, workerId),
        or(
          eq(workerTokens.status, 'active'),
          and(eq(workerTokens.status, 'superseded'), sql`${workerTokens.expiresAt} > ${now}`),
        ),
      ),
    )
    .limit(1);
  return Boolean(row);
}
