import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildSandboxPlan } from '../src/sandbox/plan.js';
import { resolveSandbox } from '../src/sandbox/resolve.js';
import type { ExecutionSandbox, SandboxSession } from '../src/sandbox/index.js';

/**
 * Does the boundary actually hold? (Sprint 3 §3, brief §2)
 *
 * `sandbox-plan.test.ts` proves the RULES. This file proves ENFORCEMENT, and it
 * does so the only way enforcement can honestly be proven: by running real
 * processes inside a real sandbox and asking them to reach things they must not
 * reach.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS RUNS AT ALL ON A DEVELOPER MACHINE
 *
 * Bubblewrap is the production provider and is Linux-only. If this suite could
 * only run there, every containment claim in Sprint 3 would rest on tests that
 * skipped on the machine the code was written on — and a boundary whose
 * enforcement has never been observed is a boundary nobody should trust,
 * including its author. Docker gives the same guarantees through a different
 * mechanism and is available on both, so the suite runs against whichever
 * provider the host has.
 *
 * It skips ONLY when the host has neither, and says so loudly rather than
 * quietly reporting green.
 * ---------------------------------------------------------------------------
 *
 * The image is deliberately tiny (`alpine`): what is under test is the mount
 * namespace, not a toolchain. A coding image carrying Node and git is an
 * administrator's choice and is exercised by the opt-in test at the bottom.
 */

const IMAGE = process.env.MAC_SANDBOX_TEST_IMAGE ?? 'alpine:3.20';

let root: string;
let repo: string;
let worktree: string;
let workspace: string;
let scratch: string;
let shim: string;
let home: string;
let otherProject: string;
let secretFile: string;

/*
 * Probed at MODULE level, not in `beforeAll`.
 *
 * Vitest decides which suites to skip while collecting, which happens before
 * any hook runs — so a flag set in `beforeAll` would arrive too late and every
 * containment test would silently skip on a host that could run them. Top-level
 * await is the difference between this suite proving something and quietly
 * reporting green.
 */
const resolution = await resolveSandbox({ provider: 'auto', image: IMAGE });
const sandbox: ExecutionSandbox | null = resolution.sandbox;
const kind = resolution.kind;

if (!sandbox) {
  // Loud, not quiet. A skipped containment suite must never look like a
  // passing one.
  // eslint-disable-next-line no-console
  console.warn(
    `\n*** SANDBOX CONFORMANCE SKIPPED ***\nNo execution sandbox is available on this host ` +
      `(${resolution.detail ?? 'unknown'}).\nContainment is therefore UNVERIFIED here. Install bubblewrap ` +
      `(Linux) or start Docker before trusting these results.\n`,
  );
}

beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'mac-sbx-'));
  repo = path.join(root, 'repo');
  workspace = path.join(root, 'workspace');
  worktree = path.join(workspace, 'worktrees', 'run-1');
  scratch = path.join(workspace, 'scratch', 'run-1');
  shim = path.join(workspace, 'shims', 'run-1');
  // Distinctively named: asserting that a generic 'home' is absent would
  // collide with the container image's own /home and prove nothing.
  home = path.join(root, 'host-home-fixture');
  otherProject = path.join(root, 'other-project');
  secretFile = path.join(home, '.ssh', 'id_ed25519');

  for (const dir of [
    path.join(repo, '.git'),
    worktree,
    scratch,
    shim,
    path.join(home, '.ssh'),
    otherProject,
  ]) {
    await fs.mkdir(dir, { recursive: true });
  }

  await fs.writeFile(path.join(worktree, 'allowed.txt'), 'THIS-IS-THE-PROJECT-FILE\n', 'utf8');
  await fs.writeFile(path.join(repo, '.git', 'HEAD'), 'ref: refs/heads/main\n', 'utf8');
  await fs.writeFile(path.join(shim, 'git'), '#!/bin/sh\nexit 0\n', { encoding: 'utf8', mode: 0o755 });
  await fs.writeFile(secretFile, 'PRIVATE-KEY-MUST-NOT-BE-READABLE\n', 'utf8');
  await fs.writeFile(path.join(otherProject, 'secrets.env'), 'OTHER-PROJECT-SECRET\n', 'utf8');
  await fs.writeFile(path.join(workspace, 'worker-state.json'), '{"workerToken":"mac_wk_LEAKED"}\n', 'utf8');
}, 120_000);

afterAll(async () => {
  await fs.rm(root, { recursive: true, force: true }).catch(() => undefined);
});

const plan = (overrides: Partial<Parameters<typeof buildSandboxPlan>[0]> = {}) =>
  buildSandboxPlan({
    worktreePath: worktree,
    repositoryGitDir: path.join(repo, '.git'),
    repositoryPath: repo,
    workspaceRoot: workspace,
    shimDir: shim,
    scratchDir: scratch,
    network: 'none',
    kind: kind as 'bubblewrap' | 'docker',
    image: IMAGE,
    homeDir: home,
    workerStateFile: path.join(workspace, 'worker-state.json'),
    ...overrides,
  });

interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs a shell command inside the sandbox and collects everything it said. */
async function inSandbox(
  session: SandboxSession,
  script: string,
  options: { signal?: AbortSignal } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = session.spawner('/bin/sh', ['-c', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(options.signal ? { signal: options.signal } : {}),
    });

    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => resolve({ code: null, stdout, stderr: `${stderr}${(err as Error).message}` }));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

const describeIfSandbox = sandbox ? describe : describe.skip;

// ---------------------------------------------------------------------------

describe('sandbox availability', () => {
  it('reports honestly whether containment is available on this host', () => {
    if (resolution.available) {
      expect(resolution.sandbox).not.toBeNull();
      expect(['bubblewrap', 'docker']).toContain(resolution.kind);
    } else {
      // The property that matters when nothing is available: `available` is
      // false and a reason is given. There is no third state where a worker
      // believes it is contained and is not.
      expect(resolution.sandbox).toBeNull();
      expect(resolution.detail).toBeTruthy();
    }
  }, 60_000);

  it('attests no containment when sandboxing is explicitly disabled', async () => {
    const resolution = await resolveSandbox({ provider: 'none' });
    expect(resolution.available).toBe(false);
    expect(resolution.sandbox).toBeNull();
    expect(resolution.detail).toContain('withhold coding work');
  });
});

describeIfSandbox('filesystem containment, proven against a real provider', () => {
  let session: SandboxSession;

  beforeAll(async () => {
    session = await sandbox!.open(plan());
  }, 180_000);

  afterAll(async () => {
    await session?.close().catch(() => undefined);
  });

  it('can read the assigned project files', async () => {
    const result = await inSandbox(session, `cat ${session.pathFor(path.join(worktree, 'allowed.txt'))}`);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('THIS-IS-THE-PROJECT-FILE');
  }, 120_000);

  it('can write inside the assigned worktree', async () => {
    const target = session.pathFor(path.join(worktree, 'written-by-agent.txt'));
    const result = await inSandbox(session, `echo AGENT-WROTE-THIS > ${target} && cat ${target}`);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('AGENT-WROTE-THIS');

    // And the host really has it — the worktree is a host directory, which is
    // why work survives even when the sandbox is torn down.
    const onHost = await fs.readFile(path.join(worktree, 'written-by-agent.txt'), 'utf8');
    expect(onHost).toContain('AGENT-WROTE-THIS');
  }, 120_000);

  it('can read this repository’s git metadata, which is what git needs to work', async () => {
    const result = await inSandbox(session, `cat ${session.pathFor(path.join(repo, '.git', 'HEAD'))}`);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('refs/heads/main');
  }, 120_000);

  it('CANNOT reach an unrelated project on the same machine', async () => {
    const result = await inSandbox(
      session,
      `cat ${posix(path.join(otherProject, 'secrets.env'))} 2>&1; echo "exit=$?"`,
    );
    expect(result.stdout).not.toContain('OTHER-PROJECT-SECRET');
    expect(result.stdout).toContain('exit=1');
  }, 120_000);

  it('CANNOT reach a known secret location', async () => {
    const result = await inSandbox(session, `cat ${posix(secretFile)} 2>&1; echo "exit=$?"`);
    expect(result.stdout).not.toContain('PRIVATE-KEY-MUST-NOT-BE-READABLE');
    expect(result.stdout).toContain('exit=1');
  }, 120_000);

  it("CANNOT reach the worker's own credential file", async () => {
    const result = await inSandbox(
      session,
      `cat ${posix(path.join(workspace, 'worker-state.json'))} 2>&1; echo "exit=$?"`,
    );
    expect(result.stdout).not.toContain('mac_wk_LEAKED');
    expect(result.stdout).toContain('exit=1');
  }, 120_000);

  it('CANNOT escape the worktree by filesystem traversal', async () => {
    const work = session.pathFor(worktree);

    /*
     * What is being asserted here, precisely.
     *
     * Climbing out of the worktree with `..` is not itself a violation — it
     * lands in the SANDBOX's own filesystem, which under a container is the
     * image's root and under bubblewrap is a namespace holding only what the
     * plan mounted. An earlier version of this test asserted that `/etc/shadow`
     * was unreadable and passed nothing but the image's own copy of it, which
     * would have been a test that looked strict and proved nothing.
     *
     * The property that matters is that traversal cannot arrive at anything
     * from the HOST that the plan did not mount: the developer's home, another
     * project, the worker's credential. Those paths must not exist at all.
     */
    const traversal = await inSandbox(
      session,
      [
        `cat ${work}/../../../${path.basename(home)}/.ssh/id_ed25519 2>&1`,
        `cat ${work}/../${path.basename(otherProject)}/secrets.env 2>&1`,
        `cat ${work}/../../worker-state.json 2>&1`,
        'echo done',
      ].join('; '),
    );

    expect(traversal.stdout).not.toContain('PRIVATE-KEY-MUST-NOT-BE-READABLE');
    expect(traversal.stdout).not.toContain('OTHER-PROJECT-SECRET');
    expect(traversal.stdout).not.toContain('mac_wk_LEAKED');
    expect(traversal.stdout).toContain('done');

    /*
     * And the tree itself, listed separately.
     *
     * Separately because `cat` echoes the path it failed to open, so a combined
     * run would contain the host directory NAMES in its error text and any
     * assertion about them would be meaningless. Listing on its own gives a
     * clean answer to "what is actually up there".
     */
    const listing = await inSandbox(session, `ls -a ${work}/../../.. 2>&1; ls -a / 2>&1`);
    expect(listing.stdout).not.toContain(path.basename(otherProject));
    expect(listing.stdout).not.toContain(path.basename(home));
  }, 120_000);

  it('CANNOT see every path the plan declared denied', async () => {
    const witnesses = plan().deniedWitnesses;
    expect(witnesses.length).toBeGreaterThan(0);

    const script = witnesses.map((w) => `test -e ${posix(w)} && echo "REACHABLE:${posix(w)}"`).join('; ');
    const result = await inSandbox(session, `${script}; echo checked`);
    expect(result.stdout).not.toContain('REACHABLE:');
    expect(result.stdout).toContain('checked');
  }, 120_000);

  it('carries none of the worker process’s environment', async () => {
    process.env.MAC_CONFORMANCE_SECRET = 'must-not-appear';
    try {
      const fresh = await sandbox!.open(plan());
      try {
        const result = await inSandbox(fresh, 'env');
        expect(result.stdout).not.toContain('must-not-appear');
        expect(result.stdout).not.toContain('MAC_CONFORMANCE_SECRET');
        // But the plan's own environment IS there.
        expect(result.stdout).toContain('GIT_TERMINAL_PROMPT=0');
      } finally {
        await fresh.close();
      }
    } finally {
      delete process.env.MAC_CONFORMANCE_SECRET;
    }
  }, 180_000);

  it('mounts the git shim read-only, so the policy cannot be rewritten from inside', async () => {
    const shimPath = session.pathFor(path.join(shim, 'git'));
    const result = await inSandbox(session, `echo tampered > ${shimPath} 2>&1; echo "exit=$?"`);
    expect(result.stdout).toContain('exit=1');

    const onHost = await fs.readFile(path.join(shim, 'git'), 'utf8');
    expect(onHost).not.toContain('tampered');
  }, 120_000);
});

describeIfSandbox('cancellation still works inside the sandbox', () => {
  it('kills a long-running sandboxed process when the run is aborted', async () => {
    const session = await sandbox!.open(plan());
    try {
      const controller = new AbortController();
      const started = Date.now();
      const finished = inSandbox(session, 'sleep 60', { signal: controller.signal });

      // Long enough for the container or the bwrap child to be genuinely up.
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      controller.abort();

      const result = await finished;
      const elapsed = Date.now() - started;

      expect(result.code).not.toBe(0);
      // Aborted, not waited out: 60s would be the un-cancelled duration.
      expect(elapsed).toBeLessThan(40_000);
    } finally {
      await session.close().catch(() => undefined);
    }
  }, 180_000);
});

describeIfSandbox('network posture', () => {
  it('isolates the network when the plan says none', async () => {
    const session = await sandbox!.open(plan({ network: 'none' }));
    try {
      // No DNS, no route. The check is deliberately one that fails fast and
      // does not depend on the host having internet access to be meaningful:
      // with `--network none` there is no non-loopback interface at all.
      const result = await inSandbox(session, 'ip -o addr 2>/dev/null || ifconfig 2>/dev/null || echo NO-TOOLS');
      if (!result.stdout.includes('NO-TOOLS')) {
        expect(result.stdout).not.toMatch(/\b(eth0|ens|enp)\b/);
      }
    } finally {
      await session.close().catch(() => undefined);
    }
  }, 180_000);
});

/** Host paths inside a shell command; the sandbox path is what should not exist. */
const posix = (p: string): string => p.replace(/\\/g, '/');
