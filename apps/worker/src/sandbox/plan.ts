import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CREDENTIAL_PATH_SEGMENTS,
  type SandboxKind,
  type SandboxMount,
  type SandboxNetworkMode,
  type SandboxPlan,
  type SandboxPlanRefusal,
} from '@mac/protocol';

/**
 * The sandbox plan (Sprint 3 §3.2).
 *
 * Every containment rule in the system lives in this file, and this file does
 * no process execution at all. The providers below it translate a plan into
 * `bwrap` or `docker` argv and add NOTHING of their own — so there is one
 * policy with two back-ends rather than two policies that can drift.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS BUYS
 *
 * Containment rules are the sort of thing that is written once, believed
 * forever, and never actually exercised. Making the plan a pure function of
 * configuration means every rule below is testable in microseconds on any
 * platform, including the ones where neither provider exists. The real
 * providers are then tested separately for the one thing only they can prove:
 * that the plan is actually enforced.
 *
 * `realpathSync` is the single exception to "no I/O" — a symlink check cannot
 * be done without touching the filesystem, and a containment rule that a
 * symlink defeats is not a containment rule.
 * ---------------------------------------------------------------------------
 */

export class SandboxPlanError extends Error {
  override readonly name = 'SandboxPlanError';
  constructor(
    readonly refusal: SandboxPlanRefusal,
    readonly offendingPath: string,
    message: string,
  ) {
    super(message);
  }
}

export interface SandboxPlanInput {
  /** The run's isolated worktree. The only writable project location. */
  worktreePath: string;
  /** The repository's git directory. Needed for git to function inside. */
  repositoryGitDir: string;
  /** Root of the repository clone. Used as an allowed root, never mounted whole. */
  repositoryPath: string;
  /** The worker's workspace root. Used as an allowed root. */
  workspaceRoot: string;
  /** The git shim directory, mounted read-only. */
  shimDir: string | null;
  /** Per-run scratch directory, writable and not shared with any other run. */
  scratchDir: string;
  /** Admin-configured read-only tooling mounts. Explicit; never inferred. */
  toolingMounts?: string[];
  /** Narrowly scoped credentials for this task. Read-only, and normally empty. */
  credentialMounts?: string[];
  network: SandboxNetworkMode;
  /** Which provider the plan is for; decides path mapping and system mounts. */
  kind: SandboxKind;
  image?: string | null;
  maxMinutes?: number;
  /** Extra environment the admin allowed through. Values only, never `process.env`. */
  extraEnv?: Record<string, string>;
  user?: { uid: number; gid: number } | null;
  /** Overridable so tests can exercise the rules without a real HOME. */
  homeDir?: string;
  /** The worker's own state file. Must never be reachable. */
  workerStateFile?: string;
}

/**
 * Canonical in-sandbox locations for the container provider.
 *
 * Bubblewrap uses identity mapping (the host path IS the sandbox path), which
 * is why it needs none of this: nothing has to be rewritten, and a stack trace
 * from inside the sandbox names a path that exists outside it.
 */
export const CONTAINER_PATHS = {
  worktree: '/mac/work',
  gitDir: '/mac/git',
  shim: '/mac/shim',
  scratch: '/mac/scratch',
  tooling: '/mac/tooling',
  credentials: '/mac/credentials',
  home: '/mac/home',
} as const;

const posix = (p: string): string => p.replace(/\\/g, '/');

/** Resolves through symlinks where possible; falls back for paths not yet created. */
function canonical(target: string): string {
  const resolved = path.resolve(target);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    // A path that does not exist yet cannot be a symlink escape, and the
    // provider will fail loudly if it is genuinely missing at spawn time.
    return resolved;
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * True when a path looks like a credential store.
 *
 * Deliberately over-inclusive. A false positive costs an admin one explicit
 * configuration line; a false negative hands a coding agent an SSH key.
 */
export function looksLikeCredentialStore(target: string): boolean {
  const normalised = posix(target).toLowerCase();
  const segments = normalised.split('/');
  return CREDENTIAL_PATH_SEGMENTS.some((needle) => {
    const n = needle.toLowerCase();
    return n.includes('/') ? normalised.includes(`/${n}`) : segments.includes(n);
  });
}

/**
 * Two classes of mount, and they are authorised differently.
 *
 * A `project` mount — the worktree, the repository's git directory, the scratch
 * space, the shim — is derived by Mac from the run, so it must be proven to sit
 * inside the repository or the workspace. That is the containment rule.
 *
 * An `operator` mount — tooling, a scoped credential — IS an administrator's
 * explicit decision, named in configuration. Requiring it to be inside the
 * workspace would make the feature useless (a toolchain lives in /opt) and,
 * worse, checking it against a root list that includes itself would make the
 * check vacuous while looking rigorous. So it is self-authorising for the ROOTS
 * rule, and still subject to every absolute refusal below.
 */
type MountAuthority = 'project' | 'operator';

function assertPathAcceptable(
  target: string,
  allowedRoots: string[],
  context: {
    homeDir: string;
    workerStateFile: string | null;
    allowCredential: boolean;
    authority: MountAuthority;
  },
): string {
  if (!path.isAbsolute(target)) {
    throw new SandboxPlanError('relative_path', target, `Sandbox mounts must be absolute paths; got "${target}".`);
  }

  const resolved = canonical(target);
  const parsed = path.parse(resolved);

  if (resolved === parsed.root) {
    throw new SandboxPlanError(
      'path_is_filesystem_root',
      resolved,
      'Refusing to mount the filesystem root into a sandbox. That is not a sandbox.',
    );
  }

  const home = canonical(context.homeDir);
  if (resolved === home) {
    throw new SandboxPlanError(
      'path_is_home_directory',
      resolved,
      'Refusing to mount the home directory into a sandbox: it is where credentials live.',
    );
  }

  if (context.workerStateFile) {
    const state = canonical(context.workerStateFile);
    if (resolved === state || isInside(state, resolved)) {
      throw new SandboxPlanError(
        'path_is_worker_state',
        resolved,
        "Refusing to expose the worker's own credential file to a sandboxed process.",
      );
    }
  }

  if (!context.allowCredential && looksLikeCredentialStore(resolved)) {
    throw new SandboxPlanError(
      'path_is_credential_store',
      resolved,
      `Refusing to mount "${resolved}": it looks like a credential store. If a task genuinely needs it, ` +
        'configure it as a scoped credential mount, which is read-only and recorded.',
    );
  }

  /*
   * The containment rule itself, and the reason `canonical` exists: the check
   * is applied to the RESOLVED path, so a symlink inside the workspace pointing
   * at /etc is refused rather than followed.
   */
  if (context.authority === 'project') {
    const insideAnAllowedRoot = allowedRoots.some((root) => isInside(resolved, canonical(root)));
    if (!insideAnAllowedRoot) {
      throw new SandboxPlanError(
        'path_outside_allowed_roots',
        resolved,
        `Refusing to mount "${resolved}": it is outside this run's repository and the worker's workspace. ` +
          'Sandbox mounts are an allowlist, not a filter.',
      );
    }
  } else if (!fs.existsSync(resolved)) {
    /*
     * Operator mounts must exist. Project mounts are created by Mac moments
     * earlier and always do.
     *
     * Docker turns `-v /typo:/mac/credentials/0:ro` into an empty directory and
     * mounts that, so a mistyped credential path produces an agent that cannot
     * log in and a plan that looks perfectly correct — diagnosed at 02:00, from
     * inside a container, by whoever is on call. A typo in configuration should
     * fail where the configuration is read.
     */
    throw new SandboxPlanError(
      'path_does_not_exist',
      resolved,
      `Refusing to mount "${resolved}": nothing exists at that path. Check the tooling or credential ` +
        'path in the worker configuration — a mount that is silently empty is worse than one that fails.',
    );
  }

  return resolved;
}

/**
 * The child's entire environment, built from EMPTY.
 *
 * Sprint 2 copied `process.env` and deleted a regex of known-dangerous keys.
 * That works until someone introduces a secret-bearing variable the regex has
 * never heard of. Starting from nothing inverts the default: a new variable is
 * excluded unless an admin adds it, which is the direction that stays correct
 * as the system grows.
 */
function buildEnvironment(input: SandboxPlanInput, homeInSandbox: string, shimPath: string | null): Record<string, string> {
  const basePath = input.kind === 'docker' ? '/usr/local/bin:/usr/bin:/bin' : (process.env.PATH ?? '/usr/bin:/bin');
  const delimiter = input.kind === 'docker' ? ':' : path.delimiter;

  const env: Record<string, string> = {
    PATH: shimPath ? `${shimPath}${delimiter}${basePath}` : basePath,
    HOME: homeInSandbox,
    TMPDIR: input.kind === 'docker' ? '/tmp' : '/tmp',
    LANG: 'C.UTF-8',
    TERM: 'dumb',
    CI: '1',
    // An interactive prompt would hang an unattended session indefinitely.
    GIT_TERMINAL_PROMPT: '0',
    // Colour codes in a captured log help nobody.
    FORCE_COLOR: '0',
  };

  for (const [key, value] of Object.entries(input.extraEnv ?? {})) {
    // Never let an explicit allowance overwrite a containment-relevant variable.
    if (key === 'PATH' || key === 'HOME' || key === 'TMPDIR') continue;
    env[key] = value;
  }

  return env;
}

export function buildSandboxPlan(input: SandboxPlanInput): SandboxPlan {
  const homeDir = input.homeDir ?? os.homedir();
  const identity = input.kind !== 'docker';

  /*
   * The roots a PROJECT mount must sit inside.
   *
   * Tooling and credential mounts are deliberately NOT in this list. Adding
   * them would mean each such mount authorised itself — a check that reads as
   * rigorous and enforces nothing. They are an administrator's explicit
   * decision instead, and are still subject to every absolute refusal.
   */
  const allowedRoots = [input.repositoryPath, input.workspaceRoot].filter(Boolean);

  const guard = {
    homeDir,
    workerStateFile: input.workerStateFile ?? null,
    allowCredential: false,
    authority: 'project' as const,
  };

  const worktree = assertPathAcceptable(input.worktreePath, allowedRoots, guard);
  const gitDir = assertPathAcceptable(input.repositoryGitDir, allowedRoots, guard);
  const scratch = assertPathAcceptable(input.scratchDir, allowedRoots, guard);

  const mounts: SandboxMount[] = [
    {
      hostPath: worktree,
      sandboxPath: identity ? worktree : CONTAINER_PATHS.worktree,
      mode: 'rw',
      purpose: 'worktree',
    },
    {
      /*
       * The repository's git metadata, writable.
       *
       * Stated plainly because it is the honest limit of this boundary: an
       * agent inside the sandbox CAN reach `.git`. What stops it moving the
       * default branch is the three git layers Sprint 2 built and verified —
       * the closed API, the PATH shim, and the after-the-fact comparison of the
       * default branch sha. The sandbox's guarantee is filesystem containment
       * to the assigned project, and claiming more would be false.
       */
      hostPath: gitDir,
      sandboxPath: identity ? gitDir : CONTAINER_PATHS.gitDir,
      mode: 'rw',
      purpose: 'repository_git',
    },
    {
      hostPath: scratch,
      sandboxPath: identity ? scratch : CONTAINER_PATHS.scratch,
      mode: 'rw',
      purpose: 'scratch',
    },
  ];

  let shimSandboxPath: string | null = null;
  if (input.shimDir) {
    const shim = assertPathAcceptable(input.shimDir, allowedRoots, guard);
    shimSandboxPath = identity ? shim : CONTAINER_PATHS.shim;
    mounts.push({ hostPath: shim, sandboxPath: shimSandboxPath, mode: 'ro', purpose: 'git_shim' });
  }

  (input.toolingMounts ?? []).forEach((tool, index) => {
    const resolved = assertPathAcceptable(tool, allowedRoots, { ...guard, authority: 'operator' });
    mounts.push({
      hostPath: resolved,
      sandboxPath: identity ? resolved : `${CONTAINER_PATHS.tooling}/${index}`,
      mode: 'ro',
      purpose: 'tooling',
    });
  });

  (input.credentialMounts ?? []).forEach((credential, index) => {
    // Credential mounts are the ONE case where a credential-shaped path is
    // permitted, and only read-only and only because an admin named it.
    const resolved = assertPathAcceptable(credential, allowedRoots, {
      ...guard,
      allowCredential: true,
      authority: 'operator',
    });
    mounts.push({
      hostPath: resolved,
      sandboxPath: identity ? resolved : `${CONTAINER_PATHS.credentials}/${index}`,
      mode: 'ro',
      purpose: 'credential',
    });
  });

  const workdirInSandbox = identity ? worktree : CONTAINER_PATHS.worktree;
  const writable = mounts.filter((m) => m.mode === 'rw');
  if (!writable.some((m) => workdirInSandbox === m.sandboxPath || isInside(workdirInSandbox, m.sandboxPath))) {
    throw new SandboxPlanError(
      'workdir_not_writable',
      workdirInSandbox,
      'The sandbox working directory must sit inside a writable mount.',
    );
  }

  const homeInSandbox = identity ? path.join(os.tmpdir(), 'mac-sandbox-home') : CONTAINER_PATHS.home;

  return {
    workdir: workdirInSandbox,
    mounts,
    tmpfs: identity ? ['/tmp'] : ['/tmp', CONTAINER_PATHS.home],
    env: buildEnvironment(input, homeInSandbox, shimSandboxPath),
    network: input.network,
    user: input.user ?? null,
    /*
     * Paths a conformance test asserts are absent.
     *
     * A sandbox that merely fails to mount a secret is indistinguishable, in a
     * passing test, from one that mounted it and nobody looked. Carrying the
     * witnesses lets the test assert absence directly against the real provider.
     */
    deniedWitnesses: [
      homeDir,
      path.join(homeDir, '.ssh'),
      path.join(homeDir, '.aws'),
      path.join(homeDir, '.claude'),
      ...(input.workerStateFile ? [input.workerStateFile] : []),
    ].map(posix),
    image: input.image ?? null,
    maxMinutes: input.maxMinutes ?? 60,
  };
}
