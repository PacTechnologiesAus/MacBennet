import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { ArtefactDto, EvidenceClass } from '@mac/protocol';
import { ARTEFACT_TYPE_LABELS, EVIDENCE_CLASS_LABELS, EVIDENCE_CLASSES, isFactualClass } from '@mac/protocol';
import { api } from '../api.js';
import { Alert, Badge, Time } from '../components/ui.js';

/**
 * One result of non-coding work (Sprint 3.3 §17, §26).
 *
 * ---------------------------------------------------------------------------
 * WHY FINDINGS ARE GROUPED BY EVIDENCE CLASS RATHER THAN LISTED
 *
 * A flat list of statements is how an autonomous researcher's output becomes
 * dangerous. Everything in it reads with the same authority, so an inference
 * Mac drew at 03:00 sits alongside a line from PAC's approved handbook looking
 * exactly as solid, and the reader acts on both.
 *
 * Grouping forces the distinction into the layout: PAC facts, project facts and
 * external facts appear under headings that say what they are and carry their
 * sources; inferences, recommendations and assumptions appear under headings
 * that say those are Mac's own work. The reader cannot skim past the difference
 * because the difference is where things are on the page.
 * ---------------------------------------------------------------------------
 */
export function Artefact() {
  const { id } = useParams<{ id: string }>();
  const [artefact, setArtefact] = useState<ArtefactDto | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!id) return;
    api
      .getArtefact(id)
      .then((r) => setArtefact(r.artefact))
      .catch((err: Error) => setError(err.message));
  }, [id]);

  if (error) return <Alert kind="error">{error}</Alert>;
  if (!artefact) return <p className="dim">Loading…</p>;

  const established = artefact.findings.filter((f) => isFactualClass(f.evidenceClass) && f.sources.length > 0);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>{artefact.title}</h1>
          <p>
            <Link to={`/tasks/${artefact.taskId}`}>← Task</Link>
            {artefact.runId ? (
              <>
                {' · '}
                <Link to={`/runs/${artefact.runId}`}>Run</Link>
              </>
            ) : null}
          </p>
        </div>
        <Badge tone="idle">{ARTEFACT_TYPE_LABELS[artefact.type]}</Badge>
      </div>

      <div className="card">
        <dl className="kv">
          <dt>Produced</dt>
          <dd>
            <Time value={artefact.createdAt} />
          </dd>
          <dt>Established findings</dt>
          <dd>
            {established.length} of {artefact.findings.length}
            <span className="hint" style={{ display: 'block' }}>
              An established finding cites a source Mac actually retrieved. Everything else is his own reasoning.
            </span>
          </dd>
          <dt>PAC company context</dt>
          <dd>
            {artefact.companyContext ? (
              <code>{artefact.companyContext.shortSha}</code>
            ) : (
              <span className="dim">Not bound</span>
            )}
          </dd>
          <dt>Model usage</dt>
          <dd>
            {artefact.usage ? (
              <>
                {artefact.usage.provider}
                {artefact.usage.model ? ` · ${artefact.usage.model}` : ''}
                {artefact.usage.inputTokens !== null || artefact.usage.outputTokens !== null
                  ? ` · ${artefact.usage.inputTokens ?? '?'} in / ${artefact.usage.outputTokens ?? '?'} out tokens`
                  : ''}
              </>
            ) : (
              <span className="dim">Not recorded</span>
            )}
          </dd>
        </dl>
      </div>

      {artefact.summary ? (
        <div className="card">
          <h2>Summary</h2>
          <p>{artefact.summary}</p>
        </div>
      ) : null}

      <div className="card">
        <h2>Report</h2>
        <div className="artefact-body">{artefact.body}</div>
      </div>

      <div className="card">
        <h2>Findings and their basis</h2>
        {artefact.findings.length === 0 ? (
          <p className="dim">No findings were recorded.</p>
        ) : (
          EVIDENCE_CLASSES.map((klass) => <EvidenceGroup key={klass} klass={klass} artefact={artefact} />)
        )}
      </div>
    </>
  );
}

function EvidenceGroup({ klass, artefact }: { klass: EvidenceClass; artefact: ArtefactDto }) {
  const group = artefact.findings.filter((f) => f.evidenceClass === klass);
  if (group.length === 0) return null;

  return (
    <div className="evidence-group">
      <h4>
        {EVIDENCE_CLASS_LABELS[klass]}{' '}
        <Badge tone={isFactualClass(klass) ? 'ok' : 'idle'}>{isFactualClass(klass) ? 'checkable' : "Mac's own"}</Badge>
      </h4>
      <ul>
        {group.map((finding, index) => (
          <li key={index}>
            {finding.statement} <span className="dim">({(finding.confidence * 100).toFixed(0)}%)</span>
            {finding.sources.length > 0 && (
              <div className="hint">
                {/* The refs are resolvable by design: `company:AUTHORITY.md#…@sha`,
                    `project_memory:project/test-command`, a real URL. */}
                Sources: {finding.sources.join(', ')}
              </div>
            )}
            {finding.reasoning ? <div className="hint">{finding.reasoning}</div> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
