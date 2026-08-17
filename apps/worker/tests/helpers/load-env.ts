import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadDotenv } from 'dotenv';

/**
 * Makes the repository-root `.env` reach the worker test process.
 *
 * Same reason as the server's copy: the opt-in real-Claude test reads
 * `MAC_E2E_REAL_CLAUDE` (and the sandbox tests read `MAC_SANDBOX_*`) straight
 * from `process.env`, and nothing in the worker's test path ever loaded the
 * file where `.env.example` tells a developer to put them.
 *
 * `dotenv` does not overwrite an already-set variable, so a command-line
 * override still wins.
 */
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

loadDotenv({ path: path.join(repoRoot, '.env') });
