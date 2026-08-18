import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { ApprovalDto, AuditEventDto, CurrentUser, RunDto, RunLogDto, SettingsDto } from '@mac/protocol';
import { isTerminalRunStatus } from '@mac/protocol';
import { api, ApiError } from '../api.js';
import { CompanyContextBadge } from './CompanyContext.js';
import { Alert, ApprovalBadge, Badge, Confidence, Empty, Field, RunStatusBadge, Time, humanise } from '../components/ui.js';
import { CodingRunPanels } from './CodingRun.js';

/**
 * Run Detail.
 *
 * This screen is where a human exercises the two powers Sprint 1 exists to
 * prove: approving work before it can run, and stopping it once it has.
 * Everything else on the page is evidence — logs, transitions, and the audit
 * trail — so that both decisions can be made and later justified.
 */
export function RunDetail({ user }: { user: CurrentUser }) {
  const { id } = useParams<{ id: string }>();
  const [run, setRun] = useState<RunDto | null>(null);
  const [approvals, setApprovals] = useState<ApprovalDto[]>([]);
  const [auditEvents, setAuditEvents] = useState<AuditEventDto[]>([]);
  const [settings, setSettings] = useState<SettingsDto | null>(null);
  const [logs, setLogs] = useState<RunLogDto[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const cursor = useRef<number | undefined>(undefined);
  const logBox = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  const canAct = user.role !== 'viewer';

  const loadRun = useCallback(async () => {
    if (!id) return;
    const detail = await api.getRun(id);
    setRun(detail.run);
    setApprovals(detail.approvals);
    setAuditEvents(detail.auditEvents);
  }, [id]);

  const loadLogs = useCallback(async () => {
    if (!id) return;
    // Incremental: the cursor is the row id, which advances over both worker
    // output and control-plane notes.
    const page = await api.getRunLogs(id, cursor.current);
    if (page.logs.length > 0) {
      cursor.current = page.logs[page.logs.length - 1]!.id;
      setLogs((existing) => [...existing, ...page.logs]);
    }
  }, [id]);

  useEffect(() => {
    setLogs([]);
    cursor.current = undefined;
    api.getSettings().then((r) => setSettings(r.settings)).catch(() => undefined);
  }, [id]);

  useEffect(() => {
    const tick = async () => {
      try {
        await loadRun();
        await loadLogs();
      } catch (err) {
        setError(err instanceof ApiError ? err.message : String(err));
      }
    };

    void tick();
    const timer = setInterval(() => {
      // Stop polling once the run can no longer change; a finished run is a
      // static document.
      if (run && isTerminalRunStatus(run.status) && !run.cancelRequestedAt) return;
      void tick();
    }, 1500);
    return () => clearInterval(timer);
  }, [loadRun, loadLogs, run?.status, run?.cancelRequestedAt]);

  // Follow the log tail, but only while the operator has not scrolled up to
  // read something.
  useEffect(() => {
    const box = logBox.current;
    if (box && pinnedToBottom.current) box.scrollTop = box.scrollHeight;
  }, [logs]);

  const act = async (action: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
      setNotice(message);
      await loadRun();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (error && !run) return <Alert kind="error">{error}</Alert>;
  if (!run) return <p className="dim">Loading…</p>;

  const terminal = isTerminalRunStatus(run.status);
  const stopping = Boolean(run.cancelRequestedAt) && !terminal;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>{run.taskTitle ?? 'Run'}</h1>
          <p>
            <Link to={`/tasks/${run.taskId}`}>← Task</Link>
            {run.projectId ? (
              <>
                {' · '}
                <Link to={`/projects/${run.projectId}`}>{run.projectName}</Link>
              </>
            ) : null}
            {' · '}
            <span className="mono dim">{run.id}</span>
          </p>
        </div>
        <div className="actions">
          <RunStatusBadge status={run.status} />
          <ApprovalBadge state={run.approvalState} />
          {/*
            Sprint 3.2: which PAC company context governed this run. Sits beside
            the approval state because they answer the same kind of question —
            under whose authority did this happen.
          */}
          <CompanyContextBadge context={run.companyContext} />
        </div>
      </div>

      <Alert kind="error">{error}</Alert>
      <Alert kind="ok">{notice}</Alert>
      {stopping && (
        <Alert kind="warn">
          A stop has been requested. The run stays <em>running</em> until the worker acknowledges it — the record must
          show that it actually stopped, not merely that someone asked.
        </Alert>
      )}

      <div className="grid grid-2">
        <div className="card">
          <h2>State</h2>
          <dl className="kv">
            <dt>Status</dt>
            <dd>
              <RunStatusBadge status={run.status} />
            </dd>
            <dt>Approval</dt>
            <dd>
              <ApprovalBadge state={run.approvalState} />
            </dd>
            <dt>Confidence</dt>
            <dd>
              <Confidence value={run.confidence} />
            </dd>
            <dt>Operation</dt>
            <dd className="mono">
              {run.jobKind}
              {Object.keys(run.jobParams).length > 0 ? (
                <div className="dim" style={{ fontSize: 12 }}>{JSON.stringify(run.jobParams)}</div>
              ) : null}
            </dd>
            <dt>Worker</dt>
            <dd>{run.workerName ?? <span className="dim">not yet assigned</span>}</dd>
            <dt>Mode</dt>
            <dd>
              {run.executionMode}
              {run.overnightDeadlineAt ? (
                <div className="dim" style={{ fontSize: 12 }}>
                  cutoff <Time value={run.overnightDeadlineAt} />
                </div>
              ) : null}
            </dd>
            <dt>Progress</dt>
            <dd>
              {run.progressStage ?? <span className="dim">—</span>}
              {run.progressPercent !== null ? (
                <div className="progress-track">
                  <div className="progress-fill" style={{ width: `${run.progressPercent}%` }} />
                </div>
              ) : null}
            </dd>
            <dt>Started</dt>
            <dd>
              <Time value={run.startedAt} />
            </dd>
            <dt>Completed</dt>
            <dd>
              <Time value={run.completedAt} />
            </dd>
            <dt>Stop reason</dt>
            <dd>{run.stopReason ? <Badge tone="idle">{humanise(run.stopReason)}</Badge> : <span className="dim">—</span>}</dd>
            <dt>Summary</dt>
            <dd>{run.summary ?? <span className="dim">—</span>}</dd>
          </dl>
        </div>

        <div className="card">
          <h2>Control</h2>
          {!canAct ? (
            <Empty>Your role is read-only. Approving and stopping runs requires the operator role.</Empty>
          ) : (
            <RunControls
              run={run}
              settings={settings}
              busy={busy}
              onSubmit={() => act(() => api.submitRun(run.id), 'Submitted for approval.')}
              onApprove={(notes, ack) =>
                act(() => api.approveRun(run.id, { notes, acknowledgeBelowThreshold: ack }), 'Approved and queued.')
              }
              onReject={(notes) => act(() => api.rejectRun(run.id, notes), 'Rejected and returned to draft.')}
              onCancel={(reason) => act(() => api.cancelRun(run.id, reason), 'Stop requested.')}
              onForceCancel={(reason) =>
                act(() => api.forceCancelRun(run.id, reason), 'Run force-cancelled without worker acknowledgement.')
              }
            />
          )}

          {approvals.length > 0 && (
            <>
              <h3 style={{ marginTop: 20 }}>Approval history</h3>
              <ul className="timeline">
                {approvals.map((approval) => (
                  <li key={approval.id}>
                    <div>
                      <strong>{approval.action}</strong> by {approval.approverName ?? 'unknown'}{' '}
                      <span className="dim">
                        <Time value={approval.createdAt} />
                      </span>
                    </div>
                    {approval.notes ? <div>{approval.notes}</div> : null}
                    <div className="meta">
                      confidence {approval.confidenceAtDecision !== null ? `${Math.round(approval.confidenceAtDecision * 100)}%` : '—'}
                      {approval.thresholdAtDecision !== null
                        ? ` · threshold ${Math.round(approval.thresholdAtDecision * 100)}%`
                        : ''}
                      {approval.thresholdOverridden ? ' · below-threshold approval acknowledged' : ''}
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </div>

      <div className="card">
        <h2>Log output</h2>
        <div
          className="logs"
          ref={logBox}
          onScroll={(e) => {
            const el = e.currentTarget;
            pinnedToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
          }}
        >
          {logs.length === 0 ? (
            <span className="dim">No output yet.</span>
          ) : (
            logs.map((line) => (
              <div className="log-line" key={line.id}>
                <span className="log-time">{new Date(line.ts).toLocaleTimeString()}</span>
                <span className={`log-${line.stream}`}>{line.message}</span>
              </div>
            ))
          )}
        </div>
        <p className="hint">
          Lines marked in italics are written by the control plane. Everything else came from the worker.
        </p>
      </div>

      {/*
        Sprint 2 panels. They render nothing at all for a run with no
        repository, so a Sprint 1 job's page looks exactly as it did.
      */}
      {run && <CodingRunPanels runId={run.id} status={run.status} />}

      <div className="card">
        <h2>Audit events</h2>
        {auditEvents.length === 0 ? (
          <Empty>No audit events.</Empty>
        ) : (
          <ul className="timeline">
            {auditEvents.map((event) => (
              <li key={event.id}>
                <div>
                  <span className="event">{event.eventType}</span>{' '}
                  <span className="dim">
                    <Time value={event.ts} />
                  </span>
                </div>
                <div className="meta">
                  {event.actorType}: {event.actorLabel}
                  {typeof event.metadata.from === 'string' ? ` · ${event.metadata.from} → ${event.metadata.to}` : ''}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function RunControls({
  run,
  settings,
  busy,
  onSubmit,
  onApprove,
  onReject,
  onCancel,
  onForceCancel,
}: {
  run: RunDto;
  settings: SettingsDto | null;
  busy: boolean;
  onSubmit: () => void;
  onApprove: (notes: string, acknowledge: boolean) => void;
  onReject: (notes: string) => void;
  onCancel: (reason: string) => void;
  onForceCancel: (reason: string) => void;
}) {
  const [notes, setNotes] = useState('');
  const [acknowledge, setAcknowledge] = useState(false);
  const [reason, setReason] = useState('');

  const confidence = run.confidence ?? 0;
  const floor = settings?.minExecutionConfidence ?? 0.6;
  const threshold = settings?.defaultConfidenceThreshold ?? 0.8;

  const belowFloor = confidence < floor;
  const belowThreshold = !belowFloor && confidence < threshold;
  const terminal = isTerminalRunStatus(run.status);
  const stopping = Boolean(run.cancelRequestedAt) && !terminal;

  if (terminal) {
    return <Empty>This run has finished. Runs are never reopened — create a new run instead.</Empty>;
  }

  if (run.status === 'draft' || run.status === 'discovery') {
    return (
      <>
        <p className="hint">This run has not been submitted for approval and cannot execute.</p>
        <button className="primary" disabled={busy} onClick={onSubmit}>
          Submit for approval
        </button>
      </>
    );
  }

  if (run.status === 'ready_for_approval') {
    return (
      <>
        {belowFloor && (
          <Alert kind="error">
            Confidence is {Math.round(confidence * 100)}%, below the {Math.round(floor * 100)}% minimum execution
            confidence. This run cannot be approved by anyone. More discovery is required.
          </Alert>
        )}
        {belowThreshold && (
          <Alert kind="warn">
            Confidence is {Math.round(confidence * 100)}%, below the {Math.round(threshold * 100)}% autonomy threshold.
            Approving requires an explicit acknowledgement and a note explaining the limited scope.
          </Alert>
        )}

        <Field label="Notes">
          <textarea
            value={notes}
            placeholder={belowThreshold ? 'Required: explain the limited scope you are authorising.' : 'Optional.'}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>

        {belowThreshold && (
          <div className="checkbox">
            <input
              id="ack"
              type="checkbox"
              checked={acknowledge}
              onChange={(e) => setAcknowledge(e.target.checked)}
            />
            <label htmlFor="ack">
              I am authorising a run below the autonomy threshold and accept the limited scope.
            </label>
          </div>
        )}

        <div className="actions">
          <button
            className="primary"
            disabled={busy || belowFloor || (belowThreshold && (!acknowledge || !notes.trim()))}
            onClick={() => onApprove(notes, acknowledge)}
          >
            Approve and queue
          </button>
          <button className="danger" disabled={busy || !notes.trim()} onClick={() => onReject(notes)}>
            Reject
          </button>
        </div>
        <p className="hint">Rejecting returns the run to draft with your note attached, so it can be revised.</p>
      </>
    );
  }

  // approved / queued / running / blocked / self_review / ready_for_human_review
  return (
    <>
      <Field label="Reason">
        <input value={reason} placeholder="Why are you stopping this?" onChange={(e) => setReason(e.target.value)} />
      </Field>
      <div className="actions">
        <button className="danger" disabled={busy || stopping} onClick={() => onCancel(reason)}>
          {stopping ? 'Stop already requested' : 'Stop run'}
        </button>
        {stopping && (
          <button className="danger" disabled={busy} onClick={() => onForceCancel(reason)}>
            Force cancel
          </button>
        )}
      </div>
      <p className="hint">
        {stopping
          ? 'Force cancel marks the run cancelled without waiting for the worker. Use it only when the worker is unreachable — it is recorded as a forced stop, and the worker may still be executing.'
          : 'The stop is delivered to the worker on its next call. The run finishes once the worker confirms it stopped.'}
      </p>
    </>
  );
}
