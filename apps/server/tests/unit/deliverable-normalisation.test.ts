import { describe, expect, it } from 'vitest';
import { emptyBriefContent, handoffBriefContentSchema, type AcceptanceCriterion } from '@mac/protocol';
import { analyseDeliverables, detectDeliverables } from '../../src/domain/deliverables.js';
import { contractTextOf, deliverableClarifications, deriveCriteria } from '../../src/domain/acceptance.js';

/**
 * Commissioning defect 9 — acceptance artefact double counting.
 *
 * ---------------------------------------------------------------------------
 * THE RUN THAT CAUSED THIS FILE
 *
 * A brief asking for "two separate engineering briefs and two distinct
 * documents" — where the second phrase was the requester saying the same thing
 * twice — derived `engineering_brief x2` AND `markdown_document x2`, and
 * therefore demanded four artefacts where two were wanted. The run produced
 * exactly what was asked for and was reported with a gap.
 *
 * That is the worst direction for this mechanism to fail in. Defect 8 was a
 * criterion no compliant run could meet; this is a criterion no correct
 * delivery could meet, which teaches a reader that acceptance gaps are noise.
 *
 * The fix is a taxonomy, not a phrase list: a SPECIFIC deliverable type defines
 * artefact identity, and a GENERIC container noun — document, file, report,
 * artefact, output — may not create an additional required artefact when the
 * evidence says it refers to a deliverable already derived.
 * ---------------------------------------------------------------------------
 */

const brief = (over: Partial<ReturnType<typeof handoffBriefContentSchema.parse>> = {}) =>
  handoffBriefContentSchema.parse({ ...emptyBriefContent('Deliverables'), ...over });

const derive = (acceptanceCriteria: string[]) =>
  deriveCriteria({
    taskKind: 'investigation',
    brief: brief({ acceptanceCriteria }),
    description: null,
    externalResearchAvailable: false,
    expectedArtefactTypes: ['investigation_report', 'engineering_brief'],
  });

/** Every artefact this criteria list demands, summed across artefact criteria. */
const requiredArtefacts = (criteria: readonly AcceptanceCriterion[]): number =>
  criteria
    .filter((c): c is Extract<AcceptanceCriterion, { kind: 'artefact_type' }> => c.kind === 'artefact_type')
    .reduce((total, c) => total + c.minimum, 0);

const artefactCriteria = (criteria: readonly AcceptanceCriterion[]) =>
  criteria
    .filter((c): c is Extract<AcceptanceCriterion, { kind: 'artefact_type' }> => c.kind === 'artefact_type')
    .map((c) => `${c.artefactType}x${c.minimum}`)
    .sort();

// ---------------------------------------------------------------------------

describe('defect 9 — a generic noun restating a specific deliverable', () => {
  // Case A. The exact wording from the failing run.
  it('does not add artefacts for "two distinct documents" naming the two briefs already required', () => {
    const text = 'Produce two separate engineering briefs and two distinct documents.';
    const analysis = analyseDeliverables(text);

    expect(analysis.deliverables.map((d) => `${d.artefactType}x${d.count}`)).toEqual(['engineering_briefx2']);
    expect(analysis.ambiguities).toHaveLength(0);

    const criteria = derive([text]);
    expect(artefactCriteria(criteria)).toEqual(['engineering_briefx2']);
    expect(requiredArtefacts(criteria)).toBe(2);
  });

  // Case B. `i.e.` is explanatory language, never a second deliverable.
  it('reads "i.e. two documents" as an alias rather than an addition', () => {
    const analysis = analyseDeliverables('Produce two engineering briefs, i.e. two documents.');

    expect(analysis.deliverables.map((d) => `${d.artefactType}x${d.count}`)).toEqual(['engineering_briefx2']);
    expect(analysis.resolutions.some((r) => r.relationship === 'alias')).toBe(true);
    expect(requiredArtefacts(derive(['Produce two engineering briefs, i.e. two documents.']))).toBe(2);
  });

  // Case C. A generic noun carrying its own specific type is a real deliverable.
  it('keeps a summary document as a deliverable of its own alongside the briefs', () => {
    const text = 'Produce two engineering briefs and a summary document.';
    const analysis = analyseDeliverables(text);

    expect(analysis.deliverables.map((d) => d.type).sort()).toEqual(['engineering_brief', 'summary_document']);
    expect(analysis.ambiguities).toHaveLength(0);

    const criteria = derive([text]);
    expect(artefactCriteria(criteria)).toEqual(['engineering_briefx2', 'markdown_documentx1']);
    expect(requiredArtefacts(criteria)).toBe(3);
  });

  // Case D. Contents of a document are content criteria, never more documents.
  it('treats what a report contains as sections rather than as further documents', () => {
    const text = 'Produce one report containing a summary and a build order.';
    const analysis = analyseDeliverables(text);

    expect(analysis.deliverables.map((d) => `${d.artefactType}x${d.count}`)).toEqual(['investigation_reportx1']);
    expect(analysis.sections).toContain('Summary');

    const criteria = derive([text]);
    expect(requiredArtefacts(criteria)).toBe(1);
    // The two things the report has to cover survive, as content criteria.
    const sections = criteria
      .filter((c): c is Extract<AcceptanceCriterion, { kind: 'named_section' }> => c.kind === 'named_section')
      .map((c) => c.section);
    expect(sections).toContain('Summary');
    expect(sections).toContain('Build order');
  });

  // Case E. Not knowing is a legitimate answer, and the only safe one here.
  it('refuses to guess whether unqualified "documentation" is the briefs or an addition', () => {
    const text = 'Provide two briefs and documentation.';
    const analysis = analyseDeliverables(text);

    expect(analysis.ambiguities).toHaveLength(1);
    expect(analysis.ambiguities[0]!.phrase).toMatch(/documentation/i);
    // No invented count in either direction.
    expect(analysis.deliverables.map((d) => `${d.artefactType}x${d.count}`)).toEqual(['engineering_briefx2']);

    const criteria = derive([text]);
    expect(requiredArtefacts(criteria)).toBe(2);
    expect(artefactCriteria(criteria)).toEqual(['engineering_briefx2']);

    // And it reaches a human before approval rather than being frozen silently.
    const questions = deliverableClarifications({ brief: brief({ acceptanceCriteria: [text] }), description: null });
    expect(questions).toHaveLength(1);
    expect(questions[0]!.dimension).toBe('acceptance_criteria');
    expect(questions[0]!.question).toMatch(/documentation/i);
  });

  // 5. Generic nouns are not globally discarded.
  it('counts two genuinely distinct generic documents as two', () => {
    const text = 'Produce a document for the client and a document for the internal team.';
    const analysis = analyseDeliverables(text);

    expect(analysis.deliverables.reduce((n, d) => n + d.count, 0)).toBe(2);
    expect(requiredArtefacts(derive([text]))).toBe(2);
  });

  // 6. Ambiguity that is genuinely ambiguous, with matching counts and no marker.
  it('will not decide "and two documents" from a matching count alone', () => {
    const analysis = analyseDeliverables('Produce two engineering briefs and two documents.');

    expect(analysis.ambiguities).toHaveLength(1);
    expect(analysis.deliverables.map((d) => `${d.artefactType}x${d.count}`)).toEqual(['engineering_briefx2']);
  });

  // 7. The generic can come first. Order must not decide identity.
  it('retracts a generic requirement that a later specific one turns out to name', () => {
    const text = 'Deliver two documents: two engineering briefs, one per system.';
    const analysis = analyseDeliverables(text);

    expect(analysis.deliverables.map((d) => `${d.artefactType}x${d.count}`)).toEqual(['engineering_briefx2']);
    expect(analysis.resolutions.some((r) => /document/i.test(r.phrase) && r.relationship === 'alias')).toBe(true);
    expect(requiredArtefacts(derive([text]))).toBe(2);
  });

  // 8. Several specific types, none of them consuming another.
  it('keeps distinct specific deliverable types apart', () => {
    const text = 'Produce an engineering brief, an architecture note, a drawing and a procedure.';
    const analysis = analyseDeliverables(text);

    expect(analysis.deliverables.map((d) => d.type).sort()).toEqual([
      'architecture_note',
      'drawing',
      'engineering_brief',
      'procedure',
    ]);
    expect(analysis.deliverables.reduce((n, d) => n + d.count, 0)).toBe(4);
    expect(analysis.ambiguities).toHaveLength(0);
  });

  // 9. Singular and plural must reach the same taxonomy.
  it('normalises singular and plural forms to the same deliverable type', () => {
    for (const text of [
      'Produce an engineering brief.',
      'Produce engineering briefs.',
      'Produce a drawing and a procedure.',
      'Produce drawings and procedures.',
      'Produce a summary document.',
      'Produce summary documents.',
    ]) {
      const types = analyseDeliverables(text).deliverables.map((d) => d.type);
      expect(types.every((t) => !t.endsWith('s') || t === 'structured_data')).toBe(true);
    }

    expect(analyseDeliverables('Produce an engineering brief.').deliverables[0]!.type).toBe('engineering_brief');
    expect(analyseDeliverables('Produce engineering briefs.').deliverables[0]!.type).toBe('engineering_brief');
    expect(analyseDeliverables('Produce a drawing and a procedure.').deliverables.map((d) => d.type).sort()).toEqual(
      analyseDeliverables('Produce drawings and procedures.').deliverables.map((d) => d.type).sort(),
    );
  });

  /*
   * What plurality DOES change, stated rather than smoothed over.
   *
   * "an engineering brief and a document" introduces the document with its own
   * article, which is how English announces a new thing — so it is additive.
   * "engineering briefs and documents" introduces it with nothing at all, and
   * that bare form is exactly how a restatement is written. The two sentences
   * are not the same sentence and must not be forced to the same verdict.
   */
  it('treats a container introduced by its own article differently from a bare one', () => {
    expect(analyseDeliverables('Produce an engineering brief and a document.').ambiguities).toEqual([]);
    expect(analyseDeliverables('Produce an engineering brief and a document.').deliverables).toHaveLength(2);

    expect(analyseDeliverables('Produce engineering briefs and documents.').ambiguities).toHaveLength(1);
  });

  // 10. Defect 8 must survive defect 9's fix.
  it('still refuses to read a refusal of external research as a request for it', () => {
    const criteria = deriveCriteria({
      taskKind: 'investigation',
      brief: brief({ acceptanceCriteria: ['Use only the PAC company context — no external research of any kind.'] }),
      description: null,
      externalResearchAvailable: true,
      expectedArtefactTypes: ['investigation_report'],
    });
    expect(criteria.map((c) => c.kind)).not.toContain('external_sources');
  });
});

// ---------------------------------------------------------------------------

describe('defect 9 — provenance', () => {
  it('records why a generic phrase was read as an already-required deliverable', () => {
    const analysis = analyseDeliverables('Produce two separate engineering briefs and two distinct documents.');
    const resolution = analysis.resolutions.find((r) => /documents/i.test(r.phrase));

    expect(resolution).toBeDefined();
    // The wording the requester used, kept verbatim.
    expect(resolution!.phrase).toMatch(/two distinct documents/i);
    // Where it was, so a human can find it in the brief.
    expect(resolution!.span.end).toBeGreaterThan(resolution!.span.start);
    // And why, in a sentence a human can disagree with.
    expect(resolution!.reason).toMatch(/engineering brief/i);
    expect(resolution!.resolvedTo).toBe('engineering_brief');
  });

  it('carries the reason onto the criterion the human approves', () => {
    const criteria = derive(['Produce two separate engineering briefs and two distinct documents.']);
    const briefs = criteria.find(
      (c): c is Extract<AcceptanceCriterion, { kind: 'artefact_type' }> =>
        c.kind === 'artefact_type' && c.artefactType === 'engineering_brief',
    );

    expect(briefs?.provenance).toMatch(/two distinct documents/i);
  });
});

// ---------------------------------------------------------------------------

describe('defect 9 — no regression in what was already read correctly', () => {
  const REAL_REQUEST =
    'Investigate the PAC Project Registry, Project Document Controller and Sales Engineer. ' +
    'Produce three separate engineering briefs, one per system, a cross-system architecture ' +
    'recommendation, and a build-order recommendation with a rough cost for each. ' +
    'Research external vendor documentation where useful. This is research, engineering ' +
    'analysis and scoping only. Do not implement anything.';

  it('still counts three separate engineering briefs as three', () => {
    expect(detectDeliverables(REAL_REQUEST).find((d) => d.type === 'engineering_brief')?.count).toBe(3);
  });

  it('still tells an architecture recommendation from a bare recommendation', () => {
    const types = detectDeliverables(REAL_REQUEST).map((d) => d.type);
    expect(types).toContain('architecture_note');
    expect(types).toContain('recommendation');
  });

  it('does not read vendor documentation Mac must READ as a deliverable he must WRITE', () => {
    // "Research external vendor documentation" names a source, not an output.
    // Reading it as a deliverable would demand an artefact nobody asked for and
    // — worse, once container nouns are recognised — raise a clarifying question
    // about a phrase that was never ambiguous.
    const analysis = analyseDeliverables(REAL_REQUEST);
    expect(analysis.deliverables.map((d) => d.type)).not.toContain('documentation');
    expect(analysis.ambiguities).toHaveLength(0);
  });

  it('does not let a count attach to a noun it was never in front of', () => {
    const found = detectDeliverables('Cover three systems, and a recommendation at the end.');
    expect(found.find((d) => d.type === 'recommendation')?.count).toBe(1);
  });
});

// ---------------------------------------------------------------------------

/**
 * The wording from the real deployment, re-derived.
 *
 * ---------------------------------------------------------------------------
 * RUN `2f2a5511…`, ORACLE VM, PART D §20
 *
 * The brief that produced defect 9 in production. Recorded in the commissioning
 * report as it was observed there:
 *
 *   artefact_type    artefact-engineering_brief   min=2
 *   artefact_type    artefact-markdown_document   min=2      <- nobody asked for this
 *   named_section    section-assumptions
 *   evidence_class   evidence-grounded            min=1
 *
 * Four required artefacts from a request for two. The run produced two
 * engineering briefs and one cover note and was reported `completed_with_gaps`
 * for `1 of type markdown_document, 2 required`.
 *
 * This is that exact wording, kept verbatim so the fix is measured against what
 * actually happened rather than against a tidied-up version of it.
 * ---------------------------------------------------------------------------
 */
describe('defect 9 — the production wording that produced it', () => {
  const PRODUCTION_BRIEF = brief({
    acceptanceCriteria: [
      'Two separate engineering briefs, one per system.',
      'Two distinct documents, not one consolidated report.',
      'State the assumptions behind each.',
      'Use only the PAC company context — no external research of any kind.',
    ],
    proposedScope: 'Produce two separate engineering briefs from the PAC company context only.',
  });

  const criteria = deriveCriteria({
    taskKind: 'investigation',
    brief: PRODUCTION_BRIEF,
    description: null,
    externalResearchAvailable: true,
    expectedArtefactTypes: ['investigation_report', 'engineering_brief'],
  });

  it('requires two artefacts where it used to require four', () => {
    const artefacts = criteria.filter(
      (c): c is Extract<AcceptanceCriterion, { kind: 'artefact_type' }> => c.kind === 'artefact_type',
    );

    expect(artefacts.map((c) => `${c.artefactType}x${c.minimum}`)).toEqual(['engineering_briefx2']);
    expect(artefacts.reduce((total, c) => total + c.minimum, 0)).toBe(2);
  });

  it('keeps the section criterion and the evidence floor it always got right', () => {
    expect(
      criteria
        .filter((c): c is Extract<AcceptanceCriterion, { kind: 'named_section' }> => c.kind === 'named_section')
        .map((c) => c.section),
    ).toContain('Assumptions');
    expect(criteria.map((c) => c.kind)).toContain('evidence_class');
  });

  it('still derives no external-source criterion, which was defect 8', () => {
    // Both defects were in the same brief. Fixing the second must not reopen
    // the first, and this is the assertion that says so about the real wording
    // rather than about a phrase chosen to be easy.
    expect(criteria.map((c) => c.kind)).not.toContain('external_sources');
  });

  it('says, in the criterion a human approves, why "documents" added nothing', () => {
    const briefs = criteria.find(
      (c): c is Extract<AcceptanceCriterion, { kind: 'artefact_type' }> =>
        c.kind === 'artefact_type' && c.artefactType === 'engineering_brief',
    );
    expect(briefs?.provenance).toMatch(/two distinct documents/i);
    expect(briefs?.provenance).toMatch(/engineering brief/i);
  });

  it('decides this wording rather than asking about it', () => {
    /*
     * The brief is not ambiguous and must not be treated as though it were.
     * `needs_clarification` is the right answer for text that does not say;
     * asking a human about text that plainly does say is the same disease as
     * the false gap, one step earlier.
     */
    const analysis = analyseDeliverables(contractTextOf(PRODUCTION_BRIEF));
    expect(analysis.ambiguities).toEqual([]);
    expect(deliverableClarifications({ brief: PRODUCTION_BRIEF })).toEqual([]);

    const resolution = analysis.resolutions.find((r) => /documents/i.test(r.phrase));
    expect(resolution?.relationship).toBe('explanatory');
    expect(resolution?.resolvedTo).toBe('engineering_brief');

    // And the phrase that says what NOT to produce produced nothing.
    expect(analysis.deliverables.map((d) => d.type)).not.toContain('report');
  });
});

// ---------------------------------------------------------------------------

/**
 * The two defects re-deriving the production wording exposed in the fix itself.
 *
 * Both were found by running defect 9's fix against the real brief from run
 * `2f2a5511…` rather than against the tidy one-sentence cases above, and both
 * would have shipped as new false gaps.
 */
describe('defect 9 — what the production wording caught in the fix', () => {
  /*
   * A deliverable being REFUSED is not a deliverable being asked for.
   *
   * "Two distinct documents, not one consolidated report" says what NOT to
   * deliver, and the first cut of this fix read `report` out of it and raised a
   * clarifying question about a phrase that was never a request. Same trap as
   * defect 8, one layer down.
   */
  it('does not read "not one consolidated report" as a request for a report', () => {
    const analysis = analyseDeliverables('Two distinct documents, not one consolidated report.');

    expect(analysis.deliverables.map((d) => d.type)).not.toContain('report');
    expect(analysis.ambiguities.map((a) => a.phrase)).not.toContain('report');
  });

  it('still reads an unnegated report as a deliverable', () => {
    // The negation has to be attached to the noun, not merely present nearby.
    expect(analyseDeliverables('Produce one report on the migration.').deliverables.map((d) => d.type)).toContain(
      'report',
    );
    expect(
      analyseDeliverables('Do not implement anything. Produce one report.').deliverables.map((d) => d.type),
    ).toContain('report');
  });

  it('does not suppress a deliverable because a refusal sits earlier in the sentence', () => {
    // "no consolidated report — produce two briefs" still asks for two briefs.
    // Dropping a deliverable is the original Part F failure and the worse of
    // the two directions, so the negation window here is the narrow one.
    const analysis = analyseDeliverables('No consolidated report — produce two engineering briefs.');
    expect(analysis.deliverables.find((d) => d.type === 'engineering_brief')?.count).toBe(2);
  });

  /*
   * A brief is a LIST. A restatement often sits on the next line, not in the
   * same sentence, and requiring the same sentence made the real production
   * wording undecidable — a question asked about a brief nobody would call
   * unclear.
   */
  it('resolves a restatement that sits on the next line of the brief', () => {
    const analysis = analyseDeliverables(
      ['Two separate engineering briefs, one per system.', 'Two distinct documents, not one consolidated report.'].join(
        '\n',
      ),
    );

    expect(analysis.deliverables.map((d) => `${d.type} x${d.count}`)).toEqual(['engineering_brief x2']);
    expect(analysis.ambiguities).toEqual([]);
    const resolution = analysis.resolutions.find((r) => /documents/i.test(r.phrase));
    expect(resolution?.relationship).toBe('explanatory');
    expect(resolution?.resolvedTo).toBe('engineering_brief');
  });

  it('quotes a repeated phrase once, not once per field it appears in', () => {
    // The contract text is the acceptance criteria, scope, objective and
    // desired behaviour concatenated, and briefs restate their deliverables
    // across all four. Three identical quotations is not more provenance.
    const criteria = deriveCriteria({
      taskKind: 'investigation',
      brief: brief({
        acceptanceCriteria: ['Two separate engineering briefs.'],
        proposedScope: 'Two separate engineering briefs.',
        userObjective: 'Two separate engineering briefs.',
      }),
      description: null,
      externalResearchAvailable: false,
      expectedArtefactTypes: ['engineering_brief'],
    });

    const briefs = criteria.find(
      (c): c is Extract<AcceptanceCriterion, { kind: 'artefact_type' }> => c.kind === 'artefact_type',
    );
    expect(briefs?.provenance?.match(/Two separate engineering briefs/gi)).toHaveLength(1);
  });

  it('asks about a mass noun in English', () => {
    // "or a documentation in addition?" is a sentence a person has to read and
    // answer. It should not look like it was written by a machine that lost.
    const [question] = deliverableClarifications({
      brief: brief({ acceptanceCriteria: ['Provide two briefs and documentation.'] }),
    });
    expect(question!.question).not.toMatch(/a documentation/);
    expect(question!.question).toMatch(/documentation in addition/);
  });
});

// ---------------------------------------------------------------------------

/**
 * Asking too often is the same disease as the false gap, one step earlier.
 *
 * ---------------------------------------------------------------------------
 * THE THIRD DEFECT THE FIX ITSELF HAD
 *
 * The first cut of the ambiguity rule called a generic noun undecidable
 * whenever a specific deliverable preceded it and nothing pointed backwards.
 * Probed against ordinary phrasings it raised a clarifying question for SEVEN
 * of TEN briefs — including "a recommendation and a report on the trial" and
 * "two engineering briefs and three documents", where the counts plainly differ
 * and nobody would hesitate.
 *
 * A system that asks about everything is one whose questions stop being read,
 * and a question nobody reads blocks a brief just as thoroughly as a false gap
 * marks a good run short. These ten sentences are the probe, kept.
 * ---------------------------------------------------------------------------
 */
describe('defect 9 — ordinary wording is decided, not queried', () => {
  const decided: Array<[string, string[]]> = [
    ['Produce a brief and a note.', ['engineering_brief x1', 'note x1']],
    ['Produce an engineering brief and a document.', ['engineering_brief x1', 'document x1']],
    ['Produce two engineering briefs and a document.', ['engineering_brief x2', 'document x1']],
    ['Produce two engineering briefs and three documents.', ['engineering_brief x2', 'document x3']],
    ['Write a recommendation and a report on the trial.', ['recommendation x1', 'report x1']],
    ['Produce an investigation report and a summary document.', ['investigation_report x1', 'summary_document x1']],
    ['Deliver an architecture note and a file for the client.', ['architecture_note x1', 'file x1']],
  ];

  it.each(decided)('decides %s', (text, expected) => {
    const analysis = analyseDeliverables(text);
    expect(analysis.ambiguities).toEqual([]);
    expect(analysis.deliverables.map((d) => `${d.type} x${d.count}`).sort()).toEqual([...expected].sort());
  });

  /*
   * And the two shapes that genuinely are undecidable, so the rule is not just
   * "never ask". A repeated count above one, and a container introduced by
   * nothing at all.
   */
  const undecidable: Array<[string, string]> = [
    ['Produce two engineering briefs and two documents.', 'two documents'],
    ['Provide two briefs and documentation.', 'documentation'],
    ['Produce engineering briefs and documents.', 'documents'],
  ];

  it.each(undecidable)('asks about %s', (text, phrase) => {
    const analysis = analyseDeliverables(text);
    expect(analysis.ambiguities).toHaveLength(1);
    expect(analysis.ambiguities[0]!.phrase).toContain(phrase);
    // And derives nothing from it, in either direction.
    expect(analysis.deliverables.map((d) => d.type)).not.toContain('document');
    expect(analysis.deliverables.map((d) => d.type)).not.toContain('documentation');
  });

  it('does not treat two singulars repeating "one" as a repeated count', () => {
    // "a brief and a note" both carry the count 1, and that coincidence is not
    // evidence of anything. The suspicious signal is a count ABOVE one repeating.
    expect(analyseDeliverables('Produce a brief and a note.').ambiguities).toEqual([]);
    expect(analyseDeliverables('Produce two briefs and two notes.').ambiguities).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

/**
 * A container noun used as a VERB is not a deliverable.
 *
 * ---------------------------------------------------------------------------
 * THE FOURTH THING PROBING REAL WORDINGS CAUGHT
 *
 * Six of the eight container nouns are also everyday verbs, and a brief is
 * usually written in the imperative. "Investigate and **report** back" derived
 * a required report; "**Write up** your findings as a recommendation" derived a
 * required write-up *and* a recommendation, where one was asked for.
 *
 * That is defect 9's own failure direction — an artefact nobody asked for,
 * against which a correct run is marked short — reintroduced by the fix for it.
 *
 * The rule is grammatical rather than lexical: an English noun phrase needs a
 * determiner in the singular. "a report" is a thing; bare "report" is an
 * instruction. Plurals need no determiner, so only the singular is filtered.
 * ---------------------------------------------------------------------------
 */
describe('defect 9 — verbs are not deliverables', () => {
  it.each([
    ['Investigate and report back.', 'report'],
    ['Write up your findings as a recommendation.', 'write_up'],
    ['Look into it and write it up.', 'write_up'],
    ['Produce a brief and note the risks.', 'note'],
  ])('does not read %s as a deliverable', (text, type) => {
    expect(analyseDeliverables(text).deliverables.map((d) => d.type)).not.toContain(type);
  });

  it('still reads the same noun as a deliverable when a determiner governs it', () => {
    expect(analyseDeliverables('Produce a report on the failure.').deliverables.map((d) => d.type)).toContain('report');
    expect(analyseDeliverables('Give me a short write-up and a diagram.').deliverables.map((d) => d.type)).toContain(
      'write_up',
    );
    // Plurals need no determiner to be nouns.
    expect(analyseDeliverables('Produce two reports.').deliverables.find((d) => d.type === 'report')?.count).toBe(2);
  });

  /*
   * The determiner test is deliberately NOT the count scan.
   *
   * The count scan stops at the first word its qualifier list has never heard
   * of, so "a SCOPING document" read as having no determiner and the document
   * went missing. Widening that list word by word is the phrase-by-phrase
   * accumulation this whole module exists to avoid, so the determiner is looked
   * for directly instead — and it governs its noun phrase only until a
   * conjunction breaks it, which is why "a brief and note the risks" above does
   * not hand "a" to "note".
   */
  it('sees a determiner through an adjective it has never heard of', () => {
    expect(analyseDeliverables('Produce a scoping document for the Wagga job.').deliverables.map((d) => d.type)).toEqual(
      ['document'],
    );
    expect(
      analyseDeliverables('Deliver an interim handover file to the client.').deliverables.map((d) => d.type),
    ).toEqual(['file']);
  });

  it('does not read a source Mac must consult as an output he must write', () => {
    for (const text of [
      'Research external vendor documentation and cite it.',
      'Check the vendor documentation for supported firmware.',
      'Base the answer on the existing documentation.',
    ]) {
      expect(analyseDeliverables(text).deliverables).toEqual([]);
      expect(analyseDeliverables(text).ambiguities).toEqual([]);
    }
  });

  it('does not read a system with a container noun in its name as a deliverable', () => {
    // "the PAC Project Document Controller" had been quietly requiring a
    // markdown_document because a system has that word in its name.
    expect(analyseDeliverables('Investigate the PAC Project Document Controller.').deliverables).toEqual([]);
  });
});
