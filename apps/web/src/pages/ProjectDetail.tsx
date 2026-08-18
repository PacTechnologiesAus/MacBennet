import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { CurrentUser, ProjectCapability, ProjectDto, TaskDto, TaskKind } from '@mac/protocol';
import {
  PROJECT_CAPABILITIES,
  PROJECT_CAPABILITY_LABELS,
  TASK_KINDS,
  describeTaskKind,
} from '@mac/protocol';
import { api, ApiError } from '../api.js';
import { Alert, Badge, Confidence, Empty, Time } from '../components/ui.js';
import { TaskForm } from './Tasks.js';

export function ProjectDetail({ user }: { user: CurrentUser }) {
  const { id } = useParams<{ id: string }>();
  const [project, setProject] = useState<ProjectDto | null>(null);
  const [tasks, setTasks] = useState<TaskDto[]>([]);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);

  const canWrite = user.role !== 'viewer';

  const load = useCallback(() => {
    if (!id) return;
    api
      .getProject(id)
      .then((r) => {
        setProject(r.project);
        setTasks(r.tasks);
      })
      .catch((err: Error) => setError(err.message));
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const toggleActive = async () => {
    if (!project) return;
    try {
      await api.updateProject(project.id, { isActive: !project.isActive });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (error) return <Alert kind="error">{error}</Alert>;
  if (!project) return <p className="dim">Loading…</p>;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>{project.name}</h1>
          <p>
            <Link to="/projects">← All projects</Link>
          </p>
        </div>
        <div className="actions">
          {canWrite && (
            <>
              <button onClick={() => void toggleActive()}>
                {project.isActive ? 'Deactivate' : 'Reactivate'}
              </button>
              <button className="primary" onClick={() => setShowForm((v) => !v)}>
                {showForm ? 'Cancel' : 'New task'}
              </button>
            </>
          )}
        </div>
      </div>

      <div className="card">
        <dl className="kv">
          <dt>State</dt>
          <dd>{project.isActive ? <Badge tone="ok">active</Badge> : <Badge tone="idle">inactive</Badge>}</dd>
          <dt>Repository</dt>
          <dd className="mono">{project.repoUrl ?? <span className="dim">not set</span>}</dd>
          <dt>Default branch</dt>
          <dd className="mono">{project.repoDefaultBranch ?? '—'}</dd>
          <dt>Description</dt>
          <dd>{project.description ?? <span className="dim">—</span>}</dd>
          <dt>Created</dt>
          <dd>
            <Time value={project.createdAt} />
          </dd>
          <dt>Updated</dt>
          <dd>
            <Time value={project.updatedAt} />
          </dd>
        </dl>
      </div>

      {!project.isActive && (
        <Alert kind="warn">
          This project is inactive. New tasks and runs cannot be created against it.
        </Alert>
      )}

      <CapabilityPanel project={project} user={user} onSaved={load} onError={setError} />

      {showForm && canWrite && (
        <TaskForm
          projectId={project.id}
          onCreated={() => {
            setShowForm(false);
            load();
          }}
          onError={setError}
        />
      )}

      <div className="card">
        <h2>Tasks</h2>
        {tasks.length === 0 ? (
          <Empty>No tasks in this project yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Status</th>
                  <th>Priority</th>
                  <th>Confidence</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => (
                  <tr key={task.id}>
                    <td>
                      <Link to={`/tasks/${task.id}`}>{task.title}</Link>
                    </td>
                    <td>
                      <Badge tone={task.status === 'done' ? 'ok' : task.status === 'blocked' ? 'danger' : 'idle'}>
                        {task.status.replace(/_/g, ' ')}
                      </Badge>
                    </td>
                    <td>{task.priority}</td>
                    <td>
                      <Confidence value={task.understandingConfidence} />
                    </td>
                    <td>
                      <Time value={task.createdAt} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

/**
 * What a project has, and what Mac is allowed to do here (Sprint 3.3 §6, §21).
 *
 * ---------------------------------------------------------------------------
 * TWO AXES, AND ONLY ONE OF THEM IS A PERMISSION
 *
 * `capabilities` describes resources: this project has a repository, a board, a
 * Dropbox folder. Editing it is bookkeeping.
 *
 * `allowedTaskKinds` decides what Mac may do here unsupervised overnight.
 * Editing it is an authority grant, which is why the endpoint behind it is
 * admin-only and why the two are presented as visibly different things rather
 * than as one list of checkboxes.
 *
 * `PAC Internal Development` reaches this screen after migration with an empty
 * allowlist, which is deliberate: Sprint 3.3 §21 requires a human to approve it
 * for autonomous work, and a migration that ticked the box would be the machine
 * granting itself the permission.
 * ---------------------------------------------------------------------------
 */
function CapabilityPanel({
  project,
  user,
  onSaved,
  onError,
}: {
  project: ProjectDto;
  user: CurrentUser;
  onSaved: () => void;
  onError: (message: string) => void;
}) {
  const [capabilities, setCapabilities] = useState<ProjectCapability[]>(project.capabilities);
  const [allowedTaskKinds, setAllowedTaskKinds] = useState<TaskKind[]>(project.allowedTaskKinds);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setCapabilities(project.capabilities);
    setAllowedTaskKinds(project.allowedTaskKinds);
  }, [project.capabilities, project.allowedTaskKinds]);

  const isAdmin = user.role === 'admin';

  const toggle = <T,>(list: T[], value: T): T[] =>
    list.includes(value) ? list.filter((v) => v !== value) : [...list, value];

  const save = async () => {
    setBusy(true);
    onError('');
    try {
      await api.updateProjectCapabilities(project.id, { capabilities, allowedTaskKinds });
      onSaved();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Could not update the project.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="card">
      <h2>Capabilities and permitted work</h2>

      <h3 style={{ fontSize: 13, marginBottom: 4 }}>What this project has</h3>
      <p className="hint">A statement of fact. Declaring a resource does not grant Mac permission to use it.</p>
      <div style={{ display: 'grid', gap: 6, marginBottom: 16 }}>
        {PROJECT_CAPABILITIES.map((capability) => (
          <label className="inline" key={capability}>
            <input
              type="checkbox"
              disabled={!isAdmin || busy}
              checked={capabilities.includes(capability)}
              onChange={() => setCapabilities((c) => toggle(c, capability))}
            />
            {PROJECT_CAPABILITY_LABELS[capability]}
          </label>
        ))}
      </div>

      <h3 style={{ fontSize: 13, marginBottom: 4 }}>What Mac may do here</h3>
      <p className="hint">
        An authority grant. Mac may take on these kinds of work autonomously overnight, subject to every other
        guardrail. Leave everything unticked and only coding is permitted &mdash; exactly what was possible before
        task kinds existed.
      </p>
      <div style={{ display: 'grid', gap: 6 }}>
        {TASK_KINDS.map((kind) => (
          <label className="inline" key={kind}>
            <input
              type="checkbox"
              disabled={!isAdmin || busy}
              checked={allowedTaskKinds.includes(kind)}
              onChange={() => setAllowedTaskKinds((k) => toggle(k, kind))}
            />
            <span>
              {describeTaskKind(kind).label}
              <span className="hint" style={{ display: 'block' }}>
                {describeTaskKind(kind).description}
              </span>
            </span>
          </label>
        ))}
      </div>

      {isAdmin ? (
        <div className="button-row">
          <button className="primary" disabled={busy} onClick={save}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      ) : (
        <p className="hint" style={{ marginTop: 10 }}>
          Only an administrator may change what Mac is permitted to do in a project.
        </p>
      )}
    </div>
  );
}
