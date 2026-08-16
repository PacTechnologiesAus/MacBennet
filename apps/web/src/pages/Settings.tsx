import { useEffect, useState, type FormEvent } from 'react';
import type { BudgetStatusDto, CurrentUser, SettingsDto } from '@mac/protocol';
import { api, ApiError } from '../api.js';
import { Alert, Field, Time } from '../components/ui.js';
import { formatMoney } from './Dashboard.js';

/**
 * Settings.
 *
 * Everything on this page is a guardrail parameter, which is why editing it is
 * admin-only: changing the confidence floor or the overnight cutoff changes
 * what the system will do without a human present.
 */
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
        });
      })
      .catch((err: Error) => setError(err.message));
    api.getBudget().then((r) => setBudget(r.budget)).catch(() => undefined);
  };

  useEffect(load, []);

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
