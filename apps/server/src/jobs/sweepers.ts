import type { FastifyBaseLogger } from 'fastify';
import { markStaleWorkersOffline } from '../services/workers.js';
import { stopRunsPastOvernightCutoff } from '../services/runs.js';
import { requestRotationForAgedTokens } from '../services/worker-credentials.js';
import { nightShiftTick } from '../services/night-shift.js';
import { deliverPendingMondayWrites } from '../services/monday/outbox.js';
import { deliverPendingEmails } from '../services/mail/delivery.js';
import { deliverPendingMessages } from '../services/notifications.js';
import { expireStaleRequests } from '../services/approval-requests.js';

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
/**
 * The night-shift loop.
 *
 * A third `setInterval` next to the two Sprint 1 already runs, for the same
 * reasons: the tick is idempotent, cheap, and safe to miss. Introducing a queue
 * or a workflow engine for it would be exactly the premature complexity spec
 * §31 warns against.
 */
const NIGHT_TICK_MS = 30_000;
/** The monday.com outbox. Fast enough that a board looks live to a human. */
const MONDAY_SWEEP_MS = 10_000;
/** The mail outbox. One email a night; there is nothing to hurry. */
const MAIL_SWEEP_MS = 20_000;
/**
 * Phase 4: the conversation outbox, and approval expiry.
 *
 * Messages are swept faster than mail because a person is waiting on the other
 * end of one. Approval expiry is slow-moving — an approval that expired four
 * minutes ago is not an emergency — and checking it often would be noise.
 */
const MESSAGE_SWEEP_MS = 10_000;
const APPROVAL_EXPIRY_SWEEP_MS = 5 * 60_000;

export interface Sweepers {
  stop: () => void;
  /** Exposed so tests can drive a sweep deterministically instead of waiting. */
  sweepWorkers: () => Promise<string[]>;
  sweepCutoffs: () => Promise<string[]>;
  sweepCredentials: () => Promise<string[]>;
  tickNightShift: () => Promise<unknown>;
  deliverMondayWrites: () => Promise<unknown>;
  deliverEmails: () => Promise<unknown>;
  deliverMessages: () => Promise<unknown>;
  expireApprovals: () => Promise<unknown>;
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

  /**
   * One turn of the night-shift loop.
   *
   * Serialised with a guard flag rather than by a lock: two overlapping ticks
   * would both see the same idle worker and could both start a task, and the
   * cheapest way to prevent that is not to have two.
   */
  let ticking = false;
  const tickNightShift = async (): Promise<unknown> => {
    if (ticking) return { decision: 'skipped_overlapping_tick' };
    ticking = true;
    try {
      const result = await nightShiftTick();
      if (result.decision !== 'no_shift' && result.decision !== 'continue') {
        logger.info({ nightShift: result }, 'night-shift decision');
      }
      return result;
    } finally {
      ticking = false;
    }
  };

  const deliverMondayWrites = async (): Promise<unknown> => {
    const result = await deliverPendingMondayWrites();
    if (result.dead > 0 || result.refused > 0) {
      logger.warn({ monday: result }, 'monday.com writes were refused or dead-lettered');
    }
    return result;
  };

  const deliverEmails = async (): Promise<unknown> => {
    const result = await deliverPendingEmails();
    if (result.sent > 0) logger.info({ mail: result }, 'reports delivered');
    // A dead-lettered morning report means nobody was told what happened
    // overnight, which is worth a warning rather than a metric.
    if (result.dead > 0) logger.warn({ mail: result }, 'report deliveries dead-lettered');
    return result;
  };

  const deliverMessages = async (): Promise<unknown> => {
    const result = await deliverPendingMessages();
    if (result.sent > 0) logger.info({ messages: result }, 'conversation messages delivered');
    // A dead-lettered message means Mac said something a person never saw —
    // which for a blocker or an approval is the whole point of having said it.
    if (result.dead > 0) logger.warn({ messages: result }, 'conversation messages dead-lettered');
    return result;
  };

  const expireApprovals = async (): Promise<unknown> => {
    const expired = await expireStaleRequests(new Date());
    if (expired > 0) logger.info({ expired }, 'approval requests expired');
    return expired;
  };

  const workerTimer = setInterval(guarded(sweepWorkers, 'heartbeat'), HEARTBEAT_SWEEP_MS);
  const cutoffTimer = setInterval(guarded(sweepCutoffs, 'cutoff'), CUTOFF_SWEEP_MS);
  const credentialTimer = setInterval(guarded(sweepCredentials, 'credential'), CREDENTIAL_SWEEP_MS);
  const nightTimer = setInterval(guarded(tickNightShift, 'night-shift'), NIGHT_TICK_MS);
  const mondayTimer = setInterval(guarded(deliverMondayWrites, 'monday-outbox'), MONDAY_SWEEP_MS);
  const mailTimer = setInterval(guarded(deliverEmails, 'mail-outbox'), MAIL_SWEEP_MS);
  const messageTimer = setInterval(guarded(deliverMessages, 'message-outbox'), MESSAGE_SWEEP_MS);
  const approvalTimer = setInterval(guarded(expireApprovals, 'approval-expiry'), APPROVAL_EXPIRY_SWEEP_MS);

  const timers = [
    workerTimer,
    cutoffTimer,
    credentialTimer,
    nightTimer,
    mondayTimer,
    mailTimer,
    messageTimer,
    approvalTimer,
  ];
  // Do not hold the process open purely for a sweep.
  for (const timer of timers) timer.unref();

  return {
    stop: () => {
      for (const timer of timers) clearInterval(timer);
    },
    sweepWorkers,
    sweepCutoffs,
    sweepCredentials,
    deliverMessages,
    expireApprovals,
    tickNightShift,
    deliverMondayWrites,
    deliverEmails,
  };
}
