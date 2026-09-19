// 画面内の切り出し（拡大・位置）を決める。**アスペクト比は変わらない。**
//
// 出来上がりは常に 9:16 なので、ここで決めるのは「その枠の中で、どこをどれだけ寄って見せるか」
// だけ。枠を動かすのではなく中身を動かす作りにしてあるので、比率が崩れようがない。
//
// 見えているものがそのまま書き出される：当て方（cropStyle）はレンダーに使う
// engine/src/GourmetReel.tsx から直接読んでいるので、プレビューと結果がずれない。
import React, {useCallback, useRef, useState} from 'react';
import {MAX_CROP_ZOOM, cropStyle} from '@engine/GourmetReel';
import {DEFAULT_CROP, type Crop} from '@shared/schema/cuts';

type Props = {
  src: string | null;
  crop: Crop;
  onChange: (c: Crop) => void;
  /** 素材の実サイズ（寄ったときの粗さを知らせる） */
  probe?: {width: number; height: number; rotation?: number};
  /** 再生位置を外から触りたいとき（区間だけ再生など） */
  videoRef?: React.RefObject<HTMLVideoElement>;
  onError?: () => void;
  /** 枠を大きくして細かい位置合わせをする。渡したときだけ切り替えボタンを出す */
  big?: boolean;
  onBig?: (v: boolean) => void;
  children?: React.ReactNode;
};

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const round2 = (v: number) => Math.round(v * 100) / 100;

/** 2 本指の間の距離（ピンチの判定に使う） */
const spread = (a: {clientX: number; clientY: number}, b: {clientX: number; clientY: number}) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);

export const CropBox: React.FC<Props> = ({src, crop, onChange, probe, videoRef, onError, big, onBig, children}) => {
  const boxRef = useRef<HTMLDivElement>(null);
  const localVideo = useRef<HTMLVideoElement>(null) as React.RefObject<HTMLVideoElement>;
  const video = videoRef ?? localVideo;
  const pointers = useRef(new Map<number, {clientX: number; clientY: number}>());
  const pinch = useRef<{dist: number; zoom: number} | null>(null);
  const [dragging, setDragging] = useState(false);

  const zoom = crop.zoom ?? 1;
  const atDefault = zoom === 1 && crop.x === 0.5 && crop.y === 0.5;

  const setZoom = useCallback(
    (z: number) => onChange({...crop, zoom: Math.max(1, Math.min(MAX_CROP_ZOOM, round2(z)))}),
    [crop, onChange],
  );

  /** 寄っている量に応じて、動かせる幅を変える（等倍では動かしても意味がない） */
  const pan = useCallback(
    (dxPx: number, dyPx: number) => {
      const el = boxRef.current;
      if (!el || zoom <= 1) return;
      const r = el.getBoundingClientRect();
      // transform-origin を動かす方式なので、指の動きと画の動きを合わせるにはこの比率になる
      const k = zoom / (zoom - 1);
      onChange({...crop, x: clamp01(crop.x - (dxPx / r.width) * k), y: clamp01(crop.y - (dyPx / r.height) * k)});
    },
    [crop, onChange, zoom],
  );

  const onPointerDown = (e: React.PointerEvent) => {
    pointers.current.set(e.pointerId, {clientX: e.clientX, clientY: e.clientY});
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = {dist: spread(a, b), zoom};
    } else if (pointers.current.size === 1 && zoom > 1) {
      setDragging(true);
    }
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      /* 捕捉できなくても動く */
    }
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const prev = pointers.current.get(e.pointerId);
    if (!prev) return;
    pointers.current.set(e.pointerId, {clientX: e.clientX, clientY: e.clientY});
    if (pointers.current.size >= 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()];
      const d = spread(a, b);
      if (pinch.current.dist > 0) setZoom(pinch.current.zoom * (d / pinch.current.dist));
      return;
    }
    if (pointers.current.size === 1 && zoom > 1) pan(e.clientX - prev.clientX, e.clientY - prev.clientY);
  };

  const onPointerUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = null;
    if (pointers.current.size === 0) setDragging(false);
    try {
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    } catch {
      /* すでに解放済みでも問題ない */
    }
  };

  /** ホイール（PC）。Ctrl 無しでも寄れるようにする（この枠の中だけ） */
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    setZoom(zoom * (e.deltaY < 0 ? 1.08 : 1 / 1.08));
  };

  // 寄ったときに実際に使われる画素数（粗さの目安）
  const rot = probe?.rotation ?? 0;
  const srcW = probe ? (rot === 90 || rot === 270 ? probe.height : probe.width) : 0;
  const effective = srcW ? Math.round(srcW / zoom) : 0;

  return (
    <div className="cropbox">
      <div
        ref={boxRef}
        className={`cropbox-stage${dragging ? ' dragging' : ''}${zoom > 1 ? ' pannable' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
      >
        <video ref={video} src={src ?? undefined} autoPlay loop muted playsInline preload="metadata" style={cropStyle(crop)} onError={onError} />
        {/* 目安の線（三分割）。寄せる位置を決めるときの当たりにする */}
        <div className="cropbox-guides" aria-hidden />
        {children}
      </div>
      <div className="cropbox-controls">
        <label className="cropbox-zoom">
          寄り
          <input type="range" min={1} max={MAX_CROP_ZOOM} step={0.05} value={zoom} onChange={(e) => setZoom(Number(e.target.value))} />
          <b>{zoom.toFixed(2)}×</b>
        </label>
        <button className="small" onClick={() => onChange({...DEFAULT_CROP})} disabled={atDefault} title="そのまま（中央・等倍）に戻す">
          切り出しを戻す
        </button>
        {onBig && (
          <button className="small" onClick={() => onBig(!big)} title="編集する枠を大きくする（Z）。切り出しは枠の中でピンチ・ドラッグ">
            {big ? '枠を小さく' : '枠を大きく'}
          </button>
        )}
        {zoom > 1 ? (
          <span className="hint">
            画をドラッグ（2 本指でピンチ）して位置を決める
            {effective ? `／実質 ${effective}px 幅` : ''}
            {effective && effective < 720 ? '（粗くなります）' : ''}
          </span>
        ) : (
          <span className="hint">スライダー・ピンチ・ホイールで寄る。比率（9:16）は変わりません</span>
        )}
      </div>
    </div>
  );
};
