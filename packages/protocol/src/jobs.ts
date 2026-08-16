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
]);

export type JobSpec = z.infer<typeof jobSpecSchema>;

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
