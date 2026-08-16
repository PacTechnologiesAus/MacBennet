import fs from 'node:fs/promises';
import path from 'node:path';
import type { ProjectContextSnapshot, RunAssignment } from '@mac/protocol';
import type { ControlPlaneClient } from '../client.js';
import { GitRunner } from '../git/git-runner.js';
import { initialPolicy } from '../git/worktree.js';
import type { JobContext, JobResult } from './index.js';

/**
 * Read-only repository inspection — discovery Phase A (spec §4).
 *
 * This runs on the worker because the worker is what holds the clone, which
 * preserves the Sprint 1 property that the control plane never reaches into the
 * VM. It writes nothing, creates no branch, and makes no commit: the only git
 * operations it performs are a fetch and a series of reads.
 *
 * Its purpose is to let Mac answer his own questions before putting any to a
 * human. Every field it returns is one that gap analysis can use to mark a
 * completeness dimension as discoverable.
 */

const README_CANDIDATES = ['README.md', 'README.rst', 'README.txt', 'README', 'readme.md'];

const MANIFEST_FILES = ['package.json', 'pyproject.toml', 'go.mod', 'Cargo.toml', 'composer.json', 'pom.xml'];

const DOC_DIRECTORIES = ['docs', 'doc', 'documentation'];

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.ts': 'TypeScript', '.tsx': 'TypeScript', '.js': 'JavaScript', '.jsx': 'JavaScript',
  '.py': 'Python', '.go': 'Go', '.rs': 'Rust', '.java': 'Java', '.cs': 'C#',
  '.rb': 'Ruby', '.php': 'PHP', '.c': 'C', '.cpp': 'C++', '.h': 'C/C++',
  '.sql': 'SQL', '.sh': 'Shell', '.st': 'Structured Text', '.scl': 'Structured Text',
};

/** Directories never worth walking: large, generated, and uninformative. */
const SKIP_DIRECTORIES = new Set([
  '.git', 'node_modules', 'dist', 'build', 'out', 'target', 'vendor',
  '.next', '.nuxt', '.venv', 'venv', '__pycache__', 'coverage', '.turbo', '.cache',
]);

export async function runRepoInspectJob(
  assignment: RunAssignment,
  ctx: JobContext,
  deps: { client: ControlPlaneClient },
): Promise<JobResult> {
  const coding = assignment.coding;
  if (!coding) throw new Error('This inspection run has no repository assignment.');

  const params = (assignment.jobParams ?? {}) as { sinceSha?: string | null };

  const git = new GitRunner({
    cwd: coding.localPath,
    policy: initialPolicy(coding.defaultBranch, false),
    signal: ctx.signal,
  });

  await ctx.progress('fetching', 10);
  await git.run(['fetch', '--prune', coding.remoteName], { allowFailure: true });

  const headSha = (await git.revParse(`${coding.remoteName}/${coding.defaultBranch}`)) ?? (await git.revParse('HEAD')) ?? '';

  await ctx.progress('reading_branches', 25);
  const branches = (await git.run(['branch', '-r', '--format=%(refname:short)'], { allowFailure: true })).stdout
    .split('\n')
    .map((b) => b.trim())
    .filter(Boolean)
    .slice(0, 200);

  await ctx.progress('reading_history', 40);
  const recentCommits = parseCommits(
    (await git.run(['log', '--format=%H|%an|%aI|%s', '-30', headSha || 'HEAD'], { allowFailure: true })).stdout,
  );

  await ctx.progress('reading_files', 60);
  const tree = await walk(coding.localPath, coding.localPath, 0);

  const readme = await readFirst(coding.localPath, README_CANDIDATES);
  const manifests = await readManifests(coding.localPath, tree);

  const docFiles = tree.filter(
    (f) => DOC_DIRECTORIES.some((d) => f.startsWith(`${d}/`)) || /\.(md|rst|adoc)$/i.test(f),
  ).slice(0, 200);

  const testPaths = Array.from(
    new Set(
      tree
        .filter((f) => /(^|\/)(tests?|__tests__|spec|e2e)(\/|$)/i.test(f) || /\.(test|spec)\.[a-z]+$/i.test(f))
        .map((f) => path.dirname(f).split(path.sep).join('/')),
    ),
  ).slice(0, 200);

  const languageCounts = new Map<string, number>();
  for (const file of tree) {
    const language = LANGUAGE_BY_EXTENSION[path.extname(file).toLowerCase()];
    if (language) languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1);
  }
  const languages = [...languageCounts.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l).slice(0, 40);

  // "What changed since Mac last worked here" — the question spec §4 asks him
  // to answer for himself rather than putting to the human.
  let changedSinceLastInvolvement: ProjectContextSnapshot['changedSinceLastInvolvement'] = null;
  if (params.sinceSha) {
    await ctx.progress('comparing_since_last_run', 80);
    const range = `${params.sinceSha}..${headSha || 'HEAD'}`;
    const count = (await git.run(['rev-list', '--count', range], { allowFailure: true })).stdout.trim();
    const files = (await git.run(['diff', '--name-only', range], { allowFailure: true })).stdout
      .split('\n')
      .map((f) => f.trim())
      .filter(Boolean)
      .slice(0, 500);

    changedSinceLastInvolvement = {
      sinceSha: params.sinceSha,
      commitCount: Number.parseInt(count, 10) || 0,
      files,
    };
  }

  const snapshot: ProjectContextSnapshot = {
    repositoryId: coding.repositoryId,
    defaultBranch: coding.defaultBranch,
    headSha,
    branches,
    recentCommits,
    readme,
    docFiles,
    packageManifests: manifests,
    testPaths,
    languages,
    fileCount: tree.length,
    changedSinceLastInvolvement,
  };

  await ctx.progress('reporting', 95);
  await deps.client.reportContextSnapshot(assignment.runId, { snapshot });

  ctx.log(
    `Inspected ${tree.length} file(s) at ${headSha.slice(0, 8)}: ${languages.slice(0, 3).join('/') || 'unknown languages'}, ` +
      `${manifests.length} manifest(s), ${testPaths.length} test path(s), ${branches.length} branch(es).`,
    'system',
  );

  await ctx.progress('complete', 100);
  return { summary: `Inspected ${tree.length} file(s) across ${languages.length} language(s) at ${headSha.slice(0, 8)}.` };
}

/** Bounded walk: a repository inspection must not become an unbounded scan. */
async function walk(root: string, directory: string, depth: number, budget = { remaining: 20_000 }): Promise<string[]> {
  if (depth > 12 || budget.remaining <= 0) return [];

  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];

  for (const entry of entries) {
    if (budget.remaining <= 0) break;
    if (entry.name.startsWith('.') && entry.name !== '.github') continue;
    if (SKIP_DIRECTORIES.has(entry.name)) continue;

    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(root, full, depth + 1, budget)));
    } else if (entry.isFile()) {
      budget.remaining -= 1;
      files.push(path.relative(root, full).split(path.sep).join('/'));
    }
  }

  return files;
}

async function readFirst(root: string, candidates: string[]): Promise<string | null> {
  for (const candidate of candidates) {
    const content = await fs.readFile(path.join(root, candidate), 'utf8').catch(() => null);
    if (content !== null) return content.slice(0, 40_000);
  }
  return null;
}

async function readManifests(
  root: string,
  tree: string[],
): Promise<Array<{ path: string; name: string | null; scripts: string[] }>> {
  const found = tree.filter((f) => MANIFEST_FILES.includes(path.basename(f))).slice(0, 50);
  const manifests: Array<{ path: string; name: string | null; scripts: string[] }> = [];

  for (const file of found) {
    const raw = await fs.readFile(path.join(root, file), 'utf8').catch(() => null);
    if (raw === null) continue;

    if (path.basename(file) === 'package.json') {
      try {
        const parsed = JSON.parse(raw) as { name?: string; scripts?: Record<string, string> };
        manifests.push({
          path: file,
          name: parsed.name ?? null,
          scripts: Object.keys(parsed.scripts ?? {}).slice(0, 80),
        });
        continue;
      } catch {
        // A malformed manifest is worth recording as present, not worth failing on.
      }
    }
    manifests.push({ path: file, name: null, scripts: [] });
  }

  return manifests;
}

function parseCommits(stdout: string): ProjectContextSnapshot['recentCommits'] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sha = '', author = '', at = '', ...rest] = line.split('|');
      return {
        sha: sha.slice(0, 64),
        author: author.slice(0, 200),
        at: at || new Date().toISOString(),
        subject: rest.join('|').slice(0, 500),
      };
    })
    .slice(0, 100);
}
