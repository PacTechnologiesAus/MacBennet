import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';
import { sql } from 'drizzle-orm';
import { buildApp } from '../../src/app.js';
import { config } from '../../src/config.js';
import { db, pool } from '../../src/db/client.js';
import { runMigrations } from '../../src/db/migrate.js';
import { createUser } from '../../src/services/auth.js';
import type { UserRole } from '@mac/protocol';

/**
 * Integration test harness.
 *
 * Tests run against a real PostgreSQL database (TEST_DATABASE_URL), not a mock
 * and not an in-memory shim, because most of what is worth testing here lives
 * in SQL: the dispatch predicate that enforces approval, the unique index that
 * makes log retries idempotent, and the trigger that makes the audit trail
 * immutable. None of those exist in a fake.
 */

let migrated = false;

export async function ensureMigrated(): Promise<void> {
  if (migrated) return;
  await runMigrations(config.databaseUrl);
  migrated = true;
}

/**
 * Wipes state between tests.
 *
 * `audit_events` is conspicuously absent: it cannot be truncated or deleted —
 * that is the whole point of it — so tests scope their audit assertions by run
 * or project id instead of assuming an empty table. That is also closer to how
 * the table behaves in production.
 */
export async function resetDatabase(): Promise<void> {
  await db.execute(sql`
    TRUNCATE TABLE
      run_logs, run_usage, approvals, runs, tasks, projects,
      worker_enrollment_tokens, workers, sessions, users,
      -- Sprint 2. Most of these would be reached by the CASCADE above, but
      -- globally scoped memory has no foreign key to anything and would
      -- otherwise leak between tests.
      repositories, worktrees, handoff_briefs, discovery_sessions,
      agent_sessions, agent_questions, run_assumptions, run_blockers,
      git_violations, run_reviews, pull_requests, usage_snapshots,
      run_reports, memory_entries,
      -- Sprint 3. Most are reached by the CASCADE above; naming them keeps the
      -- list a readable inventory of what a test can leave behind.
      worker_tokens, monday_boards, monday_items, monday_writes,
      night_shifts, night_decisions, discovery_investigations, email_deliveries
    RESTART IDENTITY CASCADE
  `);
  /*
   * Settings must be UPSERTed, not merely UPDATEd.
   *
   * `settings.updated_by` references `users`, so the CASCADE above reaches
   * `settings` and removes the singleton row the migration inserted. An UPDATE
   * would then silently affect zero rows and every subsequent test would fail
   * with "Settings row is missing" — which is exactly how this was found.
   */
  await db.execute(sql`
    INSERT INTO settings (id) VALUES (1)
    ON CONFLICT (id) DO NOTHING
  `);
  await db.execute(sql`
    UPDATE settings SET
      timezone = 'Australia/Sydney',
      overnight_cutoff = '08:00',
      default_confidence_threshold = 0.800,
      min_execution_confidence = 0.600,
      nightly_budget_cents = 5000,
      currency = 'AUD',
      budget_warning_pct = 80,
      budget_stop_pct = 100,
      heartbeat_interval_seconds = 10,
      heartbeat_grace_seconds = 20,
      -- Sprint 3 defaults, restored explicitly so a test that changes one
      -- cannot leak it into the next file.
      require_sandbox = true,
      worker_token_max_age_hours = 168,
      worker_token_overlap_seconds = 300,
      night_shift_enabled = false,
      night_shift_safety_factor = 1.50,
      night_shift_wrap_up_minutes = 10,
      night_shift_min_start_minutes = 20,
      night_shift_large_task_min_minutes = 90,
      report_recipients = '[]'::jsonb,
      allowed_recipient_domains = '[]'::jsonb,
      mail_provider = 'none',
      model_assist_enabled = false,
      model_provider = 'none',
      updated_by = NULL
    WHERE id = 1
  `);
}

export interface TestApp {
  fastify: FastifyInstance;
  close: () => Promise<void>;
}

export async function startTestApp(options: Parameters<typeof buildApp>[0] = {}): Promise<TestApp> {
  await ensureMigrated();
  const { fastify } = await buildApp({
    // Sweepers are disabled so tests can drive them deterministically rather
    // than racing a timer.
    startBackgroundJobs: false,
    // The suite logs in dozens of times from the same IP. The limiter itself
    // is covered by a dedicated test that builds an app with a low limit.
    authRateLimitMax: 10_000,
    registerRateLimitMax: 10_000,
    ...options,
  });
  await fastify.ready();
  return {
    fastify,
    close: async () => {
      await fastify.close();
    },
  };
}

export async function closePool(): Promise<void> {
  await pool.end();
}

// ---------------------------------------------------------------------------
// Authenticated request helpers
// ---------------------------------------------------------------------------

export interface Session {
  cookie: string;
  user: { id: string; email: string; name: string; role: UserRole };
}

export const TEST_PASSWORD = 'correct-horse-battery-staple';

export async function createAndLogin(
  app: FastifyInstance,
  params: { email: string; name?: string; role: UserRole },
): Promise<Session> {
  await createUser({
    email: params.email,
    name: params.name ?? params.email,
    password: TEST_PASSWORD,
    role: params.role,
  });

  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { email: params.email, password: TEST_PASSWORD },
  });

  if (response.statusCode !== 200) {
    throw new Error(`Login failed in test setup: ${response.statusCode} ${response.body}`);
  }

  const setCookie = response.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie[0]! : String(setCookie);
  const cookie = raw.split(';')[0]!;

  return { cookie, user: response.json().user };
}

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';

function inject(
  app: FastifyInstance,
  method: Method,
  url: string,
  headers: Record<string, string>,
  payload?: unknown,
): Promise<LightMyRequestResponse> {
  const options: InjectOptions = { method, url, headers };
  if (payload !== undefined) options.payload = payload as InjectOptions['payload'];
  return app.inject(options);
}

/** Convenience wrapper so tests read as requests rather than as inject boilerplate. */
export function asUser(app: FastifyInstance, session: Session) {
  const call = (method: Method) => (url: string, payload?: unknown) =>
    inject(app, method, url, { cookie: session.cookie }, payload);

  return { get: call('GET'), post: call('POST'), patch: call('PATCH'), delete: call('DELETE') };
}

/** Worker-plane wrapper: bearer token, never a cookie. */
export function asWorker(app: FastifyInstance, token: string) {
  return {
    post: (url: string, payload?: unknown) =>
      inject(app, 'POST', url, { authorization: `Bearer ${token}` }, payload),
  };
}
