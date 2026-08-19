import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { ApprovalRequestDto, CurrentUser } from '@mac/protocol';
import { AUTHORITY_REFUSALS, isConversationallyApprovable, type AuthorityClass } from '@mac/protocol';
import { api, ApiError } from '../api.js';
import { Alert, Badge, Confidence, Time } from '../components/ui.js';

/**
 * The approval and blocker inbox (Phase 4 Part J §33).
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS PAGE IS FOR
 *
 * Everything on it is something that is not moving until a person does
 * something. That is the whole selection rule, and it is why blockers and
 * approvals share a screen rather than each having one: from the point of view
 * of somebody arriving in the morning, they are the same question — what is
 * waiting on me?
 * ---------------------------------------------------------------------------
 */
export function Inbox({ user }: { user: CurrentUser }) {
  const [requests, setRequests] = useState<ApprovalRequestDto[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setRequests((await api.listApprovalRequests({ state: 'pending' })).requests);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const decide = async (request: ApprovalRequestDto, decision: 'approve' | 'reject') => {
    setBusy(request.id);
    setError(null);
    try {
      await api.decideApprovalRequest(request.id, { decision, notes: '', acceptBelowThreshold: false });
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const canDecide = user.role !== 'viewer';

  return (
    <div className="page">
      <header className="page-header">
        <h1>Waiting on you</h1>
        <p className="muted">
          Approvals Mac has raised and cannot proceed without. Each one names the exact thing being authorised — a
          decision that could apply to more than one action is not one Mac will accept.
        </p>
      </header>

      {error && <Alert kind="error">{error}</Alert>}

      {requests.length === 0 ? (
        <p className="muted">Nothing is waiting on your approval.</p>
      ) : (
        <ul className="approval-list">
          {requests.map((request) => {
            const authority = request.authority as AuthorityClass;
            const decidable = isConversationallyApprovable(authority);

            return (
              <li key={request.id} className="card approval">
                <div className="approval-head">
                  <code className="approval-code">{request.code}</code>
                  <h3>{request.title}</h3>
                  <Badge tone={request.risk === 'high' ? 'danger' : request.risk === 'medium' ? 'warn' : 'idle'}>
                    {request.risk} risk
                  </Badge>
                </div>

                <p className="muted">
                  {request.projectName} ·{' '}
                  <Link to={`/tasks/${request.taskId}`}>{request.taskTitle}</Link> · raised{' '}
                  <Time value={request.requestedAt} />
                  {request.expiresAt && (
                    <>
                      {' '}
                      · expires <Time value={request.expiresAt} />
                    </>
                  )}
                </p>

                {request.detail && <p>{request.detail}</p>}
                {request.recommendation && (
                  <p>
                    <strong>Mac recommends:</strong> {request.recommendation}
                  </p>
                )}

                {request.confidence !== null && (
                  <p>
                    Understanding confidence: <Confidence value={request.confidence} />
                  </p>
                )}

                {/*
                  A request for an authority nobody may grant Mac still appears
                  here — recording that he asked and was refused is more useful
                  than pretending he never asked — and it offers no buttons.
                */}
                {!decidable && (
                  <Alert kind="error">{AUTHORITY_REFUSALS[authority] ?? 'That authority cannot be granted.'}</Alert>
                )}

                {canDecide && decidable && (
                  <div className="approval-actions">
                    <button type="button" disabled={busy === request.id} onClick={() => void decide(request, 'approve')}>
                      Approve
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      disabled={busy === request.id}
                      onClick={() => void decide(request, 'reject')}
                    >
                      Reject
                    </button>
                    <span className="muted">
                      Or reply in the conversation with “approve {request.code}”.
                    </span>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
