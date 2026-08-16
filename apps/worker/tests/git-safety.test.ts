import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTaskBranchName } from '@mac/protocol';
import { GitRunner, ProhibitedGitOperation, assertWithinWorkspace } from '../src/git/git-runner.js';
import { WorktreeManager, initialPolicy } from '../src/git/worktree.js';

/**
 * Git and worktree behaviour, against REAL repositories.
 *
 * A bare repository plays the remote, so "cannot push to the default branch"
 * and "cannot force-push" are proven by attempting them against something that
 * would genuinely accept them, and then asserting the remote is unchanged.
 *
 * The policy unit tests prove the rules are right. These prove they are wired
 * to the thing that actually runs git.
 */

let tempDir: string;
let remoteDir: string;
let cloneDir: string;
let workspace: string;

const exec = (cmd: string, argv: string[], cwd: string): Promise<{ code: number; stdout: string; stderr: string }> =>
  new Promise((resolve) => {
    execFile(cmd, argv, { cwd, shell: false, windowsHide: true }, (error, stdout, stderr) => {
      const code = (error as { code?: number } | null)?.code;
      resolve({ code: typeof code === 'number' ? code : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });

const git = (argv: string[], cwd: string) => exec('git', argv, cwd);

/** A GitRunner in Mac's own context: may push, but only into `mac/*`. */
function macRunner(overrides: { currentBranch?: string | null; allowPush?: boolean } = {}) {
  const violations: Array<{ code: string; argv: string[] }> = [];
  const runner = new GitRunner({
    cwd: cloneDir,
    policy: {
      ...initialPolicy('main', overrides.allowPush ?? true),
      currentBranch: overrides.currentBranch ?? null,
    },
    onViolation: (v) => {
      violations.push({ code: v.code, argv: v.argv });
    },
  });
  return { runner, violations };
}

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mac-git-'));
  remoteDir = path.join(tempDir, 'remote.git');
  cloneDir = path.join(tempDir, 'clone');
  workspace = path.join(tempDir, 'workspace');

  await fs.mkdir(remoteDir, { recursive: true });
  await git(['init', '--bare', '--initial-branch=main'], remoteDir);

  const seed = path.join(tempDir, 'seed');
  await fs.mkdir(seed, { recursive: true });
  await git(['init', '--initial-branch=main'], seed);
  await git(['config', 'user.email', 'mac@pac-technologies.com.au'], seed);
  await git(['config', 'user.name', 'Mac Bennett'], seed);
  await fs.writeFile(path.join(seed, 'README.md'), '# Device Portal\n', 'utf8');
  await fs.writeFile(path.join(seed, 'app.ts'), 'export const selectDevice = (id: string) => id;\n', 'utf8');
  await git(['add', '-A'], seed);
  await git(['commit', '-m', 'initial'], seed);
  await git(['remote', 'add', 'origin', remoteDir], seed);
  await git(['push', 'origin', 'main'], seed);

  await git(['clone', remoteDir, cloneDir], tempDir);
  await git(['config', 'user.email', 'mac@pac-technologies.com.au'], cloneDir);
  await git(['config', 'user.name', 'Mac Bennett'], cloneDir);
}, 180_000);

afterAll(async () => {
  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
});

beforeEach(async () => {
  await fs.mkdir(workspace, { recursive: true });
});

describe('worktree creation', () => {
  it('creates an isolated worktree on a task branch based on the remote default', async () => {
    const { runner } = macRunner();
    const worktrees = new WorktreeManager(runner);
    const branch = buildTaskBranchName({ taskRef: '247', title: 'Multi device selection' });

    const setup = await worktrees.prepare({
      repositoryPath: cloneDir,
      workspaceRoot: workspace,
      runId: 'run-worktree-1',
      branch,
      defaultBranch: 'main',
      remoteName: 'origin',
      log: () => undefined,
    });

    expect(setup.branch).toBe('mac/247-multi-device-selection');
    expect(setup.baseBranch).toBe('main');
    expect(setup.baseSha).toMatch(/^[0-9a-f]{40}$/);

    // It really is a separate working directory, and it really is on the branch.
    const stat = await fs.stat(setup.path);
    expect(stat.isDirectory()).toBe(true);
    const current = await git(['rev-parse', '--abbrev-ref', 'HEAD'], setup.path);
    expect(current.stdout.trim()).toBe('mac/247-multi-device-selection');

    // ...and the clone itself is untouched, still on the default branch.
    const cloneBranch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], cloneDir);
    expect(cloneBranch.stdout.trim()).toBe('main');
  }, 60_000);

  it('tracks the commits created during the run, and only those', async () => {
    const { runner } = macRunner();
    const worktrees = new WorktreeManager(runner);

    const setup = await worktrees.prepare({
      repositoryPath: cloneDir,
      workspaceRoot: workspace,
      runId: 'run-worktree-2',
      branch: 'mac/2-track-commits',
      defaultBranch: 'main',
      remoteName: 'origin',
      log: () => undefined,
    });

    expect(await worktrees.commitsSince(setup.path, setup.baseSha)).toHaveLength(0);

    await fs.writeFile(path.join(setup.path, 'feature.ts'), 'export const multi = true;\n', 'utf8');
    await git(['add', '-A'], setup.path);
    await git(['commit', '-m', 'feat: support multiple devices'], setup.path);

    const commits = await worktrees.commitsSince(setup.path, setup.baseSha);
    expect(commits).toHaveLength(1);
    expect(commits[0]!.subject).toBe('feat: support multiple devices');

    const changed = await worktrees.changedFiles(setup.path, setup.baseSha);
    expect(changed.map((f) => f.path)).toContain('feature.ts');
    expect(changed[0]!.insertions).toBeGreaterThan(0);
  }, 60_000);

  it('reports files the agent left uncommitted', async () => {
    const { runner } = macRunner();
    const worktrees = new WorktreeManager(runner);
    const setup = await worktrees.prepare({
      repositoryPath: cloneDir,
      workspaceRoot: workspace,
      runId: 'run-worktree-3',
      branch: 'mac/3-uncommitted',
      defaultBranch: 'main',
      remoteName: 'origin',
      log: () => undefined,
    });

    await fs.writeFile(path.join(setup.path, 'scratch.ts'), 'const x = 1;\n', 'utf8');
    const uncommitted = await worktrees.uncommittedFiles(setup.path);
    expect(uncommitted.some((f) => f.includes('scratch.ts'))).toBe(true);
  }, 60_000);

  it('refuses a worktree path outside the workspace root', () => {
    expect(() => assertWithinWorkspace('/etc/passwd', workspace)).toThrow(/outside the workspace root/);
    expect(() => assertWithinWorkspace(path.join(workspace, '..', 'escape'), workspace)).toThrow();
  });
});

describe('the default branch cannot be modified, whatever is attempted', () => {
  let baseSha: string;

  beforeAll(async () => {
    const head = await git(['rev-parse', 'main'], remoteDir);
    baseSha = head.stdout.trim();
  });

  const remoteMainSha = async (): Promise<string> => (await git(['rev-parse', 'main'], remoteDir)).stdout.trim();

  it('refuses a direct push to the default branch, and the remote does not move', async () => {
    const { runner, violations } = macRunner({ currentBranch: 'mac/9-x' });

    await expect(runner.run(['push', 'origin', 'main'])).rejects.toBeInstanceOf(ProhibitedGitOperation);
    expect(violations[0]!.code).toBe('PUSH_TO_DEFAULT');
    expect(await remoteMainSha()).toBe(baseSha);
  }, 30_000);

  it('refuses a force push, and the remote does not move', async () => {
    const { runner, violations } = macRunner({ currentBranch: 'mac/9-x' });

    await expect(runner.run(['push', '--force', 'origin', 'mac/9-x:main'])).rejects.toBeInstanceOf(ProhibitedGitOperation);
    expect(violations[0]!.code).toBe('FORCE_PUSH');
    expect(await remoteMainSha()).toBe(baseSha);
  }, 30_000);

  it('refuses deleting the default branch on the remote', async () => {
    const { runner, violations } = macRunner({ currentBranch: 'mac/9-x' });

    await expect(runner.run(['push', '--delete', 'origin', 'main'])).rejects.toBeInstanceOf(ProhibitedGitOperation);
    expect(violations[0]!.code).toBe('DELETE_DEFAULT_BRANCH');
    expect(await remoteMainSha()).toBe(baseSha);
  }, 30_000);

  it('refuses a merge into the default branch', async () => {
    const { runner, violations } = macRunner({ currentBranch: 'main' });

    await expect(runner.run(['merge', 'mac/9-x'])).rejects.toBeInstanceOf(ProhibitedGitOperation);
    expect(violations[0]!.code).toBe('MERGE_INTO_DEFAULT');
    expect(await remoteMainSha()).toBe(baseSha);
  }, 30_000);

  it('lets Mac push his own task branch, and the default branch still does not move', async () => {
    const { runner } = macRunner();
    const worktrees = new WorktreeManager(runner);

    const setup = await worktrees.prepare({
      repositoryPath: cloneDir,
      workspaceRoot: workspace,
      runId: 'run-push-1',
      branch: 'mac/10-real-push',
      defaultBranch: 'main',
      remoteName: 'origin',
      log: () => undefined,
    });

    await fs.writeFile(path.join(setup.path, 'pushed.ts'), 'export const pushed = true;\n', 'utf8');
    await git(['add', '-A'], setup.path);
    await git(['commit', '-m', 'feat: something worth reviewing'], setup.path);

    await worktrees.pushTaskBranch({ worktreePath: setup.path, remoteName: 'origin', branch: 'mac/10-real-push' });

    // The task branch reached the remote...
    const branches = await git(['branch', '--format=%(refname:short)'], remoteDir);
    expect(branches.stdout).toContain('mac/10-real-push');
    // ...and main is exactly where it was.
    expect(await remoteMainSha()).toBe(baseSha);
  }, 60_000);

  it('refuses to push a branch outside Mac\'s namespace', async () => {
    const { runner } = macRunner({ currentBranch: 'mac/9-x' });
    await expect(runner.run(['push', 'origin', 'somebody-elses-branch'])).rejects.toBeInstanceOf(ProhibitedGitOperation);
  }, 30_000);

  it('detects the default branch moving, however it happened', async () => {
    // Layer 3: verify the EFFECT. Simulate an out-of-band change — a mechanism
    // the policy never saw — and confirm Mac notices.
    const { runner } = macRunner();
    const worktrees = new WorktreeManager(runner);

    const before = await worktrees.verifyDefaultBranchUnchanged({
      repositoryPath: cloneDir,
      remoteName: 'origin',
      defaultBranch: 'main',
      expectedSha: (await git(['rev-parse', 'origin/main'], cloneDir)).stdout.trim(),
    });
    expect(before.unchanged).toBe(true);

    const after = await worktrees.verifyDefaultBranchUnchanged({
      repositoryPath: cloneDir,
      remoteName: 'origin',
      defaultBranch: 'main',
      expectedSha: '0000000000000000000000000000000000000000',
    });
    expect(after.unchanged).toBe(false);
    expect(after.actualSha).toMatch(/^[0-9a-f]{40}$/);
  }, 30_000);
});

describe('worktree preservation and removal', () => {
  it('removes a worktree only when explicitly told to', async () => {
    const { runner } = macRunner();
    const worktrees = new WorktreeManager(runner);

    const setup = await worktrees.prepare({
      repositoryPath: cloneDir,
      workspaceRoot: workspace,
      runId: 'run-remove-1',
      branch: 'mac/11-removable',
      defaultBranch: 'main',
      remoteName: 'origin',
      log: () => undefined,
    });

    await fs.writeFile(path.join(setup.path, 'work.ts'), 'export const work = 1;\n', 'utf8');
    await git(['add', '-A'], setup.path);
    await git(['commit', '-m', 'feat: work'], setup.path);

    // Still there until removal is asked for.
    expect((await fs.stat(setup.path)).isDirectory()).toBe(true);

    await worktrees.remove(cloneDir, setup.path);
    await expect(fs.stat(setup.path)).rejects.toThrow();

    // The branch and its commit survive removal of the working directory —
    // removing a worktree must never destroy the work it produced.
    const branches = await git(['branch', '--format=%(refname:short)'], cloneDir);
    expect(branches.stdout).toContain('mac/11-removable');
  }, 60_000);
});
