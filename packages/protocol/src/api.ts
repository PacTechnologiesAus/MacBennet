import { z } from 'zod';
import {
  actorTypeSchema,
  approvalActionSchema,
  approvalStateSchema,
  auditEventTypeSchema,
  executionModeSchema,
  logStreamSchema,
  runStatusSchema,
  stopReasonSchema,
  taskPrioritySchema,
  taskStatusSchema,
  userRoleSchema,
  workerStatusSchema,
} from './enums.js';
import { jobKindSchema } from './jobs.js';

/**
 * Request and response contracts for the human-facing API.
 * The web app imports the inferred types directly, so a breaking API change is
 * a compile error in the UI rather than a runtime surprise.
 */

// --- Common ----------------------------------------------------------------

/**
 * Confidence is stored and transmitted as a fraction in [0,1] everywhere.
 * A single internal unit removes the 0.85-versus-85 bug class; percentage is
 * purely a display concern in the UI.
 */
export const confidenceSchema = z.number().min(0).max(1);

export const isoDateTime = z.string();

export const errorResponseSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

// --- Auth ------------------------------------------------------------------

export const loginRequestSchema = z.object({
  email: z.string().email().max(200),
  password: z.string().min(1).max(200),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

export const currentUserSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  name: z.string(),
  role: userRoleSchema,
});
export type CurrentUser = z.infer<typeof currentUserSchema>;

// --- Projects --------------------------------------------------------------

export const createProjectRequestSchema = z.object({
  name: z.string().min(1).max(150),
  description: z.string().max(5000).optional(),
  repoUrl: z.string().max(500).optional(),
  repoDefaultBranch: z.string().max(100).optional(),
});
export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>;

export const updateProjectRequestSchema = createProjectRequestSchema.partial().extend({
  isActive: z.boolean().optional(),
});
export type UpdateProjectRequest = z.infer<typeof updateProjectRequestSchema>;

export interface ProjectDto {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  repoUrl: string | null;
  repoDefaultBranch: string | null;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

// --- Tasks -----------------------------------------------------------------

export const createTaskRequestSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().min(1).max(200),
  description: z.string().max(20000).optional(),
  priority: taskPrioritySchema.default('normal'),
  confidence: confidenceSchema.nullable().optional(),
});
export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>;

export const updateTaskRequestSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(20000).optional(),
  status: taskStatusSchema.optional(),
  priority: taskPrioritySchema.optional(),
  confidence: confidenceSchema.nullable().optional(),
});
export type UpdateTaskRequest = z.infer<typeof updateTaskRequestSchema>;

export interface TaskDto {
  id: string;
  projectId: string;
  projectName?: string;
  title: string;
  description: string | null;
  status: z.infer<typeof taskStatusSchema>;
  priority: z.infer<typeof taskPrioritySchema>;
  confidence: number | null;
  createdAt: string;
  updatedAt: string;
}

// --- Runs ------------------------------------------------------------------

export const createRunRequestSchema = z.object({
  taskId: z.string().uuid(),
  jobKind: jobKindSchema,
  jobParams: z.record(z.unknown()).default({}),
  confidence: confidenceSchema,
  executionMode: executionModeSchema.default('interactive'),
});
export type CreateRunRequest = z.infer<typeof createRunRequestSchema>;

export const approveRunRequestSchema = z.object({
  notes: z.string().max(2000).optional(),
  /**
   * Required when confidence sits between the hard floor and the configured
   * autonomy threshold (spec §5's 60–79% band). The approver is stating
   * explicitly that they accept a limited-confidence run.
   */
  acknowledgeBelowThreshold: z.boolean().default(false),
});
export type ApproveRunRequest = z.infer<typeof approveRunRequestSchema>;

export const rejectRunRequestSchema = z.object({
  notes: z.string().min(1).max(2000),
});
export type RejectRunRequest = z.infer<typeof rejectRunRequestSchema>;

export const cancelRunRequestSchema = z.object({
  reason: z.string().max(500).optional(),
});
export type CancelRunRequest = z.infer<typeof cancelRunRequestSchema>;

export interface RunDto {
  id: string;
  taskId: string;
  taskTitle?: string;
  projectId?: string;
  projectName?: string;
  status: z.infer<typeof runStatusSchema>;
  workerId: string | null;
  workerName?: string | null;
  approvalState: z.infer<typeof approvalStateSchema>;
  confidence: number | null;
  jobKind: string;
  jobParams: Record<string, unknown>;
  executionMode: z.infer<typeof executionModeSchema>;
  overnightDeadlineAt: string | null;
  progressPercent: number | null;
  progressStage: string | null;
  summary: string | null;
  cancelRequestedAt: string | null;
  stopReason: z.infer<typeof stopReasonSchema> | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ApprovalDto {
  id: string;
  runId: string;
  action: z.infer<typeof approvalActionSchema>;
  approverUserId: string | null;
  approverName: string | null;
  notes: string | null;
  confidenceAtDecision: number | null;
  thresholdAtDecision: number | null;
  thresholdOverridden: boolean;
  createdAt: string;
}

export interface RunLogDto {
  /**
   * Insertion-ordered row id, and the cursor the UI polls with.
   *
   * `seq` cannot serve as the cursor: worker lines use ascending non-negative
   * sequences while control-plane notes use descending negative ones (so the
   * two can never collide), which means no single `seq` watermark covers both.
   * The row id is monotonic across both spaces.
   */
  id: number;
  seq: number;
  ts: string;
  stream: z.infer<typeof logStreamSchema>;
  message: string;
}

// --- Workers ---------------------------------------------------------------

export interface WorkerDto {
  id: string;
  name: string;
  status: z.infer<typeof workerStatusSchema>;
  capabilities: string[];
  lastHeartbeatAt: string | null;
  currentRunId: string | null;
  version: string | null;
  platform: string | null;
  tokenPrefix: string | null;
  registeredAt: string | null;
  /** Derived server-side from last heartbeat and the configured grace period. */
  isLive: boolean;
}

export const createEnrollmentTokenRequestSchema = z.object({
  label: z.string().min(1).max(100),
  expiresInHours: z.number().int().min(1).max(720).default(24),
});
export type CreateEnrollmentTokenRequest = z.infer<typeof createEnrollmentTokenRequestSchema>;

export interface EnrollmentTokenDto {
  id: string;
  label: string;
  /** Returned exactly once, at creation. Never retrievable afterwards. */
  token?: string;
  expiresAt: string;
  usedAt: string | null;
  createdAt: string;
}

// --- Audit -----------------------------------------------------------------

export interface AuditEventDto {
  id: string;
  /**
   * Monotonic insertion sequence, and the authoritative ordering key.
   * Several events are written inside one transaction and therefore share a
   * timestamp, so `ts` alone cannot order the trail.
   */
  seq: number;
  ts: string;
  actorType: z.infer<typeof actorTypeSchema>;
  actorId: string | null;
  actorLabel: string;
  eventType: z.infer<typeof auditEventTypeSchema>;
  projectId: string | null;
  taskId: string | null;
  runId: string | null;
  workerId: string | null;
  metadata: Record<string, unknown>;
}

export const auditQuerySchema = z.object({
  projectId: z.string().uuid().optional(),
  taskId: z.string().uuid().optional(),
  runId: z.string().uuid().optional(),
  workerId: z.string().uuid().optional(),
  eventType: auditEventTypeSchema.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export type AuditQuery = z.infer<typeof auditQuerySchema>;

// --- Settings --------------------------------------------------------------

export const updateSettingsRequestSchema = z
  .object({
    timezone: z.string().min(1).max(80).optional(),
    /** 24-hour wall-clock time in the configured timezone, e.g. "08:00". */
    overnightCutoff: z
      .string()
      .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, 'Must be HH:MM in 24-hour form')
      .optional(),
    defaultConfidenceThreshold: confidenceSchema.optional(),
    minExecutionConfidence: confidenceSchema.optional(),
    nightlyBudgetCents: z.number().int().min(0).max(100_000_000).optional(),
    currency: z.string().length(3).optional(),
    budgetWarningPct: z.number().int().min(1).max(100).optional(),
    budgetStopPct: z.number().int().min(1).max(200).optional(),
    heartbeatIntervalSeconds: z.number().int().min(1).max(600).optional(),
    heartbeatGraceSeconds: z.number().int().min(1).max(3600).optional(),
  })
  .strict();
export type UpdateSettingsRequest = z.infer<typeof updateSettingsRequestSchema>;

export interface SettingsDto {
  timezone: string;
  overnightCutoff: string;
  defaultConfidenceThreshold: number;
  minExecutionConfidence: number;
  nightlyBudgetCents: number;
  currency: string;
  budgetWarningPct: number;
  budgetStopPct: number;
  heartbeatIntervalSeconds: number;
  heartbeatGraceSeconds: number;
  updatedAt: string;
}

// --- Budget ----------------------------------------------------------------

export interface BudgetStatusDto {
  currency: string;
  nightlyBudgetCents: number;
  /** Sum of *exact* recorded provider costs for the current night window. */
  recordedSpendCents: number;
  warningThresholdCents: number;
  stopThresholdCents: number;
  windowStart: string;
  windowEnd: string;
  /**
   * False for the whole of Sprint 1 — no provider cost integration exists yet.
   * Spec §25 forbids presenting an estimate as exact provider usage, so the UI
   * shows "Provider usage unavailable" rather than a fabricated number.
   */
  providerUsageAvailable: boolean;
}

// --- Dashboard -------------------------------------------------------------

export interface DashboardDto {
  workers: WorkerDto[];
  activeRuns: RunDto[];
  pendingApprovals: RunDto[];
  recentlyCompleted: RunDto[];
  counts: {
    projects: number;
    tasks: number;
    runsToday: number;
    liveWorkers: number;
  };
  budget: BudgetStatusDto;
  settings: SettingsDto;
}
