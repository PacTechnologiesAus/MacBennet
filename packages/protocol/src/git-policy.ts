/**
 * The hard Git safety rules (Sprint 2 §2).
 *
 * This module is the single definition of what Mac — and any coding agent
 * working on his behalf — is forbidden to do with git. It is deliberately:
 *
 *   * PURE. No filesystem, no process, no I/O. It classifies an argv array and
 *     nothing else, so every rule below is directly unit-testable.
 *   * SHARED. The control plane, the worker's GitRunner and the `git` shim that
 *     is placed on the coding agent's PATH all import THIS file. Three
 *     independent enforcement layers cannot drift apart, because there is only
 *     one set of rules.
 *   * ARGV-BASED. Nothing here ever sees a command *string*. Commands are
 *     spawned with an argv array and `shell: false`, so there is no quoting,
 *     no metacharacter, and no injection surface to reason about.
 *
 * The prohibitions are NOT configurable in V1. There is no settings column, no
 * environment variable and no parameter that relaxes them, because spec §14
 * states the merge prohibition as an absolute and the remainder protect the
 * same property.
 */

/** Machine-readable reason a git invocation was refused. */
export const GIT_VIOLATION_CODES = [
  'MERGE_INTO_DEFAULT',
  'PUSH_TO_DEFAULT',
  'FORCE_PUSH',
  'DELETE_DEFAULT_BRANCH',
  'BYPASS_BRANCH_PROTECTION',
  'REWRITE_SHARED_HISTORY',
  'PUSH_NOT_PERMITTED',
  'UNSAFE_ARGUMENT',
  'UNKNOWN_SUBCOMMAND',
] as const;
export type GitViolationCode = (typeof GIT_VIOLATION_CODES)[number];

export interface GitPolicyContext {
  /** The repository's default branch, e.g. `main`. Compared case-sensitively, as git does. */
  defaultBranch: string;
  /** Branch currently checked out in the worktree, if known. */
  currentBranch?: string | null;
  /**
   * Whether the caller is permitted to push at all.
   *
   * Mac himself pushes task branches (`false` → refused outright is wrong for him),
   * whereas the coding agent may never push. This is the ONLY axis on which the
   * policy varies, and it only ever *removes* permission.
   */
  allowPush?: boolean;
  /** Prefix every pushable branch must carry. Defaults to Mac's namespace. */
  taskBranchPrefix?: string;
}

export type GitPolicyVerdict =
  | { allowed: true }
  | { allowed: false; code: GitViolationCode; message: string };

const ALLOWED: GitPolicyVerdict = { allowed: true };

const deny = (code: GitViolationCode, message: string): GitPolicyVerdict => ({
  allowed: false,
  code,
  message,
});

export const DEFAULT_TASK_BRANCH_PREFIX = 'mac/';

/**
 * Subcommands that rewrite history or move refs in ways that are never
 * appropriate for autonomous work, whatever their arguments.
 */
const ALWAYS_PROHIBITED_SUBCOMMANDS = new Set([
  'filter-branch',
  'filter-repo',
  'replace',
  'reflog', // `reflog delete`/`expire` destroys the very evidence layer 3 relies on
]);

/**
 * Refspec destinations that mean "whatever HEAD is", which we cannot prove is
 * not the default branch without resolving it — so we treat them conservatively.
 */
const IMPLICIT_DESTINATIONS = new Set(['HEAD', '@']);

/** Strips a leading `+` (force marker) and returns the destination side of a refspec. */
export function refspecDestination(refspec: string): { destination: string; forced: boolean } {
  const forced = refspec.startsWith('+');
  const spec = forced ? refspec.slice(1) : refspec;
  const colon = spec.indexOf(':');
  // `git push origin :main` deletes main. `git push origin main` pushes main to main.
  const destination = colon === -1 ? spec : spec.slice(colon + 1);
  return { destination, forced };
}

/** Normalises `refs/heads/main`, `heads/main` and `main` to `main`. */
export function normaliseBranchRef(ref: string): string {
  return ref.replace(/^refs\/heads\//, '').replace(/^heads\//, '');
}

const isDefaultBranchRef = (ref: string, defaultBranch: string): boolean => {
  const branch = normaliseBranchRef(ref.trim());
  if (branch === defaultBranch) return true;
  // Remote-tracking forms: origin/main, refs/remotes/origin/main
  const remoteStripped = branch.replace(/^refs\/remotes\//, '');
  const segments = remoteStripped.split('/');
  return segments.length === 2 && segments[1] === defaultBranch;
};

/**
 * Classifies a complete git argv (NOT including the `git` executable itself).
 *
 * Returns `allowed` only when the invocation is provably safe. Anything the
 * policy cannot understand is refused: for a rule whose whole purpose is to
 * prevent an irreversible mistake, "I am not sure" must mean no.
 */
export function checkGitCommand(argv: readonly string[], context: GitPolicyContext): GitPolicyVerdict {
  const defaultBranch = context.defaultBranch;
  const prefix = context.taskBranchPrefix ?? DEFAULT_TASK_BRANCH_PREFIX;

  // Global options may appear before the subcommand (`git -c foo=bar push ...`),
  // and `-c` is itself a branch-protection bypass vector.
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index]!;
    if (arg === '-c' || arg === '--config-env') {
      const setting = argv[index + 1] ?? '';
      const bypass = checkConfigOverride(setting);
      if (bypass) return bypass;
      index += 2;
      continue;
    }
    if (arg.startsWith('-')) {
      // `--git-dir`/`--work-tree` can retarget the operation at another
      // repository entirely, defeating every path containment guarantee.
      if (arg.startsWith('--git-dir') || arg.startsWith('--work-tree') || arg.startsWith('--namespace')) {
        return deny('UNSAFE_ARGUMENT', `Global option "${arg}" may retarget the repository and is not permitted.`);
      }
      index += 1;
      continue;
    }
    break;
  }

  const subcommand = argv[index];
  if (!subcommand) return deny('UNKNOWN_SUBCOMMAND', 'No git subcommand supplied.');
  const rest = argv.slice(index + 1);

  if (ALWAYS_PROHIBITED_SUBCOMMANDS.has(subcommand)) {
    return deny('REWRITE_SHARED_HISTORY', `"git ${subcommand}" rewrites or destroys history and is never permitted.`);
  }

  switch (subcommand) {
    case 'push':
      return checkPush(rest, { defaultBranch, prefix, allowPush: context.allowPush ?? false });
    case 'merge':
    case 'pull':
      return checkMerge(subcommand, rest, context);
    case 'rebase':
      return checkRebase(rest, context);
    case 'branch':
      return checkBranch(rest, defaultBranch);
    case 'reset':
      return checkReset(rest, context);
    case 'update-ref':
    case 'symbolic-ref':
      return checkRefWrite(subcommand, rest, defaultBranch);
    case 'checkout':
    case 'switch':
      return checkCheckout(rest, defaultBranch);
    case 'gc':
      return rest.some((a) => a.startsWith('--prune'))
        ? deny('REWRITE_SHARED_HISTORY', '"git gc --prune" may destroy unreferenced work and is not permitted.')
        : ALLOWED;
    default:
      return ALLOWED;
  }
}

// ---------------------------------------------------------------------------
// push
// ---------------------------------------------------------------------------

function checkPush(
  args: readonly string[],
  ctx: { defaultBranch: string; prefix: string; allowPush: boolean },
): GitPolicyVerdict {
  // Force detection first: a force push is prohibited regardless of destination,
  // because "force push to my own branch" is exactly how shared history is lost
  // when the branch turns out not to be as private as assumed.
  for (const arg of args) {
    if (
      arg === '-f' ||
      arg === '--force' ||
      arg === '--force-with-lease' ||
      arg.startsWith('--force-with-lease=') ||
      arg === '--force-if-includes' ||
      arg === '--mirror'
    ) {
      return deny('FORCE_PUSH', `"git push ${arg}" is prohibited: Mac may never force-push or mirror.`);
    }
    if (arg === '--no-verify') {
      return deny('BYPASS_BRANCH_PROTECTION', '"git push --no-verify" bypasses hooks and is prohibited.');
    }
    if (arg === '--exec' || arg.startsWith('--exec=') || arg.startsWith('--receive-pack')) {
      return deny('BYPASS_BRANCH_PROTECTION', `"git push ${arg}" can override server-side checks and is prohibited.`);
    }
  }

  const deleteRequested = args.includes('--delete') || args.includes('-d');

  // Positional arguments after the flags: [remote] [refspec...]
  const positionals = args.filter((a) => !a.startsWith('-'));
  const refspecs = positionals.slice(1);

  for (const refspec of refspecs) {
    const { destination, forced } = refspecDestination(refspec);

    if (forced) {
      return deny('FORCE_PUSH', `Refspec "${refspec}" carries a leading '+', which forces the update.`);
    }

    // `git push origin :main` — an empty source deletes the destination.
    const isDeletion = deleteRequested || refspec.startsWith(':');
    if (isDeletion && isDefaultBranchRef(destination, ctx.defaultBranch)) {
      return deny('DELETE_DEFAULT_BRANCH', `Deleting the default branch "${ctx.defaultBranch}" is prohibited.`);
    }

    if (isDefaultBranchRef(destination, ctx.defaultBranch)) {
      return deny('PUSH_TO_DEFAULT', `Pushing to the default branch "${ctx.defaultBranch}" is prohibited.`);
    }

    if (IMPLICIT_DESTINATIONS.has(destination)) {
      return deny(
        'PUSH_TO_DEFAULT',
        `Refspec "${refspec}" resolves to whatever HEAD is; an explicit ${ctx.prefix}* destination is required.`,
      );
    }
  }

  if (!ctx.allowPush) {
    return deny(
      'PUSH_NOT_PERMITTED',
      'Pushing is not permitted from this context. Mac pushes task branches himself after review.',
    );
  }

  if (deleteRequested) {
    return deny('DELETE_DEFAULT_BRANCH', 'Branch deletion by push is not permitted.');
  }

  // A push with no refspec pushes the current branch under the default
  // push policy — which, on the default branch, is a push to the default branch.
  if (refspecs.length === 0) {
    return deny(
      'PUSH_TO_DEFAULT',
      'A push with no explicit refspec may target the default branch. Name the task branch explicitly.',
    );
  }

  // Positive rule: Mac may only ever push into his own namespace.
  for (const refspec of refspecs) {
    const { destination } = refspecDestination(refspec);
    if (!normaliseBranchRef(destination).startsWith(ctx.prefix)) {
      return deny(
        'PUSH_TO_DEFAULT',
        `Destination "${destination}" is outside the "${ctx.prefix}*" namespace. Mac may only push his own task branches.`,
      );
    }
  }

  return ALLOWED;
}

// ---------------------------------------------------------------------------
// merge / pull / rebase
// ---------------------------------------------------------------------------

function checkMerge(
  subcommand: string,
  args: readonly string[],
  context: GitPolicyContext,
): GitPolicyVerdict {
  // Merging INTO the default branch means the default branch is checked out.
  if (context.currentBranch && context.currentBranch === context.defaultBranch) {
    return deny(
      'MERGE_INTO_DEFAULT',
      `"git ${subcommand}" while the default branch "${context.defaultBranch}" is checked out would merge into it. Prohibited.`,
    );
  }
  // If we cannot prove which branch is checked out, refuse: this is the single
  // most important prohibition in the specification and must not depend on an
  // optimistic assumption.
  if (!context.currentBranch) {
    return deny(
      'MERGE_INTO_DEFAULT',
      `"git ${subcommand}" is refused because the checked-out branch could not be established.`,
    );
  }
  return ALLOWED;
}

function checkRebase(args: readonly string[], context: GitPolicyContext): GitPolicyVerdict {
  if (context.currentBranch && context.currentBranch === context.defaultBranch) {
    return deny(
      'REWRITE_SHARED_HISTORY',
      `Rebasing while on the default branch "${context.defaultBranch}" rewrites shared history. Prohibited.`,
    );
  }
  // `git rebase --onto main` and friends rewrite the task branch, which is
  // Mac's own and unpublished until he pushes it — but `-i` is an interactive
  // editor that cannot work unattended and would hang the session.
  if (args.includes('-i') || args.includes('--interactive')) {
    return deny('UNSAFE_ARGUMENT', 'Interactive rebase cannot run unattended.');
  }
  return ALLOWED;
}

// ---------------------------------------------------------------------------
// branch / reset / ref writes / checkout
// ---------------------------------------------------------------------------

function checkBranch(args: readonly string[], defaultBranch: string): GitPolicyVerdict {
  const deleting = args.some((a) => a === '-d' || a === '-D' || a === '--delete');
  const forcing = args.some((a) => a === '-M' || a === '-f' || a === '--force');
  const targets = args.filter((a) => !a.startsWith('-'));

  if (deleting && targets.some((t) => isDefaultBranchRef(t, defaultBranch))) {
    return deny('DELETE_DEFAULT_BRANCH', `Deleting the default branch "${defaultBranch}" is prohibited.`);
  }
  if (forcing && targets.some((t) => isDefaultBranchRef(t, defaultBranch))) {
    return deny(
      'REWRITE_SHARED_HISTORY',
      `Force-moving the default branch "${defaultBranch}" is prohibited.`,
    );
  }
  return ALLOWED;
}

function checkReset(args: readonly string[], context: GitPolicyContext): GitPolicyVerdict {
  const hard = args.includes('--hard') || args.includes('--merge') || args.includes('--keep');
  if (!hard) return ALLOWED;
  if (context.currentBranch === context.defaultBranch) {
    return deny(
      'REWRITE_SHARED_HISTORY',
      `"git reset --hard" while on the default branch "${context.defaultBranch}" is prohibited.`,
    );
  }
  return ALLOWED;
}

function checkRefWrite(
  subcommand: string,
  args: readonly string[],
  defaultBranch: string,
): GitPolicyVerdict {
  const targets = args.filter((a) => !a.startsWith('-'));
  if (targets.some((t) => isDefaultBranchRef(t, defaultBranch))) {
    return deny(
      'REWRITE_SHARED_HISTORY',
      `"git ${subcommand}" targeting the default branch "${defaultBranch}" is prohibited.`,
    );
  }
  return ALLOWED;
}

/**
 * Checking the default branch OUT is not itself prohibited — inspection is
 * legitimate — but combined with a later commit it becomes a write to the
 * default branch, and the coding agent has no reason to need it. Refusing it
 * removes the precondition for a whole class of mistake.
 */
function checkCheckout(args: readonly string[], defaultBranch: string): GitPolicyVerdict {
  const creating = args.some((a) => a === '-b' || a === '-B' || a === '-c' || a === '-C');
  const targets = args.filter((a) => !a.startsWith('-'));

  if (creating && targets.some((t) => isDefaultBranchRef(t, defaultBranch))) {
    return deny(
      'REWRITE_SHARED_HISTORY',
      `Creating or resetting a branch named "${defaultBranch}" is prohibited.`,
    );
  }
  // A plain `git checkout main` in a worktree whose purpose is a task branch.
  if (!creating && targets.some((t) => isDefaultBranchRef(t, defaultBranch))) {
    return deny(
      'PUSH_TO_DEFAULT',
      `Checking out the default branch "${defaultBranch}" inside a task worktree is prohibited; work happens on the task branch.`,
    );
  }
  return ALLOWED;
}

// ---------------------------------------------------------------------------
// `-c key=value` overrides
// ---------------------------------------------------------------------------

const PROTECTED_CONFIG_PREFIXES = [
  'receive.',
  'http.',
  'url.',
  'core.hookspath',
  'core.sshcommand',
  'protocol.',
  'uploadpack.',
  'safe.',
  'credential.',
  'push.default',
];

function checkConfigOverride(setting: string): GitPolicyVerdict | null {
  const key = setting.split('=')[0]?.toLowerCase() ?? '';
  if (PROTECTED_CONFIG_PREFIXES.some((p) => key.startsWith(p))) {
    return deny(
      'BYPASS_BRANCH_PROTECTION',
      `Overriding git configuration "${key}" can bypass protection or redirect the remote, and is prohibited.`,
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Branch naming
// ---------------------------------------------------------------------------

/**
 * Builds Mac's task branch name: `mac/<taskRef>-<slug>`.
 *
 * A branch name becomes an argv value, so it is generated rather than accepted:
 * the charset is restricted to `[a-z0-9-]`, it can never begin with `-`, and it
 * is length-bounded. A title of `--force` cannot become a flag.
 */
export function buildTaskBranchName(params: {
  taskRef: string | number;
  title: string;
  prefix?: string;
  maxSlugLength?: number;
}): string {
  const prefix = params.prefix ?? DEFAULT_TASK_BRANCH_PREFIX;
  const ref = String(params.taskRef)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
    .slice(0, 24);
  const slug = slugify(params.title, params.maxSlugLength ?? 48);
  const tail = slug ? `${ref}-${slug}` : ref;
  return `${prefix}${tail || 'task'}`;
}

export function slugify(value: string, maxLength = 48): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
}

/**
 * Git's own refname rules, applied to a name we generated. Belt and braces: if
 * `buildTaskBranchName` is ever changed carelessly, this catches the result
 * before it reaches a command line.
 */
export function isSafeBranchName(name: string, prefix = DEFAULT_TASK_BRANCH_PREFIX): boolean {
  if (!name.startsWith(prefix)) return false;
  if (name.length > 200) return false;
  if (name.startsWith('-')) return false;
  if (!/^[A-Za-z0-9._\/-]+$/.test(name)) return false;
  if (name.includes('..') || name.includes('//') || name.endsWith('.lock') || name.endsWith('/')) return false;
  return true;
}
