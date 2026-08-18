import { config as loadDotenv } from 'dotenv';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/**
 * Environment is parsed once, at startup, into a frozen typed object.
 * Anything invalid fails fast with a readable message rather than surfacing as
 * `undefined` somewhere deep in a request handler.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

// The repository root .env is the single place a developer configures things.
loadDotenv({ path: path.join(repoRoot, '.env') });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8080),
  HOST: z.string().default('127.0.0.1'),
  DATABASE_URL: z.string().min(1),
  TEST_DATABASE_URL: z.string().min(1).optional(),
  WEB_ORIGIN: z.string().default('http://localhost:5173'),
  SESSION_COOKIE_NAME: z.string().default('mac_session'),
  SESSION_TTL_HOURS: z.coerce.number().int().min(1).max(24 * 30).default(12),
  SEED_ADMIN_EMAIL: z.string().email().optional(),
  SEED_ADMIN_PASSWORD: z.string().min(8).optional(),
  SEED_ADMIN_NAME: z.string().optional(),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  // --- Sprint 3 -------------------------------------------------------------
  //
  // Every credential below lives ONLY in the control plane. None is sent to the
  // worker, written to the database, or reachable from a sandboxed agent, whose
  // environment is built from empty rather than filtered.

  /** monday.com API token. Absent means the fake provider, which is inert. */
  MONDAY_API_TOKEN: z.string().optional(),
  /** Mac's own monday.com user id, so he can assign work to himself. */
  MONDAY_MAC_USER_ID: z.string().optional(),

  /** Microsoft Graph, for sending from Mac's real PAC Technologies mailbox. */
  MAC_MAIL_TENANT_ID: z.string().optional(),
  MAC_MAIL_CLIENT_ID: z.string().optional(),
  MAC_MAIL_CLIENT_SECRET: z.string().optional(),
  /** The mailbox Mac sends as. Must be one the app registration may send from. */
  MAC_MAIL_FROM: z.string().optional(),

  /** Model provider for the optional model-backed resolvers. Off by default. */
  ANTHROPIC_API_KEY: z.string().optional(),
  MAC_MODEL_NAME: z.string().default('claude-sonnet-5'),

  /** Base URL used in report links back to the Mac UI. */
  MAC_APP_URL: z.string().default('http://localhost:5173'),

  // --- Sprint 3.2 -----------------------------------------------------------
  //
  // The PAC shared company context repository. The URL is configurable, but the
  // default IS the intended PAC deployment value, so a correct deployment needs
  // only to supply a read-only token and turn the feature on.

  MAC_COMPANY_CONTEXT_REPO_URL: z
    .string()
    .default('https://github.com/PacTechnologiesAus/Company.git'),
  MAC_COMPANY_CONTEXT_REF: z.string().default('main'),
  /**
   * Where the bare mirror lives.
   *
   * Outside every coding workspace on purpose (Sprint 3.2 section 5). A default
   * under the repository root would eventually end up inside a worktree, and a
   * coding agent that can edit AUTHORITY.md can edit PAC policy.
   */
  MAC_COMPANY_CONTEXT_DIR: z
    .string()
    .default(path.join(os.homedir(), '.mac-bennett', 'company-context')),
  /**
   * A READ-ONLY GitHub token. Never placed in argv or in the remote URL - it is
   * handed to git through GIT_ASKPASS, in the child process environment only.
   */
  MAC_COMPANY_CONTEXT_TOKEN: z.string().optional(),
  MAC_COMPANY_CONTEXT_TIMEOUT_MS: z.coerce.number().int().min(1000).max(600_000).default(60_000),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  const detail = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${detail}\n\nDid you copy .env.example to .env?`);
}

const env = parsed.data;

const isTest = env.NODE_ENV === 'test' || process.env.VITEST === 'true';

/**
 * Tests must never touch the development database. If TEST_DATABASE_URL is set
 * it is used; if it is not, and we are in a test process, we refuse to start
 * rather than silently truncating a developer's data.
 */
function resolveDatabaseUrl(): string {
  if (!isTest) return env.DATABASE_URL;
  if (!env.TEST_DATABASE_URL) {
    throw new Error(
      'Refusing to run tests without TEST_DATABASE_URL. Tests truncate tables; ' +
        'pointing them at DATABASE_URL would destroy development data.',
    );
  }
  if (env.TEST_DATABASE_URL === env.DATABASE_URL) {
    throw new Error('TEST_DATABASE_URL must differ from DATABASE_URL.');
  }
  return env.TEST_DATABASE_URL;
}

export const config = Object.freeze({
  nodeEnv: env.NODE_ENV,
  isTest,
  isProduction: env.NODE_ENV === 'production',
  port: env.PORT,
  host: env.HOST,
  databaseUrl: resolveDatabaseUrl(),
  webOrigin: env.WEB_ORIGIN,
  sessionCookieName: env.SESSION_COOKIE_NAME,
  sessionTtlHours: env.SESSION_TTL_HOURS,
  seedAdmin: {
    email: env.SEED_ADMIN_EMAIL,
    password: env.SEED_ADMIN_PASSWORD,
    name: env.SEED_ADMIN_NAME ?? 'Administrator',
  },
  logLevel: isTest ? ('silent' as const) : env.LOG_LEVEL,
  repoRoot,
  /** Hard ceiling on request bodies. The worker is a semi-trusted client. */
  bodyLimitBytes: 256 * 1024,

  // --- Sprint 3 ---
  appUrl: env.MAC_APP_URL.replace(/\/+$/, ''),
  monday: {
    token: env.MONDAY_API_TOKEN,
    macUserId: env.MONDAY_MAC_USER_ID,
  },
  mail: {
    tenantId: env.MAC_MAIL_TENANT_ID,
    clientId: env.MAC_MAIL_CLIENT_ID,
    clientSecret: env.MAC_MAIL_CLIENT_SECRET,
    from: env.MAC_MAIL_FROM,
  },
  model: {
    apiKey: env.ANTHROPIC_API_KEY,
    name: env.MAC_MODEL_NAME,
  },

  // --- Sprint 3.2 ---
  companyContext: {
    repositoryUrl: env.MAC_COMPANY_CONTEXT_REPO_URL,
    ref: env.MAC_COMPANY_CONTEXT_REF,
    cacheDir: env.MAC_COMPANY_CONTEXT_DIR,
    token: env.MAC_COMPANY_CONTEXT_TOKEN,
    timeoutMs: env.MAC_COMPANY_CONTEXT_TIMEOUT_MS,
  },
});

export type Config = typeof config;
