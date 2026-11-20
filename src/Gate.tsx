// ログインの門番。クラウド版だけが実際に働く。
//
// 起動時に /api/auth/session を叩き、
//   - 200 で {user, …}               → そのままアプリを出す
//   - 200 で null                    → ログイン画面（クラウド版で未ログイン）
//   - そもそも経路が無い（404/501）  → ローカル版なのでログインは不要。アプリを出す
// 以降 401 が返ったとき（セッション切れ）も、ここに戻ってログイン画面を出す。
import React, {useCallback, useEffect, useState} from 'react';
import {api, onUnauthorized} from './api';
import {LoginPage} from './pages/Login';
import {StudioProvider} from './state/store';
import {App} from './App';
import {PwaUpdateNotice} from './components/PwaUpdateNotice';

type Phase = 'checking' | 'login' | 'ready';

export const Gate: React.FC = () => {
  const [phase, setPhase] = useState<Phase>('checking');

  const check = useCallback(async () => {
    try {
      // クラウド版は Auth.js の応答: ログイン中は {user, expires}、未ログインは null
      const r = await api.get<{user?: unknown} | null>('/api/auth/session');
      const d = r.data;
      setPhase(d === null || (typeof d === 'object' && !d.user) ? 'login' : 'ready');
    } catch (e) {
      // ローカル版にはこの経路が無い（404）。認証も要らないのでそのまま通す
      const status = (e as {status?: number}).status;
      setPhase(status === 401 ? 'login' : 'ready');
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  // セッションが切れたら（どの API でも 401）ログイン画面に戻す
  useEffect(() => onUnauthorized(() => setPhase('login')), []);

  if (phase === 'checking') return <div className="boot">読み込み中…</div>;
  if (phase === 'login') return <><LoginPage onDone={() => setPhase('ready')} /><PwaUpdateNotice /></>;
  return (
    <StudioProvider>
      <App />
    </StudioProvider>
  );
};
