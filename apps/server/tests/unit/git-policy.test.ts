import { describe, expect, it } from 'vitest';
import {
  buildTaskBranchName,
  checkGitCommand,
  isSafeBranchName,
  normaliseBranchRef,
  refspecDestination,
  slugify,
  type GitPolicyContext,
} from '@mac/protocol';

/**
 * The hard Git safety rules (Sprint 2 §2).
 *
 * These tests are the specification's prohibitions written as executable
 * assertions. If any of them ever goes red, Mac can merge to main.
 */

/** The coding agent's context: it may never push, and it works on a task branch. */
const agent = (overrides: Partial<GitPolicyContext> = {}): GitPolicyContext => ({
  defaultBranch: 'main',
  currentBranch: 'mac/247-multi-device-selection',
  allowPush: false,
  ...overrides,
});

/** Mac's own context: he may push, but only into his own namespace. */
const mac = (overrides: Partial<GitPolicyContext> = {}): GitPolicyContext => ({
  defaultBranch: 'main',
  currentBranch: 'mac/247-multi-device-selection',
  allowPush: true,
  ...overrides,
});

const expectDenied = (argv: string[], ctx: GitPolicyContext, code: string) => {
  const verdict = checkGitCommand(argv, ctx);
  expect(verdict.allowed, `expected "git ${argv.join(' ')}" to be REFUSED`).toBe(false);
  if (!verdict.allowed) expect(verdict.code).toBe(code);
};

const expectAllowed = (argv: string[], ctx: GitPolicyContext) => {
  const verdict = checkGitCommand(argv, ctx);
  expect(verdict.allowed, `expected "git ${argv.join(' ')}" to be ALLOWED, got: ${verdict.allowed ? '' : verdict.message}`).toBe(true);
};

describe('git policy — merge into the default branch', () => {
  it('refuses a merge while the default branch is checked out', () => {
    expectDenied(['merge', 'mac/247-feature'], agent({ currentBranch: 'main' }), 'MERGE_INTO_DEFAULT');
  });

  it('refuses a pull while the default branch is checked out', () => {
    expectDenied(['pull', 'origin', 'mac/247-feature'], agent({ currentBranch: 'main' }), 'MERGE_INTO_DEFAULT');
  });

  it('refuses a merge when the checked-out branch cannot be established', () => {
    // The single most important prohibition in the spec must not rest on an
    // optimistic assumption about unknown state.
    expectDenied(['merge', 'something'], agent({ currentBranch: null }), 'MERGE_INTO_DEFAULT');
  });

  it('allows merging the default branch INTO a task branch, which is the safe direction', () => {
    expectAllowed(['merge', 'origin/main'], agent());
  });
});

describe('git policy — push to the default branch', () => {
  it('refuses an explicit push to the default branch', () => {
    expectDenied(['push', 'origin', 'main'], mac(), 'PUSH_TO_DEFAULT');
  });

  it('refuses a push whose destination side of the refspec is the default branch', () => {
    expectDenied(['push', 'origin', 'HEAD:main'], mac(), 'PUSH_TO_DEFAULT');
    expectDenied(['push', 'origin', 'mac/247-x:main'], mac(), 'PUSH_TO_DEFAULT');
    expectDenied(['push', 'origin', 'mac/247-x:refs/heads/main'], mac(), 'PUSH_TO_DEFAULT');
  });

  it('refuses a push to a remote-tracking form of the default branch', () => {
    expectDenied(['push', 'origin', 'HEAD:origin/main'], mac(), 'PUSH_TO_DEFAULT');
  });

  it('refuses a bare push, which may target the default branch implicitly', () => {
    expectDenied(['push'], mac(), 'PUSH_TO_DEFAULT');
    expectDenied(['push', 'origin'], mac(), 'PUSH_TO_DEFAULT');
  });

  it('refuses a push whose destination is HEAD', () => {
    expectDenied(['push', 'origin', 'HEAD'], mac(), 'PUSH_TO_DEFAULT');
  });

  it('refuses a push outside the mac/ namespace even when it is not the default branch', () => {
    expectDenied(['push', 'origin', 'feature/someone-elses-branch'], mac(), 'PUSH_TO_DEFAULT');
  });

  it('allows Mac to push his own task branch', () => {
    expectAllowed(['push', '--set-upstream', 'origin', 'mac/247-multi-device-selection'], mac());
  });

  it('refuses ALL pushes from the coding agent, whatever the destination', () => {
    // The strongest available rule is not "police the agent's pushes" but
    // "the agent has no push capability at all".
    expectDenied(['push', 'origin', 'mac/247-multi-device-selection'], agent(), 'PUSH_NOT_PERMITTED');
  });
});

describe('git policy — force push', () => {
  it.each([
    ['-f'],
    ['--force'],
    ['--force-with-lease'],
    ['--force-with-lease=main'],
    ['--force-if-includes'],
    ['--mirror'],
  ])('refuses git push %s', (flag) => {
    expectDenied(['push', flag, 'origin', 'mac/247-x'], mac(), 'FORCE_PUSH');
  });

  it('refuses a refspec whose leading + forces the update', () => {
    expectDenied(['push', 'origin', '+mac/247-x:mac/247-x'], mac(), 'FORCE_PUSH');
  });
});

describe('git policy — deleting the default branch', () => {
  it('refuses push --delete of the default branch', () => {
    expectDenied(['push', '--delete', 'origin', 'main'], mac(), 'DELETE_DEFAULT_BRANCH');
  });

  it('refuses the empty-source deletion refspec', () => {
    expectDenied(['push', 'origin', ':main'], mac(), 'DELETE_DEFAULT_BRANCH');
  });

  it('refuses branch -D of the default branch', () => {
    expectDenied(['branch', '-D', 'main'], agent(), 'DELETE_DEFAULT_BRANCH');
    expectDenied(['branch', '-d', 'main'], agent(), 'DELETE_DEFAULT_BRANCH');
  });

  it('refuses deleting any branch by push, even a task branch', () => {
    expectDenied(['push', '--delete', 'origin', 'mac/247-x'], mac(), 'DELETE_DEFAULT_BRANCH');
  });
});

describe('git policy — bypassing branch protection', () => {
  it('refuses push --no-verify', () => {
    expectDenied(['push', '--no-verify', 'origin', 'mac/247-x'], mac(), 'BYPASS_BRANCH_PROTECTION');
  });

  it('refuses a receive.* config override', () => {
    expectDenied(['-c', 'receive.denyNonFastForwards=false', 'push', 'origin', 'mac/247-x'], mac(), 'BYPASS_BRANCH_PROTECTION');
  });

  it('refuses overriding the credential helper or hooks path', () => {
    expectDenied(['-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'x'], agent(), 'BYPASS_BRANCH_PROTECTION');
    expectDenied(['-c', 'credential.helper=evil', 'fetch'], agent(), 'BYPASS_BRANCH_PROTECTION');
  });

  it('allows Claude Code to disable hooks only for read-only inspection', () => {
    expectAllowed(['-c', 'core.hooksPath=/dev/null', 'remote', 'get-url', 'origin'], agent());
    expectAllowed(['-c', 'core.hooksPath=/dev/null', 'config', '--get', 'user.email'], agent());
    expectAllowed([
      '-c',
      'core.quotePath=false',
      '-c',
      'core.hooksPath=/dev/null',
      'log',
      '--since=7.days',
      '--name-only',
      '--format=oneline',
    ], agent());
    expectAllowed([
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=',
      '-C',
      '/tmp/task-worktree',
      'ls-files',
      '--error-unmatch',
      '--',
      ':(icase).claude/settings.local.json',
    ], agent());
    expectAllowed([
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=',
      '-C',
      '/tmp/repository',
      'worktree',
      'list',
      '--porcelain',
    ], agent());
  });

  it('allows -C only for exact read-only inspection forms', () => {
    expectAllowed(['-C', '/tmp/task-worktree', 'status', '--short'], agent());
    expectDenied(['-C', '/tmp/other-repository', 'commit', '-m', 'escape'], agent(), 'UNSAFE_ARGUMENT');
    expectDenied(['-C', '/tmp/other-repository', 'worktree', 'remove', '/tmp/task'], agent(), 'UNSAFE_ARGUMENT');
  });

  it('allows Claude Code\'s exact hardened SSH override only while cloning plugins', () => {
    const safe = 'core.sshCommand=ssh -o BatchMode=yes -o StrictHostKeyChecking=yes';
    expectAllowed([
      '-c',
      safe,
      'clone',
      '--depth',
      '1',
      '--no-checkout',
      '--',
      'https://github.com/obra/superpowers.git',
      '/tmp/plugin',
    ], agent());
    expectDenied(['-c', safe, 'fetch', 'origin'], agent(), 'BYPASS_BRANCH_PROTECTION');
    expectDenied(
      ['-c', 'core.sshCommand=ssh -o StrictHostKeyChecking=no', 'clone', 'https://example.test/repo.git'],
      agent(),
      'BYPASS_BRANCH_PROTECTION',
    );
  });

  it('refuses --receive-pack and --exec', () => {
    expectDenied(['push', '--receive-pack=evil', 'origin', 'mac/247-x'], mac(), 'BYPASS_BRANCH_PROTECTION');
  });

  it('refuses --git-dir and --work-tree, which retarget the repository entirely', () => {
    expectDenied(['--git-dir=/elsewhere/.git', 'commit', '-m', 'x'], agent(), 'UNSAFE_ARGUMENT');
    expectDenied(['--work-tree=/elsewhere', 'checkout', '.'], agent(), 'UNSAFE_ARGUMENT');
  });
});

describe('git policy — rewriting shared history', () => {
  it.each([['filter-branch'], ['filter-repo'], ['replace'], ['reflog']])('refuses git %s outright', (sub) => {
    expectDenied([sub], agent(), 'REWRITE_SHARED_HISTORY');
  });

  it('refuses reset --hard while on the default branch', () => {
    expectDenied(['reset', '--hard', 'HEAD~5'], agent({ currentBranch: 'main' }), 'REWRITE_SHARED_HISTORY');
  });

  it('allows reset --hard on a task branch, which is Mac\'s own unpublished work', () => {
    expectAllowed(['reset', '--hard', 'HEAD~1'], agent());
  });

  it('refuses update-ref and symbolic-ref against the default branch', () => {
    expectDenied(['update-ref', 'refs/heads/main', 'deadbeef'], agent(), 'REWRITE_SHARED_HISTORY');
    expectDenied(['symbolic-ref', 'HEAD', 'refs/heads/main'], agent(), 'REWRITE_SHARED_HISTORY');
  });

  it('refuses rebasing while on the default branch', () => {
    expectDenied(['rebase', 'origin/main'], agent({ currentBranch: 'main' }), 'REWRITE_SHARED_HISTORY');
  });

  it('refuses interactive rebase, which cannot run unattended', () => {
    expectDenied(['rebase', '-i', 'HEAD~3'], agent(), 'UNSAFE_ARGUMENT');
  });

  it('refuses branch -M onto the default branch', () => {
    expectDenied(['branch', '-M', 'main'], agent(), 'REWRITE_SHARED_HISTORY');
  });

  it('refuses gc --prune', () => {
    expectDenied(['gc', '--prune=now'], agent(), 'REWRITE_SHARED_HISTORY');
  });
});

describe('git policy — checking out the default branch inside a task worktree', () => {
  it('refuses checking out the default branch', () => {
    expectDenied(['checkout', 'main'], agent(), 'PUSH_TO_DEFAULT');
    expectDenied(['switch', 'main'], agent(), 'PUSH_TO_DEFAULT');
  });

  it('refuses creating or resetting a branch named like the default branch', () => {
    expectDenied(['checkout', '-B', 'main'], agent(), 'REWRITE_SHARED_HISTORY');
    expectDenied(['switch', '-c', 'main'], agent(), 'REWRITE_SHARED_HISTORY');
  });

  it('allows creating a task branch', () => {
    expectAllowed(['switch', '-c', 'mac/247-multi-device-selection'], agent());
  });
});

describe('git policy — the ordinary operations Mac actually needs', () => {
  it.each([
    [['status', '--porcelain']],
    [['add', '-A']],
    [['commit', '-m', 'feat: add multi-device selection']],
    [['diff', '--stat', 'origin/main...HEAD']],
    [['rev-list', '--count', 'origin/main..HEAD']],
    [['log', '--oneline', '-20']],
    [['fetch', '--prune', 'origin']],
    [['worktree', 'add', '--detach', '/workspace/wt', 'abc123']],
    [['worktree', 'remove', '/workspace/wt']],
    [['rev-parse', 'HEAD']],
    [['show', '--stat', 'HEAD']],
  ])('allows %j', (argv) => {
    expectAllowed(argv as string[], agent());
  });

  it('is not merely a deny-everything policy', () => {
    // Guards against a future "return deny() unconditionally" regression that
    // would make every test above pass for the wrong reason.
    const allowed = [['status'], ['add', '.'], ['commit', '-m', 'x'], ['log']].filter(
      (argv) => checkGitCommand(argv, agent()).allowed,
    );
    expect(allowed).toHaveLength(4);
  });
});

describe('git policy — a non-default default branch', () => {
  it('protects whatever the repository says its default branch is', () => {
    const ctx = agent({ defaultBranch: 'develop', currentBranch: 'mac/9-x', allowPush: true });
    expectDenied(['push', 'origin', 'develop'], ctx, 'PUSH_TO_DEFAULT');
    expectDenied(['branch', '-D', 'develop'], ctx, 'DELETE_DEFAULT_BRANCH');
    // ...and does NOT protect a branch merely because it is called `main`.
    expectAllowed(['branch', '-D', 'main'], ctx);
  });
});

describe('refspec parsing', () => {
  it('extracts the destination side', () => {
    expect(refspecDestination('main')).toEqual({ destination: 'main', forced: false });
    expect(refspecDestination('HEAD:main')).toEqual({ destination: 'main', forced: false });
    expect(refspecDestination('+a:b')).toEqual({ destination: 'b', forced: true });
    expect(refspecDestination(':main')).toEqual({ destination: 'main', forced: false });
  });

  it('normalises ref forms', () => {
    expect(normaliseBranchRef('refs/heads/main')).toBe('main');
    expect(normaliseBranchRef('heads/main')).toBe('main');
    expect(normaliseBranchRef('main')).toBe('main');
  });
});

describe('branch naming', () => {
  it('produces the format the specification gives as an example', () => {
    expect(buildTaskBranchName({ taskRef: 247, title: 'Multi device selection' })).toBe('mac/247-multi-device-selection');
  });

  it('cannot produce a branch name that would be read as a flag', () => {
    // A task titled like an option must not become an argv flag.
    const name = buildTaskBranchName({ taskRef: '--force', title: '--force-with-lease; rm -rf /' });
    expect(name.startsWith('mac/')).toBe(true);
    expect(name).not.toContain(' ');
    expect(name).not.toContain(';');
    expect(isSafeBranchName(name)).toBe(true);
  });

  it('bounds length and strips anything outside [a-z0-9-]', () => {
    const name = buildTaskBranchName({ taskRef: 12, title: 'A'.repeat(400) + ' ☃ éclair' });
    expect(name.length).toBeLessThanOrEqual(80);
    expect(isSafeBranchName(name)).toBe(true);
  });

  it('rejects unsafe branch names outright', () => {
    expect(isSafeBranchName('main')).toBe(false);
    expect(isSafeBranchName('mac/../../etc/passwd')).toBe(false);
    expect(isSafeBranchName('mac/x.lock')).toBe(false);
    expect(isSafeBranchName('mac/a b')).toBe(false);
    expect(isSafeBranchName('-mac/x')).toBe(false);
  });

  it('slugifies predictably', () => {
    expect(slugify('Add Multi-Device Selection!')).toBe('add-multi-device-selection');
    expect(slugify('   ')).toBe('');
  });
});
