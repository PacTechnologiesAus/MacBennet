import type { FastifyBaseLogger } from 'fastify';
import { markStaleWorkersOffline } from '../services/workers.js';
import { stopRunsPastOvernightCutoff } from '../services/runs.js';
import { requestRotationForAgedTokens } from '../services/worker-credentials.js';

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
/** Credential age is a slow-moving property; checking it often would be noise. */
const CREDENTIAL_SWEEP_MS = 5 * 60_000;

export interface Sweepers {
  stop: () => void;
  /** Exposed so tests can drive a sweep deterministically instead of waiting. */
  sweepWorkers: () => Promise<string[]>;
  sweepCutoffs: () => Promise<string[]>;
  sweepCredentials: () => Promise<string[]>;
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

  /**
   * Flags workers whose credential has aged past the configured maximum.
   *
   * It only REQUESTS rotation; the worker performs it. A VM that is offline at
   * the moment its token ages out therefore is not locked out — it rotates when
   * it comes back, which is the difference between a rotation policy and an
   * outage.
   */
  const sweepCredentials = async (): Promise<string[]> => {
    const flagged = await requestRotationForAgedTokens();
    if (flagged.length) logger.info({ workerIds: flagged }, 'worker credentials flagged for rotation');
    return flagged;
  };

  const workerTimer = setInterval(guarded(sweepWorkers, 'heartbeat'), HEARTBEAT_SWEEP_MS);
  const cutoffTimer = setInterval(guarded(sweepCutoffs, 'cutoff'), CUTOFF_SWEEP_MS);
  const credentialTimer = setInterval(guarded(sweepCredentials, 'credential'), CREDENTIAL_SWEEP_MS);

  // Do not hold the process open purely for a sweep.
  workerTimer.unref();
  cutoffTimer.unref();
  credentialTimer.unref();

  return {
    stop: () => {
      clearInterval(workerTimer);
      clearInterval(cutoffTimer);
      clearInterval(credentialTimer);
    },
    sweepWorkers,
    sweepCutoffs,
    sweepCredentials,
  };
}
