// 新しい版のお知らせ（ポップアップ）と、「更新する」を押したあとの一連の流れ。
//
// 押したら git pull → サーバーに再起動を頼む → ランチャーが依存の導入・ビルド・起動をやり直す →
// 新しいサーバーが応答したら画面を読み直す、までを自動で進める（ターミナルを触らない人が使う前提）。
// 再起動できないとき（ジョブ実行中・ランチャー経由でない）は、その理由を出して手で起動し直してもらう。
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {api} from '../api';
import {useStudio} from '../state/store';
import type {UpdateNotify} from '../../shared/schema/settings';
import {shouldPromptUpdate, UPDATE_POLL_MS, UPDATE_SNOOZE_MS, type UpdateSnooze} from '../../shared/update';

export type VersionInfo = {
  local: {version: string; isGit: boolean; commit: string | null; shortCommit: string | null; committedAt: string | null; branch: string | null; dirty: boolean; repo: string};
  latest: {commit: string; shortCommit: string; committedAt: string | null; url: string} | null;
  behind: number | null;
  commits: {shortCommit: string; subject: string; date: string | null}[];
  problem: string | null;
  checkedAt: string;
  notify: UpdateNotify;
  restart: {launcher: boolean; blocker: string | null; startedAt: string};
};
export type PullResult = {ok: boolean; message: string; log: string[]; needsInstall: boolean; engineChanged: boolean; restart: boolean};

/** pulling＝取得中、restarting＝起動し直すのを待っている、slow＝待っても戻らない、manual＝取得できたが手で再起動が要る */
export type UpdatePhase = 'idle' | 'pulling' | 'restarting' | 'slow' | 'manual';

/** 再起動を待つ上限（依存の入れ直し・ビルドを含む）。過ぎたら黒い画面を見てもらう */
const RESTART_WAIT_MS = 10 * 60_000;

/** 「更新する」を押したあとの流れ。Settings のカードとポップアップの両方が使う */
export const useUpdater = () => {
  const s = useStudio();
  const [phase, setPhase] = useState<UpdatePhase>('idle');
  const [result, setResult] = useState<PullResult | null>(null);
  const [manualReason, setManualReason] = useState<string | null>(null);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  /** 新しいサーバー（起動時刻が変わった）が応答したら読み直す */
  const waitForRestart = useCallback(async (startedAt: string) => {
    const until = Date.now() + RESTART_WAIT_MS;
    while (alive.current && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 1500));
      try {
        const r = await api.get<VersionInfo>('/api/version?check=0');
        if (r.data.restart?.startedAt && r.data.restart.startedAt !== startedAt) {
          window.location.reload();
          return;
        }
      } catch {
        /* 止まっている間は繋がらないのが普通 */
      }
    }
    if (alive.current) setPhase('slow');
  }, []);

  const run = useCallback(async () => {
    setPhase('pulling');
    setResult(null);
    setManualReason(null);
    try {
      const before = (await api.get<VersionInfo>('/api/version?check=0')).data;
      const r = (await api.post<PullResult>('/api/version/update', {})).data;
      setResult(r);
      if (!r.ok) {
        s.toast(r.message, 'error');
        setPhase('idle');
        return r;
      }
      if (!r.restart) {
        s.toast(r.message, 'ok');
        setPhase('idle');
        return r;
      }
      try {
        await api.post('/api/version/restart', {});
      } catch (e) {
        // ジョブ実行中・ランチャー経由でない。取得は済んでいるので、手で起動し直してもらう
        setManualReason((e as Error).message);
        setPhase('manual');
        return r;
      }
      setPhase('restarting');
      void waitForRestart(before.restart.startedAt);
      return r;
    } catch (e) {
      s.toast(`更新に失敗: ${(e as Error).message}`, 'error');
      setPhase('idle');
      return null;
    }
  }, [s, waitForRestart]);

  return {phase, result, manualReason, run, reset: () => setPhase('idle')};
};

/** 更新中〜再起動待ちのあいだ画面を覆う。操作させない（途中の保存が古いサーバーに飛ばないように） */
export const UpdateOverlay: React.FC<{phase: UpdatePhase; result: PullResult | null; manualReason: string | null; onClose: () => void}> = ({phase, result, manualReason, onClose}) => {
  if (phase === 'idle') return null;
  return (
    <div className="modal-root update-overlay" role="dialog" aria-modal="true" aria-label="Reel Studio の更新">
      <div className="modal update-modal">
        <div className="modal-head">
          <b>Reel Studio を更新しています</b>
        </div>
        <div className="modal-body">
          {phase === 'pulling' && <p className="update-wait">新しい版を取得しています…</p>}
          {phase === 'restarting' && (
            <>
              <p className="update-wait">起動し直しています。終わったら画面が自動で読み直されます。</p>
              <p className="hint">
                {result?.needsInstall ? '依存パッケージが変わったので入れ直しています。数分かかることがあります。' : '画面のビルドに少し時間がかかります。'}
                このタブは閉じずにお待ちください。
              </p>
            </>
          )}
          {phase === 'slow' && (
            <>
              <p className="warn-text">起動し直すのに時間がかかっています。</p>
              <p className="hint">
                黒い画面（Reel Studio のウィンドウ）にエラーが出ていないか確認してください。閉じてしまっている場合は「Reel Studio.cmd」で起動し直し、このページを読み直してください。
              </p>
              <button onClick={() => window.location.reload()}>読み直す</button>
            </>
          )}
          {phase === 'manual' && (
            <>
              <p>
                <b>{result?.message}</b>
              </p>
              <p className="warn-text">{manualReason}</p>
              <p className="hint">Reel Studio のウィンドウを閉じて、「Reel Studio.cmd」（またはデスクトップのショートカット）で起動し直すと新しい版になります。</p>
              <button onClick={onClose}>閉じる</button>
            </>
          )}
          {result?.engineChanged && phase !== 'pulling' && <p className="hint">テロップの描画（エンジン）が変わりました。各案件は次のレンダーで自動的に揃います。</p>}
        </div>
      </div>
    </div>
  );
};

const SNOOZE_KEY = 'reel.update.snooze';
const readSnooze = (): UpdateSnooze | null => {
  try {
    const v = JSON.parse(localStorage.getItem(SNOOZE_KEY) ?? 'null') as UpdateSnooze | null;
    return v && typeof v.commit === 'string' && typeof v.until === 'number' ? v : null;
  } catch {
    return null;
  }
};
const writeSnooze = (v: UpdateSnooze): void => {
  try {
    localStorage.setItem(SNOOZE_KEY, JSON.stringify(v));
  } catch {
    /* 保存できなくても、このタブの間は閉じたままにする */
  }
};

/**
 * 新しい版があればポップアップで知らせる（設定で「ポップアップで知らせる」のとき・PC で動かしているときだけ）。
 * held＝ほかの案内（初回のツアー・ヘルプ）が開いている間は出さず、閉じてから出す（重なって押せなくなるため）
 */
export const UpdatePrompt: React.FC<{held?: boolean}> = ({held = false}) => {
  const s = useStudio();
  const [info, setInfo] = useState<VersionInfo | null>(null);
  const [closed, setClosed] = useState(false);
  const up = useUpdater();

  useEffect(() => {
    if (s.isCloud) return;
    let stop = false;
    const check = async () => {
      try {
        const r = await api.get<VersionInfo>('/api/version');
        if (!stop) setInfo(r.data);
      } catch {
        /* 古いサーバー・オフラインでは黙っておく */
      }
    };
    void check();
    const t = setInterval(() => void check(), UPDATE_POLL_MS);
    return () => {
      stop = true;
      clearInterval(t);
    };
  }, [s.isCloud]);

  if (s.isCloud) return null;
  if (up.phase !== 'idle') return <UpdateOverlay phase={up.phase} result={up.result} manualReason={up.manualReason} onClose={up.reset} />;
  if (!info || closed || held) return null;
  if (!shouldPromptUpdate({notify: info.notify, isGit: info.local.isGit, behind: info.behind, latestCommit: info.latest?.commit ?? null, snooze: readSnooze(), now: Date.now()})) return null;

  const later = () => {
    if (info.latest) writeSnooze({commit: info.latest.commit, until: Date.now() + UPDATE_SNOOZE_MS});
    setClosed(true);
  };
  const blocker = info.local.dirty ? '手元に未コミットの変更があるため、自動では更新できません（git stash で退避するか、コミットしてください）' : null;
  // ジョブ実行中は押せるようにしておく（取得だけ済ませ、再起動は手で）。ただし先に知らせる
  const note = info.restart.blocker;

  return (
    <div className="modal-root" onClick={later}>
      <div className="modal update-modal" role="dialog" aria-modal="true" aria-label="新しい版があります" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>新しい版があります（{info.behind} 件の変更）</b>
          <span style={{flex: 1}} />
          <button className="small" onClick={later} aria-label="閉じる">
            ×
          </button>
        </div>
        <div className="modal-body">
          <p>
            いまの版 <span className="mono">{info.local.version}（{info.local.shortCommit}）</span> → 最新 <span className="mono">{info.latest?.shortCommit}</span>。
            「今すぐ更新」を押すと、取得・依存の導入・ビルド・起動し直しまで自動で行い、終わったら画面を読み直します。
            案件データ・設定・人格は失われません。
          </p>
          {info.commits.length > 0 && (
            <details className="update-log" open>
              <summary>入る変更（新しい順）</summary>
              <ul>
                {info.commits.map((c) => (
                  <li key={c.shortCommit}>
                    <span className="mono dim">{c.shortCommit}</span> {c.subject}
                  </li>
                ))}
              </ul>
            </details>
          )}
          {blocker && <p className="warn-text">{blocker}</p>}
          {!blocker && note && <p className="hint">{note}</p>}
          <div className="row update-actions">
            <button className="primary" onClick={() => void up.run()} disabled={!!blocker}>
              今すぐ更新
            </button>
            <button onClick={later}>あとで（明日また知らせる）</button>
            <span className="hint">知らせ方は Settings の「版と更新」で変えられます</span>
          </div>
        </div>
      </div>
    </div>
  );
};
