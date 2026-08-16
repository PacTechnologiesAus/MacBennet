import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { AuditEventDto } from '@mac/protocol';
import { api } from '../api.js';
import { Alert, Badge, Empty, Time } from '../components/ui.js';

/**
 * The audit trail, unfiltered.
 *
 * Presented newest-first because that is how it is read in practice — an
 * operator comes here to answer "what just happened?". The `seq` column is
 * shown deliberately: it is the authoritative order, and several events written
 * in one transaction share a timestamp.
 */
export function Audit() {
  const [events, setEvents] = useState<AuditEventDto[]>([]);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState('');

  useEffect(() => {
    api
      .listAudit({ limit: 200 })
      .then((r) => setEvents(r.events))
      .catch((err: Error) => setError(err.message));
  }, []);

  const visible = filter
    ? events.filter(
        (e) =>
          e.eventType.includes(filter) ||
          e.actorLabel.toLowerCase().includes(filter.toLowerCase()),
      )
    : events;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Audit</h1>
          <p>
            Append-only. The database refuses UPDATE, DELETE and TRUNCATE on this table, so nothing here can be
            rewritten after the fact.
          </p>
        </div>
        <div style={{ minWidth: 240 }}>
          <input
            placeholder="Filter by event type or actor…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
        </div>
      </div>

      <Alert kind="error">{error}</Alert>

      <div className="card">
        {visible.length === 0 ? (
          <Empty>No audit events match.</Empty>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Seq</th>
                  <th>Time</th>
                  <th>Event</th>
                  <th>Actor</th>
                  <th>Context</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((event) => (
                  <tr key={event.id}>
                    <td className="mono dim">{event.seq}</td>
                    <td>
                      <Time value={event.ts} />
                    </td>
                    <td className="mono" style={{ fontSize: 12.5 }}>
                      {event.eventType}
                    </td>
                    <td>
                      <Badge tone={event.actorType === 'user' ? 'info' : event.actorType === 'worker' ? 'ok' : 'idle'}>
                        {event.actorType}
                      </Badge>
                      <div className="dim" style={{ fontSize: 12 }}>{event.actorLabel}</div>
                    </td>
                    <td>
                      {event.runId ? (
                        <Link to={`/runs/${event.runId}`} className="mono" style={{ fontSize: 12 }}>
                          run {event.runId.slice(0, 8)}
                        </Link>
                      ) : event.projectId ? (
                        <Link to={`/projects/${event.projectId}`} className="mono" style={{ fontSize: 12 }}>
                          project
                        </Link>
                      ) : (
                        <span className="dim">—</span>
                      )}
                    </td>
                    <td className="mono dim" style={{ fontSize: 12, maxWidth: 380, overflowWrap: 'anywhere' }}>
                      {summarise(event)}
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

function summarise(event: AuditEventDto): string {
  const meta = event.metadata as Record<string, unknown>;
  if (typeof meta.from === 'string') return `${meta.from} → ${String(meta.to)}`;
  if (typeof meta.fromStage === 'string' || typeof meta.toStage === 'string') {
    return `stage ${String(meta.fromStage ?? '—')} → ${String(meta.toStage)}`;
  }
  if (meta.guardrail) return `guardrail: ${String(meta.guardrail)} (${String(meta.code ?? 'blocked')})`;
  if (meta.changes && typeof meta.changes === 'object') return Object.keys(meta.changes as object).join(', ');
  const keys = Object.keys(meta);
  return keys.length ? keys.slice(0, 4).join(', ') : '—';
}
