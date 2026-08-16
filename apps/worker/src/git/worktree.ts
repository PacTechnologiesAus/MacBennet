import fs from 'node:fs/promises';
import path from 'node:path';
import { isSafeBranchName, type GitPolicyContext } from '@mac/protocol';
import { assertWithinWorkspace, GitRunner, type GitResult } from './git-runner.js';

/**
 * Per-run isolated worktrees (Sprint 2 §1).
 *
 * The lifecycle this implements, and the reason for its order:
 *
 *   fetch → resolve default branch → record base sha → worktree add (detached)
 *   → create task branch → ...work... → track commits → preserve or remove
 *
 * `worktree add --detach` followed by `switch -c` rather than
 * `worktree add -b <branch> <base>`: the detached step means the worktree
 * exists at a known commit before any branch is created, so if branch creation
 * fails there is no half-made branch pointing anywhere surprising — and the
 * recorded base sha is the sha the work actually started from.
 *
 * Preservation is the default. A worktree is removed only when a caller
 * explicitly says the work is finished and reviewable.
 */

export interface WorktreeSetup {
  path: string;
  branch: string;
  baseBranch: string;
  baseSha: string;
}

export interface PrepareWorktreeParams {
  repositoryPath: string;
  workspaceRoot: string;
  runId: string;
  branch: string;
  defaultBranch: string;
  remoteName: string;
  log: (message: string) => void;
}

export class WorktreeManager {
  constructor(private readonly git: GitRunner) {}

  /**
   * Brings the local clone up to date and creates the isolated worktree.
   *
   * The base is the REMOTE's default branch, not the local one: a local `main`
   * that has drifted would silently branch from stale code, and the whole point
   * of fetching first is to avoid that.
   */
  async prepare(params: PrepareWorktreeParams): Promise<WorktreeSetup> {
    if (!isSafeBranchName(params.branch)) {
      throw new Error(`Refusing to create unsafe branch name "${params.branch}".`);
    }

    const worktreePath = assertWithinWorkspace(
      path.join(params.workspaceRoot, 'worktrees', params.runId),
      params.workspaceRoot,
    );

    params.log(`Fetching ${params.remoteName}…`);
    await this.git.run(['fetch', '--prune', params.remoteName], { cwd: params.repositoryPath });

    const baseRef = `${params.remoteName}/${params.defaultBranch}`;
    const baseSha = await this.git.revParse(baseRef, params.repositoryPath);
    if (!baseSha) {
      throw new Error(
        `Could not resolve "${baseRef}". Check that the repository's configured default branch (${params.defaultBranch}) exists on the remote.`,
      );
    }
    params.log(`Base: ${baseRef} at ${baseSha.slice(0, 8)}.`);

    // A leftover worktree from an interrupted run would make `worktree add`
    // fail; pruning stale administrative entries is safe and touches no work.
    await this.git.run(['worktree', 'prune'], { cwd: params.repositoryPath, allowFailure: true });
    await fs.rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
    await fs.mkdir(path.dirname(worktreePath), { recursive: true });

    params.log(`Creating isolated worktree at ${worktreePath}…`);
    await this.git.run(['worktree', 'add', '--detach', worktreePath, baseSha], { cwd: params.repositoryPath });

    // Now that the worktree exists at a known commit, create the task branch.
    // The policy context is updated FIRST so the branch-creation call is
    // checked against the branch it is about to be on.
    this.git.setPolicy({ defaultBranch: params.defaultBranch, currentBranch: params.branch });
    await this.git.run(['switch', '-c', params.branch], { cwd: worktreePath });
    params.log(`Working on branch ${params.branch}.`);

    return { path: worktreePath, branch: params.branch, baseBranch: params.defaultBranch, baseSha };
  }

  /** Commits created during the run, i.e. everything the agent added. */
  async commitsSince(worktreePath: string, baseSha: string): Promise<Array<{ sha: string; subject: string }>> {
    // `%H %s` with a single space, split on the FIRST space only: a commit
    // subject may contain spaces, and a control-character separator does not
    // survive a round trip through every log viewer and transport intact.
    const result = await this.git.run(['log', '--format=%H %s', `${baseSha}..HEAD`], {
      cwd: worktreePath,
      allowFailure: true,
    });
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const space = line.indexOf(' ');
        const sha = space === -1 ? line : line.slice(0, space);
        const subject = space === -1 ? '' : line.slice(space + 1);
        return { sha: sha.slice(0, 64), subject: subject.slice(0, 500) };
      });
  }

  async headSha(worktreePath: string): Promise<string | null> {
    return this.git.revParse('HEAD', worktreePath);
  }

  /** Files changed against the base, with per-file line counts. */
  async changedFiles(
    worktreePath: string,
    baseSha: string,
  ): Promise<Array<{ path: string; status: string; insertions: number; deletions: number }>> {
    const numstat = await this.git.run(['diff', '--numstat', `${baseSha}...HEAD`], { cwd: worktreePath, allowFailure: true });
    const nameStatus = await this.git.run(['diff', '--name-status', `${baseSha}...HEAD`], { cwd: worktreePath, allowFailure: true });

    const statuses = new Map<string, string>();
    for (const line of nameStatus.stdout.split('\n')) {
      const [status, file] = line.trim().split(/\s+/);
      if (status && file) statuses.set(file, status);
    }

    return numstat.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [insertions, deletions, file] = line.split(/\s+/);
        return {
          path: file ?? '',
          status: statuses.get(file ?? '') ?? 'M',
          // Binary files report '-' rather than a count.
          insertions: Number.parseInt(insertions ?? '0', 10) || 0,
          deletions: Number.parseInt(deletions ?? '0', 10) || 0,
        };
      })
      .filter((f) => f.path);
  }

  /**
   * Files modified but never committed.
   *
   * Worth its own method because this is one of the commonest ways an
   * autonomous coding run silently loses work: the agent edits, declares
   * success, and the change never enters the branch.
   */
  async uncommittedFiles(worktreePath: string): Promise<string[]> {
    const result = await this.git.run(['status', '--porcelain'], { cwd: worktreePath, allowFailure: true });
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.replace(/^..\s+/, ''))
      .slice(0, 500);
  }

  async diffSample(worktreePath: string, baseSha: string, maxChars = 180_000): Promise<string> {
    const result = await this.git.run(['diff', `${baseSha}...HEAD`], { cwd: worktreePath, allowFailure: true });
    return result.stdout.length > maxChars ? `${result.stdout.slice(0, maxChars)}\n… [diff truncated]` : result.stdout;
  }

  /**
   * Layer 3 of the git safety design: verify the EFFECT, not just the attempt.
   *
   * Whatever mechanism a coding agent might have used — the shim, an absolute
   * path to git, a language binding — the default branch either moved or it did
   * not. This checks that directly, and it is the reason the safety argument
   * does not rest solely on intercepting commands.
   */
  async verifyDefaultBranchUnchanged(params: {
    repositoryPath: string;
    remoteName: string;
    defaultBranch: string;
    expectedSha: string;
  }): Promise<{ unchanged: boolean; actualSha: string | null }> {
    const localRemoteRef = await this.git.revParse(
      `${params.remoteName}/${params.defaultBranch}`,
      params.repositoryPath,
    );
    const localDefault = await this.git.revParse(params.defaultBranch, params.repositoryPath);

    // Both the remote-tracking ref and any local copy of the default branch
    // must still be where they were.
    const unchanged =
      localRemoteRef === params.expectedSha && (localDefault === null || localDefault === params.expectedSha);

    return { unchanged, actualSha: localRemoteRef };
  }

  /**
   * Pushes the task branch.
   *
   * The destination is constructed here, never passed in, and the policy
   * refuses anything outside `mac/*` — so there is no argument a caller could
   * supply that results in a push to the default branch.
   */
  async pushTaskBranch(params: {
    worktreePath: string;
    remoteName: string;
    branch: string;
  }): Promise<GitResult> {
    if (!isSafeBranchName(params.branch)) {
      throw new Error(`Refusing to push unsafe branch name "${params.branch}".`);
    }
    return this.git.run(
      ['push', '--set-upstream', params.remoteName, `${params.branch}:${params.branch}`],
      { cwd: params.worktreePath },
    );
  }

  /**
   * Removes the worktree. Called only when a caller has decided the work is
   * finished AND reviewable — everything else preserves.
   */
  async remove(repositoryPath: string, worktreePath: string): Promise<void> {
    await this.git.run(['worktree', 'remove', '--force', worktreePath], {
      cwd: repositoryPath,
      allowFailure: true,
    });
    await fs.rm(worktreePath, { recursive: true, force: true }).catch(() => undefined);
    await this.git.run(['worktree', 'prune'], { cwd: repositoryPath, allowFailure: true });
  }
}

/** Builds the policy context for a run, before the worktree exists. */
export const initialPolicy = (defaultBranch: string, allowPush: boolean): GitPolicyContext => ({
  defaultBranch,
  currentBranch: null,
  allowPush,
});
