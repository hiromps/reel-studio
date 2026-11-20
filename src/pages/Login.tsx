// クラウド版のログイン。Google アカウントで入る（Auth.js）。入れるのはサーバーの
// AUTH_ALLOWED_EMAILS に書かれたメールアドレスだけ。
// ローカル（PC）で動かしているときはこの画面は出ない（/api/auth/session が無い）。
import React, {useState} from 'react';
import {api} from '../api';

// Auth.js が失敗時に付けて戻す ?error=… を、日本語の説明にする
const errorMessage = (code: string | null): string | null => {
  if (!code) return null;
  if (code === 'AccessDenied') return 'このアカウントでは入れません。許可されたメールアドレスの Google アカウントで入ってください。';
  if (code === 'Configuration') return 'ログインの設定が足りません（AUTH_GOOGLE_ID / AUTH_GOOGLE_SECRET / AUTH_SECRET を確認してください）。';
  return 'ログインできませんでした。もう一度試してください。';
};

export const LoginPage: React.FC<{onDone: () => void}> = () => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(() => errorMessage(new URLSearchParams(window.location.search).get('error')));

  // Auth.js のサインインは CSRF トークン付きの POST。フォームを作って送り、Google の画面へ移る
  const signIn = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.get<{csrfToken: string}>('/api/auth/csrf');
      const form = document.createElement('form');
      form.method = 'POST';
      form.action = '/api/auth/signin/google';
      for (const [name, value] of [['csrfToken', r.data.csrfToken], ['callbackUrl', `${window.location.origin}/`]]) {
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = name;
        input.value = value;
        form.appendChild(input);
      }
      document.body.appendChild(form);
      form.submit();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <div className="login card">
        <h1>Reel Studio</h1>
        <p className="muted">素材から縦型ショート動画を仕上げます。続けるにはログインしてください。</p>
        {error && <div className="login-error">{error}</div>}
        <button className="primary" type="button" onClick={() => void signIn()} disabled={busy}>
          {busy ? 'Google に移動中…' : 'Google でログイン'}
        </button>
      </div>
    </div>
  );
};
