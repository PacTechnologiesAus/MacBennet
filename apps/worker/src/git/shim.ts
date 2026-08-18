import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GitPolicyContext } from '@mac/protocol';

/**
 * The git shim (Sprint 2 §2, layer 2).
 *
 * Layer 1 stops MAC from doing anything prohibited, because Mac's only route to
 * git is `GitRunner`. That does nothing about the coding agent, which has a
 * shell and can type `git push --force origin main` whenever it likes.
 *
 * So before the agent starts, the worker writes a directory containing an
 * executable called `git` and puts it FIRST on the agent's PATH. The agent's
 * `git` resolves to that shim, which:
 *
 *   1. re-validates argv against the SAME policy module Mac uses;
 *   2. on refusal, prints why, appends a JSON record to a violations file that
 *      the worker uploads as a security event, and exits 77;
 *   3. on acceptance, execs the REAL git — resolved at shim-build time and
 *      baked in, never looked up on PATH, so the shim cannot recurse into
 *      itself and cannot be redirected by editing PATH.
 *
 * This binds regardless of what the agent's prompt said, which is the whole
 * point: Sprint 2 requires enforcement "by application code, not prompts alone".
 *
 * The shim is not the last line of defence. Layer 3 (`verifyDefaultBranchUnchanged`)
 * checks the EFFECT afterwards, so an agent that finds some other route to git
 * is still caught.
 */

export interface ShimSetup {
  /** Directory to prepend to the agent's PATH. */
  binDir: string;
  /** JSONL file the shim appends refusals to. */
  violationsFile: string;
}

export interface BuildShimParams {
  /** Directory to write the shim into. Must be inside the run's workspace. */
  directory: string;
  /** Absolute path of the real git binary. */
  realGitPath: string;
  policy: GitPolicyContext;
  /**
   * Where refusals are appended.
   *
   * Sprint 3 moved this out of the shim directory. Inside a sandbox the shim is
   * mounted READ-ONLY — so the agent cannot rewrite the policy it is being
   * judged by — which means the guard cannot write its evidence there either.
   * The violations file therefore lives in the run's writable scratch space.
   *
   * Defaults to the shim directory, preserving the unsandboxed behaviour.
   */
  violationsFile?: string;
  /**
   * How the shim's own files will be addressed by the process that runs them.
   *
   * Under bubblewrap the sandbox path IS the host path, so this is unnecessary.
   * Under a container it is not: the shim is mounted somewhere else entirely,
   * and the launcher scripts have to name the paths the sandboxed process will
   * actually see. The FILES are written to host paths; the SCRIPTS reference
   * sandbox paths.
   */
  sandbox?: {
    /** The shim directory as seen inside the sandbox. */
    binDir: string;
    /** The scratch directory as seen inside the sandbox. */
    scratchDir: string;
    /** Node executable inside the sandbox. */
    nodePath: string;
    /** The real git binary inside the sandbox. */
    realGitPath: string;
  };
}

/**
 * The policy the shim enforces, written next to it as JSON.
 *
 * Separate from the script so the script itself is static and reviewable, and
 * so the per-run values (which branch is default, which is checked out) are
 * data rather than generated code.
 */
export interface ShimPolicyFile extends GitPolicyContext {
  realGitPath: string;
  violationsFile: string;
}

export async function buildGitShim(params: BuildShimParams): Promise<ShimSetup> {
  const binDir = path.resolve(params.directory);
  await fs.mkdir(binDir, { recursive: true });

  const violationsFile = params.violationsFile
    ? path.resolve(params.violationsFile)
    : path.join(binDir, 'git-violations.jsonl');
  const policyFile = path.join(binDir, 'git-policy.json');
  const guardScript = path.join(binDir, 'git-guard.mjs');

  /*
   * Two views of the same files.
   *
   * `*Host` is where this process writes them; the unsuffixed names are how the
   * PROCESS INSIDE THE SANDBOX will address them. They are identical without a
   * sandbox and under bubblewrap, and differ under a container — which is
   * exactly the case where getting it wrong produces a shim that silently is
   * not on the agent's PATH.
   */
  const view = params.sandbox;
  const guardScriptInSandbox = view ? `${view.binDir}/git-guard.mjs` : guardScript;
  const policyFileInSandbox = view ? `${view.binDir}/git-policy.json` : policyFile;
  const policyModuleInSandbox = view ? `${view.binDir}/git-policy.mjs` : path.join(binDir, 'git-policy.mjs');
  const violationsFileInSandbox = view
    ? `${view.scratchDir}/${path.basename(violationsFile)}`
    : violationsFile;

  const policy: ShimPolicyFile = {
    ...params.policy,
    // The agent may NEVER push. Whatever the caller passed, this is forced.
    allowPush: false,
    realGitPath: view ? view.realGitPath : params.realGitPath,
    violationsFile: violationsFileInSandbox,
  };

  await fs.writeFile(policyFile, JSON.stringify(policy, null, 2), 'utf8');

  // The policy module, as plain JavaScript the guard's bare Node process can
  // import. See `emitPolicyModule` for why this is transpiled rather than
  // duplicated or built.
  const policyModulePath = path.join(binDir, 'git-policy.mjs');
  await fs.writeFile(policyModulePath, await emitPolicyModule(), 'utf8');

  await fs.writeFile(guardScript, guardSource(policyModuleInSandbox), 'utf8');

  await fs.mkdir(path.dirname(violationsFile), { recursive: true }).catch(() => undefined);

  const nodeExecutable = view ? view.nodePath : process.execPath;

  /*
   * Two launchers, because the agent's shell differs by platform:
   *   `git`     — POSIX sh, used by bash/zsh on Linux and macOS, and by the
   *               Git-Bash shell that Claude Code uses on Windows;
   *   `git.cmd` — cmd.exe and PowerShell on Windows.
   *
   * Both do the same thing: hand argv to the guard, unmodified. `"$@"` and
   * `%*` preserve quoting, so an argument containing spaces stays one argument.
   */
  const shScript = [
    '#!/bin/sh',
    '# Mac Bennett git shim. Enforces the hard Git safety rules on any process',
    '# that inherits this directory on its PATH. See apps/worker/src/git/shim.ts.',
    `exec ${quoteForSh(nodeExecutable)} ${quoteForSh(guardScriptInSandbox)} ${quoteForSh(policyFileInSandbox)} "$@"`,
    '',
  ].join('\n');

  const cmdScript = [
    '@echo off',
    'REM Mac Bennett git shim. Enforces the hard Git safety rules.',
    `"${nodeExecutable}" "${guardScriptInSandbox}" "${policyFileInSandbox}" %*`,
    'exit /b %ERRORLEVEL%',
    '',
  ].join('\r\n');

  await fs.writeFile(path.join(binDir, 'git'), shScript, { encoding: 'utf8', mode: 0o755 });
  await fs.writeFile(path.join(binDir, 'git.cmd'), cmdScript, { encoding: 'utf8', mode: 0o755 });
  // chmod is a no-op on Windows but must not be skipped on Linux, where the
  // deployment actually runs.
  await fs.chmod(path.join(binDir, 'git'), 0o755).catch(() => undefined);

  await fs.writeFile(violationsFile, '', 'utf8');

  return { binDir, violationsFile };
}

/** Single-quotes for POSIX sh, escaping any embedded single quote. */
const quoteForSh = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * Reads the refusals the shim recorded.
 *
 * Malformed lines are skipped rather than throwing: a violations file is
 * evidence, and failing to read the whole of it because one line is truncated
 * would lose the rest.
 */
export async function readShimViolations(
  violationsFile: string,
): Promise<Array<{ code: string; argv: string[]; message: string; at: string }>> {
  const raw = await fs.readFile(violationsFile, 'utf8').catch(() => '');
  const out: Array<{ code: string; argv: string[]; message: string; at: string }> = [];

  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as { code?: string; argv?: string[]; message?: string; at?: string };
      if (parsed.code && Array.isArray(parsed.argv)) {
        out.push({
          code: parsed.code,
          argv: parsed.argv.map(String).slice(0, 60),
          message: String(parsed.message ?? ''),
          at: String(parsed.at ?? new Date().toISOString()),
        });
      }
    } catch {
      // A partially written line is not a reason to discard the file.
    }
  }
  return out;
}

/**
 * Emits the shared policy module as plain ESM JavaScript.
 *
 * The guard runs in a bare `node` process spawned by a shell script. It cannot
 * import the TypeScript source (Node 20 has no type stripping), and the
 * repository has no build output to import either — everything here runs
 * straight from TypeScript under tsx.
 *
 * Three options were available, and this is the least bad:
 *
 *   * hand-write a JavaScript copy of the rules — rejected outright, because
 *     two copies of a safety policy WILL drift, and the one that drifts is the
 *     one nobody is testing;
 *   * add a build step to `@mac/protocol` — works, but makes every coding run
 *     and every test depend on a build having been run first;
 *   * transpile the single, import-free policy module at shim-build time with
 *     the TypeScript compiler API — one source of truth, no build step, and the
 *     transpile is a type-erasure only.
 *
 * `git-policy.ts` deliberately has NO imports, which is what makes the emitted
 * file self-contained. If that ever changes, this throws rather than silently
 * emitting a module that cannot load — and a shim that cannot load fails
 * closed, refusing every git invocation.
 */
async function emitPolicyModule(): Promise<string> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const source = path.resolve(here, '../../../../packages/protocol/src/git-policy.ts');
  const code = await fs.readFile(source, 'utf8');

  if (/^\s*import\s/m.test(code)) {
    throw new Error(
      'git-policy.ts has acquired an import. The git shim requires it to stay self-contained ' +
        'so it can be transpiled into a standalone module for the guard process.',
    );
  }

  let ts: typeof import('typescript');
  try {
    ts = (await import('typescript')).default ?? (await import('typescript'));
  } catch {
    throw new Error(
      'The TypeScript compiler is required to build the git shim, and it is not installed on this worker. ' +
        'Mac will not run a coding agent without the git safety shim in place.',
    );
  }

  const result = ts.transpileModule(code, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2022,
      removeComments: false,
    },
    fileName: 'git-policy.ts',
  });

  return `// GENERATED from packages/protocol/src/git-policy.ts by apps/worker/src/git/shim.ts.\n// Do not edit: edit the TypeScript source, which is the single definition of these rules.\n\n${result.outputText}`;
}

/**
 * The guard script's source.
 *
 * A standalone ESM file, because it runs in a fresh Node process spawned by a
 * shell script and must not depend on the worker's module resolution or its
 * node_modules. It imports the emitted policy module by absolute path.
 */
function guardSource(policyModule: string): string {
  return `#!/usr/bin/env node
// GENERATED by apps/worker/src/git/shim.ts — do not edit.
//
// Mac Bennett git guard. Validates every git invocation made by a coding agent
// against the shared hard-safety policy, then execs the real git.
//
// FAILS CLOSED: if the policy cannot be loaded, the invocation is refused.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';

const EXIT_REFUSED = 77;

const [, , policyPath, ...argv] = process.argv;

function loadPolicyFile() {
  try {
    return JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  } catch (err) {
    process.stderr.write('mac-git-guard: cannot read policy file: ' + err.message + '\\n');
    process.exit(EXIT_REFUSED);
  }
}

const policy = loadPolicyFile();

function recordViolation(code, message) {
  try {
    fs.appendFileSync(
      policy.violationsFile,
      JSON.stringify({ code, argv, message, at: new Date().toISOString() }) + '\\n',
      'utf8',
    );
  } catch {
    // Recording is best effort; the refusal itself is not.
  }
}

let checkGitCommand;
try {
  const mod = await import(pathToFileURL(${JSON.stringify(policyModule)}).href);
  checkGitCommand = mod.checkGitCommand;
} catch (err) {
  process.stderr.write('mac-git-guard: policy module failed to load: ' + err.message + '\\n');
  checkGitCommand = null;
}

if (typeof checkGitCommand !== 'function') {
  // Fail CLOSED. A shim that cannot evaluate the policy must refuse, not allow.
  const message =
    'The git safety policy could not be loaded, so this git invocation is refused. ' +
    'Mac never runs git without policy enforcement.';
  recordViolation('POLICY_UNAVAILABLE', message);
  process.stderr.write('mac-git-guard: ' + message + '\\n');
  process.exit(EXIT_REFUSED);
}

const verdict = checkGitCommand(argv, policy);

if (!verdict.allowed) {
  recordViolation(verdict.code, verdict.message);
  process.stderr.write(
    'mac-git-guard: REFUSED (' + verdict.code + ')\\n' +
      '  git ' + argv.join(' ') + '\\n' +
      '  ' + verdict.message + '\\n' +
      '  This is a hard safety rule enforced by Mac Bennett and cannot be overridden.\\n',
  );
  process.exit(EXIT_REFUSED);
}

const child = spawn(policy.realGitPath, argv, { stdio: 'inherit', shell: false });
child.on('error', (err) => {
  process.stderr.write('mac-git-guard: could not execute git: ' + err.message + '\\n');
  process.exit(EXIT_REFUSED);
});
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
`;
}

/**
 * Where the real git lives.
 *
 * Resolved ONCE, before the shim is installed, and baked into the policy file.
 * Looking it up from PATH at call time would find the shim itself.
 */
export async function resolveRealGit(): Promise<string> {
  const { execFile } = await import('node:child_process');
  const which = process.platform === 'win32' ? 'where' : 'which';

  return new Promise<string>((resolve, reject) => {
    execFile(which, ['git'], { shell: false, windowsHide: true }, (error, stdout) => {
      if (error) {
        reject(new Error('git is not installed or not on PATH on this worker.'));
        return;
      }
      const first = String(stdout).split(/\r?\n/).map((l) => l.trim()).filter(Boolean)[0];
      if (!first) {
        reject(new Error('Could not determine the path of the git binary.'));
        return;
      }
      resolve(first);
    });
  });
}
