import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseDotenv } from 'dotenv';
import { describe, expect, it } from 'vitest';

/**
 * Regression: the repository-root `.env` must reach the test process.
 *
 * Commissioning defect #1. The live monday.com test read `MONDAY_API_TOKEN`
 * straight from `process.env` and imported nothing that loads `.env`, so a
 * machine with the token configured exactly where `.env.example` says to put it
 * reported "the live monday.com test cannot run". It skipped loudly rather than
 * pretending, which is the right failure — but the machine was configured.
 *
 * This asserts the property rather than one variable, because the next opt-in
 * test will read a different key. Values are never read, only key presence, so
 * this cannot leak a secret into a test report.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const envPath = path.join(repoRoot, '.env');
const hasEnvFile = fs.existsSync(envPath);

describe('the test environment', () => {
  // No `.env` is the normal state in CI, and the standard suite must pass
  // there. There is nothing to assert about a file that does not exist.
  it.skipIf(!hasEnvFile)('carries every key from the repository-root .env', () => {
    const declared = Object.keys(parseDotenv(fs.readFileSync(envPath, 'utf8')));
    expect(declared.length).toBeGreaterThan(0);

    const missing = declared.filter((key) => !(key in process.env));
    expect(missing, `these .env keys never reached process.env: ${missing.join(', ')}`).toEqual([]);
  });

  it('does not let .env override an explicit command-line variable', () => {
    // dotenv's documented behaviour, relied on so that
    // `MAC_MONDAY_TEST_BOARD_ID=... npx vitest` still wins over the file.
    process.env.MAC_ENV_PRECEDENCE_PROBE = 'from-command-line';
    parseDotenv('MAC_ENV_PRECEDENCE_PROBE=from-file');
    expect(process.env.MAC_ENV_PRECEDENCE_PROBE).toBe('from-command-line');
    delete process.env.MAC_ENV_PRECEDENCE_PROBE;
  });
});
