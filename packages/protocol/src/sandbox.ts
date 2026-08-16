import { z } from 'zod';

/**
 * The execution sandbox (Sprint 3 §3).
 *
 * Sprint 2 gave the worker the ability to execute processes and admitted, in
 * its own risk register (R-4), that nothing stopped a coding agent writing
 * outside its worktree: `cwd` was set, `--add-dir` was not passed, and the
 * damage was inspected afterwards. That is a convention, not a boundary.
 *
 * This file is the vocabulary for a real one. Two things about it matter:
 *
 *  1. **The plan is data, and it is pure.** `buildSandboxPlan` takes
 *     configuration and produces this structure with no I/O at all, so every
 *     containment rule can be tested on any platform in microseconds. The
 *     providers translate the plan into `bwrap` or `docker` argv and add
 *     nothing of their own.
 *
 *  2. **`deniedWitnesses` is part of the plan.** A sandbox that merely fails to
 *     mount a secret is indistinguishable, in a passing test, from one that
 *     mounted it and nobody looked. Carrying the paths that MUST be absent lets
 *     the conformance tests assert absence directly, against the real provider.
 */

export const SANDBOX_KINDS = ['bubblewrap', 'docker', 'none'] as const;
export const sandboxKindSchema = z.enum(SANDBOX_KINDS);
export type SandboxKind = z.infer<typeof sandboxKindSchema>;

export const SANDBOX_MOUNT_MODES = ['ro', 'rw'] as const;
export const sandboxMountModeSchema = z.enum(SANDBOX_MOUNT_MODES);
export type SandboxMountMode = z.infer<typeof sandboxMountModeSchema>;

/**
 * Why a mount exists.
 *
 * Recorded because "which of these did we actually need?" is the question asked
 * when a sandbox is later tightened, and a list of paths without purposes
 * cannot answer it.
 */
export const SANDBOX_MOUNT_PURPOSES = [
  'worktree',
  'repository_git',
  'git_shim',
  'scratch',
  'tooling',
  'credential',
  'system',
] as const;
export const sandboxMountPurposeSchema = z.enum(SANDBOX_MOUNT_PURPOSES);
export type SandboxMountPurpose = z.infer<typeof sandboxMountPurposeSchema>;

export const sandboxMountSchema = z.object({
  /** Absolute host path. Resolved and checked before it reaches this structure. */
  hostPath: z.string().min(1),
  /**
   * Path inside the sandbox. Identity for bubblewrap; a canonical `/mac/...`
   * path for docker, where the host path may not even be expressible.
   */
  sandboxPath: z.string().min(1),
  mode: sandboxMountModeSchema,
  purpose: sandboxMountPurposeSchema,
});
export type SandboxMount = z.infer<typeof sandboxMountSchema>;

/**
 * Network posture.
 *
 * Two values, because there are exactly two cases: the coding agent must reach
 * its model API, and a project's test suite generally must not reach anything.
 * The filesystem is the axis this sprint's requirements are written on; this is
 * a smaller second axis and is described as such rather than oversold.
 */
export const SANDBOX_NETWORK_MODES = ['none', 'egress'] as const;
export const sandboxNetworkModeSchema = z.enum(SANDBOX_NETWORK_MODES);
export type SandboxNetworkMode = z.infer<typeof sandboxNetworkModeSchema>;

export const sandboxPlanSchema = z.object({
  /** Host path the child starts in. Must lie inside a `rw` mount. */
  workdir: z.string().min(1),
  mounts: z.array(sandboxMountSchema).min(1).max(64),
  /** In-sandbox paths backed by ephemeral storage, never shared between runs. */
  tmpfs: z.array(z.string().min(1)).max(16).default([]),
  /**
   * The child's entire environment.
   *
   * Built from EMPTY, not filtered from `process.env`. Sprint 2 deleted a regex
   * of known-dangerous keys from a copied environment; starting from nothing is
   * the stronger form of the same idea, because it is not a list that can fall
   * behind a newly introduced secret.
   */
  env: z.record(z.string()).default({}),
  network: sandboxNetworkModeSchema,
  /** Unprivileged execution identity. Null on hosts where it cannot be set. */
  user: z.object({ uid: z.number().int().min(0), gid: z.number().int().min(0) }).nullable().default(null),
  /** Paths that MUST NOT be reachable. The conformance suite's oracle. */
  deniedWitnesses: z.array(z.string()).max(64).default([]),
  /** Container image, for providers that need one. Admin-configured. */
  image: z.string().min(1).max(300).nullable().default(null),
  /** Wall-clock ceiling handed to the provider where it supports one. */
  maxMinutes: z.number().int().min(1).max(720).default(60),
});
export type SandboxPlan = z.infer<typeof sandboxPlanSchema>;

/** What a worker tells the control plane about its containment capability. */
export const sandboxAttestationSchema = z.object({
  kind: sandboxKindSchema,
  available: z.boolean(),
  version: z.string().max(120).nullable().default(null),
  /** Human-readable reason when unavailable. Shown on the Security screen. */
  detail: z.string().max(500).nullable().default(null),
});
export type SandboxAttestation = z.infer<typeof sandboxAttestationSchema>;

/**
 * Directory names that hold credentials on a developer machine.
 *
 * Used by the plan builder to refuse a mount outright. Deliberately
 * over-inclusive: a false positive costs an admin one explicit configuration
 * line, a false negative hands a coding agent an SSH key.
 */
export const CREDENTIAL_PATH_SEGMENTS = [
  '.ssh',
  '.aws',
  '.gnupg',
  '.gpg',
  '.docker',
  '.kube',
  '.azure',
  '.gcloud',
  '.config/gh',
  '.config/gcloud',
  '.claude',
  '.claude.json',
  '.npmrc',
  '.netrc',
  '.git-credentials',
  '.pgpass',
] as const;

/** Reasons the plan builder refuses to produce a plan. Each is fail-closed. */
export const SANDBOX_PLAN_REFUSALS = [
  'path_outside_allowed_roots',
  'path_is_credential_store',
  'path_is_filesystem_root',
  'path_is_home_directory',
  'path_is_worker_state',
  'workdir_not_writable',
  'no_worktree_mount',
  'relative_path',
] as const;
export const sandboxPlanRefusalSchema = z.enum(SANDBOX_PLAN_REFUSALS);
export type SandboxPlanRefusal = z.infer<typeof sandboxPlanRefusalSchema>;
