// 版の確認と更新（PC で動かしているときだけ出る）。
//
// このツールは git clone で配っているので、更新は git pull。ただし**ターミナルを開かない人が
// 使う前提**なので、更新があることと、押せば進むことを画面の中で完結させる。
// 「更新する」のあとの取得・再起動・読み直しは UpdatePrompt.tsx の useUpdater が行う（ポップアップと同じ流れ）。
// 新しい版をポップアップで知らせるか（update.notify）もここで選ぶ。
import React, {useCallback, useEffect, useState} from 'react';
import {api} from '../api';
import {useStudio} from '../state/store';
import type {UpdateNotify} from '../../shared/schema/settings';
import {UpdateOverlay, useUpdater, type VersionInfo} from './UpdatePrompt';

const day = (iso: string | null | undefined): string => (iso ? new Date(iso).toLocaleString('ja-JP', {year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'}) : '—');

const NOTIFY_OPTIONS: {value: UpdateNotify; label: string; hint: string}[] = [
  {value: 'popup', label: 'ポップアップで知らせる', hint: 'おすすめ。新しい版が出たら画面に出し、「今すぐ更新」で更新から起動し直しまで自動で行います'},
  {value: 'manual', label: 'このカードから手動で', hint: '知らせません。好きなときにここの「更新する」を押します'},
];

export const UpdateCard: React.FC<{notify?: UpdateNotify; onNotify?: (n: UpdateNotify) => void}> = ({notify, onNotify}) => {
  const s = useStudio();
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const up = useUpdater();
  const result = up.phase === 'idle' ? up.result : null;

  const load = useCallback(async (refresh = false) => {
    setBusy(true);
    try {
      const r = await api.get<VersionInfo>(`/api/version${refresh ? '?refresh=1' : ''}`);
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
    await up.run();
    await load(true);
  };

  const l = info?.local;
  const behind = info?.behind ?? null;
  const hasUpdate = behind !== null && behind > 0;

  if (info?.distribution === 'desktop') return (
    <section className="card">
      <h2>版と更新</h2>
      <p>Reel Studio デスクトップ版 <b className="mono">{l?.version}</b></p>
      <p className="hint">更新するときはアプリを終了し、新しいインストーラーを実行してください。保存済みの案件・素材・設定は引き継がれます。</p>
    </section>
  );

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
          <button className="primary" onClick={() => void update()} disabled={busy || up.phase !== 'idle' || !l?.isGit || l?.dirty}>
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
          {result.log.length > 0 && <pre className="log">{result.log.join('\n')}</pre>}
        </div>
      )}
      {info?.restart.blocker && hasUpdate && <p className="hint">{info.restart.blocker}</p>}

      {notify && onNotify && (
        <fieldset className="update-notify">
          <legend>新しい版の知らせ方</legend>
          {NOTIFY_OPTIONS.map((o) => (
            <label key={o.value} className="font-pick">
              <input type="radio" name="update-notify" checked={notify === o.value} onChange={() => onNotify(o.value)} />
              <span>
                <b>{o.label}</b>
                <span className="hint"> — {o.hint}</span>
              </span>
            </label>
          ))}
        </fieldset>
      )}

      <p className="hint">
        「更新する」を押すと、取得・依存の導入・ビルド・起動し直しまで自動で行い、終わったら画面を読み直します。
        コマンドからもできます: <span className="mono">npm run update</span>。案件データ・設定・人格はリポジトリの外にあるので、更新で失われません。
      </p>
      <UpdateOverlay phase={up.phase} result={up.result} manualReason={up.manualReason} onClose={up.reset} />
    </section>
  );
};
