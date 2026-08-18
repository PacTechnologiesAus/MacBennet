import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { BriefDto, CurrentUser, DiscoverySessionDto, ProjectDto, RepositoryDto } from '@mac/protocol';
import { api, ApiError } from '../api.js';
import { CompanyContextBadge } from './CompanyContext.js';
import { Badge, humanise } from '../components/ui.js';

/**
 * Discovery (spec §4).
 *
 * The screen deliberately mirrors the order of the conversation rather than
 * presenting a form: the human picks a project, sees what Mac read, talks
 * freely, and only then is asked one question at a time. A form would have been
 * less code and the wrong product.
 */
export function Discovery({ user }: { user: CurrentUser }) {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<ProjectDto[]>([]);
  const [repositories, setRepositories] = useState<RepositoryDto[]>([]);
  const [projectId, setProjectId] = useState('');
  const [title, setTitle] = useState('');
  const [session, setSession] = useState<DiscoverySessionDto | null>(null);
  const [brief, setBrief] = useState<BriefDto | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canWrite = user.role !== 'viewer';

  useEffect(() => {
    void api.listProjects().then((r) => setProjects(r.projects.filter((p) => p.isActive)));
  }, []);

  useEffect(() => {
    if (!projectId) return setRepositories([]);
    void api.listRepositories(projectId).then((r) => setRepositories(r.repositories));
  }, [projectId]);

  const guard = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const start = () =>
    guard(async () => {
      const result = await api.startDiscovery({ projectId, title });
      setSession(result.session);
      setBrief(null);
    });

  const send = () =>
    guard(async () => {
      if (!session || !message.trim()) return;
      const result = await api.sendDiscoveryMessage(session.id, message.trim());
      setSession(result.session);
      setMessage('');
      // Answering a question changes the brief's confidence, so refresh it.
      if (result.session.briefId) setBrief((await api.getBrief(result.session.briefId)).brief);
    });

  const structure = () =>
    guard(async () => {
      if (!session) return;
      const result = await api.generateBrief(session.id);
      setSession(result.session);
      setBrief(result.brief);
    });

  const approvedRepository = repositories.find((r) => r.isApproved);

  const createRun = () =>
    guard(async () => {
      if (!session || !brief || !approvedRepository) return;
      const run = await api.createCodingRun({
        taskId: session.taskId,
        repositoryId: approvedRepository.id,
        briefId: brief.id,
        provider: 'claude_code',
        executionMode: 'overnight',
        maxMinutes: 60,
        openPullRequest: true,
      });
      navigate(`/runs/${run.run.id}`);
    });

  return (
    <>
      <header className="page-header">
        <h1>Discovery</h1>
        <p className="dim">
          Hand Mac a piece of work the way you would hand it to another engineer at the end of a shift.
        </p>
      </header>

      {error && <div className="card" style={{ borderColor: 'var(--danger)' }}>{error}</div>}

      {!session && (
        <section className="card">
          <h2>Choose a project</h2>
          <p className="dim">
            Mac never guesses which project you mean when there is more than one.
          </p>
          <div className="form-row">
            <label>
              Project
              <select value={projectId} onChange={(e) => setProjectId(e.target.value)}>
                <option value="">Select a project…</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </select>
            </label>
            <label>
              What is the work?
              <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Allow selecting multiple devices" />
            </label>
          </div>
          <button disabled={!canWrite || !projectId || !title.trim() || busy} onClick={() => void start()}>
            Start discovery
          </button>
        </section>
      )}

      {session && (
        <>
          <section className="card">
            <h2>{session.taskTitle}</h2>
            <p className="dim">
              {session.projectName} · {humanise(session.status)}{' '}
              <CompanyContextBadge context={session.companyContext} />
            </p>

            <h3>What Mac read before asking anything</h3>
            {session.contextSummary ? (
              <p>{session.contextSummary}</p>
            ) : (
              <p className="dim">
                No repository inspection has run for this project yet. Mac will work from what you tell him,
                and his confidence will be lower for it.
              </p>
            )}
          </section>

          <section className="card">
            <h2>Conversation</h2>
            <div className="conversation">
              {session.messages.map((m, index) => (
                <div key={index} className={`message message-${m.role}`}>
                  <div className="dim small">{m.role === 'mac' ? 'Mac' : 'You'}</div>
                  <div>{m.message}</div>
                </div>
              ))}
              {session.messages.length === 0 && (
                <p className="dim">Describe the work in your own words. Mac will listen before asking anything.</p>
              )}
            </div>

            {session.pendingQuestion && (
              <div className="callout">
                <strong>Mac asks:</strong> {session.pendingQuestion.question}
              </div>
            )}

            <textarea
              rows={4}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={session.pendingQuestion ? 'Answer Mac…' : 'Tell Mac about the work…'}
            />
            <div className="button-row">
              <button disabled={!canWrite || !message.trim() || busy} onClick={() => void send()}>
                Send
              </button>
              <button className="secondary" disabled={!canWrite || busy} onClick={() => void structure()}>
                {brief ? 'Update the brief' : 'Turn this into a brief'}
              </button>
            </div>
          </section>
        </>
      )}

      {brief && <BriefPanel brief={brief} />}

      {brief && (
        <section className="card">
          <h2>Execution</h2>
          <p>{brief.executionAdvice.message}</p>

          {!brief.executionAdvice.executionPermitted && (
            <p className="dim">Keep talking to Mac until he understands enough to start.</p>
          )}

          {brief.executionAdvice.executionPermitted && !approvedRepository && (
            <p className="dim">
              This project has no approved repository. An administrator must add and approve one before Mac
              can write code.
            </p>
          )}

          <button
            disabled={!canWrite || busy || !brief.executionAdvice.executionPermitted || !approvedRepository}
            onClick={() => void createRun()}
          >
            Create a coding run
          </button>
          {brief.executionAdvice.requiresExplicitScopeApproval && (
            <p className="dim small">
              You will be asked to approve the limited scope explicitly, because Mac's understanding is below
              the autonomy threshold.
            </p>
          )}
        </section>
      )}
    </>
  );
}

/** The handoff brief, human-readable, with the confidence explained. */
export function BriefPanel({ brief }: { brief: BriefDto }) {
  const percent = Math.round(brief.confidence * 100);
  const tone = brief.confidenceBand === 'below_floor' ? 'danger' : brief.confidenceBand === 'limited_scope' ? 'warn' : 'ok';
  const unresolved = brief.content.openQuestions.filter((q) => q.answer === null);

  return (
    <section className="card">
      <div className="row-between">
        <h2>Handoff brief</h2>
        <Badge tone={tone}>{percent}% · {humanise(brief.confidenceBand)}</Badge>
      </div>

      <details>
        <summary>How that confidence was calculated</summary>
        <table className="table">
          <thead>
            <tr><th>Dimension</th><th>Known</th><th>Weight</th><th>Source</th></tr>
          </thead>
          <tbody>
            {brief.completeness.map((c) => (
              <tr key={c.dimension}>
                <td>{humanise(c.dimension)}</td>
                <td>{c.satisfied ? 'yes' : c.discoverableFrom.length ? 'from the repository' : 'no'}</td>
                <td className="dim">{Math.round(c.weight * 100)}%</td>
                <td className="dim small">{c.discoverableFrom.join('; ') || (c.satisfied ? 'you told Mac' : '—')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>

      {unresolved.length > 0 && (
        <>
          <h3>Unresolved questions</h3>
          <ul>{unresolved.map((q) => <li key={q.id}>{q.question}</li>)}</ul>
        </>
      )}

      <details open>
        <summary>The brief Mac will hand to the coding agent</summary>
        <pre className="markdown">{brief.markdown}</pre>
      </details>
    </section>
  );
}
