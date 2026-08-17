import { config as loadDotenv } from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * Worker configuration.
 *
 * The worker is meant to run on its own Linux VM with its own .env, so it
 * loads from the current working directory first and falls back to the
 * repository root for local development.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

loadDotenv({ path: path.join(process.cwd(), '.env') });
loadDotenv({ path: path.join(repoRoot, '.env') });

const envSchema = z.object({
  MAC_CONTROL_PLANE_URL: z.string().url(),
  MAC_ENROLLMENT_TOKEN: z.string().optional(),
  MAC_WORKER_NAME: z.string().min(1).max(100).default('mac-worker-01'),
  MAC_WORKER_STATE_FILE: z.string().default('./.mac-worker-state.json'),
  MAC_WORKER_WORKSPACE: z.string().default('./workspace'),
  MAC_ALLOW_INSECURE_HTTP: z
    .string()
    .optional()
    .transform((v) => v === 'true'),
  MAC_HEARTBEAT_SECONDS: z.coerce.number().int().min(1).max(600).default(10),
  MAC_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error', 'silent']).default('info'),

  // --- Sprint 3: the execution sandbox --------------------------------------
  /**
   * `auto` prefers bubblewrap, then docker. `none` is a DEVELOPMENT setting: it
   * attests no containment, so the control plane withholds coding work from
   * this worker while `requireSandbox` is on. It is not a way to run coding
   * work unconfined.
   */
  MAC_SANDBOX_PROVIDER: z.enum(['auto', 'bubblewrap', 'docker', 'none']).default('auto'),
  /** Container image for the docker provider. Must carry the project toolchain. */
  MAC_SANDBOX_IMAGE: z.string().default('node:22-bookworm-slim'),
  /** Read-only tooling mounts, colon- or comma-separated. Explicit; never inferred. */
  MAC_SANDBOX_TOOLING: z.string().optional(),
  /**
   * Names of environment variables to forward into the sandbox, comma-separated.
   *
   * Sprint 3.1 commissioning found `extraEnv` and `credentialMounts` present in
   * the sandbox plan and wired to nothing: no configuration reached them and no
   * caller supplied them. The sandbox environment is built from empty, so a real
   * coding agent inside it had no way to receive its own provider credential —
   * which is every real coding agent. Containment was proven with `sh`, `cat`
   * and `test -e`; the agent tests used a mock. Nothing was wrong with the
   * boundary, but no authenticated agent had ever run behind it.
   *
   * NAMES, not values: `MAC_SANDBOX_AGENT_ENV=ANTHROPIC_API_KEY`. The worker
   * reads each named variable from its own environment and passes the value in.
   * That is not "copy process.env" — it is an administrator naming, one at a
   * time, what the agent is allowed to hold. `REFUSED_SANDBOX_ENV` below is what
   * stops that allowance being pointed at the worker's own credentials.
   */
  MAC_SANDBOX_AGENT_ENV: z.string().optional(),
  /**
   * Read-only credential mounts for the agent, colon- or comma-separated.
   *
   * On Linux this is how a Claude Code subscription credential reaches the
   * agent: `MAC_SANDBOX_CREDENTIALS=/home/mac/.claude/.credentials.json`. Each
   * path is recorded in the plan with `purpose: 'credential'` and mounted
   * read-only, and is the ONE case where a credential-shaped path is accepted —
   * deliberately, and visibly.
   */
  MAC_SANDBOX_CREDENTIALS: z.string().optional(),
  /** Where node and git live inside the image. Unused by bubblewrap. */
  MAC_SANDBOX_NODE_PATH: z.string().default('/usr/local/bin/node'),
  MAC_SANDBOX_GIT_PATH: z.string().default('/usr/bin/git'),
  /** Unprivileged execution identity inside the sandbox. */
  MAC_SANDBOX_UID: z.coerce.number().int().min(0).optional(),
  MAC_SANDBOX_GID: z.coerce.number().int().min(0).optional(),
});

/**
 * Variable names that may never be forwarded into a sandbox, however an
 * administrator spells the request.
 *
 * The allowance in `MAC_SANDBOX_AGENT_ENV` exists so the AGENT can hold its own
 * provider credential. Pointed at the worker's enrollment token, the control
 * plane's database URL, or the monday/mailbox credentials, it would hand a
 * sandboxed process exactly the things the boundary exists to keep from it —
 * and it would do so quietly, because the plan would look perfectly valid.
 *
 * Matching is on the NAME and is prefix-based, so a future `MAC_MAIL_ANYTHING`
 * is refused without anyone remembering to come back here.
 */
export const REFUSED_SANDBOX_ENV = [
  'MAC_ENROLLMENT_TOKEN',
  'MAC_WORKER_',
  'MAC_CONTROL_PLANE_URL',
  'DATABASE_URL',
  'TEST_DATABASE_URL',
  'MONDAY_API_TOKEN',
  'MAC_MAIL_',
  'SEED_ADMIN_',
  'SESSION_',
  'AWS_',
  'GITHUB_TOKEN',
  'GH_TOKEN',
] as const;

export class RefusedSandboxEnv extends Error {
  override readonly name = 'RefusedSandboxEnv';
  constructor(readonly variable: string) {
    super(
      `Refusing to forward "${variable}" into a sandbox: it names a credential belonging to the worker or ` +
        'the control plane, not to the coding agent. The sandbox exists to keep those out of reach.',
    );
  }
}

/**
 * Resolves the named variables into values, refusing the ones that are not the
 * agent's to hold. Containment-relevant names are refused here too, rather than
 * being silently dropped later by the plan builder.
 */
export function resolveSandboxAgentEnv(
  names: string[],
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const resolved: Record<string, string> = {};

  for (const name of names) {
    const key = name.trim();
    if (!key) continue;

    if (key === 'PATH' || key === 'HOME' || key === 'TMPDIR') {
      throw new RefusedSandboxEnv(key);
    }
    if (REFUSED_SANDBOX_ENV.some((refused) => key.toUpperCase().startsWith(refused))) {
      throw new RefusedSandboxEnv(key);
    }

    const value = source[key];
    // A named-but-unset variable is a configuration mistake worth reporting: it
    // would otherwise surface as an agent that mysteriously cannot log in.
    if (value === undefined) {
      throw new Error(
        `MAC_SANDBOX_AGENT_ENV names "${key}", but it is not set in the worker's environment. ` +
          'Set it, or remove it from the list.',
      );
    }
    resolved[key] = value;
  }

  return resolved;
}

export interface WorkerConfig {
  controlPlaneUrl: string;
  enrollmentToken: string | undefined;
  name: string;
  stateFile: string;
  workspace: string;
  heartbeatSeconds: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent';
  sandbox: {
    provider: 'auto' | 'bubblewrap' | 'docker' | 'none';
    image: string;
    toolingMounts: string[];
    /** Read-only credential mounts for the AGENT's own provider credential. */
    credentialMounts: string[];
    /** Values, already resolved and already refused-checked. Never process.env. */
    agentEnv: Record<string, string>;
    nodePath: string;
    gitPath: string;
    uid: number | undefined;
    gid: number | undefined;
  };
}

/**
 * Sandbox settings for a config assembled by hand.
 *
 * Exists so tests and embedders can build a `WorkerConfig` without restating
 * seven fields that only the environment parser normally supplies. Defaults to
 * `none`, because a test that wants containment should ask for it explicitly
 * rather than acquire it by accident.
 */
export function defaultSandboxConfig(overrides: Partial<WorkerConfig['sandbox']> = {}): WorkerConfig['sandbox'] {
  return {
    provider: 'none',
    image: 'node:22-bookworm-slim',
    toolingMounts: [],
    credentialMounts: [],
    agentEnv: {},
    nodePath: '/usr/local/bin/node',
    gitPath: '/usr/bin/git',
    uid: undefined,
    gid: undefined,
    ...overrides,
  };
}

/** `C:\...` or `C:/...` — a drive letter, not a separator. */
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;

/**
 * Splits a mount list on comma, semicolon or colon.
 *
 * Colon is kept because it is the natural list separator on the Linux VM these
 * settings were written for, but it is NOT applied to a segment that begins
 * with a drive letter — Sprint 3 split unconditionally, which cut every Windows
 * path in half and made the docker provider unusable from a Windows worker.
 * The plan builder refused the resulting half-paths, so this was a confusing
 * error rather than a hole; it still meant the setting did not work here.
 */
function splitPaths(value: string | undefined): string[] {
  return (value ?? '')
    .split(/[,;]/)
    .flatMap((piece) => (WINDOWS_ABSOLUTE.test(piece.trim()) ? [piece] : piece.split(':')))
    .map((p) => p.trim())
    .filter(Boolean);
}

export function loadConfig(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid worker configuration:\n${detail}\n\nDid you copy .env.example to .env?`);
  }
  const env = parsed.data;

  const url = overrides.controlPlaneUrl ?? env.MAC_CONTROL_PLANE_URL;

  /*
   * A worker token is a bearer credential, and this process will eventually run
   * coding agents. Sending that token over plaintext HTTP to anything but
   * localhost is a mistake worth refusing outright rather than warning about.
   */
  if (url.startsWith('http://') && !env.MAC_ALLOW_INSECURE_HTTP) {
    const host = new URL(url).hostname;
    const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
    if (!isLoopback) {
      throw new Error(
        `Refusing to send worker credentials over plaintext HTTP to ${host}.\n` +
          'Use https://, or set MAC_ALLOW_INSECURE_HTTP=true for local development only.',
      );
    }
  }

  return {
    controlPlaneUrl: url.replace(/\/+$/, ''),
    enrollmentToken: overrides.enrollmentToken ?? env.MAC_ENROLLMENT_TOKEN ?? undefined,
    name: overrides.name ?? env.MAC_WORKER_NAME,
    stateFile: overrides.stateFile ?? env.MAC_WORKER_STATE_FILE,
    workspace: overrides.workspace ?? env.MAC_WORKER_WORKSPACE,
    heartbeatSeconds: overrides.heartbeatSeconds ?? env.MAC_HEARTBEAT_SECONDS,
    logLevel: overrides.logLevel ?? env.MAC_LOG_LEVEL,
    sandbox: overrides.sandbox ?? {
      provider: env.MAC_SANDBOX_PROVIDER,
      image: env.MAC_SANDBOX_IMAGE,
      toolingMounts: splitPaths(env.MAC_SANDBOX_TOOLING),
      credentialMounts: splitPaths(env.MAC_SANDBOX_CREDENTIALS),
      agentEnv: resolveSandboxAgentEnv((env.MAC_SANDBOX_AGENT_ENV ?? '').split(',')),
      nodePath: env.MAC_SANDBOX_NODE_PATH,
      gitPath: env.MAC_SANDBOX_GIT_PATH,
      uid: env.MAC_SANDBOX_UID,
      gid: env.MAC_SANDBOX_GID,
    },
  };
}
