// 選別モード：素材を 1 本ずつ大きく見て「必要／不要」を決める。
//
// 決めるだけでなく、**その場で素材を編集できる**ようにしてある。撮った直後の素材は
// 使える部分が一部だけ（手ブレの前後を落とす・見せ場だけ残す）ということが多く、
// 判定と同時に決めてしまうのが一番早い。
//   - 拡大 … 動画だけを大きくして細部を確かめる
//   - トリミング … 使える区間（usableRanges）を帯の上で掴んで決める。以降の構成プランは
//                  best が付いた区間から採る（無指定なら全尺から採る）
//   - 種別・画角・被写体 … 構成プランの判断に効く最小限のタグ
// 切り出しとトリミングは ClipEditor（素材ページの詳細欄と共通）。
// 保存は呼び出し側（Materials）が catalog.json に対して行う。ここからも押せる。
import React, {useEffect, useMemo, useRef, useState} from 'react';
import type {Clip, ClipKind} from '@shared/schema';
import {KIND_LABEL} from '../editor/labels';
import {ClipEditor, type ClipUpdate} from './ClipEditor';
import {rangeForBar, withRange, withTags} from './triage';
import {useStudio} from '../state/store';

type Props = {
  clips: Clip[];
  mediaBase: string | null;
  onDecide: (id: string, patch: Partial<Clip['user']>) => void;
  /** 素材そのものの編集（使える区間・タグ・切り出し）。Materials の updateClip をそのまま受ける */
  onUpdate: ClipUpdate;
  /** 取り消し（catalog 全体の 1 手戻し）。Materials が履歴を持つ */
  onUndo: () => void;
  canUndo: boolean;
  onClose: () => void;
};

const KINDS: ClipKind[] = ['exterior', 'signage', 'interior', 'menu', 'cooking', 'serving', 'eating', 'sizzle', 'person', 'conversation', 'detail', 'other'];
const ANGLES: NonNullable<Clip['tags']>['angle'][] = ['wide', 'mid', 'close'];
const ANGLE_LABEL: Record<string, string> = {wide: '引き', mid: '中', close: '寄り'};

export const TriageMode: React.FC<Props> = ({clips, mediaBase, onDecide, onUpdate, onUndo, canUndo, onClose}) => {
  const s = useStudio();
  const [i, setI] = useState(0);
  const [big, setBig] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const clip = clips[i] as Clip | undefined;
  const done = i >= clips.length;
  const dirty = s.files.catalog.dirty;

  const {kept, dropped} = useMemo(() => {
    const seen = clips.slice(0, i);
    return {kept: seen.filter((c) => !c.user.ng).length, dropped: seen.filter((c) => c.user.ng).length};
  }, [clips, i]);

  const setTags = (patch: Partial<NonNullable<Clip['tags']>>, historyKey?: string) => {
    if (!clip) return;
    onUpdate(clip.id, (c) => withTags(c, patch), historyKey);
  };

  // ── 判定と移動 ────────────────────────────────────────────
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

  /** 帯を触らずに IN / OUT を決める（キーボード）。区間の作り方は ClipEditor と同じ関数を使う */
  const setEdge = (edge: 'in' | 'out') => {
    const v = videoRef.current;
    if (!clip || !v) return;
    const {inSec, outSec} = rangeForBar(clip);
    const next = edge === 'in' ? {inSec: Math.min(v.currentTime, outSec - 0.2), outSec} : {inSec, outSec: Math.max(v.currentTime, inSec + 0.2)};
    onUpdate(clip.id, (c) => withRange(c, next), `trim:${clip.id}`);
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'Escape') return big ? setBig(false) : onClose();
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
      } else if (e.key === 'z' || e.key === 'Z') {
        e.preventDefault();
        // Ctrl+Z は「編集の取り消し」、素の Z は「枠を大きく」（選別中に一番よく使う）
        if (e.ctrlKey || e.metaKey) onUndo();
        else setBig((v) => !v);
      } else if (e.key === 'i' || e.key === 'I') {
        e.preventDefault();
        setEdge('in');
      } else if (e.key === 'o' || e.key === 'O') {
        e.preventDefault();
        setEdge('out');
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip, done, big, canUndo]);

  return (
    <div className="modal-root triage-root" onClick={onClose}>
      <div className={`modal triage${big ? ' big' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>選別モード</b>
          <span className="hint">{done ? '完了' : `${i + 1} / ${clips.length}`}</span>
          <span style={{flex: 1}} />
          <span className="hint">
            必要 {kept}・不要 {dropped}
          </span>
          <button className="small" onClick={onUndo} disabled={!canUndo} title="直前の編集を取り消す（Ctrl+Z）">
            ↶ 元に戻す
          </button>
          <button className="small primary" onClick={() => void s.saveFile('catalog')} disabled={!dirty} title="ここまでの編集を catalog.json に書き込む">
            保存{dirty ? ' *' : ''}
          </button>
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
              <p className="hint">「不要」にしたクリップは一覧で薄く表示されます。{dirty ? '上の「保存」を押すと catalog.json に書き込みます。' : '保存済みです。'}</p>
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
              <ClipEditor clip={clip} mediaBase={mediaBase} onUpdate={onUpdate} videoRef={videoRef} big={big} onBig={setBig} />

              {/* 構成プランの判断に効く最小限のタグ。ここで直しておくと Materials に戻らなくて済む */}
              <div className="triage-tags">
                <label>
                  種別
                  <select value={clip.tags?.kind ?? 'other'} onChange={(e) => setTags({kind: e.target.value as ClipKind})}>
                    {KINDS.map((k) => (
                      <option key={k} value={k}>
                        {KIND_LABEL[k]}
                      </option>
                    ))}
                  </select>
                </label>
                <label>
                  画角
                  <select value={clip.tags?.angle ?? 'mid'} onChange={(e) => setTags({angle: e.target.value as NonNullable<Clip['tags']>['angle']})}>
                    {ANGLES.map((a) => (
                      <option key={a} value={a}>
                        {ANGLE_LABEL[a]}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="grow">
                  被写体
                  <input value={clip.tags?.subject ?? ''} onChange={(e) => setTags({subject: e.target.value}, `subject:${clip.id}`)} placeholder="エッグベネディクト など" spellCheck={false} />
                </label>
              </div>

              <div className="triage-meta">
                <div className="row" style={{alignItems: 'center'}}>
                  <b>{clip.id}</b>
                  <span>{clip.probe.durationSec.toFixed(1)}s</span>
                  {clip.tags?.signage && <span className="badge sign">看板</span>}
                  {clip.user.hook && <span className="badge hook">★hook</span>}
                  {clip.user.ng && <span className="badge ng">不要</span>}
                  <span className="hint">{clip.tags?.description ?? clip.slug}</span>
                </div>
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
              <div className="triage-foot">
                <button className="small" onClick={back} disabled={i === 0}>
                  ← 1 つ戻る
                </button>
                <ul className="insp-keys triage-keys">
                  <li>
                    <code>→</code>/<code>K</code> 必要　<code>←</code>/<code>X</code> 不要　<code>H</code> フック候補　<code>I</code>/<code>O</code> 区間の頭／尻　<code>Z</code> 枠を大きく　<code>Ctrl+Z</code> 取り消し　<code>Backspace</code> 戻る　<code>Esc</code> 終了　／　画の上でホイール・ピンチ＝寄り、ドラッグ＝位置
                  </li>
                </ul>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};
