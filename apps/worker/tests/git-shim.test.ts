import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildGitShim, readShimViolations, resolveRealGit, type ShimSetup } from '../src/git/shim.js';

/**
 * The git shim, exercised as a real process.
 *
 * These tests spawn the shim exactly as a coding agent's shell would — by
 * invoking `git` from a directory that is first on PATH — and assert that
 * prohibited commands are refused before git ever sees them, while ordinary
 * ones pass through untouched.
 *
 * This is the layer that binds the rules on the coding agent, so it is tested
 * as a process rather than as a function.
 */

let tempDir: string;
let shim: ShimSetup;
let realGit: string;
let repoDir: string;

/**
 * Invokes git the way a coding agent actually does: through a shell, with the
 * shim directory first on PATH, so the test exercises PATH resolution rather
 * than calling the shim script by its full path.
 *
 * `bash -c 'exec "$@"' bash git <args>` passes the arguments as a real argv
 * rather than interpolating them into a command string, so an argument
 * containing a space or a quote cannot change the meaning of the test.
 */
function runIn(binDir: string, argv: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      'bash',
      ['-c', 'exec "$@"', 'bash', 'git', ...argv],
      {
        cwd,
        shell: false,
        windowsHide: true,
        timeout: 60_000,
        env: { ...process.env, PATH: `${binDir}${path.delimiter}${process.env.PATH}` },
      },
      (error, stdout, stderr) => {
        const code = (error as { code?: number } | null)?.code;
        resolve({ code: typeof code === 'number' ? code : 0, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

const runShim = (argv: string[], cwd: string) => runIn(shim.binDir, argv, cwd);

function runRealGit(argv: string[], cwd: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve) => {
    execFile(realGit, argv, { cwd, shell: false, windowsHide: true }, (error, stdout) => {
      const code = (error as { code?: number } | null)?.code;
      resolve({ code: typeof code === 'number' ? code : 0, stdout: String(stdout) });
    });
  });
}

beforeAll(async () => {
  realGit = await resolveRealGit();
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mac-shim-'));

  repoDir = path.join(tempDir, 'repo');
  await fs.mkdir(repoDir, { recursive: true });
  await runRealGit(['init', '--initial-branch=main'], repoDir);
  await runRealGit(['config', 'user.email', 'mac@pac-technologies.com.au'], repoDir);
  await runRealGit(['config', 'user.name', 'Mac Bennett'], repoDir);
  await fs.writeFile(path.join(repoDir, 'README.md'), '# test\n', 'utf8');
  await runRealGit(['add', '-A'], repoDir);
  await runRealGit(['commit', '-m', 'initial'], repoDir);
  await runRealGit(['switch', '-c', 'mac/1-test'], repoDir);

  shim = await buildGitShim({
    directory: path.join(tempDir, 'bin'),
    realGitPath: realGit,
    policy: { defaultBranch: 'main', currentBranch: 'mac/1-test', allowPush: false },
  });
}, 120_000);

afterAll(async () => {
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
});

describe('git shim — allowed operations pass through to the real git', () => {
  it('runs git status and returns its real output', async () => {
    const result = await runShim(['status', '--porcelain'], repoDir);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).not.toContain('REFUSED');
  });

  it('runs git rev-parse and returns a real sha', async () => {
    const result = await runShim(['rev-parse', 'HEAD'], repoDir);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  it('lets the agent commit on its own task branch', async () => {
    await fs.writeFile(path.join(repoDir, 'feature.txt'), 'work\n', 'utf8');
    expect((await runShim(['add', '-A'], repoDir)).code).toBe(0);
    const commit = await runShim(['commit', '-m', 'feat: add the feature'], repoDir);
    expect(commit.code).toBe(0);
  });
});

describe('git shim — prohibited operations are refused before git sees them', () => {
  it.each([
    [['push', 'origin', 'main'], 'PUSH'],
    [['push', '--force', 'origin', 'mac/1-test'], 'FORCE_PUSH'],
    [['push', 'origin', 'HEAD:main'], 'PUSH_TO_DEFAULT'],
    [['push', '--delete', 'origin', 'main'], 'DELETE_DEFAULT_BRANCH'],
    [['branch', '-D', 'main'], 'DELETE_DEFAULT_BRANCH'],
    [['checkout', 'main'], 'PUSH_TO_DEFAULT'],
    [['filter-branch', '--all'], 'REWRITE_SHARED_HISTORY'],
    [['update-ref', 'refs/heads/main', 'HEAD'], 'REWRITE_SHARED_HISTORY'],
    [['-c', 'receive.denyNonFastForwards=false', 'push', 'origin', 'mac/1-test'], 'BYPASS_BRANCH_PROTECTION'],
  ])('refuses git %j', async (argv) => {
    const result = await runShim(argv as string[], repoDir);
    expect(result.code, `expected refusal exit code for git ${(argv as string[]).join(' ')}`).toBe(77);
    expect(result.stderr).toContain('REFUSED');
    expect(result.stderr).toContain('cannot be overridden');
  }, 30_000);

  it('refuses a merge into the default branch even though the agent asked politely', async () => {
    const result = await runShim(['merge', 'mac/1-test'], repoDir);
    // The policy context says the agent is on a task branch, so a merge INTO a
    // task branch is fine; the prohibition is on merging into the default one.
    // Rebuild the shim as though main were checked out to prove that case.
    const onMain = await buildGitShim({
      directory: path.join(tempDir, 'bin-main'),
      realGitPath: realGit,
      policy: { defaultBranch: 'main', currentBranch: 'main', allowPush: false },
    });

    const refused = await runIn(onMain.binDir, ['merge', 'mac/1-test'], repoDir);

    expect(refused.code).toBe(77);
    expect(refused.stderr).toContain('MERGE_INTO_DEFAULT');
    expect(result.code).toBeDefined();
  }, 60_000);

  it('records every refusal where the worker can find it', async () => {
    const violations = await readShimViolations(shim.violationsFile);
    expect(violations.length).toBeGreaterThan(0);

    const codes = violations.map((v) => v.code);
    expect(codes).toContain('FORCE_PUSH');
    expect(codes).toContain('DELETE_DEFAULT_BRANCH');

    for (const violation of violations) {
      expect(Array.isArray(violation.argv)).toBe(true);
      expect(violation.message.length).toBeGreaterThan(0);
      expect(new Date(violation.at).toString()).not.toBe('Invalid Date');
    }
  });

  it('leaves the default branch exactly where it was, whatever was attempted', async () => {
    // The point of the whole exercise, asserted against the repository itself
    // rather than against the shim's own report.
    const head = await runRealGit(['rev-parse', 'main'], repoDir);
    const log = await runRealGit(['log', '--oneline', 'main'], repoDir);
    expect(head.code).toBe(0);
    expect(log.stdout.trim().split('\n')).toHaveLength(1); // still just the initial commit
  });
});

describe('git shim — failing closed', () => {
  it('refuses everything when the policy module cannot be loaded', async () => {
    // A shim that cannot evaluate the rules must refuse, not allow. This is the
    // single most important property of the whole mechanism.
    const broken = await buildGitShim({
      directory: path.join(tempDir, 'bin-broken'),
      realGitPath: realGit,
      policy: { defaultBranch: 'main', currentBranch: 'mac/1-test', allowPush: false },
    });
    await fs.writeFile(path.join(broken.binDir, 'git-policy.mjs'), 'this is not valid javascript {{{', 'utf8');

    const result = await runIn(broken.binDir, ['status'], repoDir);

    expect(result.code).toBe(77);
    expect(result.stderr).toContain('refused');
  }, 60_000);
});
