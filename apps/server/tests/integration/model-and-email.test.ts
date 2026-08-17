import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import {
  asUser,
  closePool,
  createAndLogin,
  resetDatabase,
  startTestApp,
  type Session,
} from '../helpers/harness.js';
import { db } from '../../src/db/client.js';
import { emailDeliveries } from '../../src/db/schema.js';
import { queryAuditEvents } from '../../src/services/audit-query.js';
import { ScriptedModelProvider, setModelProvider } from '../../src/services/model/provider.js';
import { resolveAnswerWithModel } from '../../src/services/model/resolvers.js';
import { FakeMailProvider, setMailProvider } from '../../src/services/mail/provider.js';
import {
  deliverPendingEmails,
  listEmailDeliveries,
  queueEmail,
  resolveRecipients,
  retryEmailDelivery,
} from '../../src/services/mail/delivery.js';
import { SYSTEM_ACTOR } from '../../src/services/audit.js';

/**
 * Model-backed resolvers and email delivery (Sprint 3 §9, §10).
 *
 * The interesting model tests are adversarial: what happens when it fabricates
 * a citation, cites nothing, or returns rubbish. None of those can be written
 * against a real model, because a real model cannot be made to misbehave on
 * demand — which is what `ScriptedModelProvider` is for.
 */

let app: FastifyInstance;
let close: () => Promise<void>;
let admin: Session;
let mail: FakeMailProvider;

beforeAll(async () => {
  ({ fastify: app, close } = await startTestApp());
});

afterAll(async () => {
  setModelProvider(null);
  setMailProvider(null);
  await close();
  await closePool();
});

beforeEach(async () => {
  await resetDatabase();
  admin = await createAndLogin(app, { email: 'admin@pac.test', name: 'Admin', role: 'admin' });
  mail = new FakeMailProvider();
  setMailProvider(mail);
});

afterEach(() => {
  setModelProvider(null);
});

const asAdmin = () => asUser(app, admin);

const SOURCES = [
  { id: 's1', label: 'brief.constraints[0]', text: 'The CSV import format must not change.' },
  { id: 's2', label: 'project memory: test_framework', text: 'test_framework: Vitest' },
];

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

describe('the model may help, and may not decide', () => {
  it('accepts an answer that cites a source it was actually given', async () => {
    setModelProvider(
      new ScriptedModelProvider([
        JSON.stringify({ answer: 'Use Vitest.', reasoning: 'It is what the project uses.', citedSourceIds: ['s2'] }),
      ]),
    );

    const outcome = await resolveAnswerWithModel({ question: 'Which test framework?', sources: SOURCES });
    expect(outcome.answer).toBe('Use Vitest.');
    expect(outcome.citedSourceIds).toEqual(['s2']);
    expect(outcome.record.outcome).toBe('accepted');
    expect(outcome.record.fabricatedCitations).toBe(0);
  });

  it('DROPS a citation the model invented', async () => {
    setModelProvider(
      new ScriptedModelProvider([
        JSON.stringify({ answer: 'Use Jest.', reasoning: 'Source 9 says so.', citedSourceIds: ['s2', 's9'] }),
      ]),
    );

    const outcome = await resolveAnswerWithModel({ question: 'Which test framework?', sources: SOURCES });
    // An invented source is exactly what a reader would take as evidence.
    expect(outcome.citedSourceIds).toEqual(['s2']);
    expect(outcome.record.fabricatedCitations).toBe(1);
  });

  it('DISCARDS an answer whose citations were all invented', async () => {
    setModelProvider(
      new ScriptedModelProvider([
        JSON.stringify({ answer: 'Definitely use Jest.', reasoning: 'Sources 7 and 8.', citedSourceIds: ['s7', 's8'] }),
      ]),
    );

    const outcome = await resolveAnswerWithModel({ question: 'Which test framework?', sources: SOURCES });
    expect(outcome.answer).toBeNull();
    expect(outcome.record.outcome).toBe('rejected_no_valid_citation');
    expect(outcome.record.fabricatedCitations).toBe(2);
  });

  it('DISCARDS an answer that cites nothing at all', async () => {
    setModelProvider(
      new ScriptedModelProvider([JSON.stringify({ answer: 'Trust me.', reasoning: '', citedSourceIds: [] })]),
    );
    const outcome = await resolveAnswerWithModel({ question: 'Which test framework?', sources: SOURCES });
    expect(outcome.answer).toBeNull();
    expect(outcome.record.detail).toContain('no grounding');
  });

  it('has nowhere to put a confidence, so a claimed one is ignored', async () => {
    setModelProvider(
      new ScriptedModelProvider([
        JSON.stringify({
          answer: 'Use Vitest.',
          reasoning: 'Certain.',
          citedSourceIds: ['s2'],
          confidence: 0.99,
          decision: 'answered',
          risk: 'low',
        }),
      ]),
    );

    const outcome = await resolveAnswerWithModel({ question: 'Which test framework?', sources: SOURCES });
    // The extra fields simply do not exist on the parsed shape.
    expect(outcome).not.toHaveProperty('confidence');
    expect(JSON.stringify(outcome.record)).not.toContain('0.99');
  });

  it('rejects unparseable output rather than guessing at it', async () => {
    setModelProvider(new ScriptedModelProvider(['I think you should probably use Vitest, honestly.']));
    const outcome = await resolveAnswerWithModel({ question: 'Which test framework?', sources: SOURCES });
    expect(outcome.answer).toBeNull();
    expect(outcome.record.outcome).toBe('rejected_unparseable');
  });

  it('extracts JSON a model wrapped in prose', async () => {
    setModelProvider(
      new ScriptedModelProvider([
        'Sure! Here you go:\n```json\n{"answer":"Use Vitest.","reasoning":"","citedSourceIds":["s2"]}\n```\nHope that helps.',
      ]),
    );
    const outcome = await resolveAnswerWithModel({ question: 'Which test framework?', sources: SOURCES });
    expect(outcome.answer).toBe('Use Vitest.');
  });

  it('is off by default, and falls back rather than failing', async () => {
    setModelProvider(null);
    const outcome = await resolveAnswerWithModel({ question: 'Which test framework?', sources: SOURCES });
    expect(outcome.answer).toBeNull();
    expect(outcome.record.outcome).toBe('unavailable');
    expect(outcome.record.provider).toBe('none');
  });

  it('does not consult a model when there are no sources to ground an answer in', async () => {
    const scripted = new ScriptedModelProvider([JSON.stringify({ answer: 'x', reasoning: '', citedSourceIds: [] })]);
    setModelProvider(scripted);
    const outcome = await resolveAnswerWithModel({ question: 'Anything', sources: [] });
    expect(outcome.answer).toBeNull();
    expect(scripted.prompts).toHaveLength(0);
  });
});

describe('model-assisted discovery', () => {
  const CONVERSATION = [
    'I want the device selection screen changed so users can select multiple devices.',
    'At the moment it only accepts one, and the API needs to support the change too.',
  ];

  const runDiscovery = async () => {
    const project = (await asAdmin().post('/api/projects', { name: `P${Math.random()}` })).json().project;
    const session = (
      await asAdmin().post('/api/discovery', { projectId: project.id, title: 'Multi-device selection' })
    ).json().session;
    for (const message of CONVERSATION) {
      await asAdmin().post(`/api/discovery/${session.id}/messages`, { message });
    }
    const generated = await asAdmin().post(`/api/discovery/${session.id}/brief`, {});
    return { projectId: project.id, brief: generated.json().brief };
  };

  it('lets a model fill a field the sentence classifier left empty', async () => {
    await asAdmin().patch('/api/settings', { modelAssistEnabled: true, modelProvider: 'none' });
    setModelProvider(
      new ScriptedModelProvider([
        JSON.stringify({
          // Grounded: every distinctive word appears in what the engineer said.
          acceptanceCriteria: ['An operator can select multiple devices on the selection screen.'],
        }),
      ]),
    );

    const { projectId, brief } = await runDiscovery();
    expect(brief.content.acceptanceCriteria).toContain('An operator can select multiple devices on the selection screen.');

    const events = (await queryAuditEvents({ projectId, limit: 50, offset: 0 })).map((e) => e.eventType);
    expect(events).toContain('model.assisted_discovery');
  });

  it('DROPS a field nothing in the conversation supports', async () => {
    await asAdmin().patch('/api/settings', { modelAssistEnabled: true, modelProvider: 'none' });
    setModelProvider(
      new ScriptedModelProvider([
        JSON.stringify({
          acceptanceCriteria: ['The invoice reconciliation ledger must balance against the quarterly audit export.'],
        }),
      ]),
    );

    const { projectId, brief } = await runDiscovery();
    /*
     * An invented acceptance criterion would go on to RAISE the understanding
     * confidence that decides whether Mac may execute at all — which is the
     * worst possible place for a fabrication.
     */
    expect(JSON.stringify(brief.content)).not.toContain('reconciliation ledger');

    const event = (await queryAuditEvents({ projectId, limit: 50, offset: 0 })).find(
      (e) => e.eventType === 'model.assisted_discovery',
    );
    expect(event!.metadata.ungroundedFieldsDropped).toBe(1);
  });

  it('never overwrites a field the human actually filled', async () => {
    await asAdmin().patch('/api/settings', { modelAssistEnabled: true, modelProvider: 'none' });
    setModelProvider(
      new ScriptedModelProvider([
        JSON.stringify({ currentBehaviour: 'At the moment the screen accepts multiple devices already.' }),
      ]),
    );

    const { brief } = await runDiscovery();
    // The classifier put the engineer's own sentence in `currentBehaviour`; a
    // model rephrasing it might be tidier and might also be subtly different.
    expect(brief.content.currentBehaviour).toContain('At the moment it only accepts one');
  });

  it('does not consult a model at all when assistance is off', async () => {
    const scripted = new ScriptedModelProvider([JSON.stringify({ acceptanceCriteria: ['anything'] })]);
    setModelProvider(scripted);
    await asAdmin().patch('/api/settings', { modelAssistEnabled: false });

    await runDiscovery();
    expect(scripted.prompts).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

describe('recipients', () => {
  it('are the configured list, and nothing else', async () => {
    await asAdmin().patch('/api/settings', {
      reportRecipients: ['kasper@pac-technologies.com.au'],
      allowedRecipientDomains: ['pac-technologies.com.au'],
    });

    const resolution = await resolveRecipients();
    expect(resolution.recipients).toEqual(['kasper@pac-technologies.com.au']);
    expect(resolution.refused).toEqual([]);
  });

  it('cannot be set to an address outside the allowed domains', async () => {
    const response = await asAdmin().patch('/api/settings', {
      allowedRecipientDomains: ['pac-technologies.com.au'],
      reportRecipients: ['someone@customer.example'],
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe('RECIPIENT_DOMAIN_NOT_ALLOWED');
  });

  it('refuses, and audits, an address that is outside the allowlist at send time', async () => {
    /*
     * The API already refuses to CREATE this state — the test above proves it.
     * This is the defence in depth: the send path re-checks, so an address that
     * arrived some other way (a seeded row, a direct edit, a restored backup)
     * is still refused at the moment it would otherwise be used.
     */
    await db.execute(
      sql`UPDATE settings SET report_recipients = '["someone@customer.example"]'::jsonb,
          allowed_recipient_domains = '["pac-technologies.com.au"]'::jsonb WHERE id = 1`,
    );

    const resolution = await resolveRecipients();
    expect(resolution.recipients).toEqual([]);
    expect(resolution.refused).toEqual(['someone@customer.example']);

    await queueEmail({
      kind: 'morning_report',
      idempotencyKey: 'refused-test',
      subject: 'Overnight',
      text: 'Body',
    });

    const events = (await queryAuditEvents({ limit: 100, offset: 0 })).map((e) => e.eventType);
    expect(events).toContain('report.email_recipient_refused');
  });

  it('has no parameter through which a task could introduce an address', () => {
    /*
     * The structural guarantee, asserted as a shape rather than a behaviour.
     *
     * `queueEmail` takes a kind, a key, a subject and a body. There is no `to`.
     * Recipients are read from settings immediately before sending, so nothing
     * from a task description, a brief, a monday item or a coding agent can
     * reach the send path.
     */
    const parameters = queueEmail.length;
    expect(parameters).toBeLessThanOrEqual(2);
    expect(queueEmail.toString()).not.toMatch(/\binput\.(to|recipients)\b/);
  });
});

describe('delivery', () => {
  beforeEach(async () => {
    await asAdmin().patch('/api/settings', {
      reportRecipients: ['kasper@pac-technologies.com.au'],
      allowedRecipientDomains: ['pac-technologies.com.au'],
      mailProvider: 'fake',
    });
  });

  it('sends one morning report', async () => {
    await queueEmail({
      kind: 'morning_report',
      nightShiftId: null,
      idempotencyKey: 'morning-report:shift-1',
      subject: 'Mac overnight — 1 done',
      text: 'Overnight summary.',
    });

    const result = await deliverPendingEmails();
    expect(result.sent).toBe(1);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]!.to).toEqual(['kasper@pac-technologies.com.au']);

    const [row] = await db.select().from(emailDeliveries);
    expect(row!.status).toBe('sent');
    expect(row!.providerMessageId).toBe('fake-1');
    expect(row!.sentAt).not.toBeNull();
  });

  it('stores the provider message id and audits the delivery', async () => {
    await queueEmail({ kind: 'morning_report', idempotencyKey: 'k1', subject: 's', text: 't' });
    await deliverPendingEmails();

    const [delivery] = await listEmailDeliveries();
    expect(delivery!.providerMessageId).toBe('fake-1');

    const events = (await queryAuditEvents({ limit: 100, offset: 0 })).map((e) => e.eventType);
    expect(events).toContain('report.email_attempted');
    expect(events).toContain('report.email_delivered');
  });

  it('retries a transient failure and then delivers exactly once', async () => {
    mail.failNext = 1;
    await queueEmail({ kind: 'morning_report', idempotencyKey: 'k2', subject: 's', text: 't' });

    const first = await deliverPendingEmails();
    expect(first.sent).toBe(0);
    expect(first.failed).toBe(1);

    const later = new Date(Date.now() + 120_000);
    const second = await deliverPendingEmails(later);
    expect(second.sent).toBe(1);
    expect(mail.sent).toHaveLength(1);
  });

  it('does not send twice when the same report is queued again', async () => {
    const input = { kind: 'morning_report' as const, idempotencyKey: 'morning-report:shift-9', subject: 's', text: 't' };

    const first = await queueEmail(input);
    const second = await queueEmail(input);
    // The UNIQUE key means the second call finds the first row, so this is a
    // database constraint rather than a caller remembering to check.
    expect(second.id).toBe(first.id);

    await deliverPendingEmails();
    await deliverPendingEmails(new Date(Date.now() + 600_000));

    expect(mail.sent).toHaveLength(1);
    expect(await db.select().from(emailDeliveries)).toHaveLength(1);
  });

  it('never re-sends a delivery that already went out', async () => {
    await queueEmail({ kind: 'morning_report', idempotencyKey: 'k3', subject: 's', text: 't' });
    await deliverPendingEmails();
    await deliverPendingEmails(new Date(Date.now() + 3_600_000));
    expect(mail.sent).toHaveLength(1);
  });

  it('dead-letters after the attempt budget, and says so in the UI data', async () => {
    mail.failNext = 99;
    await queueEmail({ kind: 'morning_report', idempotencyKey: 'k4', subject: 's', text: 't' });

    let at = Date.now();
    for (let i = 0; i < 6; i += 1) {
      at += 3_600_000;
      await deliverPendingEmails(new Date(at));
    }

    const [delivery] = await listEmailDeliveries();
    expect(delivery!.status).toBe('dead');
    expect(delivery!.lastError).toBeTruthy();

    const events = (await queryAuditEvents({ limit: 100, offset: 0 })).map((e) => e.eventType);
    expect(events).toContain('report.email_failed');
  });

  it('lets an operator retry a dead delivery after fixing the configuration', async () => {
    await asAdmin().patch('/api/settings', { reportRecipients: [], allowedRecipientDomains: [] });
    const queued = await queueEmail({ kind: 'morning_report', idempotencyKey: 'k5', subject: 's', text: 't' });
    expect(queued.status).toBe('dead');

    await asAdmin().patch('/api/settings', {
      reportRecipients: ['kasper@pac-technologies.com.au'],
      allowedRecipientDomains: ['pac-technologies.com.au'],
    });

    const retried = await retryEmailDelivery(queued.id, SYSTEM_ACTOR);
    expect(retried.status).toBe('pending');
    expect(retried.recipients).toEqual(['kasper@pac-technologies.com.au']);

    await deliverPendingEmails();
    expect(mail.sent).toHaveLength(1);
  });

  it('refuses to retry a delivery that already succeeded', async () => {
    const queued = await queueEmail({ kind: 'morning_report', idempotencyKey: 'k6', subject: 's', text: 't' });
    await deliverPendingEmails();
    await expect(retryEmailDelivery(queued.id, SYSTEM_ACTOR)).rejects.toThrow(/already been delivered/);
  });

  it('is dead on arrival, visibly, when nobody is configured to receive it', async () => {
    await asAdmin().patch('/api/settings', { reportRecipients: [] });
    const queued = await queueEmail({ kind: 'morning_report', idempotencyKey: 'k7', subject: 's', text: 't' });

    // A configuration problem should look like one on the Reports screen,
    // rather than sitting pending forever.
    expect(queued.status).toBe('dead');
    expect(queued.lastError).toContain('No report recipients');
    expect(mail.sent).toHaveLength(0);
  });

  it('exposes deliveries to the UI', async () => {
    await queueEmail({ kind: 'morning_report', idempotencyKey: 'k8', subject: 'Overnight', text: 't' });
    await deliverPendingEmails();

    const response = await asAdmin().get('/api/reports/deliveries');
    expect(response.statusCode).toBe(200);
    const deliveries = response.json().deliveries;
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].subject).toBe('Overnight');
    expect(deliveries[0].status).toBe('sent');
  });
});

// ---------------------------------------------------------------------------
// The email itself
// ---------------------------------------------------------------------------

describe('the morning email', () => {
  it('carries every section the brief specifies, even when empty', async () => {
    const { renderOvernightEmailText } = await import('../../src/domain/overnight-email.js');
    const text = renderOvernightEmailText({
      nightShiftId: 's1',
      generatedAt: new Date().toISOString(),
      windowStart: new Date().toISOString(),
      windowEnd: new Date().toISOString(),
      completed: [],
      inProgress: [],
      blocked: [],
      whatChanged: [],
      pullRequests: [],
      decisionsNeeded: [],
      exceptions: [],
      lowConfidenceAssumptions: [],
      estimatedHumanHours: { total: 0, byTask: [] },
      usage: { label: 'Provider usage unavailable', source: 'unavailable', note: null },
      monday: { itemsUpdated: 0, statusChanges: 0, updatesPosted: 0, failures: 0 },
      dashboardUrl: 'http://localhost:5173/night-shift',
    });

    for (const heading of [
      'Overnight Summary',
      'What Changed',
      'Pull Requests',
      'Decisions Needed',
      'Exceptions / Anomalies',
      'Low-Confidence Assumptions',
      'Estimated Human Hours',
      'AI Usage',
      'monday.com',
    ]) {
      // A missing section reads as an oversight; "None." reads as an answer.
      expect(text, heading).toContain(heading);
    }
  });

  it('contains no log output, and links back for the detail', async () => {
    const { renderOvernightEmailText } = await import('../../src/domain/overnight-email.js');
    const text = renderOvernightEmailText({
      nightShiftId: 's1',
      generatedAt: new Date().toISOString(),
      windowStart: new Date().toISOString(),
      windowEnd: new Date().toISOString(),
      completed: [{ task: 'Multi-device selection', project: 'Portal', summary: 'Added multi-select.', runId: 'r1' }],
      inProgress: [],
      blocked: [],
      whatChanged: ['Multi-device selection: 4 files changed.'],
      pullRequests: [{ url: 'https://github.com/x/y/pull/1', title: 'Multi-device', summary: 'Ready.' }],
      decisionsNeeded: [],
      exceptions: [],
      lowConfidenceAssumptions: [],
      estimatedHumanHours: { total: 2, byTask: [{ task: 'Multi-device selection', hours: 2 }] },
      usage: { label: '1,000 in / 500 out tokens. Source: exact.', source: 'exact', note: null },
      monday: { itemsUpdated: 1, statusChanges: 2, updatesPosted: 2, failures: 0 },
      dashboardUrl: 'http://localhost:5173/night-shift',
    });

    expect(text).toContain('http://localhost:5173/night-shift');
    expect(text).not.toContain('[agent]');
    expect(text).not.toContain('stdout');
    // One line per completed task; spec §28's whole point.
    expect(text.split('\n').filter((l) => l.startsWith('- DONE'))).toHaveLength(1);
  });

  it('never renders a non-exact usage figure as an enforced dollar cap', async () => {
    const { renderOvernightEmailText } = await import('../../src/domain/overnight-email.js');
    const text = renderOvernightEmailText({
      nightShiftId: 's1',
      generatedAt: new Date().toISOString(),
      windowStart: new Date().toISOString(),
      windowEnd: new Date().toISOString(),
      completed: [],
      inProgress: [],
      blocked: [],
      whatChanged: [],
      pullRequests: [],
      decisionsNeeded: [],
      exceptions: [],
      lowConfidenceAssumptions: [],
      estimatedHumanHours: { total: 0, byTask: [] },
      usage: {
        label: '$1.20 equivalent API list price (not billed — subscription access). Source: estimated.',
        source: 'estimated',
        note: 'This is not an enforceable dollar figure.',
      },
      monday: { itemsUpdated: 0, statusChanges: 0, updatesPosted: 0, failures: 0 },
      dashboardUrl: 'http://localhost:5173/night-shift',
    });

    expect(text).toContain('not billed');
    expect(text).toContain('not an enforceable dollar figure');
  });
});
