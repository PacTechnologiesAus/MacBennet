import { z } from 'zod';
import { jobKindSchema } from './jobs.js';
import { logStreamSchema, runOutcomeSchema, stopReasonSchema, workerStatusSchema } from './enums.js';

/**
 * The worker wire protocol.
 *
 * Design constraints that this shape encodes:
 *
 *  1. The control plane NEVER dials the worker. Every exchange is initiated by
 *     the worker over outbound HTTPS, so the worker VM needs no inbound ports.
 *  2. Cancellation must not depend on the heartbeat. Every worker-facing
 *     response therefore carries a `control` envelope, so a stop reaches the
 *     worker on whichever call happens next.
 *  3. Every request must be safely retryable after a network failure. Log
 *     batches carry a monotonic per-run sequence so the server can deduplicate.
 */

export const PROTOCOL_VERSION = 1;

// --- Control envelope (present on every worker-facing response) -------------

export const controlEnvelopeSchema = z.object({
  protocolVersion: z.number().int(),
  serverTime: z.string(),
  /** Cadence the worker should heartbeat at; server-owned so it is tunable centrally. */
  heartbeatIntervalSeconds: z.number().int().min(1).max(600),
  /** True when an operator or guardrail has asked the current run to stop. */
  cancelRequested: z.boolean(),
  /** The run the cancellation applies to, if any. */
  cancelRunId: z.string().uuid().nullable(),
  /** Machine-readable reason, so the worker can report it back accurately. */
  cancelReason: stopReasonSchema.nullable(),
});
export type ControlEnvelope = z.infer<typeof controlEnvelopeSchema>;

const withControl = <T extends z.ZodRawShape>(shape: T) =>
  z.object({ control: controlEnvelopeSchema, ...shape });

// --- Registration ----------------------------------------------------------

export const registerRequestSchema = z.object({
  name: z.string().min(1).max(100),
  capabilities: z.array(jobKindSchema).min(1),
  version: z.string().min(1).max(50),
  platform: z.string().min(1).max(200),
  protocolVersion: z.number().int(),
});
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

export const registerResponseSchema = withControl({
  workerId: z.string().uuid(),
  /** Returned exactly once, at registration. The server stores only its hash. */
  workerToken: z.string().min(1),
});
export type RegisterResponse = z.infer<typeof registerResponseSchema>;

// --- Heartbeat -------------------------------------------------------------

export const heartbeatRequestSchema = z.object({
  status: z.enum(['idle', 'busy']),
  currentRunId: z.string().uuid().nullable(),
  metrics: z
    .object({
      uptimeSeconds: z.number().nonnegative().optional(),
      loadAverage1m: z.number().nonnegative().optional(),
      freeMemoryBytes: z.number().nonnegative().optional(),
    })
    .strict()
    .optional(),
});
export type HeartbeatRequest = z.infer<typeof heartbeatRequestSchema>;

export const heartbeatResponseSchema = withControl({
  workerStatus: workerStatusSchema,
});
export type HeartbeatResponse = z.infer<typeof heartbeatResponseSchema>;

// --- Lease (long-poll for work) --------------------------------------------

export const leaseRequestSchema = z.object({
  /** How long the worker is willing to hold the poll open. Server caps this. */
  waitSeconds: z.number().int().min(0).max(25).default(20),
  capabilities: z.array(jobKindSchema).min(1),
});
export type LeaseRequest = z.infer<typeof leaseRequestSchema>;

export const runAssignmentSchema = z.object({
  runId: z.string().uuid(),
  taskId: z.string().uuid(),
  projectId: z.string().uuid(),
  taskTitle: z.string(),
  projectName: z.string(),
  jobKind: jobKindSchema,
  jobParams: z.record(z.unknown()),
  /** Wall-clock instant after which the worker must stop, if one applies. */
  deadlineAt: z.string().nullable(),
  leaseExpiresAt: z.string(),
  attempt: z.number().int().min(1),
});
export type RunAssignment = z.infer<typeof runAssignmentSchema>;

export const leaseResponseSchema = withControl({
  assignment: runAssignmentSchema.nullable(),
});
export type LeaseResponse = z.infer<typeof leaseResponseSchema>;

// --- Progress --------------------------------------------------------------

export const progressRequestSchema = z.object({
  stage: z.string().min(1).max(120),
  percent: z.number().int().min(0).max(100).nullable().optional(),
  message: z.string().max(1000).optional(),
});
export type ProgressRequest = z.infer<typeof progressRequestSchema>;

export const progressResponseSchema = withControl({ accepted: z.literal(true) });
export type ProgressResponse = z.infer<typeof progressResponseSchema>;

// --- Logs ------------------------------------------------------------------

export const MAX_LOG_BATCH_ENTRIES = 500;
export const MAX_LOG_MESSAGE_CHARS = 4000;

export const logEntrySchema = z.object({
  /** Monotonic per run. The server upserts on (runId, seq), so retries are idempotent. */
  seq: z.number().int().min(0),
  ts: z.string(),
  stream: logStreamSchema,
  message: z.string().max(MAX_LOG_MESSAGE_CHARS),
});
export type LogEntry = z.infer<typeof logEntrySchema>;

export const logBatchRequestSchema = z.object({
  entries: z.array(logEntrySchema).min(1).max(MAX_LOG_BATCH_ENTRIES),
});
export type LogBatchRequest = z.infer<typeof logBatchRequestSchema>;

export const logBatchResponseSchema = withControl({
  accepted: z.number().int().min(0),
  /** Highest sequence the server has durably stored for this run. */
  highestSeq: z.number().int().min(-1),
});
export type LogBatchResponse = z.infer<typeof logBatchResponseSchema>;

// --- Completion ------------------------------------------------------------

export const completeRequestSchema = z.object({
  outcome: runOutcomeSchema,
  stopReason: stopReasonSchema.nullable().optional(),
  summary: z.string().max(2000).optional(),
  /** The worker's confidence in its own result, if it has a basis for one. */
  confidence: z.number().min(0).max(1).nullable().optional(),
  /** Final log sequence the worker emitted, for completeness checking. */
  finalSeq: z.number().int().min(-1).optional(),
});
export type CompleteRequest = z.infer<typeof completeRequestSchema>;

export const completeResponseSchema = withControl({
  runStatus: z.string(),
});
export type CompleteResponse = z.infer<typeof completeResponseSchema>;

/** Header the worker uses for both enrollment and operation. */
export const WORKER_AUTH_HEADER = 'authorization';
export const WORKER_TOKEN_PREFIX = 'mac_wk_';
export const ENROLLMENT_TOKEN_PREFIX = 'mac_en_';
