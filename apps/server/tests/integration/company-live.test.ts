import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GitCompanyContextProvider } from '../../src/services/company-context/git-provider.js';
import { validateManifest, mandatoryDocuments, MANIFEST_PATH } from '../../src/services/company-context/manifest.js';
import { parseSections } from '../../src/domain/company-context.js';
import { describeActor, isPacAgent } from '../../src/domain/agent-registry.js';

/**
 * The REAL `PacTechnologiesAus/Company` repository (Sprint 3.2 §22).
 *
 * Opt-in and skipped by default. It talks to GitHub, and the brief is explicit
 * that standard CI must not depend on GitHub credentials. Run it deliberately:
 *
 *   MAC_COMPANY_LIVE_TEST=1          the opt-in switch
 *   MAC_COMPANY_CONTEXT_TOKEN=...    a READ-ONLY token (omit if the repo is public
 *                                    to you and git is already authenticated)
 *   MAC_COMPANY_CONTEXT_REPO_URL=... override the repository (defaults to PAC's)
 *
 * What it proves that the local-repository tests cannot: that the real manifest
 * at the real HEAD is one this build understands, that all seven mandatory
 * documents exist and are readable, and that authentication works against
 * github.com rather than against a file:// path.
 *
 * It is deliberately READ-ONLY, and says so in a way that is checkable: the
 * provider has no write verb at all, and the test additionally asserts that the
 * local mirror's refs are untouched by everything it does.
 */

const ENABLED = process.env.MAC_COMPANY_LIVE_TEST === '1';
const REPO_URL =
  process.env.MAC_COMPANY_CONTEXT_REPO_URL ?? 'https://github.com/PacTechnologiesAus/Company.git';
const TOKEN = process.env.MAC_COMPANY_CONTEXT_TOKEN;

if (ENABLED) {
  // Opting in and then silently skipping would be the worst outcome: it would
  // look as though the live integration had been exercised.
  // eslint-disable-next-line no-console
  console.log(`[company-live] running against ${REPO_URL}${TOKEN ? ' with a token' : ' anonymously'}`);
}

let cacheDir: string;
let provider: GitCompanyContextProvider;

const refsOf = (dir: string): string => {
  const result = spawnSync('git', ['show-ref'], { cwd: dir, encoding: 'utf8' });
  return (result.stdout ?? '').trim();
};

beforeAll(() => {
  if (!ENABLED) return;
  cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-company-live-'));
  provider = new GitCompanyContextProvider({
    repositoryUrl: REPO_URL,
    ref: 'main',
    cacheDir,
    ...(TOKEN ? { token: TOKEN } : {}),
    timeoutMs: 120_000,
  });
});

afterAll(() => {
  if (!ENABLED || !cacheDir) return;
  fs.rmSync(cacheDir, { recursive: true, force: true });
});

describe.skipIf(!ENABLED)('the real PacTechnologiesAus/Company repository', () => {
  let commitSha = '';

  it('authenticates and fetches', async () => {
    const outcome = await provider.refresh();

    if (!outcome.ok) {
      throw new Error(
        `Could not fetch ${REPO_URL}: ${outcome.error}\n` +
          'If the repository is private, set MAC_COMPANY_CONTEXT_TOKEN to a read-only token.',
      );
    }

    expect(outcome.ok).toBe(true);
    expect(outcome.fetchedFromRemote).toBe(true);

    const head = await provider.headRevision();
    expect(head).not.toBeNull();
    expect(head!.commitSha).toMatch(/^[0-9a-f]{40}$/);
    commitSha = head!.commitSha;

    // eslint-disable-next-line no-console
    console.log(`[company-live] HEAD of main is ${commitSha}`);
  });

  it('carries a manifest this build understands', async () => {
    const text = await provider.readFile(commitSha, MANIFEST_PATH);
    const result = validateManifest(text);

    if (!result.ok) {
      throw new Error(`The real context.yaml did not validate (${result.code}): ${result.errors.join('; ')}`);
    }

    expect(result.manifest.schema_version).toBe(1);
    expect(result.manifest.context_version.length).toBeGreaterThan(0);
    expect(result.manifest.governance.agents_may_approve_changes).toBe(false);

    // eslint-disable-next-line no-console
    console.log(`[company-live] context_version ${result.manifest.context_version}`);
  });

  it('has every document its manifest declares mandatory, and all are substantive', async () => {
    const manifest = validateManifest(await provider.readFile(commitSha, MANIFEST_PATH));
    expect(manifest.ok).toBe(true);
    if (!manifest.ok) return;

    const required = mandatoryDocuments(manifest.manifest);
    expect(required.length).toBeGreaterThan(0);

    for (const documentPath of required) {
      const text = await provider.readFile(commitSha, documentPath);
      expect(text.trim().length, `${documentPath} is empty`).toBeGreaterThan(0);
      // Every one should have real structure, not just a title.
      expect(parseSections(text).length, `${documentPath} has no sections`).toBeGreaterThan(0);
    }

    // eslint-disable-next-line no-console
    console.log(`[company-live] loaded ${required.length} mandatory documents: ${required.join(', ')}`);
  });

  it('states the authority rules Mac enforces in code', async () => {
    const authority = await provider.readFile(commitSha, 'AUTHORITY.md');

    // Corroboration, not derivation: PROHIBITED_CAPABILITIES lives in Mac's own
    // code precisely so a document edit cannot grant authority. This checks the
    // two have not drifted apart.
    expect(authority).toMatch(/never autonomously deploy/i);
    expect(authority).toMatch(/no authority to spend PAC money/i);
    expect(authority).toMatch(/not authorised to communicate directly/i);
    expect(authority).toMatch(/never .*(merge|autonomously merge)/i);
  });

  it('describes Forja as a platform, not as an agent', async () => {
    const agents = await provider.readFile(commitSha, 'AGENTS.md');

    expect(agents).toMatch(/Forja is not itself one of the specialist staff agents/i);
    // And Mac's own registry agrees.
    expect(isPacAgent('forja')).toBe(false);
    expect(describeActor('forja')!.kind).toBe('platform');
  });

  it('used no write capability: the mirror\'s refs are unchanged by all of the above', async () => {
    const before = refsOf(cacheDir);

    await provider.listFiles(commitSha);
    await provider.readFile(commitSha, 'AUTHORITY.md');
    await provider.headRevision();

    expect(refsOf(cacheDir)).toBe(before);

    // And there is simply no verb that could have changed the remote.
    for (const verb of ['write', 'writeFile', 'commit', 'push', 'checkout']) {
      expect((provider as unknown as Record<string, unknown>)[verb]).toBeUndefined();
    }
  });
});
