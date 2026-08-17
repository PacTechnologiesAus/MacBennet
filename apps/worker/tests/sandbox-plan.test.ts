import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSandboxPlan, looksLikeCredentialStore, SandboxPlanError } from '../src/sandbox/plan.js';
import { buildBwrapArgv } from '../src/sandbox/bubblewrap.js';
import { buildDockerArgv } from '../src/sandbox/docker.js';
import { makePathMapper } from '../src/sandbox/index.js';

/**
 * The containment RULES (Sprint 3 §3.2).
 *
 * These tests are deliberately separate from the ones that prove enforcement.
 * Containment rules are the sort of thing that is written once, believed
 * forever, and never actually exercised — so the plan is a pure function and
 * every rule below runs in microseconds on every platform, including the ones
 * where neither provider exists.
 *
 * `sandbox-conformance.test.ts` proves the other half: that a real provider
 * actually enforces the plan this file describes.
 */

let root: string;
let repo: string;
let worktree: string;
let workspace: string;
let scratch: string;
let shim: string;
let home: string;

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mac-plan-'));
  repo = path.join(root, 'repo');
  worktree = path.join(root, 'workspace', 'worktrees', 'run-1');
  workspace = path.join(root, 'workspace');
  scratch = path.join(root, 'workspace', 'scratch', 'run-1');
  shim = path.join(root, 'workspace', 'shims', 'run-1');
  home = path.join(root, 'home');

  for (const dir of [repo, path.join(repo, '.git'), worktree, scratch, shim, home, path.join(home, '.ssh')]) {
    await fs.mkdir(dir, { recursive: true });
  }
  await fs.writeFile(path.join(home, '.ssh', 'id_ed25519'), 'PRIVATE KEY', 'utf8');
});

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

const base = () => ({
  worktreePath: worktree,
  repositoryGitDir: path.join(repo, '.git'),
  repositoryPath: repo,
  workspaceRoot: workspace,
  shimDir: shim,
  scratchDir: scratch,
  network: 'egress' as const,
  kind: 'bubblewrap' as const,
  homeDir: home,
});

// ---------------------------------------------------------------------------
// What is allowed in
// ---------------------------------------------------------------------------

describe('the plan mounts exactly what a coding session needs', () => {
  it('gives the worktree read/write access', () => {
    const plan = buildSandboxPlan(base());
    const mount = plan.mounts.find((m) => m.purpose === 'worktree');
    expect(mount).toBeDefined();
    expect(mount!.mode).toBe('rw');
  });

  it('mounts the git shim read-only, so the agent cannot rewrite the policy it is judged by', () => {
    const plan = buildSandboxPlan(base());
    const mount = plan.mounts.find((m) => m.purpose === 'git_shim');
    expect(mount!.mode).toBe('ro');
  });

  it('gives the run its own scratch space, not a shared one', () => {
    const planA = buildSandboxPlan({ ...base(), scratchDir: path.join(workspace, 'scratch', 'run-1') });
    const planB = buildSandboxPlan({ ...base(), scratchDir: path.join(workspace, 'scratch', 'run-2') });
    const a = planA.mounts.find((m) => m.purpose === 'scratch')!.hostPath;
    const b = planB.mounts.find((m) => m.purpose === 'scratch')!.hostPath;
    expect(a).not.toBe(b);
  });

  it('starts the process inside a writable mount', () => {
    const plan = buildSandboxPlan(base());
    const writable = plan.mounts.filter((m) => m.mode === 'rw').map((m) => m.sandboxPath);
    expect(writable).toContain(plan.workdir);
  });

  it('uses identity paths for bubblewrap and canonical paths for a container', () => {
    const bwrap = buildSandboxPlan(base());
    expect(bwrap.workdir).toBe(path.resolve(worktree));

    const docker = buildSandboxPlan({ ...base(), kind: 'docker' });
    expect(docker.workdir).toBe('/mac/work');
    expect(docker.workdir).not.toContain(path.resolve(worktree));
  });
});

// ---------------------------------------------------------------------------
// What is refused
// ---------------------------------------------------------------------------

describe('the plan refuses anything outside the assigned project', () => {
  it('refuses a project path outside the repository and the workspace', () => {
    const unrelated = path.join(root, 'other-project');
    try {
      buildSandboxPlan({ ...base(), scratchDir: unrelated });
      expect.unreachable('a scratch directory outside the allowed roots must be refused');
    } catch (err) {
      expect((err as SandboxPlanError).refusal).toBe('path_outside_allowed_roots');
    }

    try {
      buildSandboxPlan({ ...base(), worktreePath: path.join(root, 'other-project', 'worktree') });
      expect.unreachable("another project's worktree must be refused");
    } catch (err) {
      expect((err as SandboxPlanError).refusal).toBe('path_outside_allowed_roots');
    }
  });

  it('lets an administrator name a toolchain outside the workspace, but nothing dangerous', () => {
    /*
     * Tooling mounts are an operator's explicit decision, so they are not
     * required to sit inside the workspace — a toolchain lives in /opt. What
     * they must NOT be able to do is reach a credential store or a home
     * directory, and those refusals still apply to them, which is the property
     * worth pinning down.
     */
    // Real, because an operator mount must now exist: a mistyped tooling or
    // credential path used to become an empty docker volume and an agent that
    // could not authenticate. The property under test here is the ROOTS rule,
    // and it is unchanged.
    const toolchain = path.join(root, 'opt-toolchain');
    fsSync.mkdirSync(toolchain, { recursive: true });
    expect(() => buildSandboxPlan({ ...base(), toolingMounts: [toolchain] })).not.toThrow();
    expect(() => buildSandboxPlan({ ...base(), toolingMounts: [path.join(root, 'opt-typo')] })).toThrow(
      SandboxPlanError,
    );
    expect(() => buildSandboxPlan({ ...base(), toolingMounts: [path.join(home, '.aws')] })).toThrow(SandboxPlanError);
    expect(() => buildSandboxPlan({ ...base(), toolingMounts: [home] })).toThrow(SandboxPlanError);
  });

  it('refuses a traversal that climbs out of the workspace', () => {
    const escape = path.join(workspace, '..', '..', 'etc');
    try {
      buildSandboxPlan({ ...base(), scratchDir: escape });
      expect.unreachable('..-traversal out of the allowed roots must be refused');
    } catch (err) {
      expect((err as SandboxPlanError).refusal).toBe('path_outside_allowed_roots');
    }
  });

  it('refuses the filesystem root', () => {
    try {
      buildSandboxPlan({ ...base(), toolingMounts: [path.parse(process.cwd()).root] });
      expect.unreachable('mounting / is not a sandbox');
    } catch (err) {
      expect((err as SandboxPlanError).refusal).toBe('path_is_filesystem_root');
    }
  });

  it('refuses the home directory, because that is where credentials live', () => {
    try {
      buildSandboxPlan({ ...base(), toolingMounts: [home] });
      expect.unreachable('mounting $HOME must be refused');
    } catch (err) {
      expect((err as SandboxPlanError).refusal).toBe('path_is_home_directory');
    }
  });

  it('refuses a credential store even when it is explicitly allowlisted as tooling', () => {
    const ssh = path.join(home, '.ssh');
    try {
      buildSandboxPlan({ ...base(), toolingMounts: [ssh] });
      expect.unreachable('a credential directory must not be mountable as ordinary tooling');
    } catch (err) {
      expect((err as SandboxPlanError).refusal).toBe('path_is_credential_store');
    }
  });

  it("refuses to expose the worker's own credential file", () => {
    const stateFile = path.join(workspace, 'worker-state.json');
    try {
      // Mounting the whole workspace would sweep the state file in with it,
      // which is exactly the accident this rule exists to catch.
      buildSandboxPlan({ ...base(), scratchDir: workspace, workerStateFile: stateFile });
      expect.unreachable("the worker's own token must never be inside the boundary");
    } catch (err) {
      expect((err as SandboxPlanError).refusal).toBe('path_is_worker_state');
    }
  });

  it('refuses a relative path outright', () => {
    try {
      buildSandboxPlan({ ...base(), scratchDir: './scratch' });
      expect.unreachable('a relative mount is ambiguous and must be refused');
    } catch (err) {
      expect((err as SandboxPlanError).refusal).toBe('relative_path');
    }
  });

  it('recognises the credential stores a developer machine actually has', () => {
    for (const example of [
      '/home/mac/.ssh/id_rsa',
      '/home/mac/.aws/credentials',
      '/home/mac/.config/gh/hosts.yml',
      '/home/mac/.claude.json',
      'C:\\Users\\mac\\.npmrc',
      '/root/.git-credentials',
    ]) {
      expect(looksLikeCredentialStore(example), example).toBe(true);
    }
    for (const example of ['/srv/repos/device-portal/src/index.ts', '/var/lib/mac-worker/workspace/run-1']) {
      expect(looksLikeCredentialStore(example), example).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Symlink escape
// ---------------------------------------------------------------------------

describe('symlinks cannot smuggle a path in', () => {
  it('resolves a symlink before deciding whether it is inside the allowed roots', async () => {
    const target = path.join(root, 'outside-target');
    await fs.mkdir(target, { recursive: true });
    const link = path.join(workspace, 'looks-innocent');

    try {
      await fs.symlink(target, link, 'junction');
    } catch {
      // Windows without developer mode cannot create links; the rule is still
      // covered by the traversal test above, which needs no privilege.
      return;
    }

    try {
      // A project mount, so the roots rule applies: the link LOOKS like it is
      // inside the workspace, and would be accepted by any check that did not
      // resolve it first.
      buildSandboxPlan({ ...base(), scratchDir: link });
      expect.unreachable('a symlink pointing outside the allowed roots must be refused');
    } catch (err) {
      expect((err as SandboxPlanError).refusal).toBe('path_outside_allowed_roots');
    }
  });
});

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

describe('the environment is built from empty, not filtered', () => {
  it('carries no variable from the worker process', () => {
    process.env.MAC_SECRET_UNDER_TEST = 'do-not-leak';
    process.env.DATABASE_URL = 'postgres://leak';
    try {
      const plan = buildSandboxPlan(base());
      expect(plan.env.MAC_SECRET_UNDER_TEST).toBeUndefined();
      expect(plan.env.DATABASE_URL).toBeUndefined();
      expect(JSON.stringify(plan.env)).not.toContain('do-not-leak');
    } finally {
      delete process.env.MAC_SECRET_UNDER_TEST;
      delete process.env.DATABASE_URL;
    }
  });

  it('puts the git shim first on PATH', () => {
    const plan = buildSandboxPlan(base());
    expect(plan.env.PATH!.startsWith(path.resolve(shim))).toBe(true);
  });

  it('will not let an allowed extra variable overwrite PATH or HOME', () => {
    const plan = buildSandboxPlan({
      ...base(),
      extraEnv: { PATH: '/attacker/bin', HOME: '/root', NPM_CONFIG_CACHE: '/mac/scratch/npm' },
    });
    expect(plan.env.PATH).not.toBe('/attacker/bin');
    expect(plan.env.HOME).not.toBe('/root');
    expect(plan.env.NPM_CONFIG_CACHE).toBe('/mac/scratch/npm');
  });

  it('disables interactive prompts, which would hang an unattended session', () => {
    expect(buildSandboxPlan(base()).env.GIT_TERMINAL_PROMPT).toBe('0');
  });
});

// ---------------------------------------------------------------------------
// Denied witnesses — the conformance suite's oracle
// ---------------------------------------------------------------------------

describe('the plan names what must be unreachable', () => {
  it('carries the home directory and its credential stores as witnesses', () => {
    const plan = buildSandboxPlan({ ...base(), workerStateFile: path.join(workspace, 'state.json') });
    const witnesses = plan.deniedWitnesses.join('|');
    expect(witnesses).toContain('.ssh');
    expect(witnesses).toContain('.aws');
    expect(witnesses).toContain('state.json');
  });

  it('never lists a witness that is also mounted', () => {
    const plan = buildSandboxPlan(base());
    const mounted = new Set(plan.mounts.map((m) => m.hostPath.replace(/\\/g, '/')));
    for (const witness of plan.deniedWitnesses) {
      expect(mounted.has(witness), witness).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// Provider translation
// ---------------------------------------------------------------------------

describe('both providers translate the same plan', () => {
  it('bubblewrap binds read-only mounts with --ro-bind and writable ones with --bind', () => {
    const argv = buildBwrapArgv(buildSandboxPlan(base()));
    const shimIndex = argv.indexOf(path.resolve(shim));
    expect(argv[shimIndex - 1]).toBe('--ro-bind');

    const worktreeIndex = argv.indexOf(path.resolve(worktree));
    expect(argv[worktreeIndex - 1]).toBe('--bind');
  });

  it('bubblewrap unshares everything and shares the network back only when asked', () => {
    const open = buildBwrapArgv(buildSandboxPlan({ ...base(), network: 'egress' }));
    const closed = buildBwrapArgv(buildSandboxPlan({ ...base(), network: 'none' }));
    expect(open).toContain('--unshare-all');
    expect(open).toContain('--share-net');
    expect(closed).toContain('--unshare-all');
    expect(closed).not.toContain('--share-net');
  });

  it('bubblewrap clears the environment before setting the plan’s own', () => {
    const argv = buildBwrapArgv(buildSandboxPlan(base()));
    expect(argv).toContain('--clearenv');
    expect(argv).toContain('--die-with-parent');
  });

  it('docker drops all capabilities and refuses privilege escalation', () => {
    const argv = buildDockerArgv(buildSandboxPlan({ ...base(), kind: 'docker' }), {
      image: 'alpine:3.20',
      name: 'test',
    });
    expect(argv).toContain('--cap-drop');
    expect(argv).toContain('ALL');
    expect(argv).toContain('--security-opt');
    expect(argv).toContain('no-new-privileges');
  });

  it('docker mounts read-only volumes as :ro', () => {
    const plan = buildSandboxPlan({ ...base(), kind: 'docker' });
    const argv = buildDockerArgv(plan, { image: 'alpine:3.20', name: 'test' });
    const volumes = argv.filter((_, i) => argv[i - 1] === '-v');
    expect(volumes.some((v) => v.endsWith(':/mac/shim:ro'))).toBe(true);
    expect(volumes.some((v) => v.endsWith(':/mac/work:rw'))).toBe(true);
  });

  it('docker isolates the network entirely when the plan says none', () => {
    const argv = buildDockerArgv(buildSandboxPlan({ ...base(), kind: 'docker', network: 'none' }), {
      image: 'alpine:3.20',
      name: 'test',
    });
    expect(argv[argv.indexOf('--network') + 1]).toBe('none');
  });
});

describe('path mapping', () => {
  it('maps a file inside the worktree onto its container path', () => {
    const plan = buildSandboxPlan({ ...base(), kind: 'docker' });
    const map = makePathMapper(plan);
    expect(map(path.join(worktree, 'src', 'index.ts'))).toBe('/mac/work/src/index.ts');
  });

  it('prefers the most specific mount when they nest', () => {
    const plan = buildSandboxPlan({ ...base(), kind: 'docker' });
    const map = makePathMapper(plan);
    // The scratch directory lives under the workspace, which is not itself a
    // mount; the scratch mount must still win for paths inside it.
    expect(map(path.join(scratch, 'git-violations.jsonl'))).toBe('/mac/scratch/git-violations.jsonl');
  });

  it('leaves an unmapped path alone, so the failure is visible rather than silent', () => {
    const plan = buildSandboxPlan({ ...base(), kind: 'docker' });
    const map = makePathMapper(plan);
    const outside = path.resolve(path.join(root, 'not-mounted', 'file.txt'));
    expect(map(outside)).toBe(outside);
  });
});
