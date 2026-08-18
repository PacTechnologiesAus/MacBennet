import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  loadConfig,
  REFUSED_SANDBOX_ENV,
  RefusedSandboxEnv,
  resolveSandboxAgentEnv,
} from '../src/config.js';
import { buildSandboxPlan } from '../src/sandbox/plan.js';

/**
 * How the AGENT's own credential reaches the sandbox — and nothing else's.
 *
 * Commissioning defect #3. `extraEnv` and `credentialMounts` were in the plan
 * and wired to nothing: no configuration reached them, no caller supplied them.
 * Because the sandbox environment is built from empty, that meant a real coding
 * agent inside the sandbox could not authenticate — and so none ever had. The
 * conformance suite proved containment with `sh`, `cat` and `test -e`, and the
 * coding-job tests used a mock agent, so nothing failed and nothing was true.
 *
 * The wiring is the easy half. The half worth testing is the refusal: an
 * allowance meant for the agent's provider key must not become a way to hand a
 * sandboxed process the worker's enrollment token or the monday.com credential.
 */

let workspace: string;
let repo: string;
let worktree: string;
let shim: string;
let scratch: string;
let credentialFile: string;
let fakeHome: string;
let claudeCredential: string;

beforeAll(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'mac-cred-'));
  repo = path.join(workspace, 'project');
  worktree = path.join(workspace, 'worktrees', 'mac-1');
  shim = path.join(workspace, 'shim');
  scratch = path.join(workspace, 'scratch');
  credentialFile = path.join(workspace, 'agent-credentials.json');
  fakeHome = path.join(workspace, 'fake-home');
  claudeCredential = path.join(fakeHome, '.claude', '.credentials.json');

  await fs.mkdir(path.join(repo, '.git'), { recursive: true });
  await fs.mkdir(worktree, { recursive: true });
  await fs.mkdir(shim, { recursive: true });
  await fs.mkdir(scratch, { recursive: true });
  await fs.mkdir(path.dirname(claudeCredential), { recursive: true });
  await fs.writeFile(credentialFile, '{"agent":"token"}', 'utf8');
  await fs.writeFile(claudeCredential, '{"claude":"subscription"}', 'utf8');
});

afterAll(async () => {
  await fs.rm(workspace, { recursive: true, force: true }).catch(() => undefined);
});

const plan = (extra: Parameters<typeof buildSandboxPlan>[0] extends infer T ? Partial<T> : never = {}) =>
  buildSandboxPlan({
    worktreePath: worktree,
    repositoryGitDir: path.join(repo, '.git'),
    repositoryPath: repo,
    workspaceRoot: workspace,
    shimDir: shim,
    scratchDir: scratch,
    network: 'egress',
    kind: 'docker',
    maxMinutes: 30,
    homeDir: fakeHome,
    ...extra,
  } as Parameters<typeof buildSandboxPlan>[0]);

// ---------------------------------------------------------------------------

describe('forwarding the agent’s own environment', () => {
  it('passes a named variable’s value through', () => {
    const resolved = resolveSandboxAgentEnv(['ANTHROPIC_API_KEY'], {
      ANTHROPIC_API_KEY: 'sk-ant-example',
      MAC_ENROLLMENT_TOKEN: 'must-not-appear',
    });
    expect(resolved).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-example' });
  });

  it('ignores blank entries, so a trailing comma is not an error', () => {
    expect(resolveSandboxAgentEnv(['', '  ', 'FOO'], { FOO: 'bar' })).toEqual({ FOO: 'bar' });
  });

  it('reports a named variable that is not set, rather than silently omitting it', () => {
    // The alternative is an agent that mysteriously cannot log in, diagnosed at
    // 02:00 from a stack trace inside a container.
    expect(() => resolveSandboxAgentEnv(['ANTHROPIC_API_KEY'], {})).toThrow(/is not set in the worker/);
  });
});

describe('the forwarding allowance cannot be pointed at somebody else’s secret', () => {
  const source: NodeJS.ProcessEnv = {
    MAC_ENROLLMENT_TOKEN: 'enroll',
    MAC_WORKER_STATE_FILE: './state.json',
    MAC_CONTROL_PLANE_URL: 'https://mac.example',
    DATABASE_URL: 'postgres://…',
    TEST_DATABASE_URL: 'postgres://…',
    MONDAY_API_TOKEN: 'monday',
    MAC_MAIL_CLIENT_SECRET: 'graph',
    MAC_MAIL_TENANT_ID: 'tenant',
    SEED_ADMIN_PASSWORD: 'hunter2',
    SESSION_COOKIE_NAME: 'mac_session',
    AWS_SECRET_ACCESS_KEY: 'aws',
    GITHUB_TOKEN: 'gho_…',
    GH_TOKEN: 'gho_…',
  };

  for (const name of Object.keys(source)) {
    it(`refuses ${name}`, () => {
      expect(() => resolveSandboxAgentEnv([name], source)).toThrow(RefusedSandboxEnv);
    });
  }

  it('refuses a name that merely starts with a refused prefix', () => {
    // The prefixes exist so a variable nobody has invented yet is refused too.
    expect(() => resolveSandboxAgentEnv(['MAC_MAIL_SOMETHING_NEW'], { MAC_MAIL_SOMETHING_NEW: 'x' })).toThrow(
      RefusedSandboxEnv,
    );
    expect(() => resolveSandboxAgentEnv(['MAC_WORKER_ANYTHING'], { MAC_WORKER_ANYTHING: 'x' })).toThrow(
      RefusedSandboxEnv,
    );
  });

  it('is case-insensitive, so lower-case spelling is not a bypass', () => {
    expect(() => resolveSandboxAgentEnv(['monday_api_token'], { monday_api_token: 'x' })).toThrow(RefusedSandboxEnv);
  });

  it('refuses the three variables that define containment itself', () => {
    for (const name of ['PATH', 'HOME', 'TMPDIR']) {
      expect(() => resolveSandboxAgentEnv([name], { [name]: '/attacker' })).toThrow(RefusedSandboxEnv);
    }
  });

  it('names every credential the control plane holds', () => {
    // A reminder rather than a mechanism: if a new provider credential is added
    // to the control plane and not to this list, this fails.
    for (const expected of ['MONDAY_API_TOKEN', 'MAC_MAIL_', 'DATABASE_URL', 'MAC_ENROLLMENT_TOKEN']) {
      expect(REFUSED_SANDBOX_ENV).toContain(expected);
    }
  });
});

describe('the plan carries the forwarded environment without letting it take over', () => {
  it('includes the agent’s variable in the sandbox environment', () => {
    const built = plan({ extraEnv: { ANTHROPIC_API_KEY: 'sk-ant-example' } });
    expect(built.env.ANTHROPIC_API_KEY).toBe('sk-ant-example');
  });

  it('still refuses to let it overwrite PATH, HOME or TMPDIR', () => {
    // Defence in depth: `resolveSandboxAgentEnv` refuses these by name, and the
    // plan builder ignores them even if something else supplies them.
    const built = plan({ extraEnv: { PATH: '/attacker/bin', HOME: '/root', TMPDIR: '/root/tmp' } });
    expect(built.env.PATH).not.toBe('/attacker/bin');
    expect(built.env.HOME).not.toBe('/root');
    expect(built.env.TMPDIR).not.toBe('/root/tmp');
  });
});

describe('credential mounts', () => {
  it('mounts the agent’s credential read-only, and says that is what it is', () => {
    const built = plan({ credentialMounts: [credentialFile] });
    const mount = built.mounts.find((m) => m.hostPath === credentialFile);

    expect(mount, 'the credential was not mounted').toBeDefined();
    expect(mount!.mode).toBe('ro');
    // Recorded as a credential, so a plan a human reads says plainly that a
    // secret was placed inside the boundary. That is the point of the boundary
    // being "no OTHER project and no OTHER secret" rather than "no secrets".
    expect(mount!.purpose).toBe('credential');
  });

  it('does not add the credential’s directory to the roots a project mount may sit in', () => {
    // The Sprint 3 defect that nearly shipped, in a new place: if a credential
    // mount authorised its own parent directory, mounting one would quietly
    // widen what else could be mounted.
    const built = plan({ credentialMounts: [credentialFile] });
    const projectMounts = built.mounts.filter((m) => m.purpose !== 'credential' && m.purpose !== 'tooling');
    for (const mount of projectMounts) {
      expect(mount.hostPath).not.toBe(path.dirname(credentialFile));
    }
  });

  it('places a Claude subscription credential where the sandboxed CLI discovers it', () => {
    const built = plan({ credentialMounts: [claudeCredential] });
    const mount = built.mounts.find((entry) => entry.hostPath === claudeCredential);

    expect(mount?.sandboxPath).toBe('/mac/home/.claude/.credentials.json');
    expect(mount?.mode).toBe('ro');
  });

  it('refuses a credential mount that does not exist, rather than mounting an empty directory', () => {
    expect(() => plan({ credentialMounts: [path.join(workspace, 'no-such-credential.json')] })).toThrow();
  });
});

describe('the configuration actually reaches the sandbox', () => {
  const withEnv = <T>(vars: Record<string, string | undefined>, fn: () => T): T => {
    const saved = new Map<string, string | undefined>();
    for (const [key, value] of Object.entries(vars)) {
      saved.set(key, process.env[key]);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try {
      return fn();
    } finally {
      for (const [key, value] of saved) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  };

  it('reads MAC_SANDBOX_AGENT_ENV and MAC_SANDBOX_CREDENTIALS', () => {
    const config = withEnv(
      {
        MAC_SANDBOX_AGENT_ENV: 'ANTHROPIC_API_KEY',
        ANTHROPIC_API_KEY: 'sk-ant-example',
        MAC_SANDBOX_CREDENTIALS: credentialFile,
      },
      () => loadConfig(),
    );

    expect(config.sandbox.agentEnv).toEqual({ ANTHROPIC_API_KEY: 'sk-ant-example' });
    expect(config.sandbox.credentialMounts).toEqual([credentialFile]);
  });

  it('refuses to start at all when the allowance names a worker credential', () => {
    // Loud at boot rather than quiet at 02:00.
    expect(() =>
      withEnv({ MAC_SANDBOX_AGENT_ENV: 'MAC_ENROLLMENT_TOKEN', MAC_ENROLLMENT_TOKEN: 'x' }, () => loadConfig()),
    ).toThrow(RefusedSandboxEnv);
  });

  it('does not cut a Windows path in half at the drive letter', () => {
    const config = withEnv(
      { MAC_SANDBOX_CREDENTIALS: 'C:\\Users\\mac\\.claude\\.credentials.json', MAC_SANDBOX_AGENT_ENV: undefined },
      () => loadConfig(),
    );
    expect(config.sandbox.credentialMounts).toEqual(['C:\\Users\\mac\\.claude\\.credentials.json']);
  });

  it('still splits a Linux colon-separated list, which is what the VM uses', () => {
    const config = withEnv(
      { MAC_SANDBOX_TOOLING: '/opt/node:/opt/tools', MAC_SANDBOX_AGENT_ENV: undefined },
      () => loadConfig(),
    );
    expect(config.sandbox.toolingMounts).toEqual(['/opt/node', '/opt/tools']);
  });
});
