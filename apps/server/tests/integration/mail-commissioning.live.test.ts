import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { MailProvider, MailSendResult, OutboundMail, OvernightEmailContent } from '@mac/protocol';
import { asUser, closePool, createAndLogin, resetDatabase, startTestApp, type Session } from '../helpers/harness.js';
import { db } from '../../src/db/client.js';
import { emailDeliveries, nightShifts } from '../../src/db/schema.js';
import { queryAuditEvents } from '../../src/services/audit-query.js';
import { FakeMailProvider, GraphMailProvider, setMailProvider } from '../../src/services/mail/provider.js';
import {
  deliverPendingEmails,
  listEmailDeliveries,
  queueOvernightEmail,
  resolveRecipients,
} from '../../src/services/mail/delivery.js';

/**
 * The REAL mailbox — Microsoft Graph — commissioning (brief §7, §8, §9).
 *
 * Opt-in and skipped by default: it sends actual email to an actual person.
 *
 *   MAC_MAIL_LIVE_TEST=1
 *   MAC_MAIL_TENANT_ID=...        Entra tenant (directory) id
 *   MAC_MAIL_CLIENT_ID=...        app registration (application) id
 *   MAC_MAIL_CLIENT_SECRET=...    a client secret on that registration
 *   MAC_MAIL_FROM=...             the mailbox Mac sends from
 *   MAC_MAIL_TEST_RECIPIENT=...   an APPROVED INTERNAL address, nobody external
 *
 * The service principal needs Exchange Online Application RBAC role
 * `Application Mail.Send`, restricted to the commissioning mailbox. Do not add
 * an unscoped Entra `Mail.Send` grant as well: the grants are additive.
 *
 * Exactly TWO real emails are sent by this file: one morning report, and one
 * that fails on its first attempt and succeeds on retry. Everything else is
 * asserted against the delivery table, because "did it send twice?" is a
 * question about rows rather than about a mailbox.
 */

const ENABLED = process.env.MAC_MAIL_LIVE_TEST === '1';
const TENANT = process.env.MAC_MAIL_TENANT_ID ?? '';
const CLIENT = process.env.MAC_MAIL_CLIENT_ID ?? '';
const SECRET = process.env.MAC_MAIL_CLIENT_SECRET ?? '';
const FROM = process.env.MAC_MAIL_FROM ?? '';
const RECIPIENT = process.env.MAC_MAIL_TEST_RECIPIENT ?? '';

const runnable = ENABLED && Boolean(TENANT && CLIENT && SECRET && FROM && RECIPIENT);

if (ENABLED && !runnable) {
  // eslint-disable-next-line no-console
  console.warn(
    '\n*** MAC_MAIL_LIVE_TEST=1 but the live mailbox test cannot run ***\n' +
      'Set MAC_MAIL_TENANT_ID, MAC_MAIL_CLIENT_ID, MAC_MAIL_CLIENT_SECRET, MAC_MAIL_FROM ' +
      'and MAC_MAIL_TEST_RECIPIENT.\n',
  );
}

/**
 * The real Graph provider, wrapped so the test can count what actually left the
 * building and can fail an attempt without touching the provider's own code.
 *
 * Counting is the point. Every duplicate-prevention claim in §7 is really the
 * claim "the provider was called once", and only a wrapper can witness that.
 */
class CountingGraphProvider implements MailProvider {
  readonly name = 'graph' as const;
  readonly accepted: OutboundMail[] = [];
  /** Attempts that reached the provider at all, including the failed ones. */
  attempts = 0;
  failNext = 0;

  constructor(private readonly inner: GraphMailProvider) {}

  async isAvailable() {
    return this.inner.isAvailable();
  }

  async send(message: OutboundMail): Promise<MailSendResult> {
    this.attempts += 1;
    if (this.failNext > 0) {
      this.failNext -= 1;
      // A transient network failure, not a rejection: retryable, and crucially
      // NOT delivered, so a retry that duplicated would be visible.
      return { accepted: false, providerMessageId: null, error: 'Injected transient failure.', retryable: true };
    }
    const result = await this.inner.send(message);
    if (result.accepted) this.accepted.push(message);
    return result;
  }
}

let app: FastifyInstance;
let close: () => Promise<void>;
let admin: Session;
let fakeProvider: FakeMailProvider;

const TEST_SHIFT_IDS = [
  '33333333-3333-3333-3333-333333333333',
  '44444444-4444-4444-4444-444444444444',
  '55555555-5555-5555-5555-555555555555',
  '66666666-6666-6666-6666-666666666666',
  '77777777-7777-7777-7777-777777777777',
  '88888888-8888-8888-8888-888888888888',
  '99999999-9999-9999-9999-999999999999',
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
];

const content = (nightShiftId: string): OvernightEmailContent => ({
  nightShiftId,
  generatedAt: new Date().toISOString(),
  windowStart: new Date(Date.now() - 6 * 3_600_000).toISOString(),
  windowEnd: new Date().toISOString(),
  completed: [
    {
      task: 'Add a --json flag to the summarise command',
      project: 'Shiftlog (commissioning)',
      summary: 'Added the flag, kept the human table byte-identical, added a unit test.',
      runId: '11111111-1111-1111-1111-111111111111',
    },
  ],
  inProgress: [],
  blocked: [
    {
      task: 'Round invoice totals to match the finance system',
      project: 'Shiftlog (commissioning)',
      blocker: 'Nobody knows which rounding rule the finance system uses.',
      needs: 'Confirm half-up or banker’s rounding, and the number of decimal places.',
      runId: '22222222-2222-2222-2222-222222222222',
    },
  ],
  whatChanged: ['`summarise --json` now exists.', 'A negative duration is rejected instead of silently totalling.'],
  pullRequests: [
    {
      url: 'https://github.com/KasperPac/mac-commissioning-sprint-3-1/pull/1',
      title: 'Add a --json flag to the summarise command',
      summary: 'One flag, one test, no change to the default output.',
    },
  ],
  decisionsNeeded: ['Which rounding rule does the finance system use?'],
  exceptions: [],
  lowConfidenceAssumptions: [
    { statement: 'JSON goes to stdout with no trailing text.', confidence: 0.72, task: 'Add a --json flag' },
  ],
  estimatedHumanHours: { total: 1.5, byTask: [{ task: 'Add a --json flag', hours: 0.75 }] },
  usage: {
    label: 'Claude Code subscription usage',
    source: 'estimated',
    note: 'An internal estimate. NOT money billed and not an enforceable dollar figure.',
  },
  monday: { itemsUpdated: 3, statusChanges: 4, updatesPosted: 5, failures: 0 },
  dashboardUrl: 'http://localhost:5173/runs',
});

const useRealGraph = (): CountingGraphProvider => {
  const provider = new CountingGraphProvider(
    new GraphMailProvider({ tenantId: TENANT, clientId: CLIENT, clientSecret: SECRET, from: FROM }),
  );
  setMailProvider(provider);
  return provider;
};

beforeAll(async () => {
  if (!runnable) return;
  ({ fastify: app, close } = await startTestApp());
}, 120_000);

afterAll(async () => {
  if (!runnable) return;
  setMailProvider(null);
  await close();
  await closePool();
});

beforeEach(async () => {
  if (!runnable) return;
  await resetDatabase();
  admin = await createAndLogin(app, { email: 'admin@pac.test', name: 'Admin', role: 'admin' });

  fakeProvider = new FakeMailProvider();
  setMailProvider(fakeProvider);

  await asUser(app, admin).patch('/api/settings', {
    mailProvider: 'graph',
    reportRecipients: [RECIPIENT],
    allowedRecipientDomains: [RECIPIENT.split('@')[1]!],
  });

  await db.insert(nightShifts).values(
    TEST_SHIFT_IDS.map((id) => ({
      id,
      cutoffAt: new Date(Date.now() + 6 * 3_600_000),
      settingsSnapshot: {},
    })),
  );
});

// ---------------------------------------------------------------------------
// §7.1–7.7 — authentication, send, persistence, audit
// ---------------------------------------------------------------------------

describe.skipIf(!runnable)('the real mailbox', () => {
  it('authenticates against Entra and Graph', async () => {
    const provider = useRealGraph();
    const availability = await provider.isAvailable();
    expect(availability.available, availability.reason).toBe(true);
  }, 60_000);

  it('sends a real morning report, records its status, and audits it', async () => {
    const provider = useRealGraph();
    const shiftId = '33333333-3333-3333-3333-333333333333';
    const queued = await queueOvernightEmail(shiftId, content(shiftId));
    expect(queued.status).toBe('pending');

    const outcome = await deliverPendingEmails();
    expect(outcome.sent).toBe(1);
    expect(provider.accepted).toHaveLength(1);

    const [row] = await db.select().from(emailDeliveries).where(eq(emailDeliveries.id, queued.id));
    expect(row!.status).toBe('sent');
    expect(row!.sentAt).not.toBeNull();

    const sent = provider.accepted[0]!;
    expect(sent.subject.length).toBeGreaterThan(10);
    expect(sent.subject.length).toBeLessThan(200);
    expect(sent.to).toEqual([RECIPIENT]);

    const body = sent.text;
    expect(body).toMatch(/blocked|blocker/i);
    expect(body).toMatch(/pull request/i);
    expect(body).toMatch(/hours/i);
    expect(body).toContain('https://github.com/');
    expect(body).toMatch(/NOT money billed|not billed/i);
    expect(body).not.toMatch(/\bat .*\(.*:\d+:\d+\)/);

    /*
     * Graph's sendMail answers 202 with an empty body and no message id, so the
     * honest record is null. A fabricated id would look like proof of delivery
     * in the one table that exists to say whether delivery happened — which is
     * why this asserts the absence rather than skipping the question.
     */
    expect(row!.providerMessageId).toBeNull();

    const audited = (await queryAuditEvents({ limit: 200, offset: 0 })).map((e) => e.eventType);
    expect(audited).toContain('report.email_attempted');
    expect(audited).toContain('report.email_delivered');
  }, 180_000);

});

// ---------------------------------------------------------------------------
// §7.4 — the allowlist
// ---------------------------------------------------------------------------

describe.skipIf(!runnable)('recipients', () => {
  it('refuses an address outside the allowed domains, and audits the refusal', async () => {
    // The API already refuses to create this state. Seed it directly to prove
    // the send path still protects restored or manually edited data.
    await db.execute(sql`
      UPDATE settings
      SET report_recipients = ${JSON.stringify([RECIPIENT, 'someone@customer.example'])}::jsonb,
          allowed_recipient_domains = ${JSON.stringify([RECIPIENT.split('@')[1]!])}::jsonb
      WHERE id = 1
    `);

    const resolution = await resolveRecipients();
    expect(resolution.recipients).toEqual([RECIPIENT]);
    expect(resolution.refused).toEqual(['someone@customer.example']);

    const shiftId = '55555555-5555-5555-5555-555555555555';
    await queueOvernightEmail(shiftId, content(shiftId));

    const audited = (await queryAuditEvents({ limit: 200, offset: 0 })).map((e) => e.eventType);
    expect(audited).toContain('report.email_recipient_refused');
  }, 120_000);

  it('is dead on arrival, not pending forever, when nobody is allowed', async () => {
    await asUser(app, admin).patch('/api/settings', {
      reportRecipients: [],
      allowedRecipientDomains: [RECIPIENT.split('@')[1]!],
    });

    const shiftId = '66666666-6666-6666-6666-666666666666';
    const queued = await queueOvernightEmail(shiftId, content(shiftId));

    // A configuration problem, visible on the Reports screen as one.
    expect(queued.status).toBe('dead');
    expect(fakeProvider.sent).toHaveLength(0);
  }, 120_000);

  it('has no code path that could reach an arbitrary address', () => {
    // Asserted on the function's own shape, because "we do not send external
    // email" is a property worth having structurally rather than by discipline.
    expect(queueOvernightEmail.length).toBeLessThanOrEqual(3);
    const source = queueOvernightEmail.toString();
    expect(source).not.toMatch(/\bto\b\s*[:=]/);
  });
});

// ---------------------------------------------------------------------------
// §7.8–7.10 — retry, idempotency, and the duplicate that must never happen
// ---------------------------------------------------------------------------

describe.skipIf(!runnable)('exactly once', () => {
  it('queues the same report twice and gets the same row', async () => {
    const shiftId = '77777777-7777-7777-7777-777777777777';
    const first = await queueOvernightEmail(shiftId, content(shiftId));
    const second = await queueOvernightEmail(shiftId, content(shiftId));

    expect(second.id).toBe(first.id);
    expect((await listEmailDeliveries(50)).filter((d) => d.nightShiftId === shiftId)).toHaveLength(1);
  }, 120_000);

  it('retries a transient failure and still delivers exactly one email', async () => {
    const provider = useRealGraph();
    const shiftId = '88888888-8888-8888-8888-888888888888';
    await queueOvernightEmail(shiftId, content(shiftId));

    provider.failNext = 1;
    const first = await deliverPendingEmails();
    expect(first.sent).toBe(0);
    expect(provider.accepted).toHaveLength(0);

    // The row records the failure rather than losing it.
    const [failed] = await db.select().from(emailDeliveries).where(eq(emailDeliveries.nightShiftId, shiftId));
    expect(failed!.status).toBe('failed');
    expect(failed!.attempts).toBeGreaterThan(0);
    expect(failed!.lastError).toContain('Injected transient failure');

    // Backoff is real, so the retry is driven by moving the clock forward
    // rather than by sleeping through it.
    const later = new Date(Date.now() + 60 * 60_000);
    const second = await deliverPendingEmails(later);
    expect(second.sent).toBe(1);

    // TWO provider attempts, ONE delivered email. That is the whole claim.
    expect(provider.attempts).toBe(2);
    expect(provider.accepted).toHaveLength(1);
  }, 240_000);

  it('never sends a report that has already been sent, however often it is swept', async () => {
    const shiftId = '99999999-9999-9999-9999-999999999999';
    await queueOvernightEmail(shiftId, content(shiftId));

    await deliverPendingEmails();
    expect(fakeProvider.sent).toHaveLength(1);

    // A restarted process, an overlapping scheduler, a nervous operator.
    await deliverPendingEmails();
    await deliverPendingEmails(new Date(Date.now() + 24 * 3_600_000));
    await queueOvernightEmail(shiftId, content(shiftId));
    await deliverPendingEmails();

    expect(fakeProvider.sent).toHaveLength(1);
  }, 240_000);

  it('survives two sweepers racing, because the constraint is in the database', async () => {
    const shiftId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    await queueOvernightEmail(shiftId, content(shiftId));

    // Concurrent drains. `sending` and the attempt count are written BEFORE the
    // provider call precisely so this cannot double-send.
    await Promise.all([deliverPendingEmails(), deliverPendingEmails(), deliverPendingEmails()]);

    expect(fakeProvider.sent).toHaveLength(1);
  }, 240_000);
});
