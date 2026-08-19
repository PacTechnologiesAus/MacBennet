import { describe, expect, it } from 'vitest';
import {
  decideNotification,
  NOTIFICATION_TRIGGERS,
  PROACTIVE_TRIGGERS,
  type NotificationTrigger,
} from '../../src/domain/notification-policy.js';

/**
 * What Mac may push to a person (Phase 4 Part B §7, Part G §27).
 *
 * The half of this file that matters most is the second describe block. The
 * failure mode is gradual: every individual notification looks justified to
 * whoever adds it, and six sprints later Teams is a firehose and the one
 * message that mattered at 03:00 is scrolled past in the morning.
 */

describe('what may reach a person unprompted', () => {
  const permitted: NotificationTrigger[] = [
    'blocker_raised',
    'approval_required',
    'question_required',
    'anomaly_detected',
    'morning_report',
  ];

  for (const trigger of permitted) {
    it(`sends ${trigger.replace(/_/g, ' ')}`, () => {
      expect(decideNotification({ trigger }).send).toBe(true);
    });
  }

  it('sends a completion only when the work was high priority', () => {
    expect(decideNotification({ trigger: 'high_priority_completed', highPriority: true }).send).toBe(true);
    expect(decideNotification({ trigger: 'high_priority_completed', highPriority: false }).send).toBe(false);
  });
});

describe('what is recorded and never pushed', () => {
  const suppressed: NotificationTrigger[] = [
    'run_started',
    'run_progress',
    'stage_changed',
    'run_completed',
    'artefact_created',
    'heartbeat',
    'task_created',
    'night_shift_started',
    'night_shift_ended',
  ];

  for (const trigger of suppressed) {
    it(`does not send ${trigger.replace(/_/g, ' ')}`, () => {
      const decision = decideNotification({ trigger });
      expect(decision.send).toBe(false);
      // A suppression has to say why, because the audit event records it and
      // somebody will eventually ask why they were not told.
      expect(decision.rationale.length).toBeGreaterThan(10);
    });
  }

  it('has no configuration that turns routine progress into a notification', () => {
    /*
     * The property this file exists to hold. `settingEnabled` can only ever
     * switch a proactive class OFF; there is no value of it that makes progress
     * chatter proactive, because policy decides whether a class may EVER be
     * pushed and a setting decides whether this deployment wants it.
     */
    expect(decideNotification({ trigger: 'run_progress', settingEnabled: true }).send).toBe(false);
    expect(decideNotification({ trigger: 'heartbeat', settingEnabled: true }).send).toBe(false);
  });
});

describe('the deployment’s own switch', () => {
  it('can silence a class the policy permits', () => {
    expect(decideNotification({ trigger: 'morning_report', settingEnabled: false }).send).toBe(false);
    expect(decideNotification({ trigger: 'blocker_raised', settingEnabled: false }).send).toBe(false);
  });
});

describe('the table itself', () => {
  it('has an entry for every trigger, so none defaults to whichever branch ran', () => {
    for (const trigger of NOTIFICATION_TRIGGERS) {
      const decision = decideNotification({ trigger });
      expect(decision.outboundKind, trigger).toBeTruthy();
      expect(decision.rationale, trigger).toBeTruthy();
    }
  });

  it('keeps the proactive list short', () => {
    // Not a style preference. A notification channel is only useful while
    // people still read it, and the list growing is how that stops.
    expect(PROACTIVE_TRIGGERS.length).toBeLessThanOrEqual(6);
    expect(PROACTIVE_TRIGGERS).not.toContain('run_progress');
    expect(PROACTIVE_TRIGGERS).not.toContain('run_completed');
  });
});
