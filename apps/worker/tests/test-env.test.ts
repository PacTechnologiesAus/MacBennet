import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseDotenv } from 'dotenv';
import { describe, expect, it } from 'vitest';

/**
 * Regression: the repository-root `.env` must reach the WORKER test process.
 *
 * The worker is a separate vitest project with its own config, so the server's
 * copy of this test would not have caught a regression here. The opt-in
 * real-Claude test and the sandbox conformance suite both read their switches
 * (`MAC_E2E_REAL_CLAUDE`, `MAC_SANDBOX_*`) straight from `process.env`.
 *
 * Key presence only — never values.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const envPath = path.join(repoRoot, '.env');
const hasEnvFile = fs.existsSync(envPath);

describe('the worker test environment', () => {
  it.skipIf(!hasEnvFile)('carries every key from the repository-root .env', () => {
    const declared = Object.keys(parseDotenv(fs.readFileSync(envPath, 'utf8')));
    expect(declared.length).toBeGreaterThan(0);

    const missing = declared.filter((key) => !(key in process.env));
    expect(missing, `these .env keys never reached process.env: ${missing.join(', ')}`).toEqual([]);
  });
});
