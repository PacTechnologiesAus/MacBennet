import type { OutboundKind } from '@mac/protocol';

/**
 * What Mac may push to a person, and what he must merely record
 * (Phase 4 Part B §7, Part G §27).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A TABLE AND NOT A CONDITION AT EACH CALL SITE
 *
 * Because "does Mac spam people?" needs one answer, in one place, that somebody
 * can read in ten seconds.
 *
 * The failure mode is gradual and it is not hypothetical. Every individual
 * notification looks justified to whoever is adding it — a stage change is
 * interesting, a completed run is worth knowing about, a heartbeat proves he is
 * alive. Six sprints later Teams is a firehose, everybody mutes the channel,
 * and the one message that mattered at 03:00 is scrolled past in the morning.
 *
 * The brief is unambiguous: "Teams notifications must not become a stream of
 * routine progress chatter", and "routine heartbeats/progress should stay in
 * the UI/logs unless requested". So the rule is stated once, here, and the
 * things NOT in the permitted list are as important as the things in it.
 * ---------------------------------------------------------------------------
 */

/** Why a notification is being considered. */
export const NOTIFICATION_TRIGGERS = [
  // Permitted to reach a person unprompted (§27).
  'blocker_raised',
  'approval_required',
  'question_required',
  'anomaly_detected',
  'high_priority_completed',
  'morning_report',

  // Recorded, never pushed. Named so that the reason they are absent from the
  // permitted list is a decision on the record rather than an omission.
  'run_started',
  'run_progress',
  'stage_changed',
  'run_completed',
  'artefact_created',
  'heartbeat',
  'task_created',
  'night_shift_started',
  'night_shift_ended',
] as const;
export type NotificationTrigger = (typeof NOTIFICATION_TRIGGERS)[number];

interface PolicyEntry {
  /** May this reach a person without them having asked? */
  proactive: boolean;
  outboundKind: OutboundKind;
  /** Why, in one sentence. Read by the audit event when one is suppressed. */
  rationale: string;
}

const POLICY: Record<NotificationTrigger, PolicyEntry> = {
  blocker_raised: {
    proactive: true,
    outboundKind: 'blocker',
    rationale: 'A blocker is work stopping for a reason only a person can clear.',
  },
  approval_required: {
    proactive: true,
    outboundKind: 'approval_request',
    rationale: 'Nothing proceeds until somebody decides, so the decision has to reach them.',
  },
  question_required: {
    proactive: true,
    outboundKind: 'question',
    rationale: 'Mac is waiting on an answer and will otherwise assume or stop.',
  },
  anomaly_detected: {
    proactive: true,
    outboundKind: 'notice',
    rationale: 'Something happened that nobody predicted, which is worth interrupting for.',
  },
  high_priority_completed: {
    proactive: true,
    outboundKind: 'notice',
    rationale: 'Work somebody marked urgent finished, and they are probably waiting on it.',
  },
  morning_report: {
    proactive: true,
    outboundKind: 'report',
    rationale: 'The one scheduled summary, and separately switchable because it is already emailed.',
  },

  run_started: {
    proactive: false,
    outboundKind: 'notice',
    rationale: 'Visible on the dashboard. Nobody needs telling that work Mac was told to do has begun.',
  },
  run_progress: {
    proactive: false,
    outboundKind: 'notice',
    rationale: 'This is the definition of routine progress chatter.',
  },
  stage_changed: {
    proactive: false,
    outboundKind: 'notice',
    rationale: 'An internal state transition. Interesting to Mac, not to a person.',
  },
  run_completed: {
    proactive: false,
    outboundKind: 'notice',
    rationale:
      'In the morning report and on the dashboard. An ordinary completion at 02:00 is not worth a ' +
      'notification at 02:00 — only a high-priority one is, which is a separate trigger.',
  },
  artefact_created: {
    proactive: false,
    outboundKind: 'notice',
    rationale: 'Listed against the run and in the report.',
  },
  heartbeat: {
    proactive: false,
    outboundKind: 'notice',
    rationale: 'A liveness signal between machines. It has no human reader.',
  },
  task_created: {
    proactive: false,
    outboundKind: 'notice',
    rationale: 'The person who created it already knows.',
  },
  night_shift_started: {
    proactive: false,
    outboundKind: 'notice',
    rationale: 'It starts every night. A notification that fires nightly is one people learn to ignore.',
  },
  night_shift_ended: {
    proactive: false,
    outboundKind: 'notice',
    rationale: 'The morning report is the end-of-shift communication.',
  },
};

export interface NotificationDecision {
  send: boolean;
  outboundKind: OutboundKind;
  /** Why it is or is not being sent. Recorded when suppressed. */
  rationale: string;
}

/**
 * Whether this notification may be pushed.
 *
 * `settingEnabled` is the deployment's own switch on top of the policy. Both
 * must agree: policy says whether a class of thing is EVER proactive, and the
 * setting says whether this deployment wants it. Policy is not overridable by a
 * setting in the other direction — there is no configuration that turns on
 * progress chatter, because there is no field for it.
 */
export function decideNotification(input: {
  trigger: NotificationTrigger;
  settingEnabled?: boolean;
  /** Set for triggers whose relevance depends on the work, e.g. priority. */
  highPriority?: boolean;
}): NotificationDecision {
  const entry = POLICY[input.trigger];

  if (!entry.proactive) {
    return { send: false, outboundKind: entry.outboundKind, rationale: entry.rationale };
  }

  if (input.trigger === 'high_priority_completed' && input.highPriority === false) {
    return {
      send: false,
      outboundKind: entry.outboundKind,
      rationale: 'The work completed normally and was not high priority.',
    };
  }

  if (input.settingEnabled === false) {
    return {
      send: false,
      outboundKind: entry.outboundKind,
      rationale: 'This deployment has switched off proactive notification for this class.',
    };
  }

  return { send: true, outboundKind: entry.outboundKind, rationale: entry.rationale };
}

/** Triggers that may ever reach a person unprompted. For the settings page. */
export const PROACTIVE_TRIGGERS: readonly NotificationTrigger[] = NOTIFICATION_TRIGGERS.filter(
  (trigger) => POLICY[trigger].proactive,
);
