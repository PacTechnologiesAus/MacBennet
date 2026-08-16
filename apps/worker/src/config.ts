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
  /** Where node and git live inside the image. Unused by bubblewrap. */
  MAC_SANDBOX_NODE_PATH: z.string().default('/usr/local/bin/node'),
  MAC_SANDBOX_GIT_PATH: z.string().default('/usr/bin/git'),
  /** Unprivileged execution identity inside the sandbox. */
  MAC_SANDBOX_UID: z.coerce.number().int().min(0).optional(),
  MAC_SANDBOX_GID: z.coerce.number().int().min(0).optional(),
});

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
    nodePath: '/usr/local/bin/node',
    gitPath: '/usr/bin/git',
    uid: undefined,
    gid: undefined,
    ...overrides,
  };
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
      toolingMounts: (env.MAC_SANDBOX_TOOLING ?? '')
        .split(/[,:;]/)
        .map((p) => p.trim())
        .filter(Boolean),
      nodePath: env.MAC_SANDBOX_NODE_PATH,
      gitPath: env.MAC_SANDBOX_GIT_PATH,
      uid: env.MAC_SANDBOX_UID,
      gid: env.MAC_SANDBOX_GID,
    },
  };
}
