import type { RunAssignment } from '@mac/protocol';
import type { ControlPlaneClient } from '../client.js';
import { JobCancelledError, type JobContext, type JobResult } from './index.js';

/**
 * General (non-coding) work on the worker (Sprint 3.3 §13).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS FILE DELIBERATELY DOES NOT CONTAIN
 *
 * No model client. No API key. No company documents. No project memory. No
 * monday token. No prompt. No tool.
 *
 * It is a loop that asks the control plane to perform the next reasoning step
 * and reports what came back. That split is the whole security argument for
 * general work: Sprint 3.3 §29 requires that research must not expose worker
 * credentials, mail credentials, monday credentials, Company repo write
 * credentials or unrelated project secrets — and the cheapest way to guarantee
 * that is for the VM never to hold any of them.
 *
 * What the worker DOES own is the part it is uniquely placed to own: the lease,
 * the heartbeat, prompt cancellation, the wall-clock ceiling and the run log.
 * That is the Sprint 1 lifecycle, unchanged, which is why this is not a second
 * execution architecture.
 * ---------------------------------------------------------------------------
 */

export async function runGeneralTaskJob(
  assignment: RunAssignment,
  ctx: JobContext,
  deps: { client: ControlPlaneClient },
): Promise<JobResult> {
  const general = assignment.general;
  if (!general) {
    throw new Error('This general run has no assignment. The control plane builds one at lease time.');
  }

  ctx.log(`Starting ${general.taskKind} work: ${assignment.taskTitle}`);
  ctx.log(`Objective: ${general.objective}`);
  if (general.deliverables.length) {
    ctx.log(`Deliverables: ${general.deliverables.join('; ')}`);
  }
  ctx.log(
    'Reasoning runs in the control plane, not on this worker: the model credential and the approved ' +
      'sources never leave it.',
  );

  await ctx.progress('planning', 0);

  /*
   * The wall-clock ceiling, enforced here as well as by the control plane.
   *
   * Two independent limits on the same thing is not belt-and-braces for its own
   * sake: the server's ceiling counts STEPS, and a step that takes far longer
   * than expected would satisfy it while still overrunning the night. This one
   * counts minutes, which is what the cutoff actually cares about.
   */
  const deadline = Date.now() + general.maxMinutes * 60_000;
  const assignmentDeadline = assignment.deadlineAt ? Date.parse(assignment.deadlineAt) : Number.POSITIVE_INFINITY;

  /*
   * TWO counters, and the local one bounds the loop.
   *
   * `iterations` counts what THIS worker has done; `steps` is what the control
   * plane reports. Looping on the reported figure alone was a real bug: a
   * control plane whose counter stalls — a persistence failure, a bug in the
   * step handler — would keep answering "step 1 of 8, not done" and the worker
   * would call it forever, burning model spend until something else killed it.
   *
   * The worker is the component holding the lease and the wall clock, so it is
   * the one that must be able to stop on its own account.
   */
  let iterations = 0;
  let steps = 0;
  let artefacts = 0;
  let lastNarrative = '';
  let blocker: string | null = null;
  /*
   * WHY the loop ended, in the worker's own words.
   *
   * A run that delivers nothing is reported as failed either way, but "failed
   * after being cut off at the 30-minute ceiling" and "failed after the model
   * wrote nothing across eight steps" are different problems with different
   * fixes, and a summary that cannot tell them apart sends whoever reads it
   * looking in the wrong place.
   */
  let stopCause = 'the loop finished';

  while (iterations < general.maxSteps) {
    iterations += 1;
    if (ctx.signal.aborted) throw new JobCancelledError();

    if (Date.now() >= deadline) {
      stopCause = `it reached the ${general.maxMinutes}-minute ceiling for this run`;
      ctx.log(`Reached the ${general.maxMinutes}-minute ceiling for this run.`, 'stderr');
      break;
    }
    if (Date.now() >= assignmentDeadline) {
      stopCause = 'it reached the overnight cutoff';
      ctx.log('Reached the overnight cutoff for this run.', 'stderr');
      break;
    }

    const result = await deps.client.performResearchStep(assignment.runId, ctx.signal);

    steps = result.stepsTaken;
    artefacts += result.artefactsCreated;
    lastNarrative = result.narrative || lastNarrative;
    if (result.blockerProposed) blocker = result.blockerProposed;

    ctx.log(
      `Step ${result.stepsTaken}: ${result.narrative} ` +
        `(${result.findingsSoFar} finding(s) from ${result.sourcesSoFar} source(s), ` +
        `${result.toolCallsMade} lookup(s) so far)`,
    );
    await ctx.progress(result.stage, result.percent);

    if (result.limitReached) {
      stopCause = 'the research loop reached its configured ceiling';
      ctx.log('The research loop reached its configured ceiling.', 'stderr');
      break;
    }
    if (result.done) {
      stopCause = 'the control plane reported the work was done';
      break;
    }
  }

  if (iterations >= general.maxSteps && stopCause === 'the loop finished') {
    stopCause = `it reached its ${general.maxSteps}-step ceiling`;
  }

  if (ctx.signal.aborted) throw new JobCancelledError();

  await ctx.progress('complete', 100);

  /*
   * A run that produced no artefact is reported as such, plainly.
   *
   * The tempting alternative — completing quietly — is the exact failure the
   * whole evidence model exists to prevent: a morning report that lists a
   * finished investigation with nothing in it reads as "looked, found nothing",
   * which is a claim nobody made.
   */
  if (blocker) ctx.log(`Mac believes a human decision is needed: ${blocker}`, 'stderr');

  /*
   * A run that produced nothing FAILS. It does not complete with a sad sentence.
   *
   * This block used to write "produced NO artefacts" into the summary and then
   * return success. Commissioning showed exactly what that is worth: the first
   * real run finished 8 steps, 23 lookups across 37 sources and 9 findings, hit
   * the token ceiling while writing up, produced nothing — and reported
   * `succeeded`. The prose was honest and every machine-readable signal said the
   * night had gone fine.
   *
   * Unattended at 03:00 that is the worst available outcome, because a morning
   * report on a "finished" investigation with nothing in it reads as "looked,
   * found nothing" — a claim nobody made and the evidence model exists to
   * prevent. A failed run is visible, retryable and true.
   */
  if (artefacts === 0) {
    const detail =
      `${general.taskKind} work ran for ${steps} step(s) and produced NO artefacts, because ` +
      `${stopCause}. ${lastNarrative}`.trim();
    ctx.log(detail, 'stderr');
    throw new Error(
      `${detail} A research run that delivers nothing is reported as failed rather than complete, ` +
        'so it is visible and can be retried.',
    );
  }

  /*
   * ACCEPTANCE IS CHECKED HERE, BEFORE COMPLETION IS REPORTED.
   *
   * This is the only moment remediation is possible: the lease is held, the
   * night still has time in it, and the run is not yet terminal. Once the run
   * closes, the honest way to produce a missing deliverable is a new run — which
   * leaves the record of the shortfall intact rather than papering over it.
   *
   * The worker asks and does not decide. It supplies one judgement the control
   * plane cannot make — whether there is TIME left, which is a wall-clock fact
   * only the component holding the clock knows — and the control plane decides
   * everything else: what the criteria are, whether they are met, whether
   * remediation is permitted, and what the run's final state should be.
   *
   * A failure here does not fail the run. Work was produced and is worth
   * reading; the control plane performs a deterministic review of its own when
   * completion arrives, so a skipped check cannot yield a clean `completed`.
   */
  let acceptanceNote = '';
  try {
    const remaining = Math.min(deadline, assignmentDeadline) - Date.now();
    const review = await deps.client.reviewAcceptance(
      assignment.runId,
      // Ten minutes is roughly one model call plus one remediation pass. Below
      // that, starting one would overrun the cutoff it exists to respect.
      { canRemediate: remaining > 10 * 60_000 },
      ctx.signal,
    );

    if (review.state === 'gaps') {
      acceptanceNote =
        ` Acceptance: ${review.unmet} of ${review.criteriaChecked} required criteria NOT met` +
        `${review.remediationAttempted ? ' after a remediation attempt' : ''}.`;
      ctx.log(`Acceptance criteria not fully met (${review.unmet} of ${review.criteriaChecked}):`, 'stderr');
      for (const line of review.unmetSummary) ctx.log(`  • ${line}`, 'stderr');
    } else if (review.state === 'satisfied') {
      acceptanceNote = ` Acceptance: all ${review.criteriaChecked} required criteria met.`;
      ctx.log(acceptanceNote.trim());
    }
  } catch (err) {
    if (ctx.signal.aborted) throw new JobCancelledError();
    ctx.log(`The acceptance review could not be performed: ${(err as Error).message}`, 'stderr');
  }

  const summary =
    `${general.taskKind} work completed in ${steps} step(s); ${artefacts} artefact(s) produced.${acceptanceNote} ${lastNarrative}`.trim();
  ctx.log(summary);

  return { summary: summary.slice(0, 2000) };
}
