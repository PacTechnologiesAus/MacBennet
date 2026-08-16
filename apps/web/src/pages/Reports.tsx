import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { MorningReportDto } from '@mac/protocol';
import { api } from '../api.js';
import { Badge } from '../components/ui.js';

/**
 * The morning's reading (spec §28).
 *
 * Deliberately a list of short summaries rather than a wall of reports: the
 * whole point of the morning report is that an engineer can scan it over a
 * coffee and only open the ones that need them.
 */
export function Reports() {
  const [reports, setReports] = useState<MorningReportDto[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    void api
      .listReports()
      .then((r) => setReports(r.reports))
      .finally(() => setLoaded(true));
  }, []);

  const needingAttention = reports.filter((r) => r.decisionsNeeded.length > 0 || r.risk === 'high');

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Reports</h1>
          <p className="dim">What Mac did, and what needs you.</p>
        </div>
      </div>

      {!loaded && <p className="dim">Loading…</p>}
      {loaded && reports.length === 0 && (
        <div className="card">
          <p className="dim">No runs have produced a report yet.</p>
        </div>
      )}

      {needingAttention.length > 0 && (
        <div className="card" style={{ borderColor: 'var(--warn)' }}>
          <h2>Needs a decision</h2>
          <ul>
            {needingAttention.map((r) => (
              <li key={r.runId}>
                <Link to={`/runs/${r.runId}`}>{r.taskTitle}</Link> — {r.decisionsNeeded[0] ?? `risk ${r.risk}`}
              </li>
            ))}
          </ul>
        </div>
      )}

      {reports.map((report) => (
        <ReportCard key={report.runId} report={report} />
      ))}
    </>
  );
}

function ReportCard({ report }: { report: MorningReportDto }) {
  return (
    <div className="card">
      <div className="row-between">
        <h2>
          <Link to={`/runs/${report.runId}`}>{report.taskTitle}</Link>
        </h2>
        <div className="actions">
          <Badge tone={report.risk === 'high' ? 'danger' : report.risk === 'medium' ? 'warn' : 'ok'}>
            risk {report.risk}
          </Badge>
          <Badge tone={report.outcome === 'completed' ? 'ok' : 'idle'}>{report.outcome}</Badge>
        </div>
      </div>

      <p className="dim small">
        {report.projectName} · {new Date(report.generatedAt).toLocaleString()}
      </p>

      <p><strong>What changed.</strong> {report.whatChanged}</p>
      <p><strong>Why.</strong> {report.why}</p>

      {report.decisionsNeeded.length > 0 && (
        <>
          <h3>Decisions needed</h3>
          <ul>{report.decisionsNeeded.map((d, i) => <li key={i}>{d}</li>)}</ul>
        </>
      )}

      {report.flaggedAssumptions.length > 0 && (
        <>
          <h3>Assumptions to check</h3>
          <ul>
            {report.flaggedAssumptions.map((a, i) => (
              <li key={i}>{a.statement} <span className="dim">({Math.round(a.confidence * 100)}%)</span></li>
            ))}
          </ul>
        </>
      )}

      <p className="dim small">
        {report.questionsAnswered} question(s) answered
        {report.lowConfidenceAnswers > 0 && `, ${report.lowConfidenceAnswers} below the confidence threshold`}
        {' · '}
        <Link to={`/runs/${report.runId}`}>full Q&amp;A log</Link>
        {' · '}~{report.estimatedHumanHours}h of equivalent human effort (estimate)
      </p>

      <p className="small">
        {report.pullRequestUrl ? (
          <a href={report.pullRequestUrl} target="_blank" rel="noreferrer">{report.pullRequestUrl}</a>
        ) : (
          <span className="dim">No pull request: {report.pullRequestDeclineReason ?? 'no reason recorded.'}</span>
        )}
      </p>

      <details>
        <summary>Full report</summary>
        <pre className="markdown">{report.markdown}</pre>
      </details>
    </div>
  );
}
