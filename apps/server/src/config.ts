import { config as loadDotenv } from 'dotenv';
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
});

export type Config = typeof config;
