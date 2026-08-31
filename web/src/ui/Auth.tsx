import { useState } from 'react';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { api } from '../lib/api';

export function Auth({ enrolled, onDone }: { enrolled: boolean; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState('');

  async function enroll() {
    setBusy(true);
    setError(null);
    try {
      const options = await api.registerStart(code);
      const response = await startRegistration({ optionsJSON: options });
      await api.registerFinish(response, navigator.platform || 'device');
      onDone();
    } catch (e: any) {
      setError(
        e?.message === 'bad_enroll_code'
          ? 'That enroll code is not right.'
          : e?.message ?? 'Enrollment failed.',
      );
    } finally {
      setBusy(false);
    }
  }

  async function login() {
    setBusy(true);
    setError(null);
    try {
      const options = await api.loginStart();
      const response = await startAuthentication({ optionsJSON: options });
      await api.loginFinish(response);
      onDone();
    } catch (e: any) {
      setError([e?.message ?? 'Sign-in failed.', e?.detail].filter(Boolean).join(' — '));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="auth">
      <pre className="auth-boot">
{`legible ── personal archive
────────────────────────────
${enrolled ? 'passkey required' : 'no passkey enrolled yet'}`}
      </pre>

      {enrolled ? (
        <button className="btn" onClick={login} disabled={busy}>
          {busy ? 'waiting for passkey…' : 'unlock with passkey'}
        </button>
      ) : (
        <>
          <label className="auth-label" htmlFor="enroll">enroll code</label>
          <input
            id="enroll"
            className="auth-input"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && enroll()}
            autoFocus
            autoComplete="off"
          />
          <button className="btn" onClick={enroll} disabled={busy || !code}>
            {busy ? 'waiting for passkey…' : 'enroll this device'}
          </button>
        </>
      )}

      {error && <p className="auth-error">{error}</p>}
    </div>
  );
}
