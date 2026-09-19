// クラウド版のログイン。自分専用の 1 アカウント（パスワード 1 つ）。
// ローカル（PC）で動かしているときはこの画面は出ない（/api/auth/session が最初から通る）。
import React, {useState} from 'react';
import {api} from '../api';

export const LoginPage: React.FC<{onDone: () => void}> = ({onDone}) => {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!password || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.post('/api/auth/login', {password});
      setPassword('');
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="login card" onSubmit={submit}>
        <h1>Reel Studio</h1>
        <p className="muted">素材から縦型ショート動画を仕上げます。続けるにはログインしてください。</p>
        <label>
          パスワード
          <input
            type="password"
            value={password}
            autoFocus
            autoComplete="current-password"
            onChange={(e) => setPassword(e.target.value)}
            placeholder="••••••••"
            disabled={busy}
          />
        </label>
        {error && <div className="login-error">{error}</div>}
        <button className="primary" type="submit" disabled={busy || !password}>
          {busy ? '確認中…' : 'ログイン'}
        </button>
      </form>
    </div>
  );
};
