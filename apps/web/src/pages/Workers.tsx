import { useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import type { CurrentUser, EnrollmentTokenDto, WorkerDto } from '@mac/protocol';
import { api, ApiError } from '../api.js';
import { Alert, Badge, Empty, Field, Time, WorkerStatusBadge } from '../components/ui.js';

export function Workers({ user }: { user: CurrentUser }) {
  const [workers, setWorkers] = useState<WorkerDto[]>([]);
  const [tokens, setTokens] = useState<EnrollmentTokenDto[]>([]);
  const [issued, setIssued] = useState<string | null>(null);
  const [error, setError] = useState('');

  const isAdmin = user.role === 'admin';

  const load = () => {
    api
      .listWorkers()
      .then((r) => setWorkers(r.workers))
      .catch((err: Error) => setError(err.message));
    if (isAdmin) {
      api
        .listEnrollmentTokens()
        .then((r) => setTokens(r.tokens))
        .catch(() => undefined);
    }
  };

  useEffect(() => {
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [isAdmin]);

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Workers</h1>
          <p>
            Machines approved to execute runs. Workers connect outbound only — the control plane never dials a worker,
            so a worker VM needs no inbound ports.
          </p>
        </div>
      </div>

      <Alert kind="error">{error}</Alert>

      {issued && (
        <div className="card">
          <Alert kind="warn">
            This is the only time this enrollment token will be shown. Copy it into the worker&apos;s{' '}
            <code>MAC_ENROLLMENT_TOKEN</code> now — only a hash is stored here.
          </Alert>
          <div className="token-reveal">{issued}</div>
          <button onClick={() => setIssued(null)}>I have copied it</button>
        </div>
      )}

      <div className="card">
        <h2>Registered workers</h2>
        {workers.length === 0 ? (
          <Empty>
            No workers yet. {isAdmin ? 'Create an enrollment token below and start a worker with it.' : 'Ask an administrator for an enrollment token.'}
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
                  <th>Capabilities</th>
                  <th>Version</th>
                  <th>Token</th>
                </tr>
              </thead>
              <tbody>
                {workers.map((worker) => (
                  <tr key={worker.id}>
                    <td>
                      {worker.name}
                      <div className="dim" style={{ fontSize: 12 }}>{worker.platform}</div>
                    </td>
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
                    <td className="mono" style={{ fontSize: 12 }}>
                      {worker.capabilities.join(', ')}
                    </td>
                    <td className="dim">{worker.version}</td>
                    {/* Only a display prefix — the token itself is stored as a hash. */}
                    <td className="mono dim" style={{ fontSize: 12 }}>{worker.tokenPrefix}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {isAdmin && (
        <>
          <EnrollmentForm onIssued={(token) => { setIssued(token); load(); }} onError={setError} />

          <div className="card">
            <h2>Enrollment tokens</h2>
            {tokens.length === 0 ? (
              <Empty>No enrollment tokens issued.</Empty>
            ) : (
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Label</th>
                      <th>State</th>
                      <th>Expires</th>
                      <th>Created</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tokens.map((token) => {
                      const expired = new Date(token.expiresAt).getTime() < Date.now();
                      return (
                        <tr key={token.id}>
                          <td>{token.label}</td>
                          <td>
                            {token.usedAt ? (
                              <Badge tone="idle">used</Badge>
                            ) : expired ? (
                              <Badge tone="danger">expired</Badge>
                            ) : (
                              <Badge tone="ok">available</Badge>
                            )}
                          </td>
                          <td>
                            <Time value={token.expiresAt} />
                          </td>
                          <td>
                            <Time value={token.createdAt} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>
      )}
    </>
  );
}

function EnrollmentForm({
  onIssued,
  onError,
}: {
  onIssued: (token: string) => void;
  onError: (message: string) => void;
}) {
  const [label, setLabel] = useState('');
  const [hours, setHours] = useState('24');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    onError('');
    try {
      const { token } = await api.createEnrollmentToken(label, Number(hours));
      if (token.token) onIssued(token.token);
      setLabel('');
    } catch (err) {
      onError(err instanceof ApiError ? err.message : 'Could not create the token.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card" onSubmit={submit}>
      <h2>New enrollment token</h2>
      <p className="hint" style={{ marginBottom: 12 }}>
        Single use, and it expires. A worker exchanges it once for a long-lived worker token which it stores locally,
        so this is only needed the first time a worker starts.
      </p>
      <div className="grid grid-2">
        <Field label="Label" hint="Which machine is this for?">
          <input value={label} required placeholder="mac-worker-01" onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="Valid for (hours)">
          <input type="number" min={1} max={720} value={hours} onChange={(e) => setHours(e.target.value)} />
        </Field>
      </div>
      <button type="submit" className="primary" disabled={busy}>
        {busy ? 'Creating…' : 'Create token'}
      </button>
    </form>
  );
}
