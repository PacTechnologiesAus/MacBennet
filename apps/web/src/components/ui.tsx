import type { ReactNode } from 'react';
import type { RunStatus, WorkerStatus, ApprovalState } from '@mac/protocol';

/** Small shared presentational pieces. Deliberately not a component library. */

type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'idle';

export function Badge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

/**
 * Run status colouring.
 *
 * The distinction that matters most to an operator glancing at a list is
 * "did this finish cleanly, is it still going, or does it need me?" — so
 * completed is green, in-flight is blue, anything awaiting a human is amber,
 * and anything that stopped badly is red.
 */
const RUN_TONE: Record<RunStatus, Tone> = {
  draft: 'idle',
  discovery: 'idle',
  ready_for_approval: 'warn',
  approved: 'info',
  queued: 'info',
  running: 'info',
  blocked: 'warn',
  self_review: 'info',
  ready_for_human_review: 'warn',
  completed: 'ok',
  /*
   * Amber, not green and not red.
   *
   * Work was delivered and is worth reading, so red would send somebody looking
   * for a crash that did not happen. But a required acceptance criterion was not
   * met, so green would be the exact misreport this phase exists to stop — a
   * glance down a list of green ticks is how an investigation delivering one of
   * five requested documents got filed as finished.
   */
  completed_with_gaps: 'warn',
  stopped_by_guardrail: 'danger',
  cancelled: 'idle',
  failed: 'danger',
};

export const humanise = (value: string) => value.replace(/_/g, ' ');

export function RunStatusBadge({ status }: { status: RunStatus }) {
  return <Badge tone={RUN_TONE[status] ?? 'idle'}>{humanise(status)}</Badge>;
}

const WORKER_TONE: Record<WorkerStatus, Tone> = {
  registered: 'info',
  idle: 'ok',
  busy: 'info',
  offline: 'danger',
  disabled: 'idle',
};

export function WorkerStatusBadge({ status, isLive }: { status: WorkerStatus; isLive?: boolean }) {
  // A worker can be "idle" in the database while its heartbeat has lapsed.
  // Showing the derived liveness avoids a dashboard that claims a dead worker
  // is ready for work.
  if (isLive === false && status !== 'disabled') return <Badge tone="danger">no heartbeat</Badge>;
  return <Badge tone={WORKER_TONE[status] ?? 'idle'}>{humanise(status)}</Badge>;
}

const APPROVAL_TONE: Record<ApprovalState, Tone> = {
  not_required: 'idle',
  pending: 'warn',
  approved: 'ok',
  rejected: 'danger',
  revoked: 'danger',
};

export function ApprovalBadge({ state }: { state: ApprovalState }) {
  return <Badge tone={APPROVAL_TONE[state] ?? 'idle'}>{humanise(state)}</Badge>;
}

export function Confidence({ value }: { value: number | null }) {
  if (value === null) return <span className="dim">—</span>;
  const percent = Math.round(value * 100);
  const tone: Tone = percent >= 80 ? 'ok' : percent >= 60 ? 'warn' : 'danger';
  return <Badge tone={tone}>{percent}%</Badge>;
}

export function Alert({ kind, children }: { kind: 'error' | 'ok' | 'warn'; children: ReactNode }) {
  if (!children) return null;
  return <div className={`alert alert-${kind}`}>{children}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/** Absolute local time — an audit UI should never make you compute "3h ago". */
export function Time({ value }: { value: string | null }) {
  if (!value) return <span className="dim">—</span>;
  const date = new Date(value);
  return (
    <span className="nowrap" title={date.toISOString()}>
      {date.toLocaleString(undefined, {
        year: '2-digit',
        month: 'short',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })}
    </span>
  );
}

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}
