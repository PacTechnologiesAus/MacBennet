import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

/**
 * Makes the repository-root `.env` reach the test process.
 *
 * `src/config.ts` already loads it, but only tests that import `config` got it.
 * The opt-in external tests deliberately import as little as possible — the
 * monday.com one reaches straight for `MondayGraphqlClient` — so a token
 * configured in the one place `.env.example` calls "the single place a
 * developer configures things" was invisible to exactly the tests that need it.
 * The failure was loud rather than silent, which is right, but it made a
 * correctly configured machine look unconfigured.
 *
 * `dotenv` does not overwrite a variable that is already set, so an explicit
 * `FOO=bar npx vitest` on the command line still wins over the file.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

loadDotenv({ path: path.join(repoRoot, '.env') });

/**
 * Teams identity for the suite, forced rather than inherited.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE OVERWRITE `.env` INSTEAD OF DEFERRING TO IT
 *
 * Every other variable here follows dotenv's rule that an explicit value wins.
 * These three deliberately do not, and the reason is that the Teams tests sign
 * their own JWTs with a locally generated key and assert that a token issued
 * for a DIFFERENT application is rejected.
 *
 * If a developer had real PAC Teams credentials in `.env`, the audience check
 * would be comparing against their real app id and the tests would exercise a
 * different code path on their machine than in CI — which is the class of
 * difference that makes a suite pass everywhere except where it matters.
 *
 * The genuinely live Teams test reads `MAC_TEAMS_LIVE_*` instead, and skips
 * when those are absent. Real credentials are therefore opt-in and cannot be
 * picked up by accident.
 */
process.env.MAC_TEAMS_APP_ID = '11111111-2222-4333-8444-555555555555';
process.env.MAC_TEAMS_APP_PASSWORD = 'test-secret-not-a-real-one';
process.env.MAC_TEAMS_TENANT_ID = '99999999-8888-4777-8666-555555555555';
