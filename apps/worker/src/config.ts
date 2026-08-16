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
});

export interface WorkerConfig {
  controlPlaneUrl: string;
  enrollmentToken: string | undefined;
  name: string;
  stateFile: string;
  workspace: string;
  heartbeatSeconds: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent';
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
  };
}
