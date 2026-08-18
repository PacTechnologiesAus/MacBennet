import { z } from 'zod';

/**
 * The Sprint 1 execution allowlist.
 *
 * This file is the security boundary for what a worker is able to do. There is
 * deliberately NO job kind that accepts a command, a script, a path outside the
 * configured workspace, or any other arbitrary input — the protocol simply has
 * no field in which such a thing could be expressed.
 *
 * Adding a capability later means adding an entry here plus a handler in
 * apps/worker/src/jobs. That is a visible, reviewable code change rather than a
 * configuration toggle, which is exactly the property we want.
 *
 * The catalogue is validated three times: when a run is created, again when it
 * is dispatched, and again by the worker before execution.
 */

export const jobParamSchemas = {
  /** Does nothing successfully. The smallest possible proof of the control loop. */
  noop: z.object({}).strict(),

  /** Writes a bounded message to the run log. */
  echo: z
    .object({
      message: z.string().min(1).max(500),
    })
    .strict(),

  /**
   * Sleeps for a bounded period, emitting progress as it goes.
   * Exists so that dispatch, progress reporting and cancellation of an
   * in-flight run can all be exercised for real.
   */
  sleep: z
    .object({
      seconds: z.number().int().min(1).max(120),
    })
    .strict(),

  /** Reports non-sensitive facts about the worker host. No shell involved. */
  system_info: z.object({}).strict(),

  /** Checks the configured workspace directory exists and is writable. */
  workspace_check: z.object({}).strict(),

  /**
   * Fails on purpose. Present so the failure path is a tested path rather than
   * something first exercised in anger.
   */
  fail: z
    .object({
      message: z.string().min(1).max(500).optional(),
    })
    .strict(),

  // --- Sprint 2 -------------------------------------------------------------
  //
  // Sprint 2 adds process execution to the worker. Read the two schemas below
  // carefully, because they are where that could have gone wrong and did not:
  //
  //   * neither carries a command, a script, a path, an argument list or an
  //     environment variable;
  //   * both carry ONLY identifiers, which the control plane resolves against
  //     its own database into a repository, a branch and a brief;
  //   * the commands actually executed (git, the coding agent, the project's
  //     test command) are fixed by worker code or by admin-configured argv on
  //     the repository row — never by the run request.
  //
  // So adding Claude Code did not turn the worker into a remote shell: the
  // protocol still has no field in which a shell command could be expressed.

  /**
   * Delegate implementation of an approved, briefed task to a coding agent
   * inside an isolated worktree.
   */
  claude_code: z
    .object({
      /** Which repository to work in. Must be approved; re-checked at dispatch. */
      repositoryId: z.string().uuid(),
      /** The structured handoff brief the agent will be given. */
      briefId: z.string().uuid(),
      /** Which agent implementation to use. `mock` exists for tests and dry runs. */
      provider: z.enum(['claude_code', 'mock']).default('claude_code'),
      /** Wall-clock ceiling for the agent session. */
      maxMinutes: z.number().int().min(1).max(720).default(60),
      /** Open a PR when the run is eligible. Never implies a merge. */
      openPullRequest: z.boolean().default(true),
    })
    .strict(),

  /**
   * Read-only inspection of an approved repository, used by discovery Phase A.
   * Writes nothing and creates no branch.
   */
  repo_inspect: z
    .object({
      repositoryId: z.string().uuid(),
      /** Compare against Mac's previous involvement, when there was one. */
      sinceSha: z.string().max(64).nullable().default(null),
    })
    .strict(),

  // --- Sprint 3.3 -----------------------------------------------------------
  //
  // General (non-coding) work. Read this schema with the same suspicion as the
  // two above, and note what it does NOT contain:
  //
  //   * no repository, no worktree, no branch, no path;
  //   * no command, no script, no tool name, no URL;
  //   * no prompt, and no objective.
  //
  // It carries a brief id and a task kind. The control plane turns those into a
  // research plan, a permitted tool set and a model provider — all server-side,
  // from records a human approved. The worker drives the lifecycle (heartbeat,
  // progress, cancellation, cutoff) and asks the control plane to perform each
  // reasoning step, so the model credential and the tool layer never leave the
  // control plane at all (Sprint 3.3 section 29).
  general_task: z
    .object({
      /** The structured handoff brief. The execution contract for this run. */
      briefId: z.string().uuid(),
      /** What kind of work this is. Decides the plan and the dimension set. */
      taskKind: z.enum(['research', 'analysis', 'investigation', 'scoping', 'documentation', 'administrative']),
      /** Wall-clock ceiling, as for a coding session. */
      maxMinutes: z.number().int().min(1).max(720).default(60),
      /** Upper bound on reasoning steps. Also hard-capped by RESEARCH_LIMITS. */
      maxSteps: z.number().int().min(1).max(12).default(8),
    })
    .strict(),
} as const;

export type JobKind = keyof typeof jobParamSchemas;

export const JOB_KINDS = Object.keys(jobParamSchemas) as [JobKind, ...JobKind[]];

export const jobKindSchema = z.enum(JOB_KINDS);

export interface JobDescriptor {
  kind: JobKind;
  label: string;
  description: string;
  /** Rough upper bound on runtime, used only for operator-facing hints. */
  typicalDurationSeconds: number;
}

export const JOB_CATALOGUE: readonly JobDescriptor[] = [
  { kind: 'noop', label: 'No-op', description: 'Starts and finishes immediately. Proves dispatch end to end.', typicalDurationSeconds: 1 },
  { kind: 'echo', label: 'Echo message', description: 'Writes a supplied message to the run log.', typicalDurationSeconds: 1 },
  { kind: 'sleep', label: 'Sleep', description: 'Sleeps for a bounded period, reporting progress. Cancellable mid-run.', typicalDurationSeconds: 10 },
  { kind: 'system_info', label: 'System info', description: 'Reports platform, architecture, CPU count, memory and Node version.', typicalDurationSeconds: 1 },
  { kind: 'workspace_check', label: 'Workspace check', description: "Verifies the worker's workspace directory exists and is writable.", typicalDurationSeconds: 1 },
  { kind: 'fail', label: 'Deliberate failure', description: 'Fails on purpose so the failure path can be exercised.', typicalDurationSeconds: 1 },
  {
    kind: 'claude_code',
    label: 'Coding task (Claude Code)',
    description:
      'Creates an isolated worktree and task branch, delegates implementation to a coding agent, supervises it, runs tests, self-reviews and prepares a pull request. Never merges or pushes to the default branch.',
    typicalDurationSeconds: 1800,
  },
  {
    kind: 'repo_inspect',
    label: 'Inspect repository',
    description: 'Read-only inspection of an approved repository for discovery: README, manifests, tests, branches and recent history.',
    typicalDurationSeconds: 30,
  },
  {
    kind: 'general_task',
    label: 'General task (research, analysis, scoping)',
    description:
      'Executes non-coding technical work against an approved handoff brief: investigates approved sources, ' +
      'distinguishes fact from inference, and produces evidence-backed artefacts. Requires no repository and no ' +
      'monday.com item.',
    typicalDurationSeconds: 900,
  },
] as const;

/**
 * Discriminated union of a complete job specification. Anything that does not
 * parse against this is not a job.
 */
export const jobSpecSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('noop'), params: jobParamSchemas.noop }),
  z.object({ kind: z.literal('echo'), params: jobParamSchemas.echo }),
  z.object({ kind: z.literal('sleep'), params: jobParamSchemas.sleep }),
  z.object({ kind: z.literal('system_info'), params: jobParamSchemas.system_info }),
  z.object({ kind: z.literal('workspace_check'), params: jobParamSchemas.workspace_check }),
  z.object({ kind: z.literal('fail'), params: jobParamSchemas.fail }),
  z.object({ kind: z.literal('claude_code'), params: jobParamSchemas.claude_code }),
  z.object({ kind: z.literal('repo_inspect'), params: jobParamSchemas.repo_inspect }),
  z.object({ kind: z.literal('general_task'), params: jobParamSchemas.general_task }),
]);

export type JobSpec = z.infer<typeof jobSpecSchema>;

/**
 * Job kinds that operate on a repository and therefore require an approved one.
 * Used by the dispatch guardrail, so approval cannot be forgotten at a call site.
 */
export const REPOSITORY_JOB_KINDS = ['claude_code', 'repo_inspect'] as const;
export const requiresApprovedRepository = (kind: string): boolean =>
  (REPOSITORY_JOB_KINDS as readonly string[]).includes(kind);

/** Job kinds that create commits. These are the ones the git policy governs. */
export const isCodingJobKind = (kind: string): boolean => kind === 'claude_code';

/**
 * Job kinds executed by the general (non-coding) worker capability.
 *
 * Sprint 3.3: these require a reasoning-model provider and a handoff brief, and
 * require NEITHER a repository nor a monday item. `requiresApprovedRepository`
 * above deliberately does not include this kind — that is the whole point.
 */
export const GENERAL_JOB_KINDS = ['general_task'] as const;
export const isGeneralJobKind = (kind: string): boolean =>
  (GENERAL_JOB_KINDS as readonly string[]).includes(kind);

/** Job kinds that need a handoff brief resolved server-side at lease time. */
export const requiresHandoffBrief = (kind: string): boolean =>
  kind === 'claude_code' || isGeneralJobKind(kind);

export const isAllowedJobKind = (kind: unknown): kind is JobKind =>
  typeof kind === 'string' && Object.prototype.hasOwnProperty.call(jobParamSchemas, kind);

/**
 * Parses a (kind, params) pair against the allowlist.
 * Returns a discriminated result rather than throwing so that callers are
 * forced to handle rejection explicitly at each of the three validation points.
 */
export function parseJobSpec(
  kind: unknown,
  params: unknown,
): { ok: true; job: JobSpec } | { ok: false; error: string } {
  if (!isAllowedJobKind(kind)) {
    return { ok: false, error: `Unknown job kind: ${JSON.stringify(kind)}` };
  }
  const parsed = jobSpecSchema.safeParse({ kind, params: params ?? {} });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.') || 'params'}: ${i.message}`).join('; ') };
  }
  return { ok: true, job: parsed.data };
}

/** Capabilities a Sprint 1 worker advertises at registration. */
export const WORKER_CAPABILITIES_V1 = JOB_KINDS;
