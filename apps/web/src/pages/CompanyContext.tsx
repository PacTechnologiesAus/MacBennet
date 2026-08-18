import { useCallback, useEffect, useState } from 'react';
import { NavLink } from 'react-router-dom';
import type {
  CompanyContextStatusDto,
  CompanyProposalDto,
  CompanyProposalStatus,
  CurrentUser,
} from '@mac/protocol';
import { api, ApiError } from '../api.js';
import { Alert, Badge, Empty, Field, Time, humanise } from '../components/ui.js';

/**
 * PAC company context (Sprint 3.2 §18).
 *
 * The question this screen answers is "what company policy is Mac working
 * under right now, and do I trust it?" — which is why the commit SHA, the
 * validation state and the last successful refresh sit together at the top
 * rather than being scattered. An operator who cannot see at a glance that Mac
 * is running on week-old cached policy will not go looking.
 *
 * Deliberately NOT a document editor. Company context is human-governed in Git;
 * this screen reads it and lets Mac's proposals be reviewed.
 */

const STATUS_TONE: Record<string, 'ok' | 'warn' | 'danger' | 'idle'> = {
  fresh: 'ok',
  cached: 'warn',
  stale: 'warn',
  invalid: 'danger',
  unavailable: 'danger',
  disabled: 'idle',
};

const PROPOSAL_TONE: Record<CompanyProposalStatus, 'ok' | 'warn' | 'danger' | 'info' | 'idle'> = {
  proposed: 'info',
  under_review: 'warn',
  accepted: 'ok',
  rejected: 'idle',
  superseded: 'idle',
};

export function CompanyContext({ user }: { user: CurrentUser }) {
  const [status, setStatus] = useState<CompanyContextStatusDto | null>(null);
  const [proposals, setProposals] = useState<CompanyProposalDto[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [statusResponse, proposalResponse] = await Promise.all([
        api.companyContextStatus(),
        api.companyProposals(),
      ]);
      setStatus(statusResponse.status);
      setProposals(proposalResponse.proposals);
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      const result = await api.refreshCompanyContext();
      setStatus(result.status);
      setNotice(
        result.error
          ? `Refresh failed: ${result.error}`
          : result.changed
            ? 'A newer company context revision was loaded.'
            : 'Company context is already up to date.',
      );
      setError('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setRefreshing(false);
    }
  };

  const decide = async (id: string, next: CompanyProposalStatus) => {
    try {
      await api.updateCompanyProposal(id, { status: next, reviewNotes: null });
      await load();
      setNotice(`Proposal marked ${humanise(next)}.`);
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  };

  if (!status) return <p className="dim">Loading…</p>;

  const canOperate = user.role === 'admin' || user.role === 'operator';
  const revision = status.revision;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>PAC context</h1>
          <p className="dim">
            The approved PAC Technologies company context Mac works under, and the revision that
            governs it.
          </p>
        </div>
        {canOperate && status.enabled ? (
          <button onClick={() => void refresh()} disabled={refreshing}>
            {refreshing ? 'Refreshing…' : 'Refresh now'}
          </button>
        ) : null}
      </div>

      <Alert kind="error">{error}</Alert>
      <Alert kind="ok">{notice}</Alert>

      {!status.enabled ? (
        <div className="card">
          <Empty>
            Company context is not enabled for this deployment. Mac runs without PAC shared context,
            and nothing is bound to a company revision. Enable it in Settings once the repository and
            a read-only token are configured.
          </Empty>
        </div>
      ) : null}

      {status.cached ? (
        <Alert kind="warn">
          Mac is working from a <strong>{status.stale ? 'stale' : 'cached'}</strong> copy of PAC
          company context. The remote was last reached successfully{' '}
          {status.lastSuccessfulRefreshAt ? (
            <Time value={status.lastSuccessfulRefreshAt} />
          ) : (
            'never'
          )}
          . The commit below is exact; it is simply not confirmed as current.
        </Alert>
      ) : null}

      {status.status === 'invalid' || status.status === 'unavailable' ? (
        <Alert kind="error">
          Company context is <strong>{humanise(status.status)}</strong>. Work that requires PAC
          context will be refused until this is resolved. {status.lastError ?? ''}
        </Alert>
      ) : null}

      {/* --- Status ------------------------------------------------------- */}

      <div className="card">
        <h2>Status</h2>
        <div className="detail-grid">
          <Field label="Repository">
            <code className="mono">{status.repositoryUrl}</code>
          </Field>
          <Field label="Branch / ref">
            <code className="mono">{status.ref}</code>
          </Field>
          <Field label="Refresh status">
            <Badge tone={STATUS_TONE[status.status] ?? 'idle'}>{humanise(status.status)}</Badge>
          </Field>
          <Field label="Provider">
            <span>{status.providerKind}</span>
          </Field>
          <Field label="Context version">
            <strong>{revision?.contextVersion ?? '—'}</strong>
          </Field>
          <Field label="Commit">
            {revision ? (
              <code className="mono" title={revision.commitSha}>
                {revision.shortSha}
              </code>
            ) : (
              <span className="dim">—</span>
            )}
          </Field>
          <Field label="Validation">
            {revision ? (
              <Badge tone={revision.validationState === 'valid' ? 'ok' : 'danger'}>
                {revision.validationState}
              </Badge>
            ) : (
              <span className="dim">—</span>
            )}
          </Field>
          <Field label="Obtained from">
            {revision ? <span>{revision.source}</span> : <span className="dim">—</span>}
          </Field>
          <Field label="Last check">
            <Time value={status.lastCheckAt} />
          </Field>
          <Field label="Last successful refresh">
            <Time value={status.lastSuccessfulRefreshAt} />
          </Field>
          <Field label="Commit authored">
            <Time value={revision?.commitAuthoredAt ?? null} />
          </Field>
          <Field label="Consecutive failures">
            <span>{status.consecutiveFailures}</span>
          </Field>
        </div>

        {status.lastError ? (
          <p className="dim" style={{ marginTop: 12 }}>
            Last error: {status.lastError}
          </p>
        ) : null}

        {revision && revision.validationErrors.length > 0 ? (
          <ul className="dim" style={{ marginTop: 12 }}>
            {revision.validationErrors.map((message) => (
              <li key={message}>{message}</li>
            ))}
          </ul>
        ) : null}
      </div>

      {/* --- Mandatory documents ------------------------------------------ */}

      <div className="card">
        <h2>Mandatory documents</h2>
        <p className="dim">
          Declared by <code className="mono">context.yaml</code>. Every one must load, or Mac refuses
          to treat the revision as usable company policy.
        </p>
        {status.mandatoryDocuments.length === 0 ? (
          <Empty>No company context revision has been loaded.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Document</th>
                <th>Loaded</th>
                <th>Size</th>
              </tr>
            </thead>
            <tbody>
              {status.mandatoryDocuments.map((document) => (
                <tr key={document.path}>
                  <td>
                    <code className="mono">{document.path}</code>
                  </td>
                  <td>
                    <Badge tone={document.loaded ? 'ok' : 'danger'}>
                      {document.loaded ? 'loaded' : 'missing'}
                    </Badge>
                  </td>
                  <td className="dim">{document.bytes === null ? '—' : `${document.bytes} bytes`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* --- Proposals ---------------------------------------------------- */}

      <div className="card">
        <h2>Proposed changes</h2>
        <p className="dim">
          Mac may propose an improvement to PAC company context. He cannot apply one — accepting a
          proposal records that a person agreed; making the change in the repository remains that
          person's own act.
        </p>

        {proposals.length === 0 ? (
          <Empty>No proposals have been raised.</Empty>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Target</th>
                <th>Reason</th>
                <th>Against</th>
                <th>Status</th>
                <th>Raised</th>
                {canOperate ? <th /> : null}
              </tr>
            </thead>
            <tbody>
              {proposals.map((proposal) => (
                <tr key={proposal.id}>
                  <td>
                    <code className="mono">{proposal.targetDocument}</code>
                    {proposal.targetSection ? (
                      <div className="dim">{proposal.targetSection}</div>
                    ) : null}
                  </td>
                  <td>{proposal.reason}</td>
                  <td>
                    {proposal.baseRevision ? (
                      <code className="mono" title={proposal.baseRevision.commitSha}>
                        {proposal.baseRevision.shortSha}
                      </code>
                    ) : (
                      <span className="dim">—</span>
                    )}
                  </td>
                  <td>
                    <Badge tone={PROPOSAL_TONE[proposal.status]}>{humanise(proposal.status)}</Badge>
                  </td>
                  <td>
                    <Time value={proposal.createdAt} />
                  </td>
                  {canOperate ? (
                    <td className="nowrap">
                      {proposal.status === 'proposed' || proposal.status === 'under_review' ? (
                        <>
                          <button className="small" onClick={() => void decide(proposal.id, 'accepted')}>
                            Accept
                          </button>{' '}
                          <button className="small" onClick={() => void decide(proposal.id, 'rejected')}>
                            Reject
                          </button>
                        </>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

/**
 * The per-run / per-discovery indicator.
 *
 * Small on purpose. What matters on a run page is that the governing revision is
 * visible and identifiable at a glance; the full picture is one click away.
 */
export function CompanyContextBadge({
  context,
}: {
  context: { revisionId: string; shortSha: string; contextVersion: string } | null;
}) {
  if (!context) return null;
  return (
    <span className="nowrap" title={`PAC company context version ${context.contextVersion}`}>
      <Badge tone="info">PAC Context: {context.shortSha}</Badge>
    </span>
  );
}

/**
 * The sidebar indicator.
 *
 * Renders NOTHING when company context is fresh or switched off — a permanent
 * green badge is one an operator stops seeing, and this exists precisely to be
 * noticed on the day it appears.
 */
export function CompanyContextWarning() {
  const [status, setStatus] = useState<CompanyContextStatusDto | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api
        .companyContextStatus()
        .then((r) => {
          if (!cancelled) setStatus(r.status);
        })
        .catch(() => undefined);

    void load();
    // Slow on purpose: this is a background condition, not a live readout.
    const timer = setInterval(() => void load(), 60_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (!status || !status.enabled) return null;
  if (status.status === 'fresh') return null;

  const serious = status.status === 'invalid' || status.status === 'unavailable';

  return (
    <div className={`alert alert-${serious ? 'error' : 'warn'}`} style={{ margin: '0 12px 12px' }}>
      <strong>PAC context {humanise(status.status)}</strong>
      <div className="dim" style={{ fontSize: '0.85em' }}>
        {serious
          ? 'Work requiring company context will be refused.'
          : 'Running on a previously validated copy.'}{' '}
        <NavLink to="/company-context">Open</NavLink>
      </div>
    </div>
  );
}
