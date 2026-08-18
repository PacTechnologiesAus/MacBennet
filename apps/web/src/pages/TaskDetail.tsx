import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { CurrentUser, ExecutionMode, JobDescriptor, RunDto, TaskDto } from '@mac/protocol';
import { api, ApiError } from '../api.js';
import { Alert, Badge, Confidence, Field, Time } from '../components/ui.js';
import { RunTable } from './Dashboard.js';

export function TaskDetail({ user }: { user: CurrentUser }) {
  const { id } = useParams<{ id: string }>();
  const [task, setTask] = useState<TaskDto | null>(null);
  const [runs, setRuns] = useState<RunDto[]>([]);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);

  const canWrite = user.role !== 'viewer';

  const load = useCallback(() => {
    if (!id) return;
    api
      .getTask(id)
      .then((r) => {
        setTask(r.task);
        setRuns(r.runs);
      })
      .catch((err: Error) => setError(err.message));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  if (error && !task) return <Alert kind="error">{error}</Alert>;
  if (!task) return <p className="dim">Loading…</p>;

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
        {canWrite && (
          <button className="primary" onClick={() => setShowForm((v) => !v)}>
            {showForm ? 'Cancel' : 'New run'}
          </button>
        )}
      </div>

      <Alert kind="error">{error}</Alert>

      <div className="card">
        <dl className="kv">
          <dt>Status</dt>
          <dd>
            <Badge tone={task.status === 'done' ? 'ok' : task.status === 'blocked' ? 'danger' : 'idle'}>
              {task.status.replace(/_/g, ' ')}
            </Badge>
          </dd>
          <dt>Priority</dt>
          <dd>{task.priority}</dd>
          <dt>Confidence</dt>
          <dd>
            <Confidence value={task.confidence} />
          </dd>
          <dt>Description</dt>
          <dd style={{ whiteSpace: 'pre-wrap' }}>{task.description ?? <span className="dim">—</span>}</dd>
          <dt>Created</dt>
          <dd>
            <Time value={task.createdAt} />
          </dd>
        </dl>
      </div>

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
        Sprint 1 workers execute only the operations listed above. There is no way to run an arbitrary command from
        this interface, and the worker has no code path that would execute one.
      </p>

      <button type="submit" className="primary" disabled={busy}>
        {busy ? 'Creating…' : 'Create run'}
      </button>
    </form>
  );
}
