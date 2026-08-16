import type { FastifyBaseLogger } from 'fastify';
import { markStaleWorkersOffline } from '../services/workers.js';
import { stopRunsPastOvernightCutoff } from '../services/runs.js';

/**
 * Two periodic tasks, run in-process with setInterval.
 *
 * This is deliberately not a job framework, a cron container, or a queue. Both
 * sweepers are idempotent, cheap, and safe to miss a tick; introducing
 * scheduling infrastructure for them would be exactly the premature complexity
 * spec §31 warns against. If the control plane is ever run as multiple
 * instances, both sweepers remain correct — they simply do redundant work.
 */

const HEARTBEAT_SWEEP_MS = 15_000;
const CUTOFF_SWEEP_MS = 30_000;

export interface Sweepers {
  stop: () => void;
  /** Exposed so tests can drive a sweep deterministically instead of waiting. */
  sweepWorkers: () => Promise<string[]>;
  sweepCutoffs: () => Promise<string[]>;
}

export function startSweepers(logger: FastifyBaseLogger): Sweepers {
  const sweepWorkers = async (): Promise<string[]> => {
    const offline = await markStaleWorkersOffline();
    if (offline.length) logger.warn({ workerIds: offline }, 'workers marked offline after missed heartbeats');
    return offline;
  };

  const sweepCutoffs = async (): Promise<string[]> => {
    const stopped = await stopRunsPastOvernightCutoff(new Date());
    if (stopped.length) logger.warn({ runIds: stopped }, 'runs stopped at the overnight cutoff');
    return stopped;
  };

  // A sweep failure (e.g. a momentary database blip) must never take down the
  // control plane, so each tick swallows and logs.
  const guarded = (fn: () => Promise<unknown>, name: string) => () => {
    void fn().catch((err: Error) => logger.error({ err: err.message }, `${name} sweep failed`));
  };

  const workerTimer = setInterval(guarded(sweepWorkers, 'heartbeat'), HEARTBEAT_SWEEP_MS);
  const cutoffTimer = setInterval(guarded(sweepCutoffs, 'cutoff'), CUTOFF_SWEEP_MS);

  // Do not hold the process open purely for a sweep.
  workerTimer.unref();
  cutoffTimer.unref();

  return {
    stop: () => {
      clearInterval(workerTimer);
      clearInterval(cutoffTimer);
    },
    sweepWorkers,
    sweepCutoffs,
  };
}
