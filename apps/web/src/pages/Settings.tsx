import { useEffect, useState, type FormEvent } from 'react';
import type { BudgetStatusDto, CurrentUser, SettingsDto, TeamsStatusDto } from '@mac/protocol';
import { WEB_SEARCH_PROVIDER_REQUIREMENTS, WEB_SEARCH_PROVIDERS } from '@mac/protocol';
import { api, ApiError } from '../api.js';
import { Alert, Badge, Field, Time } from '../components/ui.js';

import { formatMoney } from './Dashboard.js';

/** Newline-separated text into a trimmed list, for the multi-line settings. */
const LINE_BREAK = '\n';
const splitLines = (value: string): string[] =>
  value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

/**
 * Settings.
 *
 * Everything on this page is a guardrail parameter, which is why editing it is
 * admin-only: changing the confidence floor or the overnight cutoff changes
 * what the system will do without a human present.
 */
/** Comma- or newline-separated text into a trimmed list. */
const splitList = (value: string): string[] =>
  value
    .split(/[,\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean);

export function Settings({ user }: { user: CurrentUser }) {
  const [settings, setSettings] = useState<SettingsDto | null>(null);
  const [budget, setBudget] = useState<BudgetStatusDto | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);

  const isAdmin = user.role === 'admin';

  const [form, setForm] = useState({
    timezone: '',
    overnightCutoff: '',
    minExecutionConfidence: '',
    defaultConfidenceThreshold: '',
    nightlyBudgetCents: '',
    currency: '',
    budgetWarningPct: '',
    budgetStopPct: '',
    heartbeatIntervalSeconds: '',
    heartbeatGraceSeconds: '',
    // --- Sprint 3 ---
    requireSandbox: true,
    workerTokenMaxAgeHours: '',
    nightShiftEnabled: false,
    nightShiftSafetyFactor: '',
    nightShiftWrapUpMinutes: '',
    nightShiftMinStartMinutes: '',
    nightShiftLargeTaskMinMinutes: '',
    reportRecipients: '',
    allowedRecipientDomains: '',
    mailProvider: 'none',
    modelAssistEnabled: false,
    modelProvider: 'none',
    // --- Phase 4 ---
    teamsEnabled: false,
    teamsAuthorisedUsers: [] as string[],
    teamsNotifyBlockers: true,
    teamsNotifyApprovals: true,
    teamsNotifyReports: false,
    forjaEnabled: false,
    webSearchProvider: 'none' as SettingsDto['webSearchProvider'],
    externalResearchEnabled: false,
    allowedResearchDomains: [] as string[],
    acceptanceVerificationEnabled: true,
    acceptanceSemanticReviewEnabled: true,
    acceptanceRemediationEnabled: true,
  });

  const load = () => {
    api
      .getSettings()
      .then((r) => {
        setSettings(r.settings);
        setForm({
          timezone: r.settings.timezone,
          overnightCutoff: r.settings.overnightCutoff,
          minExecutionConfidence: String(Math.round(r.settings.minExecutionConfidence * 100)),
          defaultConfidenceThreshold: String(Math.round(r.settings.defaultConfidenceThreshold * 100)),
          nightlyBudgetCents: (r.settings.nightlyBudgetCents / 100).toFixed(2),
          currency: r.settings.currency,
          budgetWarningPct: String(r.settings.budgetWarningPct),
          budgetStopPct: String(r.settings.budgetStopPct),
          heartbeatIntervalSeconds: String(r.settings.heartbeatIntervalSeconds),
          heartbeatGraceSeconds: String(r.settings.heartbeatGraceSeconds),
          requireSandbox: r.settings.requireSandbox,
          workerTokenMaxAgeHours: String(r.settings.workerTokenMaxAgeHours),
          nightShiftEnabled: r.settings.nightShiftEnabled,
          nightShiftSafetyFactor: String(r.settings.nightShiftSafetyFactor),
          nightShiftWrapUpMinutes: String(r.settings.nightShiftWrapUpMinutes),
          nightShiftMinStartMinutes: String(r.settings.nightShiftMinStartMinutes),
          nightShiftLargeTaskMinMinutes: String(r.settings.nightShiftLargeTaskMinMinutes),
          reportRecipients: r.settings.reportRecipients.join(', '),
          allowedRecipientDomains: r.settings.allowedRecipientDomains.join(', '),
          mailProvider: r.settings.mailProvider,
          modelAssistEnabled: r.settings.modelAssistEnabled,
          modelProvider: r.settings.modelProvider,
          teamsEnabled: r.settings.teamsEnabled,
          teamsAuthorisedUsers: r.settings.teamsAuthorisedUsers,
          teamsNotifyBlockers: r.settings.teamsNotifyBlockers,
          teamsNotifyApprovals: r.settings.teamsNotifyApprovals,
          teamsNotifyReports: r.settings.teamsNotifyReports,
          forjaEnabled: r.settings.forjaEnabled,
          webSearchProvider: r.settings.webSearchProvider,
          externalResearchEnabled: r.settings.externalResearchEnabled,
          allowedResearchDomains: r.settings.allowedResearchDomains,
          acceptanceVerificationEnabled: r.settings.acceptanceVerificationEnabled,
          acceptanceSemanticReviewEnabled: r.settings.acceptanceSemanticReviewEnabled,
          acceptanceRemediationEnabled: r.settings.acceptanceRemediationEnabled,
        });
      })
      .catch((err: Error) => setError(err.message));
    api.getBudget().then((r) => setBudget(r.budget)).catch(() => undefined);
  };

  useEffect(load, []);

  /*
   * Teams CONNECTION status, separately from the Teams SETTINGS.
   *
   * A checkbox says what an operator asked for; this says what is actually
   * true, including which specific configuration key is missing. The two are
   * different questions and conflating them is how enabled comes to mean
   * working.
   */
  const [teams, setTeams] = useState<TeamsStatusDto | null>(null);
  useEffect(() => {
    api.teamsStatus().then((r) => setTeams(r.status)).catch(() => undefined);
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await api.updateSettings({
        timezone: form.timezone,
        overnightCutoff: form.overnightCutoff,
        // Percentages are a display convention only; the wire format and the
        // database both use a fraction in [0,1].
        minExecutionConfidence: Number(form.minExecutionConfidence) / 100,
        defaultConfidenceThreshold: Number(form.defaultConfidenceThreshold) / 100,
        nightlyBudgetCents: Math.round(Number(form.nightlyBudgetCents) * 100),
        currency: form.currency.toUpperCase(),
        budgetWarningPct: Number(form.budgetWarningPct),
        budgetStopPct: Number(form.budgetStopPct),
        heartbeatIntervalSeconds: Number(form.heartbeatIntervalSeconds),
        heartbeatGraceSeconds: Number(form.heartbeatGraceSeconds),
        // --- Sprint 3 ---
        requireSandbox: form.requireSandbox,
        workerTokenMaxAgeHours: Number(form.workerTokenMaxAgeHours),
        nightShiftEnabled: form.nightShiftEnabled,
        nightShiftSafetyFactor: Number(form.nightShiftSafetyFactor),
        nightShiftWrapUpMinutes: Number(form.nightShiftWrapUpMinutes),
        nightShiftMinStartMinutes: Number(form.nightShiftMinStartMinutes),
        nightShiftLargeTaskMinMinutes: Number(form.nightShiftLargeTaskMinMinutes),
        reportRecipients: splitList(form.reportRecipients),
        allowedRecipientDomains: splitList(form.allowedRecipientDomains),
        mailProvider: form.mailProvider as SettingsDto['mailProvider'],
        modelAssistEnabled: form.modelAssistEnabled,
        modelProvider: form.modelProvider as SettingsDto['modelProvider'],
        // --- Phase 4 ---
        teamsEnabled: form.teamsEnabled,
        teamsAuthorisedUsers: form.teamsAuthorisedUsers,
        teamsNotifyBlockers: form.teamsNotifyBlockers,
        teamsNotifyApprovals: form.teamsNotifyApprovals,
        teamsNotifyReports: form.teamsNotifyReports,
        forjaEnabled: form.forjaEnabled,
        webSearchProvider: form.webSearchProvider,
        externalResearchEnabled: form.externalResearchEnabled,
        allowedResearchDomains: form.allowedResearchDomains,
        acceptanceVerificationEnabled: form.acceptanceVerificationEnabled,
        acceptanceSemanticReviewEnabled: form.acceptanceSemanticReviewEnabled,
        acceptanceRemediationEnabled: form.acceptanceRemediationEnabled,
      });
      setNotice('Settings saved. The change is recorded in the audit trail.');
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save settings.');
    } finally {
      setBusy(false);
    }
  };

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));

  const toggle = (key: keyof typeof form) => (e: { target: { checked: boolean } }) =>
    setForm((f) => ({ ...f, [key]: e.target.checked }));

  if (!settings) return <p className="dim">Loading…</p>;

  return (
    <>
      <div className="page-header">
        <div>
          <h1>Settings</h1>
          <p>Guardrail configuration. Every change is audited.</p>
        </div>
      </div>

      <Alert kind="error">{error}</Alert>
      <Alert kind="ok">{notice}</Alert>
      {!isAdmin && <Alert kind="warn">These settings are read-only for your role. Changing them requires the admin role.</Alert>}

      <form onSubmit={submit}>
        <fieldset disabled={!isAdmin} style={{ border: 0, padding: 0, margin: 0 }}>
          <div className="card">
            <h2>Overnight shift</h2>
            <div className="grid grid-2">
              <Field label="Timezone" hint="IANA name. Daylight saving is handled from the zone database.">
                <input value={form.timezone} onChange={set('timezone')} />
              </Field>
              <Field
                label="Overnight cutoff"
                hint="HH:MM in the timezone above. Overnight runs are stopped at this time; interactive runs are not."
              >
                <input value={form.overnightCutoff} placeholder="08:00" onChange={set('overnightCutoff')} />
              </Field>
            </div>
          </div>

          {/* --- Sprint 3 ------------------------------------------------- */}

          <div className="card">
            <h2>Containment and credentials</h2>
            <div className="grid grid-2">
              <Field
                label="Require a sandbox for coding work"
                hint="When on, a coding run is not dispatched to a worker that has not attested an OS-enforced sandbox. Turning it off lets a coding agent run with the worker's own view of the filesystem."
              >
                <label className="inline">
                  <input type="checkbox" checked={form.requireSandbox} onChange={toggle('requireSandbox')} /> required
                </label>
              </Field>
              <Field
                label="Worker credential maximum age (hours)"
                hint="Past this, a worker is asked to rotate on its next call. It rotates itself; nobody touches the VM."
              >
                <input
                  type="number"
                  min={1}
                  value={form.workerTokenMaxAgeHours}
                  onChange={set('workerTokenMaxAgeHours')}
                />
              </Field>
            </div>
          </div>

          <div className="card">
            <h2>Night shift</h2>
            <div className="grid grid-2">
              <Field
                label="Autonomous night work"
                hint="The master switch. With this off no shift can be started, whatever is approved — so stopping Mac for a release week does not mean revoking every project and board and remembering to put them all back."
              >
                <label className="inline">
                  <input type="checkbox" checked={form.nightShiftEnabled} onChange={toggle('nightShiftEnabled')} />{' '}
                  Mac may work nights
                </label>
              </Field>
              <Field
                label="Effort safety factor"
                hint="An estimate is multiplied by this before it is compared with the time remaining. 1.5 means Mac assumes work may take half again as long as he thinks."
              >
                <input
                  type="number"
                  step="0.1"
                  min={1}
                  max={5}
                  value={form.nightShiftSafetyFactor}
                  onChange={set('nightShiftSafetyFactor')}
                />
              </Field>
              <Field
                label="Wrap-up allowance (minutes)"
                hint="Reserved for committing, testing, reviewing and reporting — all of which happen after the coding agent stops."
              >
                <input
                  type="number"
                  min={0}
                  value={form.nightShiftWrapUpMinutes}
                  onChange={set('nightShiftWrapUpMinutes')}
                />
              </Field>
              <Field label="Minimum runway to start anything (minutes)" hint="Below this, nothing new starts at all.">
                <input
                  type="number"
                  min={1}
                  value={form.nightShiftMinStartMinutes}
                  onChange={set('nightShiftMinStartMinutes')}
                />
              </Field>
              <Field
                label="Minimum runway for a large task (minutes)"
                hint="A large task additionally needs at least this much, so it is not started only to be cut off."
              >
                <input
                  type="number"
                  min={1}
                  value={form.nightShiftLargeTaskMinMinutes}
                  onChange={set('nightShiftLargeTaskMinMinutes')}
                />
              </Field>
            </div>
          </div>

          <div className="card">
            <h2>Morning report delivery</h2>
            <div className="grid grid-2">
              <Field
                label="Recipients"
                hint="Comma separated. This is the ONLY place a recipient can be set — nothing from a task, a brief or a coding agent can reach the send path."
              >
                <input
                  value={form.reportRecipients}
                  onChange={set('reportRecipients')}
                  placeholder="you@pac-technologies.com.au"
                />
              </Field>
              <Field
                label="Allowed recipient domains"
                hint="Comma separated. An address outside these is refused and audited."
              >
                <input
                  value={form.allowedRecipientDomains}
                  onChange={set('allowedRecipientDomains')}
                  placeholder="pac-technologies.com.au"
                />
              </Field>
              <Field
                label="Mail provider"
                hint="graph sends from Mac's real mailbox. none generates the report without delivering it."
              >
                <select value={form.mailProvider} onChange={set('mailProvider')}>
                  <option value="none">none</option>
                  <option value="graph">graph</option>
                  <option value="fake">fake (testing)</option>
                </select>
              </Field>
            </div>
          </div>

          <div className="card">
            <h2>Model assistance</h2>
            <p className="hint">
              Off by default. When on, a model may improve the wording of an answer Mac already grounded in his own
              sources. It never decides confidence, risk, eligibility or whether to execute, and a citation it
              invents is dropped before the answer is used.
            </p>
            <div className="grid grid-2">
              <Field label="Enabled">
                <label className="inline">
                  <input
                    type="checkbox"
                    checked={form.modelAssistEnabled}
                    onChange={toggle('modelAssistEnabled')}
                  />{' '}
                  allow model assistance
                </label>
              </Field>
              <Field label="Provider">
                <select value={form.modelProvider} onChange={set('modelProvider')}>
                  <option value="none">none</option>
                  <option value="anthropic">anthropic</option>
                </select>
              </Field>
            </div>
          </div>

          {/* --- Phase 4 ------------------------------------------------- */}

          <div className="card">
            <h2>Microsoft Teams</h2>
            <p className="hint">{teams ? teams.identity.limitation : 'Loading…'}</p>
            {teams && (
              <dl className="kv">
                <dt>Connection</dt>
                <dd>
                  <Badge tone={teams.state === 'ready' ? 'ok' : teams.state === 'error' ? 'danger' : 'idle'}>
                    {teams.state}
                  </Badge>
                  {/*
                    Which specific things are missing, by key. "Teams is not
                    configured" leaves somebody guessing between six
                    possibilities at exactly the moment they can least afford to.
                  */}
                  {teams.missing.length > 0 && <span className="dim"> — missing: {teams.missing.join(', ')}</span>}
                </dd>
                <dt>Appears as</dt>
                <dd>{teams.identity.signature}</dd>
                <dt>Threads</dt>
                <dd>{teams.conversations}</dd>
                <dt>Deliveries</dt>
                <dd>
                  {teams.pendingDeliveries} pending · {teams.failedDeliveries} failed
                  {teams.lastError && <span className="dim"> — {teams.lastError}</span>}
                </dd>
              </dl>
            )}
            <div className="grid grid-2">
              <Field label="Enabled">
                <label className="inline">
                  <input type="checkbox" checked={form.teamsEnabled} onChange={toggle('teamsEnabled')} /> accept Teams
                  messages
                </label>
              </Field>
              <Field
                label="Authorised Teams identities"
                hint="AAD object ids or UPNs, one per line. EMPTY MEANS NOBODY: an unrecognised sender may talk to Mac and ask for status, and may not create work or approve anything."
              >
                <textarea
                  rows={3}
                  value={form.teamsAuthorisedUsers.join(LINE_BREAK)}
                  onChange={(e) =>
                    setForm((current) => ({
                      ...current,
                      teamsAuthorisedUsers: splitLines(e.target.value),
                    }))
                  }
                />
              </Field>
            </div>
            <div className="grid grid-3">
              <Field label="Notify blockers">
                <label className="inline">
                  <input type="checkbox" checked={form.teamsNotifyBlockers} onChange={toggle('teamsNotifyBlockers')} />{' '}
                  yes
                </label>
              </Field>
              <Field label="Notify approvals">
                <label className="inline">
                  <input
                    type="checkbox"
                    checked={form.teamsNotifyApprovals}
                    onChange={toggle('teamsNotifyApprovals')}
                  />{' '}
                  yes
                </label>
              </Field>
              <Field
                label="Notify morning report"
                hint="Off: it is already emailed, and a notification that fires daily is one people learn to ignore."
              >
                <label className="inline">
                  <input type="checkbox" checked={form.teamsNotifyReports} onChange={toggle('teamsNotifyReports')} />{' '}
                  yes
                </label>
              </Field>
            </div>
          </div>

          <div className="card">
            <h2>External web research</h2>
            <p className="hint">
              Off by default, and additionally gated per project. This is the only capability that reaches outside
              PAC. Nothing has been purchased: each provider below states exactly what it needs from a person.
            </p>
            <div className="grid grid-2">
              <Field label="Enabled">
                <label className="inline">
                  <input
                    type="checkbox"
                    checked={form.externalResearchEnabled}
                    onChange={toggle('externalResearchEnabled')}
                  />{' '}
                  allow external research
                </label>
              </Field>
              <Field
                label="Search provider"
                hint={WEB_SEARCH_PROVIDER_REQUIREMENTS[form.webSearchProvider].humanRequirement}
              >
                <select value={form.webSearchProvider} onChange={set('webSearchProvider')}>
                  {WEB_SEARCH_PROVIDERS.map((provider) => (
                    <option key={provider} value={provider}>
                      {WEB_SEARCH_PROVIDER_REQUIREMENTS[provider].label}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            <Field
              label="Approved research domains"
              hint="One per line. Mac fetches nothing outside this list, and does not add his own."
            >
              <textarea
                rows={3}
                value={form.allowedResearchDomains.join(LINE_BREAK)}
                onChange={(e) =>
                  setForm((current) => ({ ...current, allowedResearchDomains: splitLines(e.target.value) }))
                }
              />
            </Field>
          </div>

          <div className="card">
            <h2>Acceptance verification</h2>
            <p className="hint">
              Before Mac may call a task complete, the work is checked against the criteria a human approved. A run
              with no criteria is unaffected — which is every coding run that existed before this was added.
            </p>
            <div className="grid grid-3">
              <Field label="Enabled">
                <label className="inline">
                  <input
                    type="checkbox"
                    checked={form.acceptanceVerificationEnabled}
                    onChange={toggle('acceptanceVerificationEnabled')}
                  />{' '}
                  verify
                </label>
              </Field>
              <Field
                label="Model-judged criteria"
                hint="Costs model calls. A criterion nobody could decide reads as a gap, never as a pass."
              >
                <label className="inline">
                  <input
                    type="checkbox"
                    checked={form.acceptanceSemanticReviewEnabled}
                    onChange={toggle('acceptanceSemanticReviewEnabled')}
                  />{' '}
                  allow
                </label>
              </Field>
              <Field
                label="Remediation"
                hint="One bounded attempt to produce what is missing, while the worker still holds the lease."
              >
                <label className="inline">
                  <input
                    type="checkbox"
                    checked={form.acceptanceRemediationEnabled}
                    onChange={toggle('acceptanceRemediationEnabled')}
                  />{' '}
                  allow
                </label>
              </Field>
            </div>
          </div>

          <div className="card">
            <h2>Forja</h2>
            <p className="hint">
              Forja is an application, not an agent. Every write it performs records the person it acted for; a client
              that cannot name an active Mac user cannot write at all.
            </p>
            <Field label="Enabled">
              <label className="inline">
                <input type="checkbox" checked={form.forjaEnabled} onChange={toggle('forjaEnabled')} /> accept Forja
                API calls
              </label>
            </Field>
          </div>

          <div className="card">
            <h2>Confidence thresholds</h2>
            <div className="grid grid-2">
              <Field
                label="Minimum execution confidence (%)"
                hint="Hard floor. A run below this cannot be approved by anyone, including an admin."
              >
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={form.minExecutionConfidence}
                  onChange={set('minExecutionConfidence')}
                />
              </Field>
              <Field
                label="Autonomy threshold (%)"
                hint="Between the floor and this value, approving requires an explicit acknowledgement and a note."
              >
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={form.defaultConfidenceThreshold}
                  onChange={set('defaultConfidenceThreshold')}
                />
              </Field>
            </div>
          </div>

          <div className="card">
            <h2>Nightly budget</h2>
            <div className="grid grid-2">
              <Field label="Nightly budget" hint="0 means no budget is enforced.">
                <input type="number" min={0} step="0.01" value={form.nightlyBudgetCents} onChange={set('nightlyBudgetCents')} />
              </Field>
              <Field label="Currency">
                <input value={form.currency} maxLength={3} onChange={set('currency')} />
              </Field>
              <Field label="Warning threshold (%)">
                <input type="number" min={1} max={100} value={form.budgetWarningPct} onChange={set('budgetWarningPct')} />
              </Field>
              <Field label="Stop threshold (%)" hint="Dispatch is blocked once recorded spend reaches this share of the budget.">
                <input type="number" min={1} max={200} value={form.budgetStopPct} onChange={set('budgetStopPct')} />
              </Field>
            </div>

            {budget && (
              <Alert kind="warn">
                <strong>Provider usage unavailable.</strong> Sprint 1 has no provider-cost integration, so no usage is
                recorded and the figures below are zero rather than estimated. Current window{' '}
                <Time value={budget.windowStart} /> → <Time value={budget.windowEnd} />, recorded spend{' '}
                {formatMoney(budget.recordedSpendCents, budget.currency)} of{' '}
                {formatMoney(budget.nightlyBudgetCents, budget.currency)}.
              </Alert>
            )}
          </div>

          <div className="card">
            <h2>Worker liveness</h2>
            <div className="grid grid-2">
              <Field label="Heartbeat interval (s)" hint="How often workers are expected to check in.">
                <input
                  type="number"
                  min={1}
                  max={600}
                  value={form.heartbeatIntervalSeconds}
                  onChange={set('heartbeatIntervalSeconds')}
                />
              </Field>
              <Field label="Grace period (s)" hint="Additional silence tolerated before a worker is marked offline.">
                <input
                  type="number"
                  min={1}
                  max={3600}
                  value={form.heartbeatGraceSeconds}
                  onChange={set('heartbeatGraceSeconds')}
                />
              </Field>
            </div>
          </div>

          {isAdmin && (
            <button type="submit" className="primary" disabled={busy}>
              {busy ? 'Saving…' : 'Save settings'}
            </button>
          )}
        </fieldset>
      </form>

      <p className="hint" style={{ marginTop: 16 }}>
        Last updated <Time value={settings.updatedAt} />.
      </p>
    </>
  );
}
