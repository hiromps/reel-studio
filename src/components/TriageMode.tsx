// 選別モード：カタログ読み込み後、渡されたクリップ列を 1 本ずつ大きく見て「必要」「不要」を素早く判定する。
// 判定は既存の user.ng（不要）／user.hook（フック候補）フラグをそのまま使う。保存は呼び出し側（Materials）に任せる。
import React, {useEffect, useMemo, useState} from 'react';
import type {Clip} from '@shared/schema';
import {KIND_LABEL} from '../editor/labels';
import {useStudio} from '../state/store';

type Props = {
  clips: Clip[];
  mediaBase: string | null;
  onDecide: (id: string, patch: Partial<Clip['user']>) => void;
  onClose: () => void;
};

export const TriageMode: React.FC<Props> = ({clips, mediaBase, onDecide, onClose}) => {
  const s = useStudio();
  const [i, setI] = useState(0);
  /** 映像を読めなかったクリップ（クラウドでは軽量プレビュー未作成が原因のことが多い） */
  const [failed, setFailed] = useState<string | null>(null);
  const clip = clips[i] as Clip | undefined;
  const done = i >= clips.length;
  const {kept, dropped} = useMemo(() => {
    const seen = clips.slice(0, i);
    return {kept: seen.filter((c) => !c.user.ng).length, dropped: seen.filter((c) => c.user.ng).length};
  }, [clips, i]);

  const keep = () => {
    if (!clip) return;
    onDecide(clip.id, {ng: false});
    setI((n) => n + 1);
  };
  const drop = () => {
    if (!clip) return;
    onDecide(clip.id, {ng: true});
    setI((n) => n + 1);
  };
  const toggleHook = () => clip && onDecide(clip.id, {hook: !clip.user.hook});
  const back = () => setI((n) => Math.max(0, n - 1));

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'Escape') return onClose();
      if (done) return;
      if (e.key === 'ArrowRight' || e.key === 'k' || e.key === 'K' || e.key === 'Enter') {
        e.preventDefault();
        keep();
      } else if (e.key === 'ArrowLeft' || e.key === 'x' || e.key === 'X') {
        e.preventDefault();
        drop();
      } else if (e.key === 'Backspace' || e.key === 'p' || e.key === 'P') {
        e.preventDefault();
        back();
      } else if (e.key === 'h' || e.key === 'H') {
        e.preventDefault();
        toggleHook();
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip, done]);

  return (
    <div className="modal-root triage-root" onClick={onClose}>
      <div className="modal triage" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>選別モード</b>
          <span className="hint">{done ? '完了' : `${i + 1} / ${clips.length}`}</span>
          <span style={{flex: 1}} />
          <span className="hint">
            必要 {kept}・不要 {dropped}
          </span>
          <button className="small" onClick={onClose}>
            閉じる（Esc）
          </button>
        </div>
        <div className="modal-body triage-body">
          {done || !clip ? (
            <div className="triage-done">
              <p>
                {clips.length} 本を判定しました。必要 {kept} 本・不要 {dropped} 本。
              </p>
              <p className="hint">「不要」にしたクリップは一覧で薄く表示されます。catalog.json への保存を忘れずに。</p>
              <div className="row">
                <button className="small" onClick={() => setI(0)} disabled={!clips.length}>
                  最初からやり直す
                </button>
                <button className="primary" onClick={onClose}>
                  閉じる
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="triage-stage">
                {/* iOS は playsInline が無いと**インライン再生そのものができず autoPlay も効かない**。
                    muted と両方そろって初めて自動で流れる */}
                <video
                  key={clip.id}
                  src={mediaBase ? `${mediaBase}/${clip.src}` : undefined}
                  autoPlay
                  loop
                  muted
                  controls
                  playsInline
                  preload="metadata"
                  onError={() => setFailed(clip.id)}
                  onLoadedData={() => setFailed((f) => (f === clip.id ? null : f))}
                />
                {failed === clip.id && (
                  <div className="triage-noplay">
                    <b>この素材の映像が読めません</b>
                    {s.isCloud ? (
                      <>
                        <span>クラウドには原本を置かないので、スマホで再生できるのは PC が作った軽量プレビューだけです。この案件ではまだ作られていません。</span>
                        <button className="small primary" onClick={() => void s.addJob('preview-proxy')} disabled={s.jobs.some((j) => j.type === 'preview-proxy' && (j.status === 'running' || j.status === 'queued'))}>
                          軽量プレビューを作る（PC で実行）
                        </button>
                      </>
                    ) : (
                      <span>素材ファイルが案件フォルダにあるか確認してください（{clip.src}）。</span>
                    )}
                  </div>
                )}
              </div>
              <div className="triage-meta">
                <div className="row" style={{alignItems: 'center'}}>
                  <b>{clip.id}</b>
                  <span>{clip.probe.durationSec.toFixed(1)}s</span>
                  {clip.tags && (
                    <span className="badge">
                      {KIND_LABEL[clip.tags.kind]}/{clip.tags.angle}
                    </span>
                  )}
                  {clip.tags?.signage && <span className="badge sign">看板</span>}
                  {clip.user.hook && <span className="badge hook">★hook</span>}
                  {clip.user.ng && <span className="badge ng">不要</span>}
                </div>
                <div className="hint">{clip.tags?.description ?? clip.slug}</div>
              </div>
              <div className="triage-actions">
                <button className="danger" onClick={drop}>
                  ✕ 不要
                </button>
                <button className={clip.user.hook ? 'primary' : ''} onClick={toggleHook}>
                  ★ フック候補
                </button>
                <button className="primary" onClick={keep}>
                  ✓ 必要
                </button>
              </div>
              <button className="small" onClick={back} disabled={i === 0}>
                ← 1 つ戻る
              </button>
              <ul className="insp-keys triage-keys">
                <li>
                  <code>→</code> / <code>K</code> 必要 → 次へ　<code>←</code> / <code>X</code> 不要 → 次へ　<code>H</code> フック候補（トグル）　<code>Backspace</code> 1 つ戻る　<code>Esc</code> 終了
                </li>
              </ul>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
