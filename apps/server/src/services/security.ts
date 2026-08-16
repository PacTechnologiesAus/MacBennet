import { desc, eq } from 'drizzle-orm';
import type { SandboxKind, SecurityOverviewDto, WorkerSecurityDto } from '@mac/protocol';
import { db } from '../db/client.js';
import { workerTokens, workers } from '../db/schema.js';
import { getSettings } from './settings.js';
import { isWorkerLive } from './workers.js';
import { toWorkerTokenDto } from './worker-credentials.js';

/**
 * The Security screen's data (Sprint 3 §14).
 *
 * One query set rather than four endpoints, because the question a human asks
 * is a single one — "is this fleet in a state I am comfortable leaving
 * overnight?" — and answering it from four separate screens is how the answer
 * gets to be "probably".
 *
 * `codingWorkWithheld` is computed here rather than in the UI, so the dashboard
 * and the dispatch statement cannot disagree about whether a worker is
 * currently able to receive coding work.
 */
export async function getSecurityOverview(now = new Date()): Promise<SecurityOverviewDto> {
  const settings = await getSettings();

  const rows = await db
    .select({ worker: workers, token: workerTokens })
    .from(workers)
    .leftJoin(workerTokens, eq(workerTokens.workerId, workers.id))
    .orderBy(desc(workers.registeredAt), desc(workerTokens.issuedAt));

  const byWorker = new Map<string, WorkerSecurityDto>();

  for (const { worker, token } of rows) {
    if (!byWorker.has(worker.id)) {
      byWorker.set(worker.id, {
        workerId: worker.id,
        workerName: worker.name,
        isLive: isWorkerLive(worker, settings.heartbeatIntervalSeconds, settings.heartbeatGraceSeconds, now),
        sandboxKind: (worker.sandboxKind as SandboxKind | null) ?? null,
        sandboxReady: worker.sandboxReady,
        sandboxDetail: worker.sandboxDetail,
        codingWorkWithheld: settings.requireSandbox && !worker.sandboxReady,
        activeToken: null,
        tokens: [],
        rotationRequestedAt: worker.rotationRequestedAt?.toISOString() ?? null,
        lastRotatedAt: worker.lastRotatedAt?.toISOString() ?? null,
      });
    }

    if (!token) continue;
    const entry = byWorker.get(worker.id)!;
    const dto = toWorkerTokenDto(token, now);
    entry.tokens.push(dto);
    if (dto.status === 'active') entry.activeToken = dto;
  }

  return {
    requireSandbox: settings.requireSandbox,
    workerTokenMaxAgeHours: settings.workerTokenMaxAgeHours,
    workerTokenOverlapSeconds: settings.workerTokenOverlapSeconds,
    workers: [...byWorker.values()],
  };
}
