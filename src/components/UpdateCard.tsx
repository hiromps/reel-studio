// 版の確認と更新（PC で動かしているときだけ出る）。
//
// このツールは git clone で配っているので、更新は git pull。ただし**ターミナルを開かない人が
// 使う前提**なので、更新があることと、押せば進むことを画面の中で完結させる。
// npm install はここではやらない（動いているサーバーが node_modules を掴んでいるため、
// 次の起動でランチャーが入れ直す）。
import React, {useCallback, useEffect, useState} from 'react';
import {api} from '../api';
import {useStudio} from '../state/store';

type Local = {version: string; isGit: boolean; shortCommit: string | null; committedAt: string | null; branch: string | null; dirty: boolean; repo: string};
type Info = {
  local: Local;
  latest: {shortCommit: string; committedAt: string | null; url: string} | null;
  behind: number | null;
  commits: {shortCommit: string; subject: string; date: string | null}[];
  problem: string | null;
  checkedAt: string;
};
type PullResult = {ok: boolean; message: string; log: string[]; needsInstall: boolean; engineChanged: boolean; restart: boolean};

const day = (iso: string | null | undefined): string => (iso ? new Date(iso).toLocaleString('ja-JP', {year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'}) : '—');

export const UpdateCard: React.FC = () => {
  const s = useStudio();
  const [info, setInfo] = useState<Info | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PullResult | null>(null);
  const [unsupported, setUnsupported] = useState(false);

  const load = useCallback(async (refresh = false) => {
    setBusy(true);
    try {
      const r = await api.get<Info>(`/api/version${refresh ? '?refresh=1' : ''}`);
      setInfo(r.data);
    } catch (e) {
      // クラウド版・古いサーバーにはこの経路が無い
      if ((e as {status?: number}).status === 404) setUnsupported(true);
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    if (!s.isCloud) void load();
  }, [s.isCloud, load]);

  // クラウドの画面からは更新できない（Vercel にデプロイした版で動いている）
  if (s.isCloud)
    return (
      <section className="card">
        <h2>版と更新</h2>
        <p className="hint">
          この画面はクラウド版です。更新は <span className="mono">git pull</span> のあと Vercel に再デプロイしてください（PC のワーカーも同じように更新して再起動）。
        </p>
      </section>
    );
  if (unsupported) return null;

  const update = async () => {
    setBusy(true);
    setResult(null);
    try {
      const r = await api.post<PullResult>('/api/version/update', {});
      setResult(r.data);
      if (r.data.ok) s.toast(r.data.message, 'ok');
      else s.toast(r.data.message, 'error');
      await load(true);
    } catch (e) {
      s.toast(`更新に失敗: ${(e as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const l = info?.local;
  const behind = info?.behind ?? null;
  const hasUpdate = behind !== null && behind > 0;

  return (
    <section className="card">
      <h2>版と更新</h2>
      <div className="row" style={{alignItems: 'center'}}>
        <span>
          いまの版 <b className="mono">{l?.version ?? '…'}</b>
          {l?.shortCommit && <span className="mono dim"> （{l.shortCommit}{l.branch && l.branch !== 'main' ? ` / ${l.branch}` : ''}）</span>}
        </span>
        <span className="hint">{day(l?.committedAt)}</span>
        <span style={{flex: 1}} />
        {hasUpdate ? (
          <span className="pill warn">{behind} 件の更新があります</span>
        ) : behind === 0 ? (
          <span className="pill">最新です</span>
        ) : null}
        <button className="small" onClick={() => void load(true)} disabled={busy}>
          {busy ? '確認中…' : '確認'}
        </button>
        {hasUpdate && (
          <button className="primary" onClick={() => void update()} disabled={busy || !l?.isGit || l?.dirty}>
            更新する
          </button>
        )}
      </div>

      {l && !l.isGit && (
        <p className="hint">
          zip で展開したもののようです（<span className="mono">.git</span> がありません）。更新するには
          <span className="mono"> git clone https://github.com/{l.repo}.git </span>
          で入れ直してください。設定と人格（<span className="mono">~/.reel-studio/</span>）と案件データはフォルダの外にあるので、そのまま引き継がれます。
        </p>
      )}
      {l?.dirty && (
        <p className="warn-text">
          手元に未コミットの変更があるため更新できません。<span className="mono">git stash</span> で退避するか、コミットしてから「更新する」を押してください。
        </p>
      )}
      {info?.problem && <p className="hint">最新版の確認ができませんでした: {info.problem}</p>}

      {hasUpdate && (info?.commits.length ?? 0) > 0 && (
        <details className="update-log" open>
          <summary>入る変更（新しい順）</summary>
          <ul>
            {(info?.commits ?? []).map((c) => (
              <li key={c.shortCommit}>
                <span className="mono dim">{c.shortCommit}</span> {c.subject}
              </li>
            ))}
          </ul>
        </details>
      )}

      {result && (
        <div className={result.ok ? 'update-result' : 'update-result err'}>
          <b>{result.message}</b>
          {result.restart && (
            <p>
              <b>Reel Studio を再起動してください。</b>
              {result.needsInstall && '（依存パッケージが変わったので、次の起動で自動的に入れ直します。少し時間がかかります）'}
              {result.engineChanged && ' テロップの描画（エンジン）が変わったので、各案件は次のレンダーで自動的に揃います。'}
            </p>
          )}
          {result.log.length > 0 && <pre className="log">{result.log.join('\n')}</pre>}
        </div>
      )}

      <p className="hint">
        更新はコマンドからもできます: <span className="mono">npm run update</span>（git pull と依存の導入をまとめて行います）。
        案件データ・設定・人格はリポジトリの外にあるので、更新で失われません。
      </p>
    </section>
  );
};
