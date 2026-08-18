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
import { handoffBriefContentSchema, scopeKindSchema } from './brief.js';
import { usageSourceSchema } from './usage.js';
import {
  decisionRiskSchema,
  discoveryStatusSchema,
  memoryScopeSchema,
  reviewVerdictSchema,
  riskLevelSchema,
  worktreeStatusSchema,
} from './enums.js';
import { agentAnswerDecisionSchema, agentSessionStateSchema, codingAgentProviderSchema } from './coding-agent.js';
// --- Sprint 3.3 ---
import { taskKindSchema, type ExecutionRequirement, type TaskKind, type TaskOrigin } from './task-model.js';
import { projectCapabilitySchema, type ProjectCapability } from './project-capabilities.js';
import { artefactContentSchema } from './artefacts.js';
import { evidenceRefSchema, groundednessSchema, investigationResultSchema } from './evidence.js';
import { sandboxKindSchema, sandboxNetworkModeSchema } from './sandbox.js';
import { mondayStatusLabelsSchema, mondayWriteKindSchema, mondayWriteStatusSchema } from './monday.js';
import {
  approvalSourceSchema,
  effortEstimateSchema,
  eligibilityVerdictSchema,
  nightDecisionKindSchema,
  nightShiftStatusSchema,
  nightStopReasonSchema,
  runSelectionSourceSchema,
  schedulingRationaleSchema,
  type EligibilityVerdict,
} from './night.js';
import { emailAddressSchema, emailDeliveryKindSchema, emailDeliveryStatusSchema, mailProviderSchema } from './mail.js';
import { modelProviderSchema } from './model.js';
import type { CompanyContextRef } from './company-context.js';

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
  /**
   * Sprint 3: the first of the two gates on autonomous work selection.
   *
   * A project must be explicitly approved before Mac may take work from it
   * overnight, and the monday board must be approved too.
   */
  nightShiftApproved: boolean;
  nightShiftApprovedAt: string | null;
  /** Sprint 3.3: what this project HAS. A statement of fact. */
  capabilities: ProjectCapability[];
  /** Sprint 3.3: what a human has ALLOWED here. Empty means nothing yet. */
  allowedTaskKinds: TaskKind[];
  createdAt: string;
  updatedAt: string;
}

// --- Tasks -----------------------------------------------------------------

export const createTaskRequestSchema = z.object({
  projectId: z.string().uuid(),
  title: z.string().min(1).max(200),
  description: z.string().max(20000).optional(),
  priority: taskPrioritySchema.default('normal'),
  /**
   * Sprint 3.3: what kind of work this is.
   *
   * Optional, and NOT defaulted to `coding` at the API. A task created without
   * one is unclassified until discovery proposes a kind, which is honest: the
   * person filling in a form has often not decided, and a silent default of
   * `coding` is how research work ended up needing a repository.
   */
  taskKind: taskKindSchema.optional(),
  /**
   * Sprint 3.3: renamed from `confidence` (reconciliation drift D-7).
   *
   * The REQUESTER's sense of how well-specified their own request is. It has
   * never gated execution and now cannot be mistaken for the number that does:
   * Mac's understanding confidence is derived through discovery and lives on
   * the handoff brief.
   */
  userInitialConfidence: confidenceSchema.nullable().optional(),
});
export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>;

export const updateTaskRequestSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(20000).optional(),
  status: taskStatusSchema.optional(),
  priority: taskPrioritySchema.optional(),
  taskKind: taskKindSchema.optional(),
  userInitialConfidence: confidenceSchema.nullable().optional(),
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
  /** Sprint 3.3: what kind of work. Never conflate with the job kind. */
  taskKind: TaskKind;
  /** Sprint 3.3: `direct` (Mac's own UI) or `monday` (mirrored from a board). */
  origin: TaskOrigin;
  /** Sprint 3.3: the requester's own estimate. NEVER an execution gate. */
  userInitialConfidence: number | null;
  /** Mac's DERIVED understanding confidence, from the latest handoff brief. */
  understandingConfidence: number | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Everything the Task Detail screen needs to explain itself (Sprint 3.3 §26).
 *
 * Assembled server-side rather than by the UI stitching four endpoints
 * together, because "why can this task not run?" must have exactly one answer
 * and that answer must be the same one the scheduler would give.
 */
export interface TaskExecutionStateDto {
  taskKind: TaskKind;
  origin: TaskOrigin;
  /** What this task needs before it can execute, derived from kind and origin. */
  requirements: Array<{
    requirement: ExecutionRequirement;
    label: string;
    satisfied: boolean;
    detail: string;
  }>;
  projectCapabilities: ProjectCapability[];
  allowedTaskKinds: TaskKind[];
  discovery: {
    sessionId: string | null;
    status: string | null;
    briefId: string | null;
    /** True when there is no session yet, so the UI can offer Start Discovery. */
    canStart: boolean;
  };
  understandingConfidence: number | null;
  /** The same verdict the night scheduler computes. Null when not yet evaluable. */
  eligibility: EligibilityVerdict | null;
  /** One sentence a human can act on. Empty when the task is ready. */
  blockerSummary: string;
  artefactCount: number;
}

// --- Artefacts -------------------------------------------------------------

export const createArtefactRequestSchema = z.object({
  taskId: z.string().uuid(),
  runId: z.string().uuid().nullable().optional(),
  content: artefactContentSchema,
});
export type CreateArtefactRequest = z.infer<typeof createArtefactRequestSchema>;

// --- Project capabilities --------------------------------------------------

export const updateProjectCapabilitiesRequestSchema = z.object({
  capabilities: z.array(projectCapabilitySchema).max(16).optional(),
  allowedTaskKinds: z.array(taskKindSchema).max(16).optional(),
});
export type UpdateProjectCapabilitiesRequest = z.infer<typeof updateProjectCapabilitiesRequestSchema>;

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
  /**
   * Sprint 3.2: the PAC company context revision that governed this work.
   *
   * Null when company context is not part of this deployment. Never changes once
   * set - a database trigger refuses to move it - so a historical record stays
   * attributable to the policy actually in force at the time.
   */
  companyContext: CompanyContextRef | null;
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
  /**
   * WHICH authority approved this (Sprint 3).
   *
   * `night_shift_policy` means a human pre-approved the project, the board and
   * the item, and the eligibility predicate then found it startable. Carried on
   * the DTO so the UI shows it rather than rendering a blank approver — a
   * machine approval must never be readable as a human one.
   */
  source: z.infer<typeof approvalSourceSchema>;
  policyBasis: Record<string, unknown> | null;
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
  // --- Sprint 3: containment, re-attested on every heartbeat ---
  sandboxKind: z.infer<typeof sandboxKindSchema> | null;
  sandboxReady: boolean;
  sandboxDetail: string | null;
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
    // --- Sprint 2 ---
    /** Soft threshold on non-exact usage. Warns; stops only if explicitly enabled. */
    softUsageThresholdPct: z.number().int().min(1).max(100).optional(),
    softUsageStopsExecution: z.boolean().optional(),
    /** Master switch for delegating work to a coding agent. */
    codingAgentEnabled: z.boolean().optional(),
    maxAgentMinutes: z.number().int().min(1).max(720).optional(),
    maxQuestionsPerRun: z.number().int().min(0).max(200).optional(),
    /** Confidence at or above which Mac answers a question rather than assuming. */
    answerConfidenceThreshold: confidenceSchema.optional(),
    // --- Sprint 3.3 ---
    generalWorkEnabled: z.boolean().optional(),
    maxResearchSteps: z.number().int().min(1).max(12).optional(),
    maxResearchToolCalls: z.number().int().min(1).max(200).optional(),
    externalResearchEnabled: z.boolean().optional(),
    allowedResearchDomains: z.array(z.string().min(1).max(253)).max(100).optional(),

    // --- Sprint 3 ---
    /** When true, a coding run is not dispatched to a worker without a sandbox. */
    requireSandbox: z.boolean().optional(),
    workerTokenMaxAgeHours: z.number().int().min(1).max(8760).optional(),
    workerTokenOverlapSeconds: z.number().int().min(0).max(3600).optional(),
    nightShiftEnabled: z.boolean().optional(),
    /** Multiplier applied to an effort estimate before it is compared to the runway. */
    nightShiftSafetyFactor: z.number().min(1).max(5).optional(),
    /** Minutes reserved for committing, testing, reviewing and reporting. */
    nightShiftWrapUpMinutes: z.number().int().min(0).max(240).optional(),
    /** Below this much runway, nothing new starts at all. */
    nightShiftMinStartMinutes: z.number().int().min(1).max(600).optional(),
    /** A `large` task additionally needs at least this much runway. */
    nightShiftLargeTaskMinMinutes: z.number().int().min(1).max(1440).optional(),
    /**
     * Where morning reports go. The ONLY place a recipient can be configured;
     * nothing from a task, brief or agent can reach the send path.
     */
    reportRecipients: z.array(emailAddressSchema).max(20).optional(),
    allowedRecipientDomains: z.array(z.string().min(1).max(200)).max(20).optional(),
    mailProvider: mailProviderSchema.optional(),
    /** Off by default: determinism is the default posture for unattended work. */
    modelAssistEnabled: z.boolean().optional(),
    modelProvider: modelProviderSchema.optional(),
    // --- Sprint 3.2 ---
    companyContextEnabled: z.boolean().optional(),
    companyContextAllowCached: z.boolean().optional(),
    companyContextMinRefreshSeconds: z.number().int().min(0).max(86_400).optional(),
    companyContextMaxStaleHours: z.number().int().min(0).max(8760).optional(),
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
  softUsageThresholdPct: number;
  softUsageStopsExecution: boolean;
  codingAgentEnabled: boolean;
  maxAgentMinutes: number;
  maxQuestionsPerRun: number;
  answerConfidenceThreshold: number;
  // --- Sprint 3 ---
  requireSandbox: boolean;
  workerTokenMaxAgeHours: number;
  workerTokenOverlapSeconds: number;
  nightShiftEnabled: boolean;
  nightShiftSafetyFactor: number;
  nightShiftWrapUpMinutes: number;
  nightShiftMinStartMinutes: number;
  nightShiftLargeTaskMinMinutes: number;
  reportRecipients: string[];
  allowedRecipientDomains: string[];
  mailProvider: z.infer<typeof mailProviderSchema>;
  modelAssistEnabled: boolean;
  modelProvider: z.infer<typeof modelProviderSchema>;
  // --- Sprint 3.2 ---
  companyContextEnabled: boolean;
  companyContextAllowCached: boolean;
  companyContextMinRefreshSeconds: number;
  companyContextMaxStaleHours: number;
  // --- Sprint 3.3 ---
  generalWorkEnabled: boolean;
  maxResearchSteps: number;
  maxResearchToolCalls: number;
  externalResearchEnabled: boolean;
  allowedResearchDomains: string[];
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
   * Whether any provider usage at all was recorded for this window. Spec §25
   * forbids presenting an estimate as exact provider usage, so when this is
   * false the UI shows "Provider usage unavailable" rather than a zero that
   * looks like a measurement.
   */
  providerUsageAvailable: boolean;
  /**
   * Sprint 2 §17. A dollar budget is only genuinely enforceable when exact
   * monetary cost is available. Under subscription access it is not, and the UI
   * must not imply otherwise.
   */
  costEnforceable: boolean;
  /** The weakest source among usage recorded in this window. */
  usageSource: z.infer<typeof usageSourceSchema>;
  /** Non-exact usage against the soft threshold, reported with its uncertainty. */
  softUsage: {
    thresholdPct: number;
    observedPct: number | null;
    estimatedSpendCents: number;
    warning: boolean;
    note: string;
  };
}

// --- Repositories (Sprint 2) -----------------------------------------------

/**
 * `testCommand` and `buildCommand` are argv ARRAYS, not strings.
 *
 * This is the one place a project-specific command enters the system, so it is
 * bounded on every axis that matters: admin-only to set, audited on change,
 * executed with `shell: false`, and validated to reject anything that looks
 * like shell syntax. A pipeline, a redirect or a `;` cannot be expressed here.
 */
export const commandArgvSchema = z
  .array(z.string().min(1).max(300))
  .max(30)
  .refine((argv) => argv.every((a) => !/[;&|`$><\n\r]/.test(a)), {
    message: 'Command arguments must not contain shell metacharacters; this is an argv array, not a shell command.',
  });

export const createRepositoryRequestSchema = z.object({
  projectId: z.string().uuid(),
  name: z.string().min(1).max(150),
  remoteUrl: z.string().min(1).max(500),
  /** Absolute path of the clone on the worker VM. Admin-configured. */
  localPath: z.string().min(1).max(1000),
  defaultBranch: z.string().min(1).max(100).default('main'),
  remoteName: z.string().min(1).max(60).default('origin'),
  testCommand: commandArgvSchema.default([]),
  buildCommand: commandArgvSchema.default([]),
});
export type CreateRepositoryRequest = z.infer<typeof createRepositoryRequestSchema>;

export const updateRepositoryRequestSchema = createRepositoryRequestSchema
  .omit({ projectId: true })
  .partial()
  .strict();
export type UpdateRepositoryRequest = z.infer<typeof updateRepositoryRequestSchema>;

export const approveRepositoryRequestSchema = z.object({
  approved: z.boolean(),
  notes: z.string().max(1000).optional(),
});
export type ApproveRepositoryRequest = z.infer<typeof approveRepositoryRequestSchema>;

export interface RepositoryDto {
  id: string;
  projectId: string;
  name: string;
  remoteUrl: string;
  localPath: string;
  defaultBranch: string;
  remoteName: string;
  isApproved: boolean;
  approvedBy: string | null;
  approvedAt: string | null;
  lastFetchedAt: string | null;
  lastKnownDefaultSha: string | null;
  testCommand: string[];
  buildCommand: string[];
  /** Worktrees Mac currently holds against this repository. */
  activeWorktrees: WorktreeDto[];
  createdAt: string;
  updatedAt: string;
}

export interface WorktreeDto {
  id: string;
  runId: string;
  repositoryId: string;
  path: string;
  branch: string;
  baseBranch: string;
  baseSha: string;
  headSha: string | null;
  commitCount: number;
  status: z.infer<typeof worktreeStatusSchema>;
  createdAt: string;
  releasedAt: string | null;
  removedAt: string | null;
}

// --- Discovery and briefs (Sprint 2) ---------------------------------------

export const startDiscoveryRequestSchema = z.object({
  /** Explicit. Mac never infers the project when several are available. */
  projectId: z.string().uuid(),
  /** An existing task, or a title from which one is created. */
  taskId: z.string().uuid().optional(),
  title: z.string().min(1).max(200).optional(),
});
export type StartDiscoveryRequest = z.infer<typeof startDiscoveryRequestSchema>;

export const discoveryMessageRequestSchema = z.object({
  /** The human talking freely. Mac listens; he does not impose a form. */
  message: z.string().min(1).max(20000),
});
export type DiscoveryMessageRequest = z.infer<typeof discoveryMessageRequestSchema>;

export interface DiscoveryMessageDto {
  role: 'human' | 'mac';
  message: string;
  at: string;
  /** Set when this Mac turn was a gap-analysis question. */
  questionId?: string;
}

export interface DiscoverySessionDto {
  id: string;
  projectId: string;
  projectName: string;
  taskId: string;
  taskTitle: string;
  status: z.infer<typeof discoveryStatusSchema>;
  messages: DiscoveryMessageDto[];
  contextSummary: string | null;
  contextInspectedAt: string | null;
  briefId: string | null;
  /** The single next question Mac wants answered. One at a time, per spec §4. */
  pendingQuestion: { id: string; question: string; dimension: string } | null;
  /**
   * Sprint 3.2: the PAC company context revision that governed this work.
   *
   * Null when company context is not part of this deployment. Never changes once
   * set - a database trigger refuses to move it - so a historical record stays
   * attributable to the policy actually in force at the time.
   */
  companyContext: CompanyContextRef | null;
  createdAt: string;
  updatedAt: string;
}

export const generateBriefRequestSchema = z.object({
  /** Optional operator edits applied on top of what Mac derived. */
  overrides: handoffBriefContentSchema.partial().optional(),
});
export type GenerateBriefRequest = z.infer<typeof generateBriefRequestSchema>;

export const updateBriefRequestSchema = z.object({
  content: handoffBriefContentSchema.partial(),
});
export type UpdateBriefRequest = z.infer<typeof updateBriefRequestSchema>;

export const answerBriefQuestionRequestSchema = z.object({
  questionId: z.string().min(1).max(80),
  answer: z.string().min(1).max(4000),
});
export type AnswerBriefQuestionRequest = z.infer<typeof answerBriefQuestionRequestSchema>;

export interface CompletenessDto {
  dimension: string;
  satisfied: boolean;
  weight: number;
  /** Non-null when the repository can answer it, so Mac must not ask the human. */
  discoverableFrom: string[];
  question: string;
}

export interface BriefDto {
  id: string;
  taskId: string;
  projectId: string;
  version: number;
  status: string;
  content: z.infer<typeof handoffBriefContentSchema>;
  markdown: string;
  confidence: number;
  confidenceBand: string;
  completeness: CompletenessDto[];
  /** What Mac may execute at this confidence, and whether the human must approve a narrower scope. */
  executionAdvice: {
    executionPermitted: boolean;
    scopeKind: z.infer<typeof scopeKindSchema>;
    requiresExplicitScopeApproval: boolean;
    message: string;
  };
  contextSummary: string | null;
  /**
   * Sprint 3.2: the PAC company context revision that governed this work.
   *
   * Null when company context is not part of this deployment. Never changes once
   * set - a database trigger refuses to move it - so a historical record stays
   * attributable to the policy actually in force at the time.
   */
  companyContext: CompanyContextRef | null;
  createdAt: string;
  updatedAt: string;
}

// --- Coding runs (Sprint 2) ------------------------------------------------

export const createCodingRunRequestSchema = z.object({
  taskId: z.string().uuid(),
  repositoryId: z.string().uuid(),
  briefId: z.string().uuid(),
  provider: codingAgentProviderSchema.default('claude_code'),
  executionMode: executionModeSchema.default('interactive'),
  maxMinutes: z.number().int().min(1).max(720).default(60),
  openPullRequest: z.boolean().default(true),
});
export type CreateCodingRunRequest = z.infer<typeof createCodingRunRequestSchema>;

export interface AgentSessionDto {
  id: string;
  runId: string;
  provider: z.infer<typeof codingAgentProviderSchema>;
  providerSessionId: string | null;
  providerVersion: string | null;
  model: string | null;
  state: z.infer<typeof agentSessionStateSchema>;
  currentActivity: string | null;
  startedAt: string;
  endedAt: string | null;
  error: string | null;
}

export interface AgentQuestionDto {
  id: string;
  runId: string;
  seq: number;
  question: string;
  answer: string | null;
  decision: z.infer<typeof agentAnswerDecisionSchema> | null;
  confidence: number | null;
  reasoning: string | null;
  sources: string[];
  risk: z.infer<typeof decisionRiskSchema>;
  requiredHuman: boolean;
  affectedImplementation: boolean;
  askedAt: string;
  answeredAt: string | null;
  // --- Sprint 3: evidence-based answers ---
  evidence: z.infer<typeof evidenceRefSchema>[];
  /** Derived from the evidence, never asserted by the answering code. */
  groundedness: z.infer<typeof groundednessSchema>;
  modelAssisted: boolean;
  sourcesChecked: string[];
  /**
   * Sprint 3.2: the PAC company context revision that governed this work.
   *
   * Null when company context is not part of this deployment. Never changes once
   * set - a database trigger refuses to move it - so a historical record stays
   * attributable to the policy actually in force at the time.
   */
  companyContext: CompanyContextRef | null;
}

export interface RunAssumptionDto {
  id: string;
  runId: string;
  statement: string;
  confidence: number;
  reversible: boolean;
  /** True when it must be surfaced prominently — below the autonomy threshold. */
  flagged: boolean;
  source: string | null;
  createdAt: string;
}

export interface RunBlockerDto {
  id: string;
  runId: string;
  description: string;
  reason: string;
  risk: z.infer<typeof decisionRiskSchema>;
  resolved: boolean;
  createdAt: string;
}

export interface GitViolationDto {
  id: string;
  runId: string;
  code: string;
  argv: string[];
  message: string;
  origin: 'mac' | 'agent';
  at: string;
}

export interface RunReviewDto {
  id: string;
  runId: string;
  verdict: z.infer<typeof reviewVerdictSchema>;
  riskLevel: z.infer<typeof riskLevelSchema>;
  satisfiesBrief: boolean;
  acceptanceCriteriaMet: boolean;
  unexpectedScope: boolean;
  humanAttentionRequired: boolean;
  prRecommended: boolean;
  prDeclineReason: string | null;
  anomalies: string[];
  evidence: Record<string, unknown>;
  createdAt: string;
}

export interface PullRequestDto {
  id: string;
  runId: string;
  provider: string;
  number: number | null;
  url: string;
  title: string;
  branch: string;
  baseBranch: string;
  createdAt: string;
}

export interface CodingRunDetailDto {
  run: RunDto;
  repository: RepositoryDto | null;
  worktree: WorktreeDto | null;
  brief: BriefDto | null;
  session: AgentSessionDto | null;
  questions: AgentQuestionDto[];
  assumptions: RunAssumptionDto[];
  blockers: RunBlockerDto[];
  violations: GitViolationDto[];
  review: RunReviewDto | null;
  pullRequest: PullRequestDto | null;
  usage: RunUsageSummaryDto;
}

// --- Usage (Sprint 2) ------------------------------------------------------

export interface UsageSnapshotDto {
  id: string;
  runId: string;
  provider: string;
  phase: 'before' | 'after';
  source: z.infer<typeof usageSourceSchema>;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  costCents: number | null;
  percentUsed: number | null;
  state: string | null;
  reportingPeriod: string | null;
  note: string | null;
  capturedAt: string;
}

export interface RunUsageSummaryDto {
  provider: string | null;
  /** The weakest source among the readings — never upgraded. */
  source: z.infer<typeof usageSourceSchema>;
  before: UsageSnapshotDto | null;
  after: UsageSnapshotDto | null;
  delta: {
    inputTokens: number | null;
    outputTokens: number | null;
    cacheReadTokens: number | null;
    cacheCreationTokens: number | null;
    costCents: number | null;
    percentUsedDelta: number | null;
    meaningful: boolean;
    note: string | null;
  };
  /** Display string; equals "Provider usage unavailable" when nothing is known. */
  label: string;
  /** True only when a monetary figure is exact and therefore enforceable. */
  costEnforceable: boolean;
}

// --- Morning report (Sprint 2) ---------------------------------------------

export interface MorningReportDto {
  runId: string;
  taskTitle: string;
  projectName: string;
  generatedAt: string;
  /** Deliberately short. Engineers stop reading essays. */
  whatChanged: string;
  why: string;
  risk: z.infer<typeof riskLevelSchema>;
  riskRationale: string;
  exceptions: string[];
  decisionsNeeded: string[];
  /** Only assumptions below the autonomy threshold reach this list. */
  flaggedAssumptions: Array<{ statement: string; confidence: number }>;
  questionsAnswered: number;
  lowConfidenceAnswers: number;
  /** Detailed Q&A lives behind this link, not in the report body. */
  questionsLogUrl: string;
  pullRequestUrl: string | null;
  pullRequestDeclineReason: string | null;
  estimatedHumanHours: number;
  estimatedHumanHoursBasis: string;
  usage: RunUsageSummaryDto;
  outcome: string;
  markdown: string;
}

// --- Memory (Sprint 2, spec §9) --------------------------------------------

export const createMemoryRequestSchema = z.object({
  scope: memoryScopeSchema,
  projectId: z.string().uuid().nullable().optional(),
  taskId: z.string().uuid().nullable().optional(),
  key: z.string().min(1).max(200),
  value: z.string().min(1).max(8000),
  confidence: confidenceSchema.default(1),
  source: z.string().max(300).optional(),
});
export type CreateMemoryRequest = z.infer<typeof createMemoryRequestSchema>;

export interface MemoryEntryDto {
  id: string;
  scope: z.infer<typeof memoryScopeSchema>;
  projectId: string | null;
  taskId: string | null;
  key: string;
  value: string;
  confidence: number;
  source: string | null;
  /** True once promoted from task memory into project memory after validation. */
  promoted: boolean;
  createdAt: string;
}

// ===========================================================================
// Sprint 3 — sandbox, credentials, monday.com, night shift, email
// ===========================================================================

// --- Security: worker credentials and sandbox ------------------------------

export interface WorkerTokenDto {
  id: string;
  workerId: string;
  /** Display only. The token itself exists in plaintext exactly once, at issue. */
  tokenPrefix: string;
  status: 'active' | 'superseded' | 'revoked';
  issuedVia: 'enrollment' | 'rotation' | 'admin_reset';
  issuedAt: string;
  /** Set on a superseded token: the end of its overlap window. */
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  revokedReason: string | null;
  ageHours: number;
}

export interface WorkerSecurityDto {
  workerId: string;
  workerName: string;
  isLive: boolean;
  sandboxKind: z.infer<typeof sandboxKindSchema> | null;
  sandboxReady: boolean;
  sandboxDetail: string | null;
  /** True when the control plane is currently withholding coding work. */
  codingWorkWithheld: boolean;
  activeToken: WorkerTokenDto | null;
  tokens: WorkerTokenDto[];
  rotationRequestedAt: string | null;
  lastRotatedAt: string | null;
}

export interface SecurityOverviewDto {
  requireSandbox: boolean;
  workerTokenMaxAgeHours: number;
  workerTokenOverlapSeconds: number;
  workers: WorkerSecurityDto[];
}

export const revokeWorkerTokensRequestSchema = z.object({
  reason: z.string().min(1).max(500),
});
export type RevokeWorkerTokensRequest = z.infer<typeof revokeWorkerTokensRequestSchema>;

// --- monday.com ------------------------------------------------------------

/**
 * Board mapping.
 *
 * `dueDateColumnId` and `priorityColumnId` are recorded even though Mac may
 * never write to them. That is the point: storing them is what lets the write
 * guard RECOGNISE an attempt to touch a commercial field and refuse it by name,
 * rather than merely failing to find it on an allowlist.
 */
export const createMondayBoardRequestSchema = z.object({
  projectId: z.string().uuid(),
  boardId: z.string().min(1).max(60),
  name: z.string().min(1).max(300),
  groupIds: z.array(z.string().max(120)).max(50).default([]),
  statusColumnId: z.string().min(1).max(120),
  assigneeColumnId: z.string().max(120).nullable().default(null),
  priorityColumnId: z.string().max(120).nullable().default(null),
  dueDateColumnId: z.string().max(120).nullable().default(null),
  pullRequestColumnId: z.string().max(120).nullable().default(null),
  dependencyColumnId: z.string().max(120).nullable().default(null),
  nightShiftFlagColumnId: z.string().max(120).nullable().default(null),
  itemTypeColumnId: z.string().max(120).nullable().default(null),
  sizeColumnId: z.string().max(120).nullable().default(null),
  statusLabels: mondayStatusLabelsSchema,
  /** Statuses Mac may pick work up from. Anything else is not startable. */
  startableStatuses: z.array(z.string().min(1).max(200)).min(1).max(20),
  /** Statuses that mean a dependency is finished. */
  completedStatuses: z.array(z.string().min(1).max(200)).max(20).default([]),
  allowedItemTypes: z.array(z.string().min(1).max(120)).max(40).default([]),
  /** Off by default: Ready for Review is Mac's terminal state unless opted in. */
  mayComplete: z.boolean().default(false),
  nightShiftEligible: z.boolean().default(false),
  /** On by default: an item must be explicitly marked before Mac may take it. */
  requireItemFlag: z.boolean().default(true),
  /** Mac's own monday user id, so he can assign work to himself. */
  macUserId: z.string().max(60).nullable().default(null),
});
export type CreateMondayBoardRequest = z.infer<typeof createMondayBoardRequestSchema>;

export const updateMondayBoardRequestSchema = createMondayBoardRequestSchema
  .omit({ projectId: true, boardId: true })
  .partial()
  .strict();
export type UpdateMondayBoardRequest = z.infer<typeof updateMondayBoardRequestSchema>;

export const approveMondayBoardRequestSchema = z.object({
  approved: z.boolean(),
  notes: z.string().max(1000).optional(),
});
export type ApproveMondayBoardRequest = z.infer<typeof approveMondayBoardRequestSchema>;

export interface MondayBoardDto {
  id: string;
  projectId: string;
  projectName: string;
  boardId: string;
  name: string;
  groupIds: string[];
  statusColumnId: string;
  assigneeColumnId: string | null;
  priorityColumnId: string | null;
  dueDateColumnId: string | null;
  pullRequestColumnId: string | null;
  dependencyColumnId: string | null;
  nightShiftFlagColumnId: string | null;
  itemTypeColumnId: string | null;
  sizeColumnId: string | null;
  statusLabels: z.infer<typeof mondayStatusLabelsSchema>;
  startableStatuses: string[];
  completedStatuses: string[];
  allowedItemTypes: string[];
  mayComplete: boolean;
  nightShiftEligible: boolean;
  requireItemFlag: boolean;
  macUserId: string | null;
  isApproved: boolean;
  approvedAt: string | null;
  lastSyncedAt: string | null;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface MondayItemDto {
  id: string;
  boardRowId: string;
  projectId: string;
  taskId: string | null;
  itemId: string;
  name: string;
  url: string | null;
  status: string | null;
  priority: string | null;
  assigneeIds: string[];
  dueDate: string | null;
  description: string | null;
  dependsOn: string[];
  nightShiftFlag: boolean;
  itemType: string | null;
  sizeLabel: string | null;
  lastSyncedAt: string;
}

export interface MondayWriteDto {
  id: string;
  itemId: string;
  runId: string | null;
  kind: z.infer<typeof mondayWriteKindSchema>;
  status: z.infer<typeof mondayWriteStatusSchema>;
  attempts: number;
  providerMessageId: string | null;
  lastError: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

// --- Night shift -----------------------------------------------------------

export const startNightShiftRequestSchema = z.object({
  /** Overrides the configured cutoff for this shift only. */
  cutoffAt: z.string().optional(),
  notes: z.string().max(1000).optional(),
});
export type StartNightShiftRequest = z.infer<typeof startNightShiftRequestSchema>;

export const stopNightShiftRequestSchema = z.object({
  reason: z.string().max(500).optional(),
});
export type StopNightShiftRequest = z.infer<typeof stopNightShiftRequestSchema>;

export interface NightDecisionDto {
  id: string;
  nightShiftId: string;
  at: string;
  sequence: number;
  decision: z.infer<typeof nightDecisionKindSchema>;
  runId: string | null;
  taskId: string | null;
  taskTitle: string | null;
  mondayItemId: string | null;
  rationale: z.infer<typeof schedulingRationaleSchema>;
  eligibility: z.infer<typeof eligibilityVerdictSchema> | null;
  effort: z.infer<typeof effortEstimateSchema> | null;
}

export interface NightShiftDto {
  id: string;
  status: z.infer<typeof nightShiftStatusSchema>;
  startedAt: string;
  endedAt: string | null;
  cutoffAt: string;
  stopReason: z.infer<typeof nightStopReasonSchema> | null;
  tasksAttempted: number;
  tasksCompleted: number;
  tasksBlocked: number;
  minutesRemaining: number;
}

/**
 * A candidate for the Night Queue screen.
 *
 * Carries the FULL eligibility verdict, not just a boolean, because the screen
 * has to answer "why is this eligible?" as readily as "why was this skipped?".
 */
export interface NightCandidateDto {
  taskId: string | null;
  taskTitle: string;
  projectId: string;
  projectName: string;
  mondayItemId: string | null;
  mondayItemUrl: string | null;
  priority: string | null;
  priorityRank: number;
  confidence: number | null;
  eligibility: z.infer<typeof eligibilityVerdictSchema>;
  effort: z.infer<typeof effortEstimateSchema> | null;
  /** Null when the task is eligible and would be startable now. */
  skipReason: string | null;
}

export interface NightShiftDashboardDto {
  shift: NightShiftDto | null;
  macState: 'day_mode' | 'idle' | 'working' | 'blocked' | 'stopped';
  activeRun: RunDto | null;
  activeProjectName: string | null;
  queue: NightCandidateDto[];
  blocked: Array<{ runId: string; taskTitle: string; projectName: string; blocker: string; at: string }>;
  completedTonight: Array<{ runId: string; taskTitle: string; projectName: string; pullRequestUrl: string | null }>;
  minutesUntilCutoff: number;
  budget: BudgetStatusDto;
  workers: WorkerDto[];
  sandboxReadyWorkers: number;
  recentDecisions: NightDecisionDto[];
}

export const approveProjectNightShiftRequestSchema = z.object({
  approved: z.boolean(),
  notes: z.string().max(1000).optional(),
});
export type ApproveProjectNightShiftRequest = z.infer<typeof approveProjectNightShiftRequestSchema>;

// --- Email deliveries ------------------------------------------------------

export interface EmailDeliveryDto {
  id: string;
  kind: z.infer<typeof emailDeliveryKindSchema>;
  nightShiftId: string | null;
  runId: string | null;
  recipients: string[];
  subject: string;
  status: z.infer<typeof emailDeliveryStatusSchema>;
  attempts: number;
  provider: string;
  providerMessageId: string | null;
  lastError: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
  sentAt: string | null;
}

// --- Investigations --------------------------------------------------------

export interface InvestigationDto {
  id: string;
  taskId: string;
  runId: string | null;
  discoverySessionId: string | null;
  result: z.infer<typeof investigationResultSchema>;
  createdAt: string;
}

// --- Sprint 3 additions to existing DTOs -----------------------------------

export interface RunProvenanceDto {
  selectedBy: z.infer<typeof runSelectionSourceSchema>;
  approvalSource: z.infer<typeof approvalSourceSchema> | null;
  nightShiftId: string | null;
  mondayItemId: string | null;
  testNetwork: z.infer<typeof sandboxNetworkModeSchema> | null;
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
  /** Compact company-context summary for the sidebar indicator. */
  companyContext: {
    enabled: boolean;
    status: string;
    shortSha: string | null;
    contextVersion: string | null;
    cached: boolean;
    stale: boolean;
  };
}
