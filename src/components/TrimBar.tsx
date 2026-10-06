// 素材 1 本ぶんの帯の上で、頭（IN）と尻（OUT）を掴んで尺を決める。
// 帯の背景は catalog のストリップ（1 秒刻みのコマ）。無い素材はただの帯になる。
import React, {useRef, useState} from 'react';
import {stripStepSec} from '@shared/strip';
import {MIN_CUT_SEC, applyTrim, nudgeSec, type TrimHandle, type TrimRange} from './trim';

type Props = {
  inSec: number;
  outSec: number;
  /** 素材の全長。これがバーの幅になる */
  durationSec: number;
  fps: number;
  /** .studio 相対のストリップ画像（catalog の clip.thumbs.strip） */
  strip?: string[];
  /** 素材 URL の先頭（`/p/<slug>/<mode>`）。null ならフィルム帯を出さない */
  mediaBase?: string | null;
  usableRanges?: {inSec: number; outSec: number; label: string}[];
  disabled?: boolean;
  /** 固定尺の候補中は窓だけを移動できる */
  moveOnly?: boolean;
  /** 全尺のうち帯に表示する範囲。短い区間を掴みやすくする拡大表示用 */
  view?: TrimRange;
  /** ドラッグ開始時に 1 度だけ（Ctrl+Z 用に履歴を積む） */
  onStart?: () => void;
  onChange: (r: TrimRange) => void;
};

const pct = (v: number) => `${(v * 100).toFixed(4)}%`;

export const TrimBar: React.FC<Props> = ({inSec, outSec, durationSec, fps, strip = [], mediaBase, usableRanges = [], disabled, moveOnly, view, onStart, onChange}) => {
  const barRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{handle: TrimHandle; startX: number; base: TrimRange; width: number} | null>(null);
  const last = useRef<TrimRange>({inSec, outSec});
  const [active, setActive] = useState<TrimHandle | null>(null);
  const viewStart = view?.inSec ?? 0;
  const viewEnd = view?.outSec ?? durationSec;
  const viewDuration = Math.max(0.001, viewEnd - viewStart);
  const visibleRatio = (sec: number) => Math.max(0, Math.min(1, (sec - viewStart) / viewDuration));

  const emit = (next: TrimRange) => {
    // スナップで同じ値になったフレームでは再描画させない（カット数が多いと重くなる）
    if (next.inSec === last.current.inSec && next.outSec === last.current.outSec) return;
    last.current = next;
    onChange(next);
  };

  const begin = (handle: TrimHandle) => (e: React.PointerEvent) => {
    if (disabled || e.button !== 0) return;
    const el = barRef.current;
    if (!el) return;
    e.preventDefault();
    e.stopPropagation();
    const width = el.getBoundingClientRect().width;
    drag.current = {handle, startX: e.clientX, base: {inSec, outSec}, width};
    last.current = {inSec, outSec};
    setActive(handle);
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      /* 捕捉できなくてもバー上のドラッグは動く */
    }
    onStart?.();
  };

  const move = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d || d.width <= 0) return;
    emit(applyTrim(d.base, d.handle, ((e.clientX - d.startX) / d.width) * viewDuration, durationSec, fps));
  };

  const end = (e: React.PointerEvent) => {
    if (!drag.current) return;
    drag.current = null;
    setActive(null);
    try {
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    } catch {
      /* すでに解放済みでも問題ない */
    }
  };

  /** 矢印キーで 1 フレーム（Shift で 10 フレーム）ずつ */
  const onKey = (handle: TrimHandle) => (e: React.KeyboardEvent) => {
    if (disabled) return;
    const dir = e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowRight' ? 1 : 0;
    if (!dir) return;
    e.preventDefault();
    if (!drag.current) onStart?.();
    last.current = {inSec, outSec};
    emit(applyTrim({inSec, outSec}, handle, nudgeSec(fps, dir * (e.shiftKey ? 10 : 1)), durationSec, fps));
  };

  const l = visibleRatio(inSec);
  const r = visibleRatio(outSec);
  const dur = outSec - inSec;
  const stripStep = stripStepSec(durationSec);

  return (
    <div className="trim">
      <div ref={barRef} className={`trimbar${disabled ? ' disabled' : ''}${active ? ' dragging' : ''}`} onPointerMove={move} onPointerUp={end} onPointerCancel={end}>
        <div className="trim-film" aria-hidden>
          {mediaBase &&
            strip.map((s, i) => view
              ? (i * stripStep < viewEnd && (i + 1) * stripStep > viewStart
                ? <img key={s} src={`${mediaBase}/studio/${s}`} alt="" draggable={false} style={{position: 'absolute', left: pct((i * stripStep - viewStart) / viewDuration), width: pct(stripStep / viewDuration)}} />
                : null)
              : <img key={s} src={`${mediaBase}/studio/${s}`} alt="" draggable={false} />)}
        </div>
        {usableRanges
          .filter((u) => u.outSec > u.inSec)
          .map((u, i) => (
            <div
              key={i}
              className={`trim-usable ${u.label}`}
              style={{left: pct(visibleRatio(u.inSec)), width: pct(Math.max(0, visibleRatio(u.outSec) - visibleRatio(u.inSec)))}}
              title={`${u.label}: ${u.inSec}〜${u.outSec}s`}
            />
          ))}
        <div className="trim-out-of-range" style={{left: 0, width: pct(l)}} aria-hidden />
        <div className="trim-out-of-range" style={{left: pct(r), width: pct(1 - r)}} aria-hidden />
        <div className="trim-window" style={{left: pct(l), width: pct(Math.max(0, r - l))}} onPointerDown={begin('move')} title="ドラッグで尺を保ったまま前後に動かす" />
        {!moveOnly && <div
          className={`trim-handle in${active === 'in' ? ' on' : ''}`}
          style={{left: pct(l)}}
          onPointerDown={begin('in')}
          onKeyDown={onKey('in')}
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-label="頭（IN）"
          aria-valuemin={0}
          aria-valuemax={Math.max(0, outSec - MIN_CUT_SEC)}
          aria-valuenow={inSec}
          aria-valuetext={`${inSec.toFixed(2)} 秒`}
        />}
        {!moveOnly && <div
          className={`trim-handle out${active === 'out' ? ' on' : ''}`}
          style={{left: pct(r)}}
          onPointerDown={begin('out')}
          onKeyDown={onKey('out')}
          role="slider"
          tabIndex={disabled ? -1 : 0}
          aria-label="尻（OUT）"
          aria-valuemin={Math.min(durationSec, inSec + MIN_CUT_SEC)}
          aria-valuemax={durationSec}
          aria-valuenow={outSec}
          aria-valuetext={`${outSec.toFixed(2)} 秒`}
        />}
      </div>
      <div className="trim-meta">
        <b>{dur.toFixed(2)}s</b>
        <span>
          {inSec.toFixed(2)} 〜 {outSec.toFixed(2)}
        </span>
        <span className="hint">{view ? `表示 ${viewStart.toFixed(2)}〜${viewEnd.toFixed(2)}s / ` : ''}素材 {durationSec.toFixed(2)}s</span>
      </div>
    </div>
  );
};
