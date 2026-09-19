// 選別モード：素材を 1 本ずつ大きく見て「必要／不要」を決める。
//
// 決めるだけでなく、**その場で素材を編集できる**ようにしてある。撮った直後の素材は
// 使える部分が一部だけ（手ブレの前後を落とす・見せ場だけ残す）ということが多く、
// 判定と同時に決めてしまうのが一番早い。
//   - 拡大 … 動画だけを大きくして細部を確かめる
//   - トリミング … 使える区間（usableRanges）を帯の上で掴んで決める。以降の構成プランは
//                  best が付いた区間から採る（無指定なら全尺から採る）
//   - 種別・画角・被写体 … 構成プランの判断に効く最小限のタグ
// 保存は呼び出し側（Materials）が catalog.json に対して行う。
import React, {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import type {Clip, ClipKind, UsableRange} from '@shared/schema';
import {KIND_LABEL} from '../editor/labels';
import {TrimBar} from './TrimBar';
import {CropBox} from './CropBox';
import {DEFAULT_CROP, type Crop} from '@shared/schema/cuts';
import {primaryRangeIndex, rangeForBar, withRange, withRangeLabel, withTags, withoutPrimaryRange} from './triage';
import {useStudio} from '../state/store';

type Props = {
  clips: Clip[];
  mediaBase: string | null;
  onDecide: (id: string, patch: Partial<Clip['user']>) => void;
  /** 素材そのものの編集（使える区間・タグ）。Materials の updateClip をそのまま受ける */
  onUpdate: (id: string, patch: (c: Clip) => Clip) => void;
  onClose: () => void;
};

const KINDS: ClipKind[] = ['exterior', 'signage', 'interior', 'menu', 'cooking', 'serving', 'eating', 'sizzle', 'person', 'conversation', 'detail', 'other'];
const ANGLES: NonNullable<Clip['tags']>['angle'][] = ['wide', 'mid', 'close'];
const ANGLE_LABEL: Record<string, string> = {wide: '引き', mid: '中', close: '寄り'};
const LABELS: UsableRange['label'][] = ['best', 'ok', 'motion-full', 'avoid'];
const LABEL_TEXT: Record<UsableRange['label'], string> = {best: 'best（見せ場）', ok: 'ok', 'motion-full': 'motion-full（一連動作）', avoid: 'avoid（使わない）'};

export const TriageMode: React.FC<Props> = ({clips, mediaBase, onDecide, onUpdate, onClose}) => {
  const s = useStudio();
  const [i, setI] = useState(0);
  const [failed, setFailed] = useState<string | null>(null);
  const [zoom, setZoom] = useState(false);
  /** 使える区間だけを繰り返し再生する（決めた部分がどう見えるかを確かめる） */
  const [loopRange, setLoopRange] = useState(true);
  const videoRef = useRef<HTMLVideoElement>(null);
  const clip = clips[i] as Clip | undefined;
  const done = i >= clips.length;

  const {kept, dropped} = useMemo(() => {
    const seen = clips.slice(0, i);
    return {kept: seen.filter((c) => !c.user.ng).length, dropped: seen.filter((c) => c.user.ng).length};
  }, [clips, i]);

  // ── 使える区間 ────────────────────────────────────────────
  const pi = clip ? primaryRangeIndex(clip) : -1;
  const range = clip && pi >= 0 ? clip.usableRanges[pi] : null;
  const duration = clip?.probe.durationSec ?? 0;
  const {inSec, outSec} = clip ? rangeForBar(clip) : {inSec: 0, outSec: 0};

  const setRange = useCallback(
    (next: {inSec: number; outSec: number}) => {
      if (!clip) return;
      onUpdate(clip.id, (c) => withRange(c, next));
    },
    [clip, onUpdate],
  );

  const setLabel = (label: UsableRange['label']) => {
    if (!clip) return;
    onUpdate(clip.id, (c) => withRangeLabel(c, label, {inSec, outSec}));
  };

  const clearRange = () => {
    if (!clip || pi < 0) return;
    onUpdate(clip.id, (c) => withoutPrimaryRange(c));
  };

  const setTags = (patch: Partial<NonNullable<Clip['tags']>>) => {
    if (!clip) return;
    onUpdate(clip.id, (c) => withTags(c, patch));
  };

  /** 画面内の切り出し（アスペクト比は変えない）。素材側に覚えるので、構成に組むとカットへ引き継がれる */
  const setCrop = (crop: Crop) => {
    if (!clip) return;
    onUpdate(clip.id, (c) => ({...c, crop}));
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

  /** 区間を繰り返し再生する。IN を動かしたらそこから見せる */
  useEffect(() => {
    const v = videoRef.current;
    if (!v || !clip) return;
    if (!loopRange || !range) return;
    const onTime = () => {
      if (v.currentTime >= outSec - 0.02 || v.currentTime < inSec - 0.05) {
        v.currentTime = inSec;
        if (v.paused) void v.play().catch(() => undefined);
      }
    };
    v.addEventListener('timeupdate', onTime);
    return () => v.removeEventListener('timeupdate', onTime);
  }, [clip, loopRange, range, inSec, outSec]);

  /** IN を動かしたら、その位置を見せる（触っている場所と画が合うように） */
  const seekIn = (sec: number) => {
    const v = videoRef.current;
    if (!v) return;
    try {
      v.currentTime = Math.max(0, Math.min(duration - 0.05, sec));
    } catch {
      /* まだ読み込み前なら何もしない */
    }
  };

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.repeat) return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
      if (e.key === 'Escape') return zoom ? setZoom(false) : onClose();
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
        setZoom((v) => !v);
      } else if (e.key === 'i' || e.key === 'I') {
        e.preventDefault();
        if (videoRef.current) setRange({inSec: Math.min(videoRef.current.currentTime, outSec - 0.2), outSec});
      } else if (e.key === 'o' || e.key === 'O') {
        e.preventDefault();
        if (videoRef.current) setRange({inSec, outSec: Math.max(videoRef.current.currentTime, inSec + 0.2)});
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip, done, zoom, inSec, outSec]);

  return (
    <div className="modal-root triage-root" onClick={onClose}>
      <div className={`modal triage${zoom ? ' zoom' : ''}`} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <b>選別モード</b>
          <span className="hint">{done ? '完了' : `${i + 1} / ${clips.length}`}</span>
          <span style={{flex: 1}} />
          <span className="hint">
            必要 {kept}・不要 {dropped}
          </span>
          {!done && (
            <button className="small" onClick={() => setZoom((v) => !v)} title="編集する枠を大きくする（Z）。切り出しは枠の中でピンチ・ドラッグ">
              {zoom ? '枠を小さく' : '枠を大きく'}
            </button>
          )}
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
              {/* 9:16 の枠の中で「どこを、どれだけ寄って見せるか」を決める。比率は変わらない */}
              <div className="triage-stage">
                <CropBox
                  key={clip.id}
                  src={mediaBase ? `${mediaBase}/${clip.src}` : null}
                  crop={clip.crop ?? DEFAULT_CROP}
                  onChange={setCrop}
                  probe={clip.probe}
                  videoRef={videoRef}
                  onError={() => setFailed(clip.id)}
                >
                  {failed === clip.id && (
                    <div className="triage-noplay">
                      <b>この素材の映像が読めません</b>
                      {s.isCloud ? (
                        <>
                          <span>クラウドには原本を置かないので、スマホで再生できるのは PC が作った軽量プレビューだけです。この案件ではまだ作られていません。</span>
                          <button
                            className="small primary"
                            onClick={() => void s.addJob('preview-proxy')}
                            disabled={s.jobs.some((j) => j.type === 'preview-proxy' && (j.status === 'running' || j.status === 'queued'))}
                          >
                            軽量プレビューを作る（PC で実行）
                          </button>
                        </>
                      ) : (
                        <span>素材ファイルが案件フォルダにあるか確認してください（{clip.src}）。</span>
                      )}
                    </div>
                  )}
                </CropBox>
              </div>

              {/* 使える区間（トリミング）。帯を掴むとその場で区間ができる */}
              <div className="triage-trim">
                <TrimBar
                  inSec={inSec}
                  outSec={outSec}
                  durationSec={duration}
                  fps={clip.probe.fps}
                  strip={clip.thumbs.strip}
                  mediaBase={mediaBase}
                  usableRanges={clip.usableRanges}
                  onChange={(r) => {
                    setRange(r);
                    seekIn(r.inSec);
                  }}
                />
                <div className="triage-trim-row">
                  <select value={range?.label ?? 'best'} onChange={(e) => setLabel(e.target.value as UsableRange['label'])} title="この区間の扱い">
                    {LABELS.map((l) => (
                      <option key={l} value={l}>
                        {LABEL_TEXT[l]}
                      </option>
                    ))}
                  </select>
                  <label className="triage-loop" title="決めた区間だけを繰り返し再生する">
                    <input type="checkbox" checked={loopRange} onChange={(e) => setLoopRange(e.target.checked)} />
                    <span>区間だけ再生</span>
                  </label>
                  <button className="small" onClick={() => videoRef.current && setRange({inSec: Math.min(videoRef.current.currentTime, outSec - 0.2), outSec})} title="再生位置を頭にする（I）">
                    IN=いま
                  </button>
                  <button className="small" onClick={() => videoRef.current && setRange({inSec, outSec: Math.max(videoRef.current.currentTime, inSec + 0.2)})} title="再生位置を尻にする（O）">
                    OUT=いま
                  </button>
                  <button className="small" onClick={clearRange} disabled={pi < 0} title="区間の指定をやめる（全尺から使う）">
                    区間を消す
                  </button>
                  {pi < 0 && <span className="hint">未指定（全尺から使う）。帯を掴むと区間ができます</span>}
                </div>
              </div>

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
                  <input value={clip.tags?.subject ?? ''} onChange={(e) => setTags({subject: e.target.value})} placeholder="エッグベネディクト など" spellCheck={false} />
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
                    <code>→</code>/<code>K</code> 必要　<code>←</code>/<code>X</code> 不要　<code>H</code> フック候補　<code>I</code>/<code>O</code> 区間の頭／尻　<code>Z</code> 枠を大きく　<code>Backspace</code> 戻る　<code>Esc</code> 終了　／　画の上でホイール・ピンチ＝寄り、ドラッグ＝位置
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
