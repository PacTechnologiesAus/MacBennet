import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { CurrentUser, ProjectDto, TaskDto } from '@mac/protocol';
import { api } from '../api.js';
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
                      <Confidence value={task.confidence} />
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
