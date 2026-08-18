import { and, asc, desc, eq, inArray, lte, sql } from 'drizzle-orm';
import {
  EMAIL_MAX_ATTEMPTS,
  nextEmailAttemptDelaySeconds,
  type EmailDeliveryDto,
  type EmailDeliveryKind,
  type EmailDeliveryStatus,
  type OvernightEmailContent,
} from '@mac/protocol';
import { db, type DbHandle } from '../../db/client.js';
import { emailDeliveries } from '../../db/schema.js';
import type { EmailDeliveryRow } from '../../db/schema.js';
import { AppError } from '../../http/errors.js';
import { record, recordRejection, SYSTEM_ACTOR, type Actor } from '../audit.js';
import { getSettings } from '../settings.js';
import { getMailProvider } from './provider.js';
import {
  renderOvernightEmailHtml,
  renderOvernightEmailSubject,
  renderOvernightEmailText,
} from '../../domain/overnight-email.js';

/**
 * Email delivery (Sprint 3 §9).
 *
 * ---------------------------------------------------------------------------
 * THE RECIPIENT GUARDRAIL, AS A SHAPE RATHER THAN A CHECK
 *
 * Look at what `queueOvernightEmail` takes: a night-shift id and a content
 * structure. There is no recipient parameter — not here, not on the provider
 * call site, not anywhere between them. Recipients are resolved from settings
 * immediately before sending.
 *
 * That is the structural version of "do not allow arbitrary recipients from
 * task prompts", and it is why external customer-facing email is not merely
 * disallowed in Sprint 3 but unreachable: there is no argument through which a
 * task description, a brief, a monday item or a coding agent could introduce an
 * address.
 * ---------------------------------------------------------------------------
 */

export const toEmailDeliveryDto = (row: EmailDeliveryRow): EmailDeliveryDto => ({
  id: row.id,
  kind: row.kind as EmailDeliveryKind,
  nightShiftId: row.nightShiftId,
  runId: row.runId,
  recipients: Array.isArray(row.recipients) ? (row.recipients as string[]) : [],
  subject: row.subject,
  status: row.status as EmailDeliveryStatus,
  attempts: row.attempts,
  provider: row.provider,
  providerMessageId: row.providerMessageId,
  lastError: row.lastError,
  nextAttemptAt: row.nextAttemptAt.toISOString(),
  createdAt: row.createdAt.toISOString(),
  sentAt: row.sentAt?.toISOString() ?? null,
});

// ---------------------------------------------------------------------------
// Recipients
// ---------------------------------------------------------------------------

export interface RecipientResolution {
  recipients: string[];
  refused: string[];
  reason: string | null;
}

/**
 * Who the morning report goes to.
 *
 * The configured list, intersected with the configured domain allowlist. An
 * address outside the allowlist is refused and audited rather than silently
 * dropped — a report that quietly went to four of five people is worse than one
 * that says so.
 */
export async function resolveRecipients(): Promise<RecipientResolution> {
  const settings = await getSettings();
  const configured = settings.reportRecipients;
  const domains = settings.allowedRecipientDomains.map((d) => d.trim().toLowerCase());

  if (configured.length === 0) {
    return { recipients: [], refused: [], reason: 'No report recipients are configured.' };
  }

  if (domains.length === 0) return { recipients: configured, refused: [], reason: null };

  const recipients: string[] = [];
  const refused: string[] = [];
  for (const address of configured) {
    const domain = address.split('@')[1]?.toLowerCase() ?? '';
    if (domains.includes(domain)) recipients.push(address);
    else refused.push(address);
  }

  return {
    recipients,
    refused,
    reason: recipients.length === 0 ? 'Every configured recipient is outside the allowed domains.' : null,
  };
}

// ---------------------------------------------------------------------------
// Queueing
// ---------------------------------------------------------------------------

export interface QueueEmailInput {
  kind: EmailDeliveryKind;
  nightShiftId?: string | null;
  runId?: string | null;
  /** Must be stable for the same logical email. The UNIQUE constraint uses it. */
  idempotencyKey: string;
  subject: string;
  text: string;
  html?: string;
  content?: Record<string, unknown>;
}

/**
 * Creates a delivery, or returns the existing one.
 *
 * The idempotency key is a UNIQUE column, so "do not send this twice" is a
 * database constraint rather than a caller remembering to check. A second call
 * with the same key finds the first row — including one already `sent`, which is
 * never sent again.
 */
export async function queueEmail(input: QueueEmailInput, actor: Actor = SYSTEM_ACTOR): Promise<EmailDeliveryDto> {
  const resolution = await resolveRecipients();
  const provider = await getMailProvider();

  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(emailDeliveries)
      .where(eq(emailDeliveries.idempotencyKey, input.idempotencyKey))
      .limit(1);

    if (existing) return toEmailDeliveryDto(existing);

    if (resolution.refused.length > 0) {
      await recordRejection(db, {
        actor,
        eventType: 'report.email_recipient_refused',
        metadata: {
          refused: resolution.refused,
          reason: 'Outside the configured allowed domains.',
          idempotencyKey: input.idempotencyKey,
        },
      });
    }

    const [row] = await tx
      .insert(emailDeliveries)
      .values({
        kind: input.kind,
        nightShiftId: input.nightShiftId ?? null,
        runId: input.runId ?? null,
        idempotencyKey: input.idempotencyKey,
        recipients: resolution.recipients,
        subject: input.subject.slice(0, 500),
        bodyText: input.text,
        bodyHtml: input.html ?? null,
        content: input.content ?? {},
        // A delivery with nobody to send to is `dead` on arrival rather than
        // pending forever: it is a configuration problem, and it should be
        // visible as one on the Reports screen.
        status: resolution.recipients.length === 0 ? 'dead' : 'pending',
        lastError: resolution.recipients.length === 0 ? resolution.reason : null,
        provider: provider.name,
      })
      .returning();
    if (!row) throw new AppError(500, 'EMAIL_QUEUE_FAILED', 'Could not queue the email.');

    await record(tx, {
      actor,
      eventType: 'report.email_attempted',
      context: { runId: input.runId ?? null },
      metadata: {
        deliveryId: row.id,
        kind: input.kind,
        recipients: resolution.recipients.length,
        refused: resolution.refused.length,
        provider: provider.name,
        idempotencyKey: input.idempotencyKey,
      },
    });

    return toEmailDeliveryDto(row);
  });
}

/**
 * The morning report for a night shift.
 *
 * The key is the shift id, so a night produces exactly one email however many
 * times this is called — by the tick that ends the shift, by an operator
 * pressing the button, or by a retry.
 */
export async function queueOvernightEmail(
  nightShiftId: string,
  content: OvernightEmailContent,
  actor: Actor = SYSTEM_ACTOR,
): Promise<EmailDeliveryDto> {
  return queueEmail(
    {
      kind: 'morning_report',
      nightShiftId,
      idempotencyKey: `morning-report:${nightShiftId}`,
      subject: renderOvernightEmailSubject(content),
      text: renderOvernightEmailText(content),
      html: renderOvernightEmailHtml(content),
      content: content as unknown as Record<string, unknown>,
    },
    actor,
  );
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

export interface MailSweepOutcome {
  sent: number;
  failed: number;
  dead: number;
}

export async function deliverPendingEmails(now = new Date(), actor: Actor = SYSTEM_ACTOR): Promise<MailSweepOutcome> {
  const due = await db
    .select()
    .from(emailDeliveries)
    .where(
      and(
        inArray(emailDeliveries.status, ['pending', 'failed']),
        lte(emailDeliveries.nextAttemptAt, now),
        sql`${emailDeliveries.attempts} < ${EMAIL_MAX_ATTEMPTS}`,
      ),
    )
    .orderBy(asc(emailDeliveries.createdAt))
    .limit(20);

  const outcome: MailSweepOutcome = { sent: 0, failed: 0, dead: 0 };
  const provider = await getMailProvider();

  for (const delivery of due) {
    const attempts = delivery.attempts + 1;
    const recipients = Array.isArray(delivery.recipients) ? (delivery.recipients as string[]) : [];

    /*
     * Claim with a compare-and-swap, not an unconditional update.
     *
     * Several workers can select the same due row before any of them writes.
     * Only the first update may move the exact status/attempt pair to
     * `sending`; every loser gets no row back and must not call the provider.
     */
    const [claimed] = await db
      .update(emailDeliveries)
      .set({
        status: recipients.length === 0 ? 'dead' : 'sending',
        attempts,
        ...(recipients.length === 0 ? { lastError: 'No recipients.' } : {}),
      })
      .where(
        and(
          eq(emailDeliveries.id, delivery.id),
          inArray(emailDeliveries.status, ['pending', 'failed']),
          eq(emailDeliveries.attempts, delivery.attempts),
          lte(emailDeliveries.nextAttemptAt, now),
        ),
      )
      .returning();

    if (!claimed) continue;

    if (recipients.length === 0) {
      outcome.dead += 1;
      continue;
    }

    /*
     * `sending` is written BEFORE the provider call.
     *
     * A process that dies mid-send then leaves a row that says so, rather than
     * an ambiguous `pending` that a later sweep would happily send again. The
     * attempt count is part of the same write, so the retry budget is consumed
     * whether or not the process survives.
     */
    const result = await provider.send({
      to: recipients,
      subject: delivery.subject,
      text: delivery.bodyText,
      ...(delivery.bodyHtml ? { html: delivery.bodyHtml } : {}),
      idempotencyKey: delivery.idempotencyKey,
    });

    if (result.accepted) {
      await db.transaction(async (tx) => {
        await tx
          .update(emailDeliveries)
          .set({
            status: 'sent',
            sentAt: new Date(),
            providerMessageId: result.providerMessageId,
            provider: provider.name,
            lastError: null,
          })
          .where(eq(emailDeliveries.id, delivery.id));

        await record(tx, {
          actor,
          eventType: 'report.email_delivered',
          context: { runId: delivery.runId },
          metadata: {
            deliveryId: delivery.id,
            recipients: recipients.length,
            provider: provider.name,
            providerMessageId: result.providerMessageId,
            attempts,
          },
        });
      });
      outcome.sent += 1;
      continue;
    }

    const exhausted = !result.retryable || attempts >= EMAIL_MAX_ATTEMPTS;
    await db
      .update(emailDeliveries)
      .set({
        status: exhausted ? 'dead' : 'failed',
        lastError: (result.error ?? 'Unknown error').slice(0, 2000),
        nextAttemptAt: new Date(now.getTime() + nextEmailAttemptDelaySeconds(attempts) * 1000),
        provider: provider.name,
      })
      .where(eq(emailDeliveries.id, delivery.id));

    if (exhausted) {
      // Dead-lettered and visible on the Reports screen, rather than retried
      // forever where nobody would notice the report never arrived.
      await recordRejection(db, {
        actor,
        eventType: 'report.email_failed',
        context: { runId: delivery.runId },
        metadata: {
          deliveryId: delivery.id,
          attempts,
          provider: provider.name,
          reason: (result.error ?? 'Unknown error').slice(0, 500),
        },
      });
      outcome.dead += 1;
    } else {
      outcome.failed += 1;
    }
  }

  return outcome;
}

/** Puts a dead delivery back in the queue. An operator action, always audited. */
export async function retryEmailDelivery(id: string, actor: Actor): Promise<EmailDeliveryDto> {
  return db.transaction(async (tx) => {
    const [existing] = await tx.select().from(emailDeliveries).where(eq(emailDeliveries.id, id)).limit(1);
    if (!existing) throw AppError.notFound('Email delivery');
    if (existing.status === 'sent') {
      throw AppError.conflict('EMAIL_ALREADY_SENT', 'That report has already been delivered; it will not be sent again.');
    }

    // Recipients are re-resolved, so fixing the configuration and retrying
    // works without editing the row by hand.
    const resolution = await resolveRecipients();

    const [row] = await tx
      .update(emailDeliveries)
      .set({
        status: resolution.recipients.length ? 'pending' : 'dead',
        attempts: 0,
        nextAttemptAt: new Date(),
        recipients: resolution.recipients,
        lastError: resolution.recipients.length ? null : resolution.reason,
      })
      .where(eq(emailDeliveries.id, id))
      .returning();

    await record(tx, {
      actor,
      eventType: 'report.email_attempted',
      metadata: { deliveryId: id, retry: true, recipients: resolution.recipients.length },
    });

    return toEmailDeliveryDto(row ?? existing);
  });
}

export async function listEmailDeliveries(limit = 50): Promise<EmailDeliveryDto[]> {
  const rows = await db.select().from(emailDeliveries).orderBy(desc(emailDeliveries.createdAt)).limit(limit);
  return rows.map(toEmailDeliveryDto);
}

export async function getEmailDelivery(id: string, handle: DbHandle = db): Promise<EmailDeliveryDto | null> {
  const [row] = await handle.select().from(emailDeliveries).where(eq(emailDeliveries.id, id)).limit(1);
  return row ? toEmailDeliveryDto(row) : null;
}
