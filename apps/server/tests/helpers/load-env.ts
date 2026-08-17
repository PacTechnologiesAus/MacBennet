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
