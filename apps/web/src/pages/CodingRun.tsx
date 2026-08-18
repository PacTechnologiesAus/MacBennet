import { useEffect, useState } from 'react';
import type { CodingRunDetailDto, MorningReportDto, RunUsageSummaryDto } from '@mac/protocol';
import { api } from '../api.js';
import { Badge, humanise } from '../components/ui.js';
import { BriefPanel } from './Discovery.js';

/**
 * Everything about a coding run that Sprint 1's Run Detail screen has no
 * concept of: the repository and worktree, the coding session, Mac's questions
 * and answers, his self-review, the pull request, usage, and the report.
 *
 * Presented as panels appended to the existing run page rather than a new
 * screen, so an operator follows one run in one place.
 */
export function CodingRunPanels({ runId, status }: { runId: string; status: string }) {
  const [detail, setDetail] = useState<CodingRunDetailDto | null>(null);
  const [report, setReport] = useState<MorningReportDto | null>(null);

  const live = ['queued', 'running', 'blocked', 'self_review'].includes(status);

  useEffect(() => {
    let cancelled = false;

    const load = async () => {
      const result = await api.getCodingRun(runId).catch(() => null);
      if (!cancelled && result) setDetail(result.detail);
    };

    void load();
    // Polls while the run is live, exactly as the Sprint 1 log view does.
    const timer = live ? setInterval(() => void load(), 2000) : null;
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [runId, live]);

  useEffect(() => {
    if (live) return;
    void api.getRunReport(runId).then((r) => setReport(r.report)).catch(() => undefined);
  }, [runId, live]);

  if (!detail || !detail.repository) return null;

  return (
    <>
      <section className="card">
        <h2>Repository and worktree</h2>
        <dl className="facts">
          <dt>Repository</dt>
          <dd>{detail.repository.name} <span className="dim">{detail.repository.remoteUrl}</span></dd>
          <dt>Default branch</dt>
          <dd>
            {detail.repository.defaultBranch}{' '}
            <Badge tone="ok">never modified by Mac</Badge>
          </dd>
          <dt>Task branch</dt>
          <dd>{detail.worktree?.branch ?? <span className="dim">not created yet</span>}</dd>
          <dt>Worktree</dt>
          <dd>
            {detail.worktree ? (
              <>
                <code>{detail.worktree.path}</code>{' '}
                <Badge tone={detail.worktree.status === 'removed' ? 'idle' : 'info'}>
                  {humanise(detail.worktree.status)}
                </Badge>
              </>
            ) : (
              <span className="dim">not created yet</span>
            )}
          </dd>
          <dt>Commits</dt>
          <dd>{detail.worktree?.commitCount ?? 0}</dd>
        </dl>
      </section>

      <section className="card">
        <h2>Coding session</h2>
        {detail.session ? (
          <dl className="facts">
            <dt>Provider</dt>
            <dd>{detail.session.provider}{detail.session.model ? ` · ${detail.session.model}` : ''}</dd>
            <dt>State</dt>
            <dd><Badge tone={sessionTone(detail.session.state)}>{humanise(detail.session.state)}</Badge></dd>
            <dt>Current activity</dt>
            <dd>{detail.session.currentActivity ?? <span className="dim">—</span>}</dd>
            <dt>Started</dt>
            <dd>{new Date(detail.session.startedAt).toLocaleString()}</dd>
            {detail.session.error && (
              <>
                <dt>Error</dt>
                <dd className="danger">{detail.session.error}</dd>
              </>
            )}
          </dl>
        ) : (
          <p className="dim">No coding session has started yet.</p>
        )}
      </section>

      {detail.violations.length > 0 && (
        <section className="card" style={{ borderColor: 'var(--danger)' }}>
          <h2>Refused git operations</h2>
          <p>
            {detail.violations.length} prohibited operation(s) were attempted and refused. No pull request will be
            opened until a human has reviewed what happened.
          </p>
          <table className="table">
            <thead><tr><th>Rule</th><th>Attempted by</th><th>Command</th></tr></thead>
            <tbody>
              {detail.violations.map((v) => (
                <tr key={v.id}>
                  <td><Badge tone="danger">{humanise(v.code.toLowerCase())}</Badge></td>
                  <td>{v.origin === 'agent' ? 'the coding agent' : 'Mac'}</td>
                  <td><code>git {v.argv.join(' ')}</code></td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="card">
        <div className="row-between">
          <h2>Questions Mac answered</h2>
          <span className="dim">{detail.questions.length} question(s)</span>
        </div>

        {detail.questions.length === 0 ? (
          <p className="dim">The coding agent has not asked anything.</p>
        ) : (
          detail.questions.map((q) => (
            <details key={q.id} className="qa">
              <summary>
                <Badge tone={q.decision === 'blocked' ? 'danger' : q.decision === 'assumed' ? 'warn' : 'ok'}>
                  {q.decision ? humanise(q.decision) : 'pending'}
                </Badge>{' '}
                {q.confidence !== null && <span className="dim">{Math.round(q.confidence * 100)}%</span>}{' '}
                {q.question}
              </summary>
              <p><strong>Mac:</strong> {q.answer}</p>
              <p className="dim small"><strong>Reasoning:</strong> {q.reasoning}</p>
              {q.sources.length > 0 && (
                <p className="dim small"><strong>From:</strong> {q.sources.join(', ')}</p>
              )}
              <p className="dim small">
                Risk {q.risk} · {q.affectedImplementation ? 'affected the implementation' : 'did not change the implementation'}
                {q.requiredHuman ? ' · needs a human' : ''}
              </p>
            </details>
          ))
        )}
      </section>

      {(detail.assumptions.length > 0 || detail.blockers.length > 0) && (
        <section className="card">
          <h2>Assumptions and blockers</h2>

          {detail.assumptions.length > 0 && (
            <>
              <h3>Assumptions</h3>
              <ul>
                {detail.assumptions.map((a) => (
                  <li key={a.id}>
                    {a.flagged && <Badge tone="warn">review this</Badge>} {a.statement}{' '}
                    <span className="dim">({Math.round(a.confidence * 100)}%)</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {detail.blockers.length > 0 && (
            <>
              <h3>Blocked work</h3>
              <p className="dim">
                Mac left these unimplemented rather than guessing, and continued with the independent work.
              </p>
              <ul>
                {detail.blockers.map((b) => (
                  <li key={b.id}>
                    <Badge tone="danger">{b.risk}</Badge> {b.description}
                    <div className="dim small">{b.reason}</div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </section>
      )}

      {detail.review && (
        <section className="card">
          <div className="row-between">
            <h2>Mac's self-review</h2>
            <Badge tone={detail.review.verdict === 'satisfies_brief' ? 'ok' : detail.review.verdict === 'unreviewable' ? 'danger' : 'warn'}>
              {humanise(detail.review.verdict)}
            </Badge>
          </div>

          <dl className="facts">
            <dt>Risk</dt>
            <dd><Badge tone={detail.review.riskLevel === 'high' ? 'danger' : detail.review.riskLevel === 'medium' ? 'warn' : 'ok'}>{detail.review.riskLevel}</Badge></dd>
            <dt>Acceptance criteria</dt>
            <dd>{detail.review.acceptanceCriteriaMet ? 'appear met' : 'not evidenced in the diff'}</dd>
            <dt>Scope</dt>
            <dd>{detail.review.unexpectedScope ? 'broader than the brief implied' : 'as briefed'}</dd>
            <dt>Human attention</dt>
            <dd>{detail.review.humanAttentionRequired ? <Badge tone="warn">required</Badge> : 'not required'}</dd>
          </dl>

          {detail.review.anomalies.length > 0 && (
            <>
              <h3>Anomalies</h3>
              <ul>{detail.review.anomalies.map((a, i) => <li key={i}>{a}</li>)}</ul>
            </>
          )}

          <ChangedFiles evidence={detail.review.evidence} />
        </section>
      )}

      <section className="card">
        <h2>Pull request</h2>
        {detail.pullRequest ? (
          <>
            <p>
              <a href={detail.pullRequest.url} target="_blank" rel="noreferrer">{detail.pullRequest.url}</a>
            </p>
            <p className="dim">
              {detail.pullRequest.branch} → {detail.pullRequest.baseBranch}. Mac does not merge his own work.
            </p>
          </>
        ) : (
          <p className="dim">
            {detail.review?.prDeclineReason ?? 'No pull request yet.'}
          </p>
        )}
      </section>

      <UsagePanel usage={detail.usage} />

      {report && <ReportPanel report={report} />}
    </>
  );
}

function ChangedFiles({ evidence }: { evidence: Record<string, unknown> }) {
  const files = (evidence.filesChanged ?? []) as Array<{ path: string; status: string; insertions: number; deletions: number }>;
  const tests = evidence.tests as { ran: boolean; command: string[]; passed: boolean | null; exitCode: number | null } | null;
  const build = evidence.build as { ran: boolean; command: string[]; passed: boolean | null } | null;

  return (
    <>
      <h3>Tests</h3>
      {tests?.ran ? (
        <p>
          <code>{tests.command.join(' ')}</code>{' '}
          <Badge tone={tests.passed ? 'ok' : 'danger'}>{tests.passed ? 'passed' : `failed (exit ${tests.exitCode})`}</Badge>
        </p>
      ) : (
        <p className="dim">No test command is configured for this repository, so none was run.</p>
      )}

      {build?.ran && (
        <p>
          <code>{build.command.join(' ')}</code>{' '}
          <Badge tone={build.passed ? 'ok' : 'danger'}>{build.passed ? 'passed' : 'failed'}</Badge>
        </p>
      )}

      <h3>Changed files ({files.length})</h3>
      {files.length === 0 ? (
        <p className="dim">No files changed.</p>
      ) : (
        <table className="table">
          <thead><tr><th>File</th><th>+</th><th>−</th></tr></thead>
          <tbody>
            {files.slice(0, 50).map((f) => (
              <tr key={f.path}>
                <td><code>{f.path}</code></td>
                <td className="ok">+{f.insertions}</td>
                <td className="danger">−{f.deletions}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

/**
 * Usage, always rendered with its provenance.
 *
 * There is no branch here that shows a bare number: every figure is
 * accompanied by whether it is exact, observed, estimated — or the panel says
 * "Provider usage unavailable" and shows nothing else.
 */
export function UsagePanel({ usage }: { usage: RunUsageSummaryDto }) {
  const tone = usage.source === 'exact' ? 'ok' : usage.source === 'unavailable' ? 'idle' : 'warn';

  return (
    <section className="card">
      <div className="row-between">
        <h2>AI usage</h2>
        <Badge tone={tone}>{usage.source}</Badge>
      </div>

      {usage.source === 'unavailable' ? (
        <p className="dim">Provider usage unavailable</p>
      ) : (
        <>
          <table className="table">
            <thead><tr><th /><th>Before</th><th>After</th><th>Delta</th></tr></thead>
            <tbody>
              <tr>
                <td>Input tokens</td>
                <td className="dim">{usage.before?.inputTokens ?? '—'}</td>
                <td>{usage.after?.inputTokens ?? '—'}</td>
                <td>{usage.delta.inputTokens ?? '—'}</td>
              </tr>
              <tr>
                <td>Output tokens</td>
                <td className="dim">{usage.before?.outputTokens ?? '—'}</td>
                <td>{usage.after?.outputTokens ?? '—'}</td>
                <td>{usage.delta.outputTokens ?? '—'}</td>
              </tr>
              <tr>
                <td>Allowance used</td>
                <td className="dim">{usage.before?.percentUsed ?? '—'}</td>
                <td>{usage.after?.percentUsed ?? '—'}</td>
                <td>{usage.delta.percentUsedDelta ?? '—'}</td>
              </tr>
              <tr>
                <td>Cost</td>
                <td className="dim">—</td>
                <td>{usage.delta.costCents !== null ? `$${(usage.delta.costCents / 100).toFixed(2)}` : '—'}</td>
                <td>{usage.costEnforceable ? <Badge tone="ok">billed</Badge> : <Badge tone="warn">not billed</Badge>}</td>
              </tr>
            </tbody>
          </table>

          <p className="dim small">{usage.label}</p>
          {usage.after?.note && <p className="dim small">{usage.after.note}</p>}
          {!usage.costEnforceable && (
            <p className="dim small">
              This figure is not enforceable as a monetary budget. Only exact provider cost is.
            </p>
          )}
        </>
      )}
    </section>
  );
}

export function ReportPanel({ report }: { report: MorningReportDto }) {
  return (
    <section className="card">
      <div className="row-between">
        <h2>Morning report</h2>
        <Badge tone={report.risk === 'high' ? 'danger' : report.risk === 'medium' ? 'warn' : 'ok'}>
          risk {report.risk}
        </Badge>
      </div>
      <pre className="markdown">{report.markdown}</pre>
    </section>
  );
}

const sessionTone = (state: string) =>
  state === 'completed' ? 'ok' : state === 'failed' ? 'danger' : state === 'awaiting_answer' ? 'warn' : 'info';
