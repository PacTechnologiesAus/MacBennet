import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { CurrentUser, NightCandidateDto, NightShiftDashboardDto } from '@mac/protocol';
import { api, ApiError } from '../api.js';
import { Alert, Badge, Confidence, Empty, RunStatusBadge, Time, humanise } from '../components/ui.js';

/**
 * The Night Shift dashboard and queue (Sprint 3 §14).
 *
 * The question this screen exists to answer at 08:00 is a single one: what
 * happened, and is anything waiting for me? So the ordering is deliberate —
 * what needs a person first, then what Mac is doing, then why he chose it.
 *
 * The queue below shows EVERY eligibility check, passing and failing. An
 * engineer who has just configured a board and sees nothing in the queue needs
 * to know which of thirteen conditions is the one stopping it, and a screen
 * that only listed failures could not explain why the working ones work.
 */
export function NightShift({ user }: { user: CurrentUser }) {
  const [dashboard, setDashboard] = useState<NightShiftDashboardDto | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await api.nightShift();
      setDashboard(response.dashboard);
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
    // A night shift moves on the scale of minutes, not seconds; polling faster
    // would be load without information.
    const timer = setInterval(() => void load(), 10_000);
    return () => clearInterval(timer);
  }, [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      await load();
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!dashboard) return <p className="dim">Loading…</p>;

  const { shift } = dashboard;
  const canOperate = user.role !== 'viewer';

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Night shift</h1>
          <p className="dim">
            {shift
              ? `Started ${new Date(shift.startedAt).toLocaleString()} · cutoff ${new Date(shift.cutoffAt).toLocaleTimeString()}`
              : 'Mac is in day mode. He will inspect, answer and plan, but will not start work.'}
          </p>
        </div>
        <div className="actions">
          {canOperate && !shift?.endedAt && shift ? (
            <button className="danger" disabled={busy} onClick={() => void act(() => api.stopNightShift('Stopped from the dashboard.'))}>
              Stop shift
            </button>
          ) : null}
          {canOperate && (!shift || shift.endedAt) ? (
            <button disabled={busy} onClick={() => void act(() => api.startNightShift())}>
              Start night shift
            </button>
          ) : null}
          {user.role === 'admin' && shift && !shift.endedAt ? (
            <button className="small" disabled={busy} onClick={() => void act(() => api.tickNightShift())}>
              Tick now
            </button>
          ) : null}
        </div>
      </div>

      <Alert kind="error">{error}</Alert>

      {/* --- State ------------------------------------------------------- */}

      <div className="card">
        <div className="stat-row">
          <Stat label="Mac" value={<MacState state={dashboard.macState} />} />
          <Stat
            label="Active task"
            value={
              dashboard.activeRun ? (
                <Link to={`/runs/${dashboard.activeRun.id}`}>{dashboard.activeRun.taskTitle ?? 'Run'}</Link>
              ) : (
                <span className="dim">—</span>
              )
            }
          />
          <Stat label="Project" value={dashboard.activeProjectName ?? <span className="dim">—</span>} />
          <Stat
            label="Until cutoff"
            value={shift ? `${Math.floor(dashboard.minutesUntilCutoff / 60)}h ${dashboard.minutesUntilCutoff % 60}m` : '—'}
          />
          <Stat label="Done tonight" value={String(dashboard.completedTonight.length)} />
          <Stat label="Blocked" value={String(dashboard.blocked.length)} />
          <Stat
            label="Workers"
            value={
              <>
                {dashboard.workers.filter((w) => w.isLive).length} live ·{' '}
                <span className={dashboard.sandboxReadyWorkers === 0 ? 'danger-text' : undefined}>
                  {dashboard.sandboxReadyWorkers} sandboxed
                </span>
              </>
            }
          />
          <Stat
            label="Usage"
            value={
              <span title={dashboard.budget.softUsage.note}>
                <Badge tone={dashboard.budget.costEnforceable ? 'ok' : 'idle'}>
                  {dashboard.budget.usageSource}
                </Badge>
              </span>
            }
          />
        </div>
        {!dashboard.budget.costEnforceable && (
          <p className="hint">
            The nightly budget is not an enforceable dollar cap under this provider: usage is{' '}
            {dashboard.budget.usageSource}, and Mac says so rather than implying a limit he cannot enforce.
          </p>
        )}
      </div>

      {/* --- Needs a person ----------------------------------------------- */}

      {dashboard.blocked.length > 0 && (
        <div className="card" style={{ borderColor: 'var(--warn)' }}>
          <h2>Blocked — waiting on a person</h2>
          <table>
            <thead>
              <tr>
                <th>Task</th>
                <th>Project</th>
                <th>What stopped</th>
                <th>When</th>
              </tr>
            </thead>
            <tbody>
              {dashboard.blocked.map((b) => (
                <tr key={`${b.runId}-${b.at}`}>
                  <td>
                    <Link to={`/runs/${b.runId}`}>{b.taskTitle}</Link>
                  </td>
                  <td>{b.projectName}</td>
                  <td>{b.blocker}</td>
                  <td>
                    <Time value={b.at} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {dashboard.completedTonight.length > 0 && (
        <div className="card">
          <h2>Completed tonight</h2>
          <table>
            <thead>
              <tr>
                <th>Task</th>
                <th>Project</th>
                <th>Pull request</th>
              </tr>
            </thead>
            <tbody>
              {dashboard.completedTonight.map((c) => (
                <tr key={c.runId}>
                  <td>
                    <Link to={`/runs/${c.runId}`}>{c.taskTitle}</Link>
                  </td>
                  <td>{c.projectName}</td>
                  <td>
                    {c.pullRequestUrl ? (
                      <a href={c.pullRequestUrl} target="_blank" rel="noreferrer">
                        open
                      </a>
                    ) : (
                      <span className="dim">none</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* --- The queue ----------------------------------------------------- */}

      <div className="card">
        <h2>Night queue</h2>
        <p className="hint">
          What Mac would consider next, in the order he would consider it. Every eligibility check is shown, so a
          candidate that is not being picked up says which condition is stopping it.
        </p>
        {dashboard.queue.length === 0 ? (
          <Empty>
            Nothing on any approved board. Map a board under monday.com, approve it, approve the project for night
            shift, and flag the items Mac may take.
          </Empty>
        ) : (
          dashboard.queue.map((candidate) => <QueueRow key={candidate.mondayItemId ?? candidate.taskId} candidate={candidate} />)
        )}
      </div>

      {/* --- Decisions ----------------------------------------------------- */}

      {dashboard.recentDecisions.length > 0 && (
        <div className="card">
          <h2>Scheduling decisions</h2>
          <p className="hint">Every decision Mac made, including the ones not to start something.</p>
          <table>
            <thead>
              <tr>
                <th>#</th>
                <th>At</th>
                <th>Decision</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {dashboard.recentDecisions.map((decision) => (
                <tr key={decision.id}>
                  <td>{decision.sequence}</td>
                  <td>
                    <Time value={decision.at} />
                  </td>
                  <td>
                    <Badge tone={decision.decision === 'start' ? 'ok' : decision.decision === 'stop' ? 'danger' : 'idle'}>
                      {humanise(decision.decision)}
                    </Badge>
                  </td>
                  <td>
                    {decision.rationale.reason}
                    {decision.rationale.skipped.length > 0 && (
                      <div className="hint">
                        Skipped: {decision.rationale.skipped.map((s) => `${s.title} (${humanise(s.reason)})`).join('; ')}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function QueueRow({ candidate }: { candidate: NightCandidateDto }) {
  const [open, setOpen] = useState(false);
  const failing = candidate.eligibility.checks.filter((c) => !c.ok);

  return (
    <div className="queue-row">
      <div className="row-between">
        <div>
          <strong>{candidate.taskTitle}</strong>{' '}
          <span className="dim">
            {candidate.projectName}
            {candidate.priority ? ` · ${candidate.priority}` : ''}
            {candidate.effort ? ` · ${candidate.effort.sizeClass}` : ''}
          </span>
        </div>
        <div className="actions">
          <Confidence value={candidate.confidence} />
          {candidate.eligibility.eligible ? (
            candidate.skipReason ? (
              <Badge tone="warn">not now</Badge>
            ) : (
              <Badge tone="ok">eligible</Badge>
            )
          ) : (
            <Badge tone="idle">{failing.length} check(s) failing</Badge>
          )}
          <button className="small" onClick={() => setOpen((v) => !v)}>
            {open ? 'hide' : 'why'}
          </button>
        </div>
      </div>

      {candidate.skipReason && <div className="hint">{candidate.skipReason}</div>}

      {open && (
        <table className="compact">
          <tbody>
            {candidate.eligibility.checks.map((check) => (
              <tr key={check.code}>
                <td style={{ width: 90 }}>
                  <Badge tone={check.ok ? 'ok' : 'danger'}>{check.ok ? 'pass' : 'fail'}</Badge>
                </td>
                <td style={{ width: 260 }}>{humanise(check.code)}</td>
                <td className="dim">{check.detail}</td>
              </tr>
            ))}
            {candidate.effort && (
              <tr>
                <td>
                  <Badge tone="info">effort</Badge>
                </td>
                <td>{candidate.effort.sizeClass}</td>
                <td className="dim">{candidate.effort.basis}</td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}

function MacState({ state }: { state: NightShiftDashboardDto['macState'] }) {
  const tone =
    state === 'working' ? 'info' : state === 'blocked' ? 'warn' : state === 'stopped' ? 'danger' : 'idle';
  return <Badge tone={tone}>{humanise(state)}</Badge>;
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}

/** Re-exported so `RunStatusBadge` stays available to future panels here. */
export { RunStatusBadge };
