import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { CurrentUser, ProjectDto } from '@mac/protocol';
import { api, ApiError } from '../api.js';
import { Alert, Badge, Empty, Field, Time } from '../components/ui.js';

export function Projects({ user }: { user: CurrentUser }) {
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);

  const canWrite = user.role !== 'viewer';

  const load = () =>
    api
      .listProjects()
      .then((r) => setProjects(r.projects))
      .catch((err: Error) => setError(err.message));

  useEffect(() => {
    void load();
  }, []);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Projects</h1>
          <p>Repositories Mac is approved to work on. Sprint 1 records the reference; nothing is cloned yet.</p>
        </div>
        {canWrite && (
          <button className="primary" onClick={() => setShowForm((v) => !v)}>
            {showForm ? 'Cancel' : 'New project'}
          </button>
        )}
      </div>

      <Alert kind="error">{error}</Alert>

      {showForm && canWrite && (
        <ProjectForm
          onCreated={() => {
            setShowForm(false);
            void load();
          }}
          onError={setError}
        />
      )}

      <div className="card">
        {projects.length === 0 ? (
          <Empty>No projects yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Repository</th>
                  <th>State</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {projects.map((project) => (
                  <tr key={project.id}>
                    <td>
                      <Link to={`/projects/${project.id}`}>{project.name}</Link>
                      <div className="dim mono" style={{ fontSize: 12 }}>{project.slug}</div>
                    </td>
                    <td className="mono">{project.repoUrl ?? <span className="dim">—</span>}</td>
                    <td>
                      {project.isActive ? <Badge tone="ok">active</Badge> : <Badge tone="idle">inactive</Badge>}
                    </td>
                    <td>
                      <Time value={project.createdAt} />
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

function ProjectForm({ onCreated, onError }: { onCreated: () => void; onError: (message: string) => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [repoUrl, setRepoUrl] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    onError('');
    try {
      await api.createProject({
        name,
        ...(description ? { description } : {}),
        ...(repoUrl ? { repoUrl } : {}),
      });
      onCreated();
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Could not create the project.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card" onSubmit={submit}>
      <h2>New project</h2>
      <Field label="Name">
        <input value={name} required autoFocus onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Description">
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <Field
        label="Repository reference"
        hint="An https:// URL or an SSH reference such as git@github.com:pac-technologies/forger.git"
      >
        <input value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} />
      </Field>
      <button type="submit" className="primary" disabled={busy}>
        {busy ? 'Creating…' : 'Create project'}
      </button>
    </form>
  );
}
