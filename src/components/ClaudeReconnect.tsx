// Settings「使うAIを選ぶ」の Claude 再接続。PC の claude CLI（Claude Code）のログイン状態を見て、
// ログイン済みなら接続先を Claude に切り替えて保存する。未ログイン・期限切れなら PC で `claude auth login` の
// ウィンドウを開き、ブラウザでの承認が終わるのを待ってから自動で切り替える。
// クラウド画面からはログインを開けないので、PC がログイン済みのときだけ切り替えを依頼する。
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {api, type ApiError} from '../api';
import type {ClaudeAuth, ClaudeReconnectResult, SettingsView} from '@shared/schema/settings';

type AuthReply = {available: boolean; auth: ClaudeAuth | null; command: string; remote?: boolean};
type Props = {
  /** 切り替え後に使うモデル（画面で選んでいるもの） */
  model: string;
  /** いま保存されている接続先が Claude か */
  current: boolean;
  /** 保存後の見え方を Settings に渡す */
  onView: (view: SettingsView, message: string) => void | Promise<void>;
};

const POLL_MS = 3000;
const WAIT_LIMIT_MS = 5 * 60_000;

const errText = (e: unknown): string => (e as ApiError)?.message ?? String(e);

const describe = (auth: ClaudeAuth | null): string => {
  if (!auth) return '確認していません';
  if (!auth.loggedIn) return auth.error ?? 'ログインしていません';
  const until = auth.expiresAt ? `・${new Date(auth.expiresAt).toLocaleDateString('ja-JP', {month: 'numeric', day: 'numeric'})}まで有効` : '';
  return `ログイン済み${auth.plan ? `（${auth.plan}）` : ''}${until}`;
};

export const ClaudeReconnect: React.FC<Props> = ({model, current, onView}) => {
  const [info, setInfo] = useState<AuthReply | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [message, setMessage] = useState<{ok: boolean; text: string} | null>(null);
  const waitRef = useRef<{until: number; timer?: ReturnType<typeof setTimeout>} | null>(null);
  const modelRef = useRef(model);
  modelRef.current = model;

  const check = useCallback(async (): Promise<AuthReply | null> => {
    setChecking(true);
    try {
      const r = await api.get<AuthReply>('/api/settings/claude/auth');
      setInfo(r.data);
      return r.data;
    } catch (e) {
      setMessage({ok: false, text: errText(e)});
      return null;
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void check();
    return () => {
      if (waitRef.current?.timer) clearTimeout(waitRef.current.timer);
      waitRef.current = null;
    };
  }, [check]);

  const stopWaiting = () => {
    if (waitRef.current?.timer) clearTimeout(waitRef.current.timer);
    waitRef.current = null;
    setWaiting(false);
  };

  const reconnect = useCallback(
    async (openLogin: boolean): Promise<void> => {
      setBusy(true);
      try {
        const r = await api.post<ClaudeReconnectResult>('/api/settings/claude/reconnect', {model: modelRef.current, openLogin});
        const res = r.data;
        if (res.auth) setInfo((prev) => ({available: true, command: prev?.command ?? 'claude auth login', remote: prev?.remote, auth: res.auth}));
        if (res.state === 'connected' || res.state === 'pending') {
          stopWaiting();
          setMessage({ok: true, text: res.message});
          if (res.view) await onView(res.view, res.message);
          return;
        }
        if (res.state === 'login-started') {
          setMessage({ok: true, text: res.message});
          startWaiting();
          return;
        }
        stopWaiting();
        setMessage({ok: false, text: res.message});
      } catch (e) {
        stopWaiting();
        setMessage({ok: false, text: errText(e)});
      } finally {
        setBusy(false);
      }
    },
    // startWaiting は下で定義している（呼ぶのはクリック後なので、その時点では定義済み）
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [onView],
  );

  // ログインが終わるまで数秒おきに状態を読み、ログインできたら切り替える（ログイン画面は開き直さない）
  const startWaiting = () => {
    stopWaiting();
    const state: {until: number; timer?: ReturnType<typeof setTimeout>} = {until: Date.now() + WAIT_LIMIT_MS};
    waitRef.current = state;
    setWaiting(true);
    const tick = async () => {
      if (waitRef.current !== state) return;
      const r = await check();
      if (waitRef.current !== state) return;
      if (r?.auth?.loggedIn) {
        waitRef.current = null;
        setWaiting(false);
        await reconnect(false);
        return;
      }
      if (Date.now() > state.until) {
        stopWaiting();
        setMessage({ok: false, text: 'ログインの完了を確認できませんでした。ログインが終わったら「Claude に再接続」をもう一度押してください'});
        return;
      }
      state.timer = setTimeout(() => void tick(), POLL_MS);
    };
    state.timer = setTimeout(() => void tick(), POLL_MS);
  };

  const auth = info?.auth ?? null;
  const remote = !!info?.remote;
  const loggedIn = !!auth?.loggedIn;
  // クラウドからはログインを開けない。PC が未ログインなら押しても失敗するだけなので案内に替える
  const blocked = remote && !!auth && !loggedIn;

  return (
    <div className="full claude-reconnect" data-testid="claude-reconnect">
      <div className="row" style={{alignItems: 'center', gap: 8, flexWrap: 'wrap'}}>
        <span>{remote ? 'PC の Claude:' : 'この PC の Claude:'}</span>
        <span className={`pill${info && !info.available ? ' err' : loggedIn ? '' : auth ? ' warn' : ''}`} role="status">
          {checking && !auth ? '確認中…' : info && !info.available ? 'claude が見つかりません' : describe(auth)}
        </span>
        <button type="button" className="small" onClick={() => void check()} disabled={checking || busy}>
          {checking ? '確認中…' : '状態を確認'}
        </button>
      </div>
      <div className="row" style={{alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 6}}>
        <button
          type="button"
          className={current && loggedIn ? '' : 'primary'}
          onClick={() => void reconnect(true)}
          disabled={busy || waiting || blocked || (!!info && !info.available)}
          title={
            remote
              ? 'PC がログイン済みなら、接続先を Claude に切り替えるよう PC に依頼します'
              : 'ログイン済みならそのまま Claude に切り替えて保存します。未ログインならログイン用のウィンドウを開きます'
          }
        >
          {busy ? '接続中…' : waiting ? 'ログインの完了を待っています…' : loggedIn ? 'Claude に再接続' : remote ? 'Claude に再接続' : 'ログインして Claude に再接続'}
        </button>
        {waiting && (
          <button type="button" className="small" onClick={stopWaiting}>
            待つのをやめる
          </button>
        )}
      </div>
      {waiting && (
        <p className="hint">
          開いたウィンドウの案内に沿ってブラウザで承認してください。終わると自動で Claude に切り替わります。ウィンドウが開かないときは、ターミナルで <span className="mono">{info?.command ?? 'claude auth login'}</span> を実行してください。
        </p>
      )}
      {blocked && <p className="hint">PC の Claude がログインしていません。PC の Reel Studio の Settings で「ログインして Claude に再接続」を押してください。</p>}
      {message && (
        <p className={message.ok ? 'hint' : 'warn-text'} role={message.ok ? 'status' : 'alert'}>
          {message.text}
        </p>
      )}
    </div>
  );
};
