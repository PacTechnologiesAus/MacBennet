import { useCallback, useEffect, useState } from 'react';
import type { CurrentUser, SecurityOverviewDto, WorkerSecurityDto } from '@mac/protocol';
import { api, ApiError } from '../api.js';
import { Alert, Badge, Empty, Time, humanise } from '../components/ui.js';

/**
 * Worker credentials and containment (Sprint 3 §14).
 *
 * The question this screen answers is "is this fleet in a state I am
 * comfortable leaving overnight?", which is why credential age and sandbox
 * status sit next to each other rather than on separate pages: they are the two
 * halves of the same judgement.
 */
export function Security({ user }: { user: CurrentUser }) {
  const [security, setSecurity] = useState<SecurityOverviewDto | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    try {
      setSecurity((await api.security()).security);
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (user.role !== 'admin') {
    return (
      <div className="card">
        <Empty>Credential and containment state is visible to administrators only.</Empty>
      </div>
    );
  }

  const act = async (fn: () => Promise<unknown>, message: string) => {
    try {
      await fn();
      await load();
      setNotice(message);
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  if (!security) return <p className="dim">Loading…</p>;

  const withheld = security.workers.filter((w) => w.codingWorkWithheld);
  const stale = security.workers.filter(
    (w) => w.activeToken && w.activeToken.ageHours > security.workerTokenMaxAgeHours,
  );

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Security</h1>
          <p className="dim">Worker credentials and the containment boundary around coding sessions.</p>
        </div>
      </div>

      <Alert kind="error">{error}</Alert>
      <Alert kind="ok">{notice}</Alert>

      <div className="card">
        <div className="stat-row">
          <Stat
            label="Sandbox required"
            value={
              <Badge tone={security.requireSandbox ? 'ok' : 'danger'}>
                {security.requireSandbox ? 'yes' : 'no'}
              </Badge>
            }
          />
          <Stat label="Credential max age" value={`${security.workerTokenMaxAgeHours}h`} />
          <Stat label="Rotation overlap" value={`${security.workerTokenOverlapSeconds}s`} />
          <Stat label="Workers" value={String(security.workers.length)} />
        </div>
        {!security.requireSandbox && (
          <p className="hint danger-text">
            Coding sessions may currently run without an OS-enforced sandbox. This is a development setting; turn it
            back on in Settings before leaving Mac to work unattended.
          </p>
        )}
        {withheld.length > 0 && (
          <p className="hint">
            Coding work is being withheld from {withheld.length} worker(s) because they have not attested a working
            sandbox. Non-coding jobs are unaffected.
          </p>
        )}
        {stale.length > 0 && (
          <p className="hint">
            {stale.length} credential(s) are older than the configured maximum and have been asked to rotate. The
            worker performs the rotation itself on its next call; nobody needs to touch the VM.
          </p>
        )}
      </div>

      {security.workers.length === 0 ? (
        <div className="card">
          <Empty>No workers have registered yet.</Empty>
        </div>
      ) : (
        security.workers.map((worker) => <WorkerCard key={worker.workerId} worker={worker} onAct={act} />)
      )}
    </>
  );
}

function WorkerCard({
  worker,
  onAct,
}: {
  worker: WorkerSecurityDto;
  onAct: (fn: () => Promise<unknown>, message: string) => Promise<void>;
}) {
  const [revokeReason, setRevokeReason] = useState('');
  const [confirming, setConfirming] = useState(false);

  return (
    <div className="card">
      <div className="row-between">
        <h2>{worker.workerName}</h2>
        <div className="actions">
          <Badge tone={worker.isLive ? 'ok' : 'danger'}>{worker.isLive ? 'live' : 'no heartbeat'}</Badge>
          <Badge tone={worker.sandboxReady ? 'ok' : 'danger'}>
            {worker.sandboxReady ? `sandbox: ${worker.sandboxKind}` : 'no sandbox'}
          </Badge>
          {worker.codingWorkWithheld && <Badge tone="warn">coding work withheld</Badge>}
          {worker.rotationRequestedAt && <Badge tone="info">rotation requested</Badge>}
        </div>
      </div>

      {worker.sandboxDetail && <p className="hint">{worker.sandboxDetail}</p>}

      <div className="stat-row">
        <Stat label="Active credential" value={worker.activeToken?.tokenPrefix ?? <span className="dim">none</span>} />
        <Stat
          label="Age"
          value={worker.activeToken ? `${worker.activeToken.ageHours}h` : <span className="dim">—</span>}
        />
        <Stat label="Last rotated" value={<Time value={worker.lastRotatedAt} />} />
        <Stat label="Last used" value={<Time value={worker.activeToken?.lastUsedAt ?? null} />} />
      </div>

      <details>
        <summary>{worker.tokens.length} credential(s) ever issued</summary>
        <table className="compact">
          <thead>
            <tr>
              <th>Prefix</th>
              <th>Status</th>
              <th>Issued via</th>
              <th>Issued</th>
              <th>Expires</th>
              <th>Revoked</th>
            </tr>
          </thead>
          <tbody>
            {worker.tokens.map((token) => (
              <tr key={token.id}>
                <td className="mono">{token.tokenPrefix}</td>
                <td>
                  <Badge
                    tone={token.status === 'active' ? 'ok' : token.status === 'superseded' ? 'warn' : 'idle'}
                  >
                    {humanise(token.status)}
                  </Badge>
                </td>
                <td>{humanise(token.issuedVia)}</td>
                <td>
                  <Time value={token.issuedAt} />
                </td>
                <td>
                  <Time value={token.expiresAt} />
                </td>
                <td>{token.revokedReason ?? <span className="dim">—</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="hint">
          Only a display prefix is ever retained. The credential itself exists in plaintext exactly once, at the
          moment it is issued.
        </p>
      </details>

      <div className="actions">
        <button
          onClick={() => void onAct(() => api.rotateWorkerToken(worker.workerId, 'Requested from the Security screen.'), 'Rotation requested. The worker will replace its credential on its next call.')}
          disabled={Boolean(worker.rotationRequestedAt)}
        >
          Request rotation
        </button>

        {confirming ? (
          <>
            <input
              placeholder="Why are you revoking?"
              value={revokeReason}
              onChange={(e) => setRevokeReason(e.target.value)}
            />
            <button
              className="danger"
              disabled={!revokeReason.trim()}
              onClick={() =>
                void onAct(
                  () => api.revokeWorkerTokens(worker.workerId, revokeReason.trim()),
                  'Every credential revoked. The worker must re-enroll.',
                ).then(() => {
                  setConfirming(false);
                  setRevokeReason('');
                })
              }
            >
              Revoke now
            </button>
            <button className="small" onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button className="danger small" onClick={() => setConfirming(true)}>
            Revoke all credentials
          </button>
        )}
      </div>

      <p className="hint">
        Rotation is a request the worker fulfils itself, and the previous credential keeps working for a short
        overlap so an in-flight call does not fail. Revocation is immediate and has no grace period: the worker will
        fail its next call and must re-enroll with a fresh single-use token.
      </p>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
    </div>
  );
}
