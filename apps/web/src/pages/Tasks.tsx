import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { CurrentUser, ProjectDto, TaskDto, TaskKind, TaskPriority } from '@mac/protocol';
import { TASK_KINDS, TASK_PRIORITIES, describeTaskKind } from '@mac/protocol';
import { api, ApiError } from '../api.js';
import { Alert, Badge, Confidence, Empty, Field, Time } from '../components/ui.js';

export function Tasks({ user }: { user: CurrentUser }) {
  const [tasks, setTasks] = useState<TaskDto[]>([]);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);

  const canWrite = user.role !== 'viewer';

  const load = () =>
    api
      .listTasks()
      .then((r) => setTasks(r.tasks))
      .catch((err: Error) => setError(err.message));

  useEffect(() => {
    void load();
  }, []);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Tasks</h1>
          <p>Units of work. A task is executed by creating a run against it and approving that run.</p>
        </div>
        {canWrite && (
          <button className="primary" onClick={() => setShowForm((v) => !v)}>
            {showForm ? 'Cancel' : 'New task'}
          </button>
        )}
      </div>

      <Alert kind="error">{error}</Alert>

      {showForm && canWrite && (
        <TaskForm
          onCreated={() => {
            setShowForm(false);
            void load();
          }}
          onError={setError}
        />
      )}

      <div className="card">
        {tasks.length === 0 ? (
          <Empty>No tasks yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Title</th>
                  <th>Project</th>
                  <th>Type</th>
                  <th>Origin</th>
                  <th>Status</th>
                  <th>Priority</th>
                  <th>Understanding</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((task) => (
                  <tr key={task.id}>
                    <td>
                      <Link to={`/tasks/${task.id}`}>{task.title}</Link>
                    </td>
                    <td className="dim">{task.projectName}</td>
                    <td>{describeTaskKind(task.taskKind).label}</td>
                    <td className="dim">{task.origin === 'monday' ? 'monday.com' : 'Mac'}</td>
                    <td>
                      <Badge tone={task.status === 'done' ? 'ok' : task.status === 'blocked' ? 'danger' : 'idle'}>
                        {task.status.replace(/_/g, ' ')}
                      </Badge>
                    </td>
                    <td>{task.priority}</td>
                    <td>
                      {/* Mac's DERIVED confidence, not the requester's estimate. */}
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

export function TaskForm({
  projectId,
  onCreated,
  onError,
}: {
  projectId?: string;
  onCreated: () => void;
  onError: (message: string) => void;
}) {
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [selectedProject, setSelectedProject] = useState(projectId ?? '');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<TaskPriority>('normal');
  const [taskKind, setTaskKind] = useState<TaskKind | ''>('');
  const [userInitialConfidence, setUserInitialConfidence] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (projectId) return;
    api
      .listProjects()
      .then((r) => {
        // Only active projects can take new tasks, so offering inactive ones
        // would just produce a confusing 409.
        const active = r.projects.filter((p) => p.isActive);
        setProjects(active);
        if (active[0] && !selectedProject) setSelectedProject(active[0].id);
      })
      .catch(() => undefined);
  }, [projectId]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    onError('');
    try {
      await api.createTask({
        projectId: projectId ?? selectedProject,
        title,
        ...(description ? { description } : {}),
        priority,
        // Left unset when the requester did not choose: Mac proposes a kind
        // during discovery, and a silent default is how research work came to
        // demand a repository.
        ...(taskKind ? { taskKind } : {}),
        ...(userInitialConfidence ? { userInitialConfidence: Number(userInitialConfidence) / 100 } : {}),
      });
      onCreated();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Could not create the task.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card" onSubmit={submit}>
      <h2>New task</h2>

      {!projectId && (
        <Field label="Project">
          <select value={selectedProject} required onChange={(e) => setSelectedProject(e.target.value)}>
            <option value="">Select a project…</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </Field>
      )}

      <Field label="Title">
        <input value={title} required autoFocus onChange={(e) => setTitle(e.target.value)} />
      </Field>

      <Field label="Description" hint="What is needed and why. This becomes part of the task's permanent record.">
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>

      <div className="grid grid-2">
        <Field label="Priority">
          <select value={priority} onChange={(e) => setPriority(e.target.value as TaskPriority)}>
            {TASK_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </Field>

        <Field
          label="Type of work"
          hint="Leave blank and Mac will propose one when discovery starts. Research and scoping need no repository."
        >
          <select value={taskKind} onChange={(e) => setTaskKind(e.target.value as TaskKind | '')}>
            <option value="">Let Mac decide</option>
            {TASK_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {describeTaskKind(kind).label}
              </option>
            ))}
          </select>
        </Field>
      </div>

      {/*
        Renamed and re-explained (reconciliation drift D-7).

        The old label was "Confidence (%)" and the old hint read "Mac's
        confidence in his understanding of this task" — which described the
        DERIVED number while collecting a typed one. Mac derives his own
        understanding confidence through discovery; this field is the
        requester's, it is optional, and it gates nothing.
      */}
      <Field
        label="Your own confidence in this request (%)"
        hint="Optional, and never used to decide whether Mac may execute. Mac derives his own understanding confidence through discovery."
      >
        <input
          type="number"
          min={0}
          max={100}
          value={userInitialConfidence}
          onChange={(e) => setUserInitialConfidence(e.target.value)}
        />
      </Field>

      <button type="submit" className="primary" disabled={busy}>
        {busy ? 'Creating…' : 'Create task'}
      </button>
    </form>
  );
}
