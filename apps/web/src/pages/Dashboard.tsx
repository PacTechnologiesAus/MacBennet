import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { DashboardDto, RunDto } from '@mac/protocol';
import { api } from '../api.js';
import { Alert, ApprovalBadge, Confidence, Empty, RunStatusBadge, Time, WorkerStatusBadge } from '../components/ui.js';

/**
 * The Dashboard answers one question: does anything need me right now?
 * Pending approvals come first for that reason — an unapproved run is the one
 * state where the system is deliberately stuck waiting on a human.
 */
export function Dashboard() {
  const [data, setData] = useState<DashboardDto | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const load = () =>
      api
        .dashboard()
        .then(setData)
        .catch((err: Error) => setError(err.message));

    void load();
    // Polling keeps the view live without a websocket. Five seconds is well
    // inside the heartbeat grace period, so worker liveness never looks stale.
    const timer = setInterval(() => void load(), 5000);
    return () => clearInterval(timer);
  }, []);

  if (error) return <Alert kind="error">{error}</Alert>;
  if (!data) return <p className="dim">Loading…</p>;

  const budgetUnavailable = !data.budget.providerUsageAvailable;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Dashboard</h1>
          <p>
            Overnight cutoff {data.settings.overnightCutoff} {data.settings.timezone} · autonomy threshold{' '}
            {Math.round(data.settings.defaultConfidenceThreshold * 100)}%
          </p>
        </div>
      </div>

      <div className="grid grid-4" style={{ marginBottom: 16 }}>
        <Stat label="Live workers" value={`${data.counts.liveWorkers}/${data.workers.length}`} />
        <Stat label="Active runs" value={data.activeRuns.length} />
        <Stat label="Pending approvals" value={data.pendingApprovals.length} />
        <Stat label="Runs (24h)" value={data.counts.runsToday} />
      </div>

      {data.pendingApprovals.length > 0 && (
        <div className="card">
          <h2>Awaiting your approval</h2>
          <RunTable runs={data.pendingApprovals} emptyText="Nothing awaiting approval." />
        </div>
      )}

      <div className="grid grid-2">
        <div className="card">
          <h2>Workers</h2>
          {data.workers.length === 0 ? (
            <Empty>
              No workers registered. Create an enrollment token under <Link to="/workers">Workers</Link> and start a
              worker with it.
            </Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Status</th>
                    <th>Last heartbeat</th>
                    <th>Current run</th>
                  </tr>
                </thead>
                <tbody>
                  {data.workers.map((worker) => (
                    <tr key={worker.id}>
                      <td>{worker.name}</td>
                      <td>
                        <WorkerStatusBadge status={worker.status} isLive={worker.isLive} />
                      </td>
                      <td>
                        <Time value={worker.lastHeartbeatAt} />
                      </td>
                      <td>
                        {worker.currentRunId ? (
                          <Link to={`/runs/${worker.currentRunId}`} className="mono">
                            {worker.currentRunId.slice(0, 8)}
                          </Link>
                        ) : (
                          <span className="dim">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="card">
          <h2>Nightly budget</h2>
          <dl className="kv">
            <dt>Budget</dt>
            <dd>
              {formatMoney(data.budget.nightlyBudgetCents, data.budget.currency)} per night
            </dd>
            <dt>Recorded spend</dt>
            <dd>
              {budgetUnavailable ? (
                // Spec §25: never present an estimate as exact provider usage.
                <span className="dim">Provider usage unavailable</span>
              ) : (
                formatMoney(data.budget.recordedSpendCents, data.budget.currency)
              )}
            </dd>
            <dt>Stop threshold</dt>
            <dd>{formatMoney(data.budget.stopThresholdCents, data.budget.currency)}</dd>
            <dt>Window</dt>
            <dd className="dim">
              <Time value={data.budget.windowStart} /> → <Time value={data.budget.windowEnd} />
            </dd>
          </dl>
          {budgetUnavailable && (
            <p className="hint">
              No provider cost integration exists in Sprint 1, so no usage is recorded. The budget guardrail is active
              and will block dispatch once exact usage is reported.
            </p>
          )}
        </div>
      </div>

      <div className="card">
        <h2>Active runs</h2>
        <RunTable runs={data.activeRuns} emptyText="No runs in flight." />
      </div>

      <div className="card">
        <h2>Recently completed</h2>
        <RunTable runs={data.recentlyCompleted} emptyText="No completed runs yet." />
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="stat">
      <div className="value">{value}</div>
      <div className="label">{label}</div>
    </div>
  );
}

export function RunTable({ runs, emptyText }: { runs: RunDto[]; emptyText: string }) {
  if (runs.length === 0) return <Empty>{emptyText}</Empty>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Task</th>
            <th>Job</th>
            <th>Status</th>
            <th>Approval</th>
            <th>Confidence</th>
            <th>Worker</th>
            <th>Created</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {runs.map((run) => (
            <tr key={run.id}>
              <td>
                <Link to={`/runs/${run.id}`}>{run.taskTitle ?? run.taskId.slice(0, 8)}</Link>
                {run.projectName ? <div className="dim" style={{ fontSize: 12 }}>{run.projectName}</div> : null}
              </td>
              <td className="mono">{run.jobKind}</td>
              <td>
                <RunStatusBadge status={run.status} />
                {run.cancelRequestedAt && !['cancelled', 'stopped_by_guardrail'].includes(run.status) ? (
                  <div style={{ fontSize: 11, marginTop: 3 }} className="dim">
                    stopping…
                  </div>
                ) : null}
              </td>
              <td>
                <ApprovalBadge state={run.approvalState} />
              </td>
              <td>
                <Confidence value={run.confidence} />
              </td>
              <td className="dim">{run.workerName ?? '—'}</td>
              <td>
                <Time value={run.createdAt} />
              </td>
              <td className="right">
                <Link to={`/runs/${run.id}`} className="mono">
                  open
                </Link>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function formatMoney(cents: number, currency: string): string {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}
