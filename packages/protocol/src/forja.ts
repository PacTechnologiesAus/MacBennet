import { z } from 'zod';
import { taskKindSchema } from './task-model.js';

/**
 * The Forja orchestration contract (Phase 4 Part D).
 *
 * ---------------------------------------------------------------------------
 * FORJA IS AN APPLICATION. IT IS NOT AN AGENT.
 *
 * This is worth restating in the file that defines its interface, because the
 * shape of an orchestration API invites the mistake: Forja creates tasks,
 * answers questions and approves work, which is what a colleague does.
 *
 * It is not a colleague. It is PAC's engineering and agent-orchestration
 * platform — a piece of software through which PEOPLE do those things. It has
 * no identity as an employee, is never registered in `agent-registry.ts`, and
 * an approval that arrives through it records the human it came from, not
 * "Forja". A test asserts the registry never gains it.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT JUST THE EXISTING API WITH ANOTHER AUTH HEADER
 *
 * Because "avoid tight coupling to current UI internals" (Part D §13) is a
 * requirement, and the human API is shaped by what the web UI happens to need
 * this month. A DTO that gains a field because a page wanted it is fine; a DTO
 * that gains a field because a page wanted it AND is also a published contract
 * that an external platform compiles against is a breaking change waiting for
 * an unrelated reason to happen.
 *
 * So Forja gets its own stable projections, versioned, deliberately narrower
 * than the internal ones, and containing nothing whose only purpose is a screen.
 * ---------------------------------------------------------------------------
 */

/** Bumped when a projection below changes shape incompatibly. */
export const FORJA_CONTRACT_VERSION = 1;

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

/**
 * What a Forja client is permitted to do.
 *
 * Separate read and write scopes, and `approve` separate from `write`, because
 * a platform that can create tasks is not thereby a platform that can authorise
 * them to run unattended.
 */
export const FORJA_SCOPES = [
  'read',
  /** Create conversations, messages and tasks; start discovery. */
  'write',
  /** Submit an approval decision on behalf of a named human. */
  'approve',
  /** Read the event stream. */
  'events',
] as const;
export const forjaScopeSchema = z.enum(FORJA_SCOPES);
export type ForjaScope = z.infer<typeof forjaScopeSchema>;

export const FORJA_SCOPE_LABELS: Record<ForjaScope, string> = {
  read: 'Read projects, tasks, runs and artefacts',
  write: 'Create conversations, tasks and discovery',
  approve: 'Submit approval decisions on behalf of a named person',
  events: 'Consume the event stream',
};

export const FORJA_KEY_PREFIX = 'forja_';

export interface ForjaClientDto {
  id: string;
  name: string;
  /** Display prefix of the active key. The key itself is stored only hashed. */
  keyPrefix: string;
  scopes: ForjaScope[];
  isActive: boolean;
  /** Where signed events are POSTed, when the client wants push rather than poll. */
  webhookUrl: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  revokedAt: string | null;
}

export const createForjaClientRequestSchema = z.object({
  name: z.string().min(1).max(120),
  scopes: z.array(forjaScopeSchema).min(1).max(FORJA_SCOPES.length),
  webhookUrl: z.string().url().max(500).nullish(),
});
export type CreateForjaClientRequest = z.infer<typeof createForjaClientRequestSchema>;

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/**
 * The event types Forja may observe (Part D §14).
 *
 * Every one of these names a state change that already happens. None of them is
 * emitted speculatively, and none is emitted from a place that is not also the
 * place that performs the change — so an event cannot exist without the thing
 * it describes having happened.
 */
export const MAC_EVENT_TYPES = [
  'task_created',
  'discovery_started',
  'question_required',
  'brief_ready',
  'approval_required',
  'approval_decided',
  'run_started',
  'blocker_raised',
  'artefact_created',
  'task_ready_for_review',
  'run_completed',
  'night_report_ready',
  'conversation_message',
] as const;
export const macEventTypeSchema = z.enum(MAC_EVENT_TYPES);
export type MacEventType = z.infer<typeof macEventTypeSchema>;

/**
 * One event.
 *
 * `seq` is a monotonic bigserial, and it is the ONLY cursor. Timestamps are not
 * a cursor: two events written in the same millisecond are ordered by `seq` and
 * not by `at`, and a consumer that pages by time will eventually skip one.
 */
export interface MacEventDto {
  seq: number;
  type: MacEventType;
  at: string;
  projectId: string | null;
  taskId: string | null;
  runId: string | null;
  conversationId: string | null;
  approvalRequestId: string | null;
  artefactId: string | null;
  /**
   * A small, stable payload.
   *
   * Deliberately not "the whole DTO of whatever changed". An event says THAT
   * something happened and gives the identifiers to go and read it; embedding
   * the full object would make every DTO change a contract change.
   */
  data: Record<string, unknown>;
}

export const forjaEventQuerySchema = z.object({
  after: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  /** Long-poll seconds. Bounded, like the worker's run lease. */
  wait: z.coerce.number().int().min(0).max(50).default(0),
  types: z.string().max(500).optional(),
});
export type ForjaEventQuery = z.infer<typeof forjaEventQuerySchema>;

export interface ForjaEventPageDto {
  contractVersion: number;
  events: MacEventDto[];
  /** Pass this back as `after`. Equal to the last event's seq, or the input. */
  cursor: number;
}

/**
 * Header names for signed webhook delivery.
 *
 * HMAC-SHA256 over `${timestamp}.${body}` with the client's secret. The
 * timestamp is inside the signed material so a captured delivery cannot be
 * replayed a week later against a receiver that only checks the signature.
 */
/**
 * Webhook delivery states.
 *
 * Deliberately NOT reusing `EMAIL_DELIVERY_STATUSES`, which carries `sending`.
 * Mail needs that state because an SMTP conversation is long enough for a crash
 * to land in the middle of one; a webhook POST is a single request whose
 * outcome is known when it returns, and a state nothing can ever be observed in
 * is a state that only exists to be handled incorrectly somewhere.
 */
export const EVENT_DELIVERY_STATUSES = ['pending', 'sent', 'failed', 'dead'] as const;
export type EventDeliveryStatus = (typeof EVENT_DELIVERY_STATUSES)[number];

export const FORJA_SIGNATURE_HEADER = 'x-mac-signature';
export const FORJA_TIMESTAMP_HEADER = 'x-mac-timestamp';
export const FORJA_EVENT_ID_HEADER = 'x-mac-event-seq';

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

/**
 * An agent, as Forja sees one.
 *
 * Note that the list this comes from contains Mac and Otto and does NOT contain
 * Forja. A platform enumerating the agents it orchestrates should not find
 * itself in the list.
 */
export interface ForjaAgentDto {
  key: string;
  name: string;
  jobTitle: string;
  email: string | null;
  /** What this agent is responsible for, in one sentence. */
  responsibility: string;
  online: boolean;
  /** Capabilities advertised by workers currently online for this agent. */
  capabilities: string[];
  activeRunCount: number;
  nightShiftActive: boolean;
}

export interface ForjaProjectDto {
  id: string;
  name: string;
  slug: string;
  capabilities: string[];
  allowedTaskKinds: string[];
  nightShiftApproved: boolean;
  hasRepository: boolean;
}

export interface ForjaTaskDto {
  id: string;
  projectId: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  taskKind: string;
  origin: string;
  /** Mac's DERIVED understanding confidence, never the requester's estimate. */
  understandingConfidence: number | null;
  discoverySessionId: string | null;
  briefId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ForjaDiscoveryDto {
  sessionId: string;
  taskId: string;
  status: string;
  /** The single question Mac is waiting on, if any. */
  pendingQuestion: { id: string; question: string; dimension: string } | null;
  briefId: string | null;
  confidence: number | null;
  messageCount: number;
  contextSummary: string | null;
  companyContextSha: string | null;
}

export interface ForjaBriefDto {
  id: string;
  taskId: string;
  version: number;
  status: string;
  confidence: number;
  confidenceBand: string;
  title: string;
  objective: string;
  acceptanceCriteria: string[];
  /** The machine-checkable criteria, which is what completion is judged against. */
  structuredAcceptance: Array<{ id: string; kind: string; description: string }>;
  openQuestions: Array<{ id: string; question: string; answered: boolean }>;
  markdown: string;
  /** Also rendered into `markdown`; separate so a client can style them. */
  scopeNote: string | null;
  researchGapNote: string | null;
  companyContextSha: string | null;
}

export interface ForjaRunDto {
  id: string;
  taskId: string;
  status: string;
  jobKind: string;
  executionMode: string;
  approvalState: string;
  progressStage: string | null;
  progressPercent: number | null;
  stopReason: string | null;
  acceptanceState: string;
  summary: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface ForjaBlockerDto {
  id: string;
  runId: string;
  taskId: string;
  projectId: string;
  description: string;
  resolved: boolean;
  raisedAt: string;
}

export interface ForjaArtefactDto {
  id: string;
  taskId: string;
  runId: string | null;
  type: string;
  title: string;
  summary: string;
  format: string;
  findingCount: number;
  externalSourceCount: number;
  companyContextSha: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/**
 * Every write carries the human it is acting for.
 *
 * ---------------------------------------------------------------------------
 * WHY `onBehalfOf` IS MANDATORY ON WRITES
 *
 * Because "Forja approved it" is not an answer to "who approved this?".
 *
 * The audit trail already distinguishes a human approval from a night-shift
 * policy approval, for exactly this reason — a machine authorisation must never
 * be readable as a person's. An orchestration platform is a third case, and the
 * honest record is "Kasper approved this through Forja", which requires Forja
 * to say who. A client that cannot name a person cannot approve.
 * ---------------------------------------------------------------------------
 */
export const forjaActorSchema = z.object({
  /** A Mac user's email. Resolved against `users`; an unknown one is refused. */
  onBehalfOf: z.string().email().max(320),
});

export const forjaCreateTaskRequestSchema = forjaActorSchema.extend({
  projectId: z.string().uuid(),
  title: z.string().min(1).max(200),
  description: z.string().max(20_000).optional(),
  /*
   * The enum, not a free string.
   *
   * This was `z.string().max(40)`, which published a field the contract had no
   * intention of honouring: `tasks.task_kind` is CHECK-constrained to seven
   * values, so anything else reached the database and returned a 500. A caller
   * reading the contract could not discover the permitted set, and the error it
   * got said Mac had broken rather than that the request was wrong.
   */
  taskKind: taskKindSchema.optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  /** Start discovery immediately, which is almost always what is wanted. */
  startDiscovery: z.boolean().default(true),
});
export type ForjaCreateTaskRequest = z.infer<typeof forjaCreateTaskRequestSchema>;

export const forjaStartConversationRequestSchema = forjaActorSchema.extend({
  projectId: z.string().uuid().optional(),
  taskId: z.string().uuid().optional(),
  title: z.string().max(200).optional(),
  message: z.string().min(1).max(8000).optional(),
});
export type ForjaStartConversationRequest = z.infer<typeof forjaStartConversationRequestSchema>;

export const forjaSendMessageRequestSchema = forjaActorSchema.extend({
  message: z.string().min(1).max(8000),
});
export type ForjaSendMessageRequest = z.infer<typeof forjaSendMessageRequestSchema>;

export const forjaDecideApprovalRequestSchema = forjaActorSchema.extend({
  decision: z.enum(['approve', 'reject']),
  notes: z.string().max(4000).default(''),
  acceptBelowThreshold: z.boolean().default(false),
});
export type ForjaDecideApprovalRequest = z.infer<typeof forjaDecideApprovalRequestSchema>;

export const forjaRequestApprovalRequestSchema = forjaActorSchema.extend({
  taskId: z.string().uuid(),
  runId: z.string().uuid().nullish(),
  briefId: z.string().uuid().nullish(),
  title: z.string().min(1).max(300),
  detail: z.string().max(8000).default(''),
});
export type ForjaRequestApprovalRequest = z.infer<typeof forjaRequestApprovalRequestSchema>;
