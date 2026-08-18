import { useState, type FormEvent } from 'react';
import type { CurrentUser } from '@mac/protocol';
import { api, ApiError } from '../api.js';
import { Alert, Field } from '../components/ui.js';

export function Login({ onAuthenticated }: { onAuthenticated: (user: CurrentUser) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { user } = await api.login(email, password);
      onAuthenticated(user);
    } catch (err) {
      // The server returns one message for every failure mode by design, so
      // this UI must not try to be more helpful than that.
      setError(err instanceof ApiError ? err.message : 'Could not sign in.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-shell">
      <form className="card login-card" onSubmit={submit}>
        <h1>Mac Bennett</h1>
        <p className="sub">Automation Engineer · control plane</p>

        <Alert kind="error">{error}</Alert>

        <Field label="Email">
          <input
            type="email"
            value={email}
            autoComplete="username"
            autoFocus
            required
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>

        <Field label="Password">
          <input
            type="password"
            value={password}
            autoComplete="current-password"
            required
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>

        <button type="submit" className="primary" disabled={busy} style={{ width: '100%' }}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
