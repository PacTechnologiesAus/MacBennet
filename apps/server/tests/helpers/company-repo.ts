import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * A real, local, throwaway Git repository standing in for
 * `PacTechnologiesAus/Company`.
 *
 * Local rather than mocked, because most of what is worth testing about the Git
 * provider IS Git: that a mirror clone works, that `remote update` picks up a
 * new commit, that an unreachable remote fails the way an unreachable remote
 * actually fails, and that a document is still readable at an OLD sha after the
 * branch has moved on. None of that exists in a fake.
 *
 * The document bodies below are trimmed but faithful to the real repository, so
 * a selection test asserting that a controls question pulls in the operating
 * model is asserting something about text PAC actually wrote.
 */

export const DEFAULT_MANIFEST = `schema_version: 1

organisation:
  name: PAC Technologies

context_version: 0.1.0

documents:
  mandatory:
    - COMPANY.md
    - VALUES.md
    - OPERATING_MODEL.md
    - SYSTEMS.md
    - AUTHORITY.md
    - AGENTS.md
    - GLOSSARY.md

precedence:
  - AUTHORITY.md
  - agent_specific_context
  - project_context
  - task_context

governance:
  agents_may_propose_changes: true
  agents_may_approve_changes: false
  human_review_required: true

refresh:
  check_on_agent_start: true
  check_before_new_project: true
  record_commit_sha: true
`;

export const DEFAULT_DOCUMENTS: Record<string, string> = {
  'context.yaml': DEFAULT_MANIFEST,

  'COMPANY.md': [
    '# PAC Technologies — Company Context',
    '',
    '## Who We Are',
    '',
    'PAC Technologies is an Australian industrial automation and control systems',
    'integrator. We deliver PLC, HMI and SCADA systems for process and packaging',
    'customers, and we commission them on site.',
    '',
    '## Direction',
    '',
    'PAC is moving toward consistent, transferable engineering supported by a',
    'structured engineering platform and an AI agent workforce. Repeatable',
    'engineering beats individual heroics.',
    '',
    '## Engineering Organisation',
    '',
    'Small senior engineering team. Every project has a lead engineer.',
    '',
  ].join('\n'),

  'VALUES.md': [
    '# PAC Technologies — Values & Engineering Principles',
    '',
    '## 1. Do the Job Properly',
    '',
    'Do the work correctly the first time. Shortcuts on a commissioned plant are',
    'paid for by somebody at 2am.',
    '',
    '## 4. Fully Test and Simulate',
    '',
    'Controls software is tested and simulated against a digital twin before it',
    'goes anywhere near real hardware. Simulation evidence is part of the',
    'deliverable, not an optional extra.',
    '',
    '## 8. Notice Improvements, Do Not Automatically Make Them',
    '',
    'Noticing that nearby code could be better is useful. Changing it inside an',
    'unrelated task is not.',
    '',
    '## 11. Safety Outranks Schedule Pressure',
    '',
    'Safety interlocks and permissives are never weakened to meet a date.',
    '',
  ].join('\n'),

  'OPERATING_MODEL.md': [
    '# PAC Technologies — Operating Model',
    '',
    '## 10. FDS',
    '',
    'The Functional Design Specification defines what the system must do. It is',
    'approved by the customer before controls implementation begins.',
    '',
    '## 13. Controls Implementation',
    '',
    'PLC and HMI implementation follows the approved FDS and the PAC Engineering',
    'Library. Code is developed in isolation and reviewed before release.',
    '',
    '## 14. Digital Twin and Testing',
    '',
    'Controls software is verified against the digital twin. Test and simulation',
    'evidence is recorded against the project.',
    '',
    '## 18. Safety Review',
    '',
    'A safety review is performed before commissioning. Safety functions are',
    'verified independently of the functional testing.',
    '',
    '## 19. Commissioning',
    '',
    'Commissioning on a live or partially live plant is performed by a PAC',
    'engineer on site.',
    '',
  ].join('\n'),

  'SYSTEMS.md': [
    '# PAC Technologies — Systems & Sources of Truth',
    '',
    '## Principle',
    '',
    'Each system keeps the authority it already has. Nothing is centralised',
    'merely to centralise it.',
    '',
    '## Forja',
    '',
    'Forja is the PAC engineering and orchestration platform. It assembles',
    'project context, routes agent tasks and provides review surfaces. It is not',
    'a system of record for documents or work items.',
    '',
    '## monday.com',
    '',
    'monday.com is the system of record for project execution and task status.',
    '',
    '## GitHub',
    '',
    'GitHub is the system of record for code and technical implementation.',
    '',
    '## Dropbox',
    '',
    'Dropbox holds customer job folders, drawings and vendor documentation.',
    '',
  ].join('\n'),

  'AUTHORITY.md': [
    '# PAC Technologies — AI Agent Authority & Guardrails',
    '',
    '## Core Principle',
    '',
    'Agents prepare. Humans release.',
    '',
    '## Financial Authority',
    '',
    'Agents have no authority to spend PAC money. They must not purchase',
    'software, start paid subscriptions, place orders or approve invoices.',
    'Agents may research and recommend purchases.',
    '',
    '## External Communication',
    '',
    'Agents are not authorised to communicate directly with customers,',
    'suppliers, OEMs or other external parties. They may draft responses for',
    'human review.',
    '',
    '## Live and Commissioned Systems',
    '',
    'PAC AI agents must NEVER autonomously deploy changes to a live or',
    'commissioned customer system. No exception for confidence, simplicity,',
    'schedule pressure, passing tests or reversibility.',
    '',
    '## Development Code',
    '',
    'Agents may create branches, modify development code, test, commit and',
    'prepare pull requests. They must never autonomously merge to protected,',
    'default or release branches.',
    '',
    '## Safety',
    '',
    'Agents must never weaken, bypass or disable safety controls, interlocks,',
    'permissives or safety-related verification.',
    '',
    '## Warranty',
    '',
    'Agents may investigate and collect evidence but cannot approve or reject',
    'warranty claims, waive conditions or promise coverage.',
    '',
  ].join('\n'),

  'AGENTS.md': [
    '# PAC Technologies — Agent Roles & Orchestration',
    '',
    '## Operating Model',
    '',
    'PAC uses specialist agents rather than one unrestricted general-purpose AI.',
    'Forja is the orchestration layer for the PAC agent workforce.',
    '',
    '## Shared Agent Context',
    '',
    'Every PAC agent receives PAC shared company context, its own role',
    'definition and authority, relevant project context, and the current task',
    'context. Agents may propose changes to shared company context but cannot',
    'approve their own changes.',
    '',
    '## Mac — Automation Engineer',
    '',
    "Mac is PAC's AI Automation Engineer and primary technical autonomous",
    'worker. Mac performs technical investigation, software engineering,',
    'controlled autonomous overnight work and coding-agent supervision.',
    '',
    '## Forja — Orchestration Platform',
    '',
    'Forja is not itself one of the specialist staff agents. It is the',
    'engineering and orchestration platform through which PAC humans and agents',
    'work together.',
    '',
  ].join('\n'),

  'GLOSSARY.md': [
    '# PAC Technologies — Glossary',
    '',
    '## Forja',
    '',
    "PAC's engineering and orchestration platform.",
    '',
    '## FDS',
    '',
    'Functional Design Specification.',
    '',
    '## Digital Twin',
    '',
    'A simulation model of the plant used to verify controls software.',
    '',
    '## Commissioned / Live System',
    '',
    'A system running in production at a customer site.',
    '',
  ].join('\n'),

  // Present in the real repository, and deliberately NOT manifest-mandatory.
  'README.md': '# PAC Agent Context\n\nShared company context for PAC agents.\n',
};

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'PAC Test',
      GIT_AUTHOR_EMAIL: 'test@pac.invalid',
      GIT_COMMITTER_NAME: 'PAC Test',
      GIT_COMMITTER_EMAIL: 'test@pac.invalid',
      GIT_TERMINAL_PROMPT: '0',
    },
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

export interface CompanyRepoFixture {
  /** Path usable as a git remote URL. */
  url: string;
  dir: string;
  /** A fresh directory for the provider's mirror, not yet created. */
  cacheDir: string;
  head(): string;
  /** Writes files and commits them. Returns the new sha. */
  commit(files: Record<string, string | null>, message: string): string;
  cleanup(): void;
}

/**
 * Creates a real Git repository on disk containing the PAC company documents.
 */
export function createCompanyRepo(
  documents: Record<string, string> = DEFAULT_DOCUMENTS,
): CompanyRepoFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mac-company-'));
  const dir = path.join(root, 'repo');
  const cacheDir = path.join(root, 'cache');
  fs.mkdirSync(dir, { recursive: true });

  git(dir, ['init', '--quiet', '--initial-branch=main']);
  git(dir, ['config', 'user.email', 'test@pac.invalid']);
  git(dir, ['config', 'user.name', 'PAC Test']);
  // A mirror clone of a repository whose HEAD is a symref works either way, but
  // being explicit keeps the fixture readable.
  git(dir, ['symbolic-ref', 'HEAD', 'refs/heads/main']);

  for (const [file, content] of Object.entries(documents)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), content, 'utf8');
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '--quiet', '-m', 'Initial company context']);

  return {
    // file:// so the provider exercises its real URL handling rather than a
    // path that happens to work.
    url: `file:///${dir.replace(/\\/g, '/').replace(/^\//, '')}`,
    dir,
    cacheDir,
    head: () => git(dir, ['rev-parse', 'refs/heads/main']),
    commit(files, message) {
      for (const [file, content] of Object.entries(files)) {
        const full = path.join(dir, file);
        if (content === null) {
          fs.rmSync(full, { force: true });
          continue;
        }
        fs.mkdirSync(path.dirname(full), { recursive: true });
        fs.writeFileSync(full, content, 'utf8');
      }
      git(dir, ['add', '-A']);
      git(dir, ['commit', '--quiet', '--allow-empty', '-m', message]);
      return git(dir, ['rev-parse', 'refs/heads/main']);
    },
    cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** A manifest with one field changed, for the validation-failure cases. */
export const manifestWith = (replacements: Array<[string, string]>): string =>
  replacements.reduce((text, [from, to]) => text.replace(from, to), DEFAULT_MANIFEST);
