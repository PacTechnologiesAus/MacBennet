import { z } from 'zod';
import { jobKindSchema } from './jobs.js';
import { logStreamSchema, runOutcomeSchema, stopReasonSchema, workerStatusSchema } from './enums.js';
import { agentAnswerSchema, agentEventSchema, codingTaskSchema } from './coding-agent.js';
import { usageSnapshotSchema } from './usage.js';
import { sandboxAttestationSchema, sandboxNetworkModeSchema } from './sandbox.js';

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
  /**
   * Sprint 3: the control plane is asking this worker to rotate its credential.
   *
   * It rides the envelope for exactly the reason cancellation does — the
   * envelope is on EVERY worker-facing response, so the request reaches the
   * worker on whichever call happens next. That is what makes rotation possible
   * without anyone touching the VM, which was the requirement.
   */
  rotateTokenRequested: z.boolean().default(false),
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
  /**
   * Sprint 3: what containment this worker can actually provide.
   *
   * Reported rather than assumed, and re-reported on every heartbeat, because
   * a sandbox that stopped working between registration and 02:00 must stop
   * coding work rather than silently become a claim on a dashboard.
   */
  sandbox: sandboxAttestationSchema.optional(),
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
  /** Re-attested every beat, so a sandbox that broke is noticed within seconds. */
  sandbox: sandboxAttestationSchema.optional(),
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

/**
 * Everything a coding run needs, resolved SERVER-SIDE at lease time from the
 * repository row and the handoff brief.
 *
 * No part of this is supplied by a client. A run request names a repository id
 * and a brief id; the control plane turns those into a remote, a path, a branch
 * name and a brief. That is why the worker can execute a coding session without
 * the protocol ever carrying a command or a filesystem path from a user.
 */
export const generalAssignmentSchema = z.object({
  /** What kind of work. The worker uses it only for log wording. */
  taskKind: z.enum(['research', 'analysis', 'investigation', 'scoping', 'documentation', 'administrative']),
  /** Ceiling the worker enforces locally, in addition to the server's own. */
  maxSteps: z.number().int().min(1).max(12),
  maxMinutes: z.number().int().min(1).max(720),
  /** The objective, for the run log. Not a prompt: the plan lives server-side. */
  objective: z.string().max(4000),
  deliverables: z.array(z.string().max(600)).max(20).default([]),
});
export type GeneralAssignment = z.infer<typeof generalAssignmentSchema>;

export const codingAssignmentSchema = z.object({
  repositoryId: z.string().uuid(),
  repositoryName: z.string(),
  remoteUrl: z.string(),
  remoteName: z.string(),
  /** Where the repository is cloned on the worker. Admin-configured, not run-supplied. */
  localPath: z.string(),
  defaultBranch: z.string(),
  /** Generated by the control plane from the task; charset-restricted. */
  branch: z.string(),
  provider: z.enum(['claude_code', 'mock']),
  /** The structured brief, minus the ids the worker has no use for. */
  task: codingTaskSchema.omit({ runId: true, taskId: true, worktreePath: true, branch: true, baseBranch: true }),
  openPullRequest: z.boolean(),
  /** Base for the PR. Always the default branch — and Mac may never merge it. */
  pullRequestBase: z.string(),
  /**
   * Sprint 3: the containment the control plane requires for this run.
   *
   * Built server-side like everything else in this block. A worker that cannot
   * satisfy it refuses the run rather than running the agent unconfined —
   * `required: true` means exactly that, and it is the default.
   */
  sandbox: z
    .object({
      required: z.boolean().default(true),
      /** Network posture for the project's own test/build command. */
      testNetwork: sandboxNetworkModeSchema.default('none'),
    })
    .default({}),
});
export type CodingAssignment = z.infer<typeof codingAssignmentSchema>;

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
  /** Present only for repository jobs. Built server-side; never client-supplied. */
  coding: codingAssignmentSchema.nullable().default(null),
  /** Sprint 3.3: present only for general (non-coding) jobs. Also server-built. */
  general: generalAssignmentSchema.nullable().default(null),
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

export const MAX_COMPLETION_SUMMARY_CHARS = 2000;

export const completeRequestSchema = z.object({
  outcome: runOutcomeSchema,
  stopReason: stopReasonSchema.nullable().optional(),
  summary: z.string().max(MAX_COMPLETION_SUMMARY_CHARS).optional(),
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

// --- Sprint 2: supervision, agent events, usage, worktrees ------------------

/**
 * The worker asks Mac a question on the coding agent's behalf.
 *
 * The worker deliberately does NOT answer it. Every decision made during an
 * autonomous run belongs in the control plane, where it is persisted, audited
 * and reviewable — a worker that decided things itself would be a worker whose
 * reasoning nobody could inspect afterwards.
 */
export const askQuestionRequestSchema = z.object({
  questionId: z.string().min(1).max(80),
  question: z.string().min(1).max(4000),
  context: z.string().max(4000).optional(),
  /** What the agent was doing when it asked. Helps Mac judge risk. */
  activity: z.string().max(500).optional(),
});
export type AskQuestionRequest = z.infer<typeof askQuestionRequestSchema>;

export const askQuestionResponseSchema = withControl({ answer: agentAnswerSchema });
export type AskQuestionResponse = z.infer<typeof askQuestionResponseSchema>;

export const MAX_AGENT_EVENT_BATCH = 200;

export const agentEventBatchRequestSchema = z.object({
  sessionId: z.string().min(1).max(80),
  provider: z.string().min(1).max(60),
  events: z.array(agentEventSchema).min(1).max(MAX_AGENT_EVENT_BATCH),
});
export type AgentEventBatchRequest = z.infer<typeof agentEventBatchRequestSchema>;

export const agentEventBatchResponseSchema = withControl({
  accepted: z.number().int().min(0),
  highestSeq: z.number().int().min(-1),
});
export type AgentEventBatchResponse = z.infer<typeof agentEventBatchResponseSchema>;

export const usageSnapshotRequestSchema = z.object({ snapshot: usageSnapshotSchema });
export type UsageSnapshotRequest = z.infer<typeof usageSnapshotRequestSchema>;

export const usageSnapshotResponseSchema = withControl({ accepted: z.literal(true) });
export type UsageSnapshotResponse = z.infer<typeof usageSnapshotResponseSchema>;

/** Reported once the worktree exists, so it is visible in the UI while work runs. */
export const worktreeReportRequestSchema = z.object({
  path: z.string().min(1).max(1000),
  branch: z.string().min(1).max(200),
  baseBranch: z.string().min(1).max(200),
  baseSha: z.string().min(1).max(64),
  headSha: z.string().max(64).nullable().optional(),
  commitCount: z.number().int().min(0).default(0),
  status: z.enum(['active', 'preserved', 'removed']).default('active'),
});
export type WorktreeReportRequest = z.infer<typeof worktreeReportRequestSchema>;

export const worktreeReportResponseSchema = withControl({ worktreeId: z.string().uuid() });
export type WorktreeReportResponse = z.infer<typeof worktreeReportResponseSchema>;

/**
 * A refused git operation. Reported separately from logs because it is a
 * security event, not commentary: it means a coding agent attempted something
 * the specification forbids.
 */
export const gitViolationReportRequestSchema = z.object({
  code: z.string().min(1).max(60),
  argv: z.array(z.string().max(500)).max(60),
  message: z.string().max(2000),
  /** 'mac' when Mac's own code was refused, 'agent' when the shim caught the agent. */
  origin: z.enum(['mac', 'agent']),
  at: z.string(),
});
export type GitViolationReportRequest = z.infer<typeof gitViolationReportRequestSchema>;

export const gitViolationReportResponseSchema = withControl({ accepted: z.literal(true) });
export type GitViolationReportResponse = z.infer<typeof gitViolationReportResponseSchema>;

/**
 * Evidence collected from the repository after the coding agent finishes.
 *
 * The worker gathers FACTS; it draws no conclusions. Mac reads these and
 * produces the verdict, because "did this satisfy the brief" is a judgement
 * that must live where the brief lives and where it can be audited.
 */
export const reviewEvidenceSchema = z.object({
  agentSummary: z.string().max(8000),
  agentReportedSuccess: z.boolean(),
  filesChanged: z
    .array(z.object({ path: z.string().max(400), status: z.string().max(20), insertions: z.number().int().min(0), deletions: z.number().int().min(0) }))
    .max(1000)
    .default([]),
  /** Files modified but never committed — a common way work is silently lost. */
  uncommittedFiles: z.array(z.string().max(400)).max(500).default([]),
  commits: z
    .array(z.object({ sha: z.string().max(64), subject: z.string().max(500) }))
    .max(200)
    .default([]),
  diffStat: z.object({ files: z.number().int().min(0), insertions: z.number().int().min(0), deletions: z.number().int().min(0) }),
  /** Truncated unified diff, for the reviewer and for anomaly detection. */
  diffSample: z.string().max(200_000).default(''),
  tests: z
    .object({
      ran: z.boolean(),
      command: z.array(z.string().max(300)).max(30).default([]),
      exitCode: z.number().int().nullable(),
      passed: z.boolean().nullable(),
      durationMs: z.number().int().min(0).nullable(),
      output: z.string().max(60_000).default(''),
    })
    .nullable()
    .default(null),
  build: z
    .object({
      ran: z.boolean(),
      command: z.array(z.string().max(300)).max(30).default([]),
      exitCode: z.number().int().nullable(),
      passed: z.boolean().nullable(),
      output: z.string().max(60_000).default(''),
    })
    .nullable()
    .default(null),
  dependencyChanges: z.array(z.string().max(400)).max(200).default([]),
  configurationChanges: z.array(z.string().max(400)).max(200).default([]),
  migrations: z.array(z.string().max(400)).max(200).default([]),
  /** Layer-3 git verification: did the default branch move? */
  defaultBranchUnchanged: z.boolean(),
  defaultBranchSha: z.string().max(64).nullable().default(null),
  prohibitedOperationsAttempted: z.number().int().min(0).default(0),
});
export type ReviewEvidence = z.infer<typeof reviewEvidenceSchema>;

export const submitReviewRequestSchema = z.object({ evidence: reviewEvidenceSchema });
export type SubmitReviewRequest = z.infer<typeof submitReviewRequestSchema>;

/**
 * Mac's verdict, plus — when he decides a PR is warranted — the exact text to
 * open it with. The worker performs the push and the `gh` call; it does not
 * decide whether to.
 */
export const reviewVerdictResponseSchema = withControl({
  verdict: z.string(),
  riskLevel: z.enum(['low', 'medium', 'high']),
  satisfiesBrief: z.boolean(),
  acceptanceCriteriaMet: z.boolean(),
  unexpectedScope: z.boolean(),
  humanAttentionRequired: z.boolean(),
  anomalies: z.array(z.string().max(1000)).default([]),
  pullRequest: z
    .object({ shouldOpen: z.literal(true), title: z.string().max(300), body: z.string().max(60_000), base: z.string().max(200) })
    .or(z.object({ shouldOpen: z.literal(false), reason: z.string().max(2000) })),
});
export type ReviewVerdictResponse = z.infer<typeof reviewVerdictResponseSchema>;

export const pullRequestReportRequestSchema = z.object({
  number: z.number().int().min(1).nullable(),
  url: z.string().max(1000),
  title: z.string().max(300),
  branch: z.string().max(200),
  baseBranch: z.string().max(200),
  provider: z.string().max(60).default('github'),
});
export type PullRequestReportRequest = z.infer<typeof pullRequestReportRequestSchema>;

export const pullRequestReportResponseSchema = withControl({ pullRequestId: z.string().uuid() });
export type PullRequestReportResponse = z.infer<typeof pullRequestReportResponseSchema>;

/** The result of the worker's read-only repository inspection (discovery Phase A). */
export const projectContextSnapshotSchema = z.object({
  repositoryId: z.string().uuid(),
  defaultBranch: z.string(),
  headSha: z.string(),
  branches: z.array(z.string().max(300)).max(200).default([]),
  recentCommits: z
    .array(
      z.object({
        sha: z.string().max(64),
        author: z.string().max(200),
        at: z.string(),
        subject: z.string().max(500),
      }),
    )
    .max(100)
    .default([]),
  readme: z.string().max(40_000).nullable().default(null),
  docFiles: z.array(z.string().max(400)).max(200).default([]),
  packageManifests: z
    .array(z.object({ path: z.string().max(400), name: z.string().max(200).nullable(), scripts: z.array(z.string().max(120)).max(80).default([]) }))
    .max(50)
    .default([]),
  testPaths: z.array(z.string().max(400)).max(200).default([]),
  languages: z.array(z.string().max(60)).max(40).default([]),
  fileCount: z.number().int().min(0),
  /** Commits since Mac's previous involvement, when a prior sha was supplied. */
  changedSinceLastInvolvement: z
    .object({ sinceSha: z.string().max(64), commitCount: z.number().int().min(0), files: z.array(z.string().max(400)).max(500).default([]) })
    .nullable()
    .default(null),
});
export type ProjectContextSnapshot = z.infer<typeof projectContextSnapshotSchema>;

export const contextSnapshotRequestSchema = z.object({ snapshot: projectContextSnapshotSchema });
export type ContextSnapshotRequest = z.infer<typeof contextSnapshotRequestSchema>;

export const contextSnapshotResponseSchema = withControl({ accepted: z.literal(true) });
export type ContextSnapshotResponse = z.infer<typeof contextSnapshotResponseSchema>;

// --- General (non-coding) work, Sprint 3.3 ---------------------------------
//
// The worker DRIVES a general run and the control plane PERFORMS each reasoning
// step. Read the two schemas below with that split in mind, and note what the
// worker never receives:
//
//   * no model API key, and no provider name it could redirect;
//   * no company-context documents, and no path to the mirror;
//   * no project memory, no monday token, no other project's data;
//   * no prompt, and no tool it could call directly.
//
// It sends "do the next step" and gets back progress. Every credential and every
// data scope stays in the control plane, which is what Sprint 3.3 section 29
// requires — a research capability must not become a way to hand the VM the keys
// to everything Mac can read.


export const researchStepRequestSchema = z.object({}).strict();
export type ResearchStepRequest = z.infer<typeof researchStepRequestSchema>;

/**
 * What one step produced.
 *
 * Counts and a narrative, never content. A worker that logged the findings
 * themselves would be writing PAC policy excerpts into a VM's log file, and the
 * whole point of keeping reasoning in the control plane is that they never get
 * there.
 */
export const researchStepResponseSchema = withControl({
  stage: z.string().max(40),
  stepsTaken: z.number().int().min(0),
  toolCallsMade: z.number().int().min(0),
  narrative: z.string().max(4000),
  findingsSoFar: z.number().int().min(0),
  sourcesSoFar: z.number().int().min(0),
  artefactsCreated: z.number().int().min(0),
  done: z.boolean(),
  limitReached: z.boolean(),
  blockerProposed: z.string().max(1000).nullable(),
  percent: z.number().int().min(0).max(100),
});
export type ResearchStepResponse = z.infer<typeof researchStepResponseSchema>;

// --- Sprint 3: credential rotation and sandbox attestation ------------------

/**
 * The worker rotates its own credential.
 *
 * Authenticated with the token being replaced, so possession of the current
 * credential is what authorises its replacement — the same property that makes
 * the two-stage enrollment safe. The new token is returned exactly once, like
 * the one registration issues, and exists in plaintext nowhere else.
 */
export const rotateTokenRequestSchema = z.object({
  /** Why the worker is rotating. Recorded on the audit event. */
  reason: z.enum(['server_requested', 'scheduled', 'worker_initiated']).default('worker_initiated'),
});
export type RotateTokenRequest = z.infer<typeof rotateTokenRequestSchema>;

export const rotateTokenResponseSchema = withControl({
  workerToken: z.string().min(1),
  /**
   * How long the previous token keeps working.
   *
   * It exists so an in-flight request signed with the old token does not fail
   * mid-rotation, and it is deliberately short. A long overlap would turn a
   * rotation into "two valid credentials", which is the thing rotation is
   * supposed to end.
   */
  previousTokenValidForSeconds: z.number().int().min(0),
  issuedAt: z.string(),
});
export type RotateTokenResponse = z.infer<typeof rotateTokenResponseSchema>;

/**
 * The worker reports the containment it established for a specific run.
 *
 * Distinct from the fleet-level attestation above, which says what a worker CAN
 * do. This says what it actually did for this piece of work — "the sandbox was
 * open, and these were its mounts" — which is the fact a reviewer needs
 * afterwards and which a log line cannot be queried for.
 */
export const runSandboxReportSchema = z.object({
  established: z.boolean(),
  kind: z.string().max(40),
  version: z.string().max(120).nullable().default(null),
  /** Mount purposes and modes only. Never the host paths, which are noise here. */
  mounts: z
    .array(z.object({ purpose: z.string().max(40), mode: z.enum(['ro', 'rw']) }))
    .max(64)
    .default([]),
  network: z.enum(['none', 'egress']).default('egress'),
  /** Present when containment was refused: why, in a form a human can act on. */
  refusalReason: z.string().max(1000).nullable().default(null),
});
export type RunSandboxReport = z.infer<typeof runSandboxReportSchema>;

export const runSandboxReportRequestSchema = z.object({ sandbox: runSandboxReportSchema });
export type RunSandboxReportRequest = z.infer<typeof runSandboxReportRequestSchema>;

export const runSandboxReportResponseSchema = withControl({ accepted: z.literal(true) });
export type RunSandboxReportResponse = z.infer<typeof runSandboxReportResponseSchema>;

export const sandboxAttestationRequestSchema = z.object({ sandbox: sandboxAttestationSchema });
export type SandboxAttestationRequest = z.infer<typeof sandboxAttestationRequestSchema>;

export const sandboxAttestationResponseSchema = withControl({
  accepted: z.literal(true),
  /** True when the control plane will withhold coding work from this worker. */
  codingWorkWithheld: z.boolean(),
});
export type SandboxAttestationResponse = z.infer<typeof sandboxAttestationResponseSchema>;

/** Header the worker uses for both enrollment and operation. */
export const WORKER_AUTH_HEADER = 'authorization';
export const WORKER_TOKEN_PREFIX = 'mac_wk_';
export const ENROLLMENT_TOKEN_PREFIX = 'mac_en_';
