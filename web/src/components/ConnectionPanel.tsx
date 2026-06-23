import { useState } from 'react';
import type { ConnectionState } from '../types';

interface Props {
  state: ConnectionState | null;
  busy: boolean;
  onConnect: (payload: {
    adminEmail: string;
    adminPassword: string;
    appAuth: 'auto' | 'manual';
    totp?: string;
    clientId?: string;
    clientSecret?: string;
  }) => void;
  error?: string;
}

export function ConnectionPanel({ state, busy, onConnect, error }: Props) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [totp, setTotp] = useState('');
  const [appAuth, setAppAuth] = useState<'auto' | 'manual'>('auto');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const connected = state?.connected;

  return (
    <div className="card">
      <h2>Connection</h2>
      <div className="row" style={{ marginBottom: 8 }}>
        <span className={`dot ${connected ? 'on' : 'off'}`} />
        <span className="small">
          {connected ? (
            <>
              Connected as <b>{state?.adminEmail}</b>
            </>
          ) : (
            'Not connected'
          )}
        </span>
      </div>

      {connected && (
        <div className="small muted" style={{ marginBottom: 8 }}>
          <div>
            User token: <span className={state?.haveUserToken ? 'ok-text' : 'error-text'}>{state?.haveUserToken ? 'yes' : 'no'}</span>
            {'  ·  '}
            App token: <span className={state?.haveAppToken ? 'ok-text' : 'error-text'}>{state?.haveAppToken ? 'yes' : 'no'}</span>
          </div>
          {state?.appId && <div className="mono">appId: {state.appId}</div>}
        </div>
      )}

      <div className="grid2">
        <div>
          <label>Admin email</label>
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="admin@org" autoComplete="username" />
        </div>
        <div>
          <label>Admin password</label>
          <input value={password} onChange={(e) => setPassword(e.target.value)} type="password" autoComplete="current-password" />
        </div>
      </div>
      <div className="grid2 mt">
        <div>
          <label>TOTP (if enabled)</label>
          <input value={totp} onChange={(e) => setTotp(e.target.value)} placeholder="optional" />
        </div>
        <div>
          <label>App auth</label>
          <select value={appAuth} onChange={(e) => setAppAuth(e.target.value as 'auto' | 'manual')}>
            <option value="auto">Auto-provision app</option>
            <option value="manual">Manual client creds</option>
          </select>
        </div>
      </div>
      {appAuth === 'manual' && (
        <div className="grid2 mt">
          <div>
            <label>Client ID</label>
            <input value={clientId} onChange={(e) => setClientId(e.target.value)} />
          </div>
          <div>
            <label>Client secret</label>
            <input value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} type="password" />
          </div>
        </div>
      )}

      <div className="row mt">
        <button
          className="primary"
          disabled={busy || !email || !password}
          onClick={() =>
            onConnect({
              adminEmail: email,
              adminPassword: password,
              appAuth,
              totp: totp || undefined,
              clientId: clientId || undefined,
              clientSecret: clientSecret || undefined,
            })
          }
        >
          {busy ? 'Connecting…' : connected ? 'Reconnect' : 'Connect'}
        </button>
      </div>

      {error && <div className="note warn">{error}</div>}
      {state?.notes?.map((n, i) => (
        <div className="note" key={i}>
          {n}
        </div>
      ))}
    </div>
  );
}
