import { describe, expect, it } from 'vitest';
import {
  mandatoryDocuments,
  normaliseDocumentPath,
  validateManifest,
} from '../../src/services/company-context/manifest.js';
import { headingsOf, parseSections, documentSetHash, sha256 } from '../../src/domain/company-context.js';

/**
 * The company context manifest (Sprint 3.2 §6).
 *
 * The claim under test is not "the manifest parses". It is that a manifest Mac
 * cannot fully understand produces a REFUSAL rather than a default — because
 * the failure mode this guards against is the quiet one, where Mac guesses at
 * the document set, loads six of seven mandatory documents, and then does work
 * that looks perfectly grounded.
 */

/** The real manifest from PacTechnologiesAus/Company, byte for byte. */
const REAL_MANIFEST = `schema_version: 1

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

describe('a valid manifest', () => {
  it('loads the real PAC manifest and reports its declared document set', () => {
    const result = validateManifest(REAL_MANIFEST);

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.manifest.schema_version).toBe(1);
    expect(result.manifest.context_version).toBe('0.1.0');
    expect(mandatoryDocuments(result.manifest)).toEqual([
      'COMPANY.md',
      'VALUES.md',
      'OPERATING_MODEL.md',
      'SYSTEMS.md',
      'AUTHORITY.md',
      'AGENTS.md',
      'GLOSSARY.md',
    ]);
  });

  it('does NOT require README.md, because the manifest does not declare it', () => {
    // The repository contains README.md. Mac loads what context.yaml declares,
    // not what happens to be in the tree — the manifest is the authority.
    const result = validateManifest(REAL_MANIFEST);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(mandatoryDocuments(result.manifest)).not.toContain('README.md');
  });

  it('records the governance and refresh policy rather than inventing one', () => {
    const result = validateManifest(REAL_MANIFEST);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.manifest.governance.agents_may_propose_changes).toBe(true);
    expect(result.manifest.governance.agents_may_approve_changes).toBe(false);
    expect(result.manifest.refresh.check_on_agent_start).toBe(true);
    expect(result.manifest.precedence[0]).toBe('AUTHORITY.md');
  });

  it('preserves unknown future-compatible fields instead of dropping them', () => {
    // A future PAC manifest may declare things this build does not act on. It
    // should still reach the provenance record, so an operator can see what was
    // declared even on an older Mac.
    const result = validateManifest(
      `${REAL_MANIFEST}\nretention:\n  keep_revisions: 50\ndocuments_optional:\n  - EXTRA.md\n`,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.manifest as Record<string, unknown>).retention).toEqual({ keep_revisions: 50 });
    expect((result.manifest as Record<string, unknown>).documents_optional).toEqual(['EXTRA.md']);
  });

  it('tolerates an unknown key nested inside a known block', () => {
    const result = validateManifest(REAL_MANIFEST.replace('  record_commit_sha: true', '  record_commit_sha: true\n  future_flag: true'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.manifest.refresh as Record<string, unknown>).future_flag).toBe(true);
  });
});

describe('a manifest Mac must refuse', () => {
  it('fails on malformed YAML rather than pressing on', () => {
    const result = validateManifest('schema_version: 1\n  documents:\n   - [unclosed\n');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('COMPANY_MANIFEST_MALFORMED');
  });

  it('fails when the file parses to something that is not a mapping', () => {
    const result = validateManifest('- just\n- a\n- list\n');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('COMPANY_MANIFEST_MALFORMED');
  });

  it('fails on an unsupported schema version, and says so plainly', () => {
    const result = validateManifest(REAL_MANIFEST.replace('schema_version: 1', 'schema_version: 2'));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('COMPANY_MANIFEST_SCHEMA_UNSUPPORTED');
    // The error must name the problem it actually has. Reporting a downstream
    // shape complaint about a version-2 manifest would send whoever reads it
    // looking for the wrong bug.
    expect(result.errors.join(' ')).toContain('schema_version 2');
    expect(result.errors.join(' ')).not.toContain('documents.mandatory');
  });

  it('fails when schema_version is missing entirely', () => {
    const result = validateManifest(REAL_MANIFEST.replace('schema_version: 1\n', ''));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('COMPANY_MANIFEST_INVALID');
  });

  it('fails when the mandatory document list is missing', () => {
    const result = validateManifest(
      REAL_MANIFEST.replace(/documents:[\s\S]*?\nprecedence:/, 'precedence:'),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('COMPANY_MANIFEST_INVALID');
  });

  it('fails when the mandatory document list is empty', () => {
    const result = validateManifest(
      REAL_MANIFEST.replace(/  mandatory:[\s\S]*?\nprecedence:/, '  mandatory: []\nprecedence:'),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('COMPANY_MANIFEST_INVALID');
  });

  it('fails on a duplicate mandatory entry rather than de-duplicating it', () => {
    // A manifest listing AUTHORITY.md twice is one somebody edited by hand and
    // got wrong. Quietly collapsing it hides an editing mistake in the document
    // that defines Mac's authority.
    const result = validateManifest(REAL_MANIFEST.replace('    - GLOSSARY.md', '    - GLOSSARY.md\n    - AUTHORITY.md'));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('COMPANY_MANIFEST_DUPLICATE_DOCUMENT');
    expect(result.errors.join(' ')).toContain('AUTHORITY.md');
  });

  it('treats ./X.md and X.md as the same document for duplicate detection', () => {
    const result = validateManifest(REAL_MANIFEST.replace('    - GLOSSARY.md', '    - GLOSSARY.md\n    - ./COMPANY.md'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('COMPANY_MANIFEST_DUPLICATE_DOCUMENT');
  });

  it.each([
    ['../../etc/passwd', 'traversal'],
    ['/etc/passwd', 'absolute posix'],
    ['C:/secrets.md', 'absolute windows'],
    ['docs\\policy.md', 'backslash'],
  ])('refuses an unsafe mandatory path (%s)', (unsafe) => {
    const result = validateManifest(REAL_MANIFEST.replace('    - COMPANY.md', `    - ${unsafe}`));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('COMPANY_MANIFEST_UNSAFE_PATH');
  });

  it('fails when governance is absent, rather than assuming Mac may approve', () => {
    const result = validateManifest(REAL_MANIFEST.replace(/governance:[\s\S]*?\nrefresh:/, 'refresh:'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('COMPANY_MANIFEST_INVALID');
  });

  it('fails when the refresh policy is absent', () => {
    const result = validateManifest(REAL_MANIFEST.replace(/refresh:[\s\S]*$/, ''));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('COMPANY_MANIFEST_INVALID');
  });
});

describe('path normalisation', () => {
  it('strips a leading ./ and collapses repeated slashes', () => {
    expect(normaliseDocumentPath('./AUTHORITY.md')).toBe('AUTHORITY.md');
    expect(normaliseDocumentPath('docs//policy.md')).toBe('docs/policy.md');
  });

  it('does NOT fold case, because Git does not', () => {
    // Folding case would let a manifest validate and the read then fail.
    expect(normaliseDocumentPath('authority.md')).not.toBe(normaliseDocumentPath('AUTHORITY.md'));
  });
});

describe('reading a company document', () => {
  const DOC = [
    '# PAC Technologies — Values',
    '',
    'Preamble text.',
    '',
    '## 1. Do the Job Properly',
    '',
    'Body one.',
    '',
    '## 4. Fully Test and Simulate',
    '',
    'Body four.',
    '',
    '### A sub-point',
    '',
    'Still part of section four.',
    '',
  ].join('\n');

  it('splits on level-2 headings and keeps the preamble', () => {
    const sections = parseSections(DOC);
    expect(sections[0]!.heading).toBeNull();
    expect(sections[0]!.text).toContain('Preamble text.');
    expect(sections.map((s) => s.heading)).toEqual([null, '1. Do the Job Properly', '4. Fully Test and Simulate']);
  });

  it('keeps a level-3 sub-point inside its parent section', () => {
    // In these documents a ### is a sub-point OF the policy above it. Detaching
    // it would produce a fragment that reads as though it stood alone.
    const sections = parseSections(DOC);
    const four = sections.find((s) => s.heading === '4. Fully Test and Simulate');
    expect(four?.text).toContain('Still part of section four.');
  });

  it('does not split on a ## line inside a fenced code block', () => {
    const fenced = ['# Doc', '', '## Real', '', '```', '## Not a heading', '```', '', 'After.'].join('\n');
    expect(parseSections(fenced).map((s) => s.heading)).toEqual([null, 'Real']);
  });

  it('lists headings in document order', () => {
    expect(headingsOf(DOC)).toEqual(['1. Do the Job Properly', '4. Fully Test and Simulate']);
  });
});

describe('hashes', () => {
  it('gives the same document-set hash regardless of read order', () => {
    const a = { path: 'A.md', bytes: 1, sha256: sha256('a'), headings: [] };
    const b = { path: 'B.md', bytes: 1, sha256: sha256('b'), headings: [] };
    expect(documentSetHash([a, b])).toBe(documentSetHash([b, a]));
  });

  it('changes when any document changes', () => {
    const a = { path: 'A.md', bytes: 1, sha256: sha256('a'), headings: [] };
    const a2 = { path: 'A.md', bytes: 1, sha256: sha256('a-modified'), headings: [] };
    expect(documentSetHash([a])).not.toBe(documentSetHash([a2]));
  });
});
