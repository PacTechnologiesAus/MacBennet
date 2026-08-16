import { z } from 'zod';

/**
 * Email delivery (Sprint 3 §9, spec §19, §28).
 *
 * Sprint 2 generated a morning report and left it in the database. Sprint 3
 * delivers it, and the three properties that matter for something sent on Mac's
 * behalf while nobody is watching are all encoded here:
 *
 *  * **Idempotent.** `idempotencyKey` is a UNIQUE column, so a duplicate send is
 *    prevented by the database rather than by a caller remembering to check.
 *  * **Retryable.** Delivery is an outbox row with attempts and a backoff, and a
 *    dead letter is visible in the UI rather than retried forever.
 *  * **Auditable.** Attempt, delivery, failure and refusal are all audit events.
 *
 * And one thing that is deliberately absent: there is no recipient parameter
 * anywhere a task, a brief, a monday item or a coding agent can reach. See
 * §9.3 — the send API takes a report, not an address.
 */

export const MAIL_PROVIDERS = ['graph', 'fake', 'none'] as const;
export const mailProviderSchema = z.enum(MAIL_PROVIDERS);
export type MailProviderName = z.infer<typeof mailProviderSchema>;

export const EMAIL_DELIVERY_KINDS = ['morning_report', 'night_shift_summary'] as const;
export const emailDeliveryKindSchema = z.enum(EMAIL_DELIVERY_KINDS);
export type EmailDeliveryKind = z.infer<typeof emailDeliveryKindSchema>;

export const EMAIL_DELIVERY_STATUSES = ['pending', 'sending', 'sent', 'failed', 'dead'] as const;
export const emailDeliveryStatusSchema = z.enum(EMAIL_DELIVERY_STATUSES);
export type EmailDeliveryStatus = z.infer<typeof emailDeliveryStatusSchema>;

/**
 * What a provider is handed.
 *
 * `to` is resolved by the control plane from configured settings immediately
 * before the call; it is never an argument that travelled in from anywhere else.
 */
export interface OutboundMail {
  to: string[];
  subject: string;
  text: string;
  html?: string;
  /** Passed to providers that support deduplication; also our own outbox key. */
  idempotencyKey: string;
}

export interface MailSendResult {
  accepted: boolean;
  providerMessageId: string | null;
  error?: string;
  /** False for a permanent rejection — a bad address will not become good. */
  retryable: boolean;
}

export interface MailProvider {
  readonly name: MailProviderName;
  isAvailable(): Promise<{ available: boolean; reason?: string }>;
  send(message: OutboundMail): Promise<MailSendResult>;
}

/** Backoff for a failed delivery. Bounded, then dead-lettered into the UI. */
export const EMAIL_MAX_ATTEMPTS = 5;
export const EMAIL_BACKOFF_SECONDS = [30, 120, 600, 1800] as const;

export function nextEmailAttemptDelaySeconds(attempts: number): number {
  const index = Math.max(0, Math.min(attempts - 1, EMAIL_BACKOFF_SECONDS.length - 1));
  return EMAIL_BACKOFF_SECONDS[index]!;
}

/**
 * A permissive but real address check.
 *
 * Deliberately not an RFC 5322 parser: the guard that matters is the configured
 * recipient list and its domain allowlist, and this only exists to keep obvious
 * rubbish out of the settings table.
 */
export const emailAddressSchema = z
  .string()
  .min(3)
  .max(320)
  .regex(/^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/, 'Must be an email address');

// ---------------------------------------------------------------------------
// The overnight email
// ---------------------------------------------------------------------------

/**
 * The structure of the morning email (Sprint 3 §16 of the brief).
 *
 * Assembled from the per-run `MorningReportDto`s Sprint 2 already produces, so
 * there is one report generator rather than two that can disagree. Every field
 * is bounded, and none of them is a log: detail lives behind a link back to the
 * Mac UI, because spec §28's whole point is that engineers ignore long reports.
 */
export interface OvernightEmailContent {
  nightShiftId: string;
  generatedAt: string;
  windowStart: string;
  windowEnd: string;
  completed: Array<{ task: string; project: string; summary: string; runId: string }>;
  inProgress: Array<{ task: string; project: string; stage: string; runId: string }>;
  blocked: Array<{ task: string; project: string; blocker: string; needs: string; runId: string }>;
  whatChanged: string[];
  pullRequests: Array<{ url: string; title: string; summary: string }>;
  decisionsNeeded: string[];
  exceptions: string[];
  lowConfidenceAssumptions: Array<{ statement: string; confidence: number; task: string }>;
  estimatedHumanHours: { total: number; byTask: Array<{ task: string; hours: number }> };
  /** Carries its own source label. An estimate is never rendered as a dollar cap. */
  usage: { label: string; source: string; note: string | null };
  monday: { itemsUpdated: number; statusChanges: number; updatesPosted: number; failures: number };
  /** Where to read the detail. The email never contains it. */
  dashboardUrl: string;
}
