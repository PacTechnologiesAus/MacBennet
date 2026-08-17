import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { EmailDeliveryDto, MorningReportDto } from '@mac/protocol';
import { api, ApiError } from '../api.js';
import { Alert, Badge, Time, humanise } from '../components/ui.js';

/**
 * Delivery state (Sprint 3 §9).
 *
 * A report that was generated and never sent is worse than no report at all,
 * because it looks like nothing happened overnight. This panel exists so that
 * failure is visible rather than silent, and so a dead delivery can be retried
 * after the configuration is fixed.
 */
function DeliveryPanel({
  deliveries,
  onRetry,
  onError,
}: {
  deliveries: EmailDeliveryDto[];
  onRetry: () => void;
  onError: (message: string) => void;
}) {
  const failed = deliveries.filter((d) => d.status === 'dead' || d.status === 'failed');

  const retry = async (id: string) => {
    try {
      await api.retryDelivery(id);
      onError('');
      onRetry();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : String(err));
    }
  };

  return (
    <div className="card" style={failed.length ? { borderColor: 'var(--warn)' } : undefined}>
      <h2>Morning email</h2>
      {failed.length > 0 && (
        <p className="hint">
          {failed.length} report(s) did not reach anybody. Fix the recipients in Settings, then retry — the
          addresses are re-resolved when you do.
        </p>
      )}
      <table>
        <thead>
          <tr>
            <th>Subject</th>
            <th>To</th>
            <th>Status</th>
            <th>Attempts</th>
            <th>Provider id</th>
            <th>Sent</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {deliveries.map((delivery) => (
            <tr key={delivery.id}>
              <td>{delivery.subject}</td>
              <td className="dim">{delivery.recipients.join(', ') || '—'}</td>
              <td>
                <Badge
                  tone={
                    delivery.status === 'sent'
                      ? 'ok'
                      : delivery.status === 'dead'
                        ? 'danger'
                        : delivery.status === 'failed'
                          ? 'warn'
                          : 'idle'
                  }
                >
                  {humanise(delivery.status)}
                </Badge>
                {delivery.lastError && <div className="hint">{delivery.lastError}</div>}
              </td>
              <td>{delivery.attempts}</td>
              <td className="mono dim">{delivery.providerMessageId ?? '—'}</td>
              <td>
                <Time value={delivery.sentAt} />
              </td>
              <td>
                {delivery.status !== 'sent' && (
                  <button className="small" onClick={() => void retry(delivery.id)}>
                    Retry
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * The morning's reading (spec §28).
 *
 * Deliberately a list of short summaries rather than a wall of reports: the
 * whole point of the morning report is that an engineer can scan it over a
 * coffee and only open the ones that need them.
 */
export function Reports() {
  const [reports, setReports] = useState<MorningReportDto[]>([]);
  const [deliveries, setDeliveries] = useState<EmailDeliveryDto[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');

  const load = () => {
    void api.listReports().then((r) => setReports(r.reports));
    void api
      .listDeliveries()
      .then((r) => setDeliveries(r.deliveries))
      // Delivery state is admin-visible; a viewer simply does not see the panel.
      .catch(() => setDeliveries([]))
      .finally(() => setLoaded(true));
  };

  useEffect(load, []);

  const needingAttention = reports.filter((r) => r.decisionsNeeded.length > 0 || r.risk === 'high');

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Reports</h1>
          <p className="dim">What Mac did, what needs you, and whether the morning email actually arrived.</p>
        </div>
      </div>

      <Alert kind="error">{error}</Alert>

      {deliveries.length > 0 && (
        <DeliveryPanel deliveries={deliveries} onRetry={load} onError={setError} />
      )}

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
