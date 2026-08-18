import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type {
  ArtefactDto,
  CurrentUser,
  DiscoverySessionDto,
  ExecutionMode,
  JobDescriptor,
  RunDto,
  TaskDto,
  TaskExecutionStateDto,
  TaskKind,
} from '@mac/protocol';
import { ARTEFACT_TYPE_LABELS, TASK_KINDS, describeTaskKind } from '@mac/protocol';
import { api, ApiError } from '../api.js';
import { Alert, Badge, Confidence, Field, Time } from '../components/ui.js';
import { RunTable } from './Dashboard.js';

/**
 * Task detail (Sprint 3.3 §26).
 *
 * ---------------------------------------------------------------------------
 * THE SCREEN THAT COULD NOT ANSWER THE QUESTION
 *
 * Before Sprint 3.3 this page showed a status, a priority, a confidence and a
 * "New run" button. A user created a perfectly good research task, looked at
 * this screen, and had no way to find out that the task would never execute or
 * what to do about it.
 *
 * So the page now leads with the two things that were missing: what kind of
 * work this is, and — in one sentence — what is stopping it. Everything else is
 * detail behind that.
 * ---------------------------------------------------------------------------
 */
export function TaskDetail({ user }: { user: CurrentUser }) {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [task, setTask] = useState<TaskDto | null>(null);
  const [runs, setRuns] = useState<RunDto[]>([]);
  const [execution, setExecution] = useState<TaskExecutionStateDto | null>(null);
  const [artefacts, setArtefacts] = useState<ArtefactDto[]>([]);
  const [discovery, setDiscovery] = useState<DiscoverySessionDto[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);

  const canWrite = user.role !== 'viewer';

  const load = useCallback(() => {
    if (!id) return;
    api
      .getTask(id)
      .then((r) => {
        setTask(r.task);
        setRuns(r.runs);
        setExecution(r.execution);
        setArtefacts(r.artefacts);
        setDiscovery(r.discovery);
      })
      .catch((err: Error) => setError(err.message));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const startDiscovery = async () => {
    if (!id) return;
    setBusy(true);
    setError('');
    try {
      const { discovery: session } = await api.startTaskDiscovery(id);
      navigate(`/discovery?session=${session.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not start discovery.');
    } finally {
      setBusy(false);
    }
  };

  const changeKind = async (taskKind: TaskKind) => {
    if (!id) return;
    setBusy(true);
    try {
      await api.updateTask(id, { taskKind });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not change the task type.');
    } finally {
      setBusy(false);
    }
  };

  if (error && !task) return <Alert kind="error">{error}</Alert>;
  if (!task || !execution) return <p className="dim">Loading…</p>;

  const openSession = discovery.find((s) => s.status !== 'closed') ?? discovery[0] ?? null;
  const descriptor = describeTaskKind(execution.taskKind);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>{task.title}</h1>
          <p>
            <Link to="/tasks">← All tasks</Link>
            {task.projectId ? (
              <>
                {' · '}
                <Link to={`/projects/${task.projectId}`}>{task.projectName ?? 'Project'}</Link>
              </>
            ) : null}
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          {canWrite && execution.discovery.canStart && (
            <button className="primary" disabled={busy} onClick={startDiscovery}>
              {busy ? 'Starting…' : 'Start Discovery'}
            </button>
          )}
          {canWrite && openSession && (
            <Link className="button" to={`/discovery?session=${openSession.id}`}>
              Continue Discovery
            </Link>
          )}
          {canWrite && <button onClick={() => setShowForm((v) => !v)}>{showForm ? 'Cancel' : 'New run'}</button>}
        </div>
      </div>

      <Alert kind="error">{error}</Alert>

      {/*
        The blocker, first and in plain words.

        This is the single most important element on the page: it is the answer
        the user came for, and it is produced by the same domain function the
        night scheduler uses, so the screen cannot disagree with the scheduler.
      */}
      {execution.blockerSummary ? (
        <Alert kind="warn">{execution.blockerSummary}</Alert>
      ) : (
        <Alert kind="ok">Everything this task needs is in place.</Alert>
      )}

      <div className="card">
        <dl className="kv">
          <dt>Task type</dt>
          <dd>
            {canWrite ? (
              <select
                value={execution.taskKind}
                disabled={busy}
                onChange={(e) => changeKind(e.target.value as TaskKind)}
              >
                {TASK_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {describeTaskKind(kind).label}
                  </option>
                ))}
              </select>
            ) : (
              descriptor.label
            )}
            <span className="hint" style={{ display: 'block', marginTop: 4 }}>
              {descriptor.description}
            </span>
          </dd>

          <dt>Origin</dt>
          <dd>
            <Badge tone={execution.origin === 'monday' ? 'idle' : 'ok'}>
              {execution.origin === 'monday' ? 'monday.com item' : 'Created in Mac'}
            </Badge>
          </dd>

          <dt>Status</dt>
          <dd>
            <Badge tone={task.status === 'done' ? 'ok' : task.status === 'blocked' ? 'danger' : 'idle'}>
              {task.status.replace(/_/g, ' ')}
            </Badge>
          </dd>

          <dt>Priority</dt>
          <dd>{task.priority}</dd>

          {/*
            Two confidences, labelled so they cannot be confused.

            Reconciliation drift D-7: before Sprint 3.3 both appeared under the
            single word "Confidence", which invited a manual number to be read
            as Mac's own assessment. Only the derived one gates execution, and
            the labels now say which is which.
          */}
          <dt>Understanding confidence</dt>
          <dd>
            <Confidence value={execution.understandingConfidence} />
            <span className="hint" style={{ display: 'block' }}>
              Derived by Mac through discovery. This is the number that decides whether he may execute.
            </span>
          </dd>

          <dt>Requester&rsquo;s initial estimate</dt>
          <dd>
            {task.userInitialConfidence === null ? (
              <span className="dim">—</span>
            ) : (
              `${(task.userInitialConfidence * 100).toFixed(0)}%`
            )}
            <span className="hint" style={{ display: 'block' }}>
              What the person who raised this thought. Never used as an execution gate.
            </span>
          </dd>

          <dt>Discovery</dt>
          <dd>
            {openSession ? (
              <>
                <Badge tone={openSession.status === 'ready' ? 'ok' : 'idle'}>
                  {openSession.status.replace(/_/g, ' ')}
                </Badge>{' '}
                <Link to={`/discovery?session=${openSession.id}`}>open</Link>
              </>
            ) : (
              <span className="dim">Not started</span>
            )}
          </dd>

          <dt>Description</dt>
          <dd style={{ whiteSpace: 'pre-wrap' }}>{task.description ?? <span className="dim">—</span>}</dd>

          <dt>Created</dt>
          <dd>
            <Time value={task.createdAt} />
          </dd>
        </dl>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <h2>What this work needs</h2>
          <p className="hint">
            Derived from the task type and where it came from. A research task needs no repository; a direct task
            needs no monday.com item.
          </p>
          <ul className="checklist">
            {execution.requirements.map((r) => (
              <li key={r.requirement}>
                <Badge tone={r.satisfied ? 'ok' : 'danger'}>{r.satisfied ? 'yes' : 'no'}</Badge>{' '}
                <strong>{r.label}</strong>
                <div className="hint">{r.detail}</div>
              </li>
            ))}
          </ul>
        </div>

        <div className="card">
          <h2>Project</h2>
          <dl className="kv">
            <dt>Has</dt>
            <dd>
              {execution.projectCapabilities.length ? (
                execution.projectCapabilities.map((c) => (
                  <Badge key={c} tone="idle">
                    {c.replace(/_/g, ' ')}
                  </Badge>
                ))
              ) : (
                <span className="dim">Nothing declared</span>
              )}
            </dd>
            <dt>Allowed work</dt>
            <dd>
              {execution.allowedTaskKinds.length ? (
                execution.allowedTaskKinds.map((k) => (
                  <Badge key={k} tone="ok">
                    {describeTaskKind(k).label}
                  </Badge>
                ))
              ) : (
                <span className="dim">
                  Nothing configured — coding only, until an administrator allows more.
                </span>
              )}
            </dd>
          </dl>
        </div>
      </div>

      {execution.eligibility && (
        <div className="card">
          <h2>Could Mac start this tonight?</h2>
          <p className="hint">{execution.eligibility.summary}</p>
          <ul className="checklist">
            {execution.eligibility.checks.map((c) => (
              <li key={c.code}>
                <Badge tone={c.ok ? 'ok' : 'danger'}>{c.ok ? 'yes' : 'no'}</Badge>{' '}
                <strong>{c.code.replace(/_/g, ' ')}</strong>
                <div className="hint">{c.detail}</div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {artefacts.length > 0 && (
        <div className="card">
          <h2>Results</h2>
          <ArtefactList artefacts={artefacts} />
        </div>
      )}

      {showForm && canWrite && (
        <RunForm
          taskId={task.id}
          onCreated={() => {
            setShowForm(false);
            load();
          }}
          onError={setError}
        />
      )}

      <div className="card">
        <h2>Runs</h2>
        <RunTable runs={runs} emptyText="No runs for this task yet." />
      </div>
    </>
  );
}

/**
 * Artefacts, with the distinction that matters made visible.
 *
 * Established facts are counted separately from everything else, because a
 * reader deciding whether to act on a recommendation needs to know how much of
 * it rests on something checkable.
 */
export function ArtefactList({ artefacts }: { artefacts: ArtefactDto[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Title</th>
            <th>Type</th>
            <th>Established</th>
            <th>Inferred</th>
            <th>PAC context</th>
            <th>Produced</th>
          </tr>
        </thead>
        <tbody>
          {artefacts.map((a) => {
            const established = a.findings.filter((f) =>
              ['pac_fact', 'project_fact', 'external_fact', 'user_approved_decision'].includes(f.evidenceClass),
            ).length;
            return (
              <tr key={a.id}>
                <td>
                  <Link to={`/artefacts/${a.id}`}>{a.title}</Link>
                  {a.summary ? <div className="hint">{a.summary.slice(0, 160)}</div> : null}
                </td>
                <td>{ARTEFACT_TYPE_LABELS[a.type]}</td>
                <td>{established}</td>
                <td>{a.findings.length - established}</td>
                <td className="dim">{a.companyContext?.shortSha ?? '—'}</td>
                <td>
                  <Time value={a.createdAt} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Run creation.
 *
 * The job dropdown is populated from the server's allowlist rather than from a
 * list hard-coded here, so the UI can only ever offer operations the backend
 * will actually accept. There is deliberately no free-text command field —
 * the protocol has no place to put one.
 */
function RunForm({
  taskId,
  onCreated,
  onError,
}: {
  taskId: string;
  onCreated: () => void;
  onError: (message: string) => void;
}) {
  const navigate = useNavigate();
  const [jobs, setJobs] = useState<JobDescriptor[]>([]);
  const [jobKind, setJobKind] = useState('noop');
  const [message, setMessage] = useState('Hello from Sprint 1.');
  const [seconds, setSeconds] = useState('10');
  const [confidence, setConfidence] = useState('90');
  const [executionMode, setExecutionMode] = useState<ExecutionMode>('interactive');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .jobCatalogue()
      .then((r) => setJobs(r.jobs))
      .catch(() => undefined);
  }, []);

  const selected = jobs.find((j) => j.kind === jobKind);

  const buildParams = (): Record<string, unknown> => {
    if (jobKind === 'echo') return { message };
    if (jobKind === 'sleep') return { seconds: Number(seconds) };
    if (jobKind === 'fail') return { message };
    return {};
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    onError('');
    try {
      const { run } = await api.createRun({
        taskId,
        jobKind: jobKind as never,
        jobParams: buildParams(),
        confidence: Number(confidence) / 100,
        executionMode,
      });
      onCreated();
      // Straight to the run so the operator can submit and approve it without
      // hunting for it in a list.
      navigate(`/runs/${run.id}`);
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Could not create the run.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card" onSubmit={submit}>
      <h2>New run</h2>

      <Field label="Operation" hint={selected?.description}>
        <select value={jobKind} onChange={(e) => setJobKind(e.target.value)}>
          {jobs.map((job) => (
            <option key={job.kind} value={job.kind}>
              {job.label}
            </option>
          ))}
        </select>
      </Field>

      {(jobKind === 'echo' || jobKind === 'fail') && (
        <Field label="Message">
          <input value={message} maxLength={500} onChange={(e) => setMessage(e.target.value)} />
        </Field>
      )}

      {jobKind === 'sleep' && (
        <Field label="Seconds" hint="1–120. The run can be stopped remotely while it sleeps.">
          <input type="number" min={1} max={120} value={seconds} onChange={(e) => setSeconds(e.target.value)} />
        </Field>
      )}

      <div className="grid grid-2">
        <Field
          label="Confidence (%)"
          hint="Below 60% cannot be approved at all. Below 80% requires an explicit acknowledgement."
        >
          <input
            type="number"
            min={0}
            max={100}
            value={confidence}
            required
            onChange={(e) => setConfidence(e.target.value)}
          />
        </Field>

        <Field
          label="Execution mode"
          hint="Overnight runs are stopped at the configured cutoff. Interactive runs are not."
        >
          <select value={executionMode} onChange={(e) => setExecutionMode(e.target.value as ExecutionMode)}>
            <option value="interactive">Interactive (now)</option>
            <option value="overnight">Overnight (subject to cutoff)</option>
          </select>
        </Field>
      </div>

      <p className="hint" style={{ marginBottom: 12 }}>
        Workers execute only the operations listed above. There is no way to run an arbitrary command from this
        interface, and the worker has no code path that would execute one.
      </p>

      <button type="submit" className="primary" disabled={busy}>
        {busy ? 'Creating…' : 'Create run'}
      </button>
    </form>
  );
}
