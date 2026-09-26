// 編集画面のタイムライン：横一列・時間比例で、映像（V）・テロップ（T）・ナレーション（N）・効果音（S）の 4 段。
//   V: ブロックの両端で尺（IN/OUT）、中をドラッグで並べ替え、Alt+ドラッグで中身をずらす（スリップ）
//   T: 同じ文言が続く範囲（テロップグループ）。クリックでグループを選んで文言を直す
//   N: narration.json のブロック。横にドラッグして配置秒（at）を動かす。カット境界に吸着する
//   S: 効果音。同じく横にドラッグ
// 素材ビンからのドロップ（挿入）は親が useBinDrag でポインタを追い、ここは「その点なら何番目か」を答える（insertIndexAtPoint）。
// 秒 ⇄ px や cuts.json の書き換えは components/track.ts、段の配置は editor/tracks.ts（どちらも純粋・テストあり）。
import React, {forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState} from 'react';
import type {Clip, Cut, Narration, NarrationSegment, ReelData} from '@shared/schema';
import {cutDurationSec} from '@shared/timeline';
import type {SfxLibrary} from '@shared/sfx';
import {useDragReorder} from '../components/useDragReorder';
import {caretRectFor, destIndexOf, insertIndexAt, type Caret, type Rect} from '../components/reorder';
import {applyTrim, fallbackDuration, type TrimHandle, type TrimRange} from '../components/trim';
import {CutThumb} from '../components/CutThumb';
import {clampZoom, filmCells, fitPxPerSec, fmtSec, frameAtX, layoutBlocks, moveCuts, rulerTicks, setCutRange, trackWidth, trimDeltaSec} from '../components/track';
import {cutBoundaries, draggedAt, narrationBlocks, setNarrationAt, setSfxAt, sfxMarkers, telopBlocks} from './tracks';
import type {Selection} from './selection';
import {sameSelection} from './selection';
import {ROLE_LABEL} from './labels';

export type TimelineHandle = {
  /** viewport 座標の点が映像段の上なら、そこへ落としたときの挿入位置（0〜n）。外なら null */
  insertIndexAtPoint: (x: number, y: number) => number | null;
  /** そのカットが見える位置まで横スクロール */
  scrollToCut: (i: number) => void;
  /** 全体が収まる拡大率にする */
  fit: () => void;
  /** 映像段のカードにフォーカスを移す（キー操作のため） */
  focusCut: (i: number) => void;
};

export type TrackVisibility = {telop: boolean; narr: boolean; sfx: boolean};

type Props = {
  slug: string | null;
  mediaBase: string | null;
  cuts: ReelData | null;
  fps: number;
  narration: Narration | null;
  sfxLib: SfxLibrary | null;
  /** durSec が無いナレーションの秒数見積もり */
  estimateSec: (s: NarrationSegment) => number;
  clipOf: (src: string) => Clip | undefined;
  slotRole: (c: Cut) => string | undefined;
  selection: Selection;
  /** クリック（＝そこへシークもする） */
  onSelect: (sel: Selection) => void;
  /** ドラッグ開始など、選ぶだけでシークしない */
  onSelectQuiet: (sel: Selection) => void;
  currentFrame: number;
  onSeek: (frame: number) => void;
  pxPerSec: number;
  onPxPerSec: (v: number) => void;
  issueOf?: Map<number, 'E' | 'W'>;
  groupColors: string[];
  /** 変更の直前に 1 度呼ぶ（Ctrl+Z 用に履歴を積む） */
  onStart: () => void;
  onCutsChange: (next: ReelData) => void;
  onNarrationChange: (next: Narration) => void;
  onRemoveCut: (i: number) => void;
  onSplitCut: (i: number) => void;
  onAddNarration: (atSec: number) => void;
  onAddSfx: (atSec: number) => void;
  /** IN/OUT をドラッグ中、その素材のその秒を見せたいとき */
  onScrub?: (src: string, sec: number) => void;
  /** 素材ビンからドラッグ中のポインタ（挿入位置のキャレットを出す） */
  external: {x: number; y: number} | null;
  /** ナレーション・効果音のドラッグでカット境界に吸着する */
  snap: boolean;
  tracks: TrackVisibility;
  /** サムネイルの背景にしているコマの位置（動画の秒）。目盛りにピンを立てる。null なら出さない */
  thumbnailSec?: number | null;
  /** ピンを横にドラッグして離したとき（その秒のコマを背景にする） */
  onThumbnailSec?: (sec: number) => void;
};

type Drag =
  | {kind: 'trim'; index: number; handle: TrimHandle; startX: number; base: TrimRange; durationSec: number; rate: number; last: TrimRange; pushed: boolean}
  | {kind: 'scrub'}
  | {kind: 'narr' | 'sfx'; index: number; startX: number; baseAt: number; last: number; pushed: boolean};

const measureBlocks = (el: HTMLElement) => {
  const nodes = Array.from(el.querySelectorAll<HTMLElement>('[data-dnd-index]')).sort((a, b) => Number(a.dataset.dndIndex) - Number(b.dataset.dndIndex));
  const rects: Rect[] = nodes.map((n) => {
    const r = n.getBoundingClientRect();
    return {left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height};
  });
  const c = el.getBoundingClientRect();
  return {rects, origin: {left: c.left + el.clientLeft - el.scrollLeft, top: c.top + el.clientTop - el.scrollTop}, width: el.clientWidth};
};

const descOf = (clip: Clip | undefined, c: Cut): string => clip?.tags?.description ?? clip?.slug ?? c.src.replace(/^uploads\//, '');

const stop = (e: React.SyntheticEvent) => e.stopPropagation();

export const Timeline = forwardRef<TimelineHandle, Props>((props, ref) => {
  const {slug, mediaBase, cuts, fps, narration, sfxLib, estimateSec, clipOf, slotRole, selection, onSelect, onSelectQuiet, currentFrame, onSeek, pxPerSec, onPxPerSec, issueOf, groupColors, onStart, onCutsChange, onNarrationChange, onRemoveCut, onSplitCut, onAddNarration, onAddSfx, onScrub, external, snap, tracks, thumbnailSec, onThumbnailSec} = props;
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const innerRef = useRef<HTMLDivElement | null>(null);
  const videoRowRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const [activeTrim, setActiveTrim] = useState<{index: number; handle: TrimHandle} | null>(null);
  const [extCaret, setExtCaret] = useState<Caret | null>(null);
  const [extOver, setExtOver] = useState(false);
  const [focusIdx, setFocusIdx] = useState<number | null>(null);
  const latest = useRef({cuts, fps, pxPerSec, onPxPerSec, onSeek, narration});
  latest.current = {cuts, fps, pxPerSec, onPxPerSec, onSeek, narration};

  const data = useMemo<Pick<ReelData, 'fps' | 'cuts'>>(() => ({fps: cuts?.fps ?? fps, cuts: cuts?.cuts ?? []}), [cuts, fps]);
  const blocks = useMemo(() => layoutBlocks(data, pxPerSec), [data, pxPerSec]);
  const totalSec = blocks.length ? blocks[blocks.length - 1].endSec : 0;
  const width = Math.max(trackWidth(blocks, pxPerSec), 200);
  const ticks = useMemo(() => rulerTicks(totalSec, pxPerSec), [totalSec, pxPerSec]);
  const currentCut = blocks.findIndex((b) => currentFrame / data.fps >= b.startSec && currentFrame / data.fps < b.endSec);
  const tBlocks = useMemo(() => (tracks.telop ? telopBlocks(data, pxPerSec) : []), [data, pxPerSec, tracks.telop]);
  const nBlocks = useMemo(() => (tracks.narr ? narrationBlocks(narration, estimateSec, pxPerSec, totalSec) : []), [narration, estimateSec, pxPerSec, totalSec, tracks.narr]);
  const sMarkers = useMemo(() => (tracks.sfx ? sfxMarkers(narration?.sfx, pxPerSec, sfxLib ?? undefined) : []), [narration, pxPerSec, sfxLib, tracks.sfx]);
  const boundaries = useMemo(() => cutBoundaries(data), [data]);
  const playheadSec = currentFrame / data.fps;

  // ---- 並べ替え（絵コンテと同じフック。横一列なので grid 軸で行が 1 つになるだけ） ----
  const dnd = useDragReorder({
    axis: 'grid',
    gap: 2,
    onDrop: (block, to) => {
      if (!cuts) return;
      onStart();
      onCutsChange(moveCuts(cuts, block, to));
      onSelectQuiet({kind: 'cut', index: destIndexOf(block, to)});
    },
  });

  // ---- 外から（素材ビン）落とすときの挿入位置 ----
  const insertIndexAtPoint = useCallback((x: number, y: number): number | null => {
    const el = scrollerRef.current;
    const row = videoRowRef.current;
    if (!el || !row) return null;
    const r = row.getBoundingClientRect();
    const s = el.getBoundingClientRect();
    // 横はスクロール領域の中、縦は映像段（少し上下に余裕を持たせる）
    if (x < s.left || x > s.right || y < r.top - 24 || y > r.bottom + 12) return null;
    const m = measureBlocks(el);
    if (!m.rects.length) return 0;
    return insertIndexAt(m.rects, x, y, 'grid');
  }, []);

  useEffect(() => {
    if (!external) {
      setExtCaret(null);
      setExtOver(false);
      return;
    }
    const idx = insertIndexAtPoint(external.x, external.y);
    setExtOver(idx !== null);
    const el = scrollerRef.current;
    if (idx === null || !el) return setExtCaret(null);
    const m = measureBlocks(el);
    setExtCaret(m.rects.length ? caretRectFor(m.rects, idx, 'grid', m.origin, m.width, 2) : null);
  }, [external, insertIndexAtPoint]);

  const fit = useCallback(() => {
    const el = scrollerRef.current;
    const {cuts: cur, fps: f, onPxPerSec: setZoom} = latest.current;
    if (!el) return;
    const total = cur ? layoutBlocks({fps: cur.fps ?? f, cuts: cur.cuts}, 1).reduce((s, b) => s + b.durSec, 0) : 0;
    setZoom(fitPxPerSec(total, el.clientWidth));
  }, []);

  const scrollToCut = useCallback((i: number) => {
    scrollerRef.current?.querySelector(`[data-dnd-index="${i}"]`)?.scrollIntoView({inline: 'nearest', block: 'nearest'});
  }, []);
  const focusCut = useCallback((i: number) => setFocusIdx(i), []);

  useImperativeHandle(ref, () => ({insertIndexAtPoint, scrollToCut, fit, focusCut}), [insertIndexAtPoint, scrollToCut, fit, focusCut]);

  // Ctrl + ホイールで拡大縮小（ポインタの下の時刻を動かさない）。React の onWheel は passive なので直接付ける
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const h = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const {pxPerSec: cur, onPxPerSec: setZoom} = latest.current;
      const px = e.clientX - el.getBoundingClientRect().left;
      const t = (el.scrollLeft + px) / cur;
      const next = clampZoom(cur * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
      if (next === cur) return;
      setZoom(next);
      requestAnimationFrame(() => {
        el.scrollLeft = Math.max(0, t * next - px);
      });
    };
    el.addEventListener('wheel', h, {passive: false});
    return () => el.removeEventListener('wheel', h);
  }, []);

  // ---- 2 本指：つまんで拡大縮小、そのまま動かして横スクロール（指での操作） ----
  // 指 1 本の操作（尺・並べ替え・シーク）と取り合いにならないよう、**2 本目が触れた時点で
  // それまでの操作を捨てて**ピンチに切り替える。触った位置の時刻は動かさないので、
  // 見たいところを指の間に置いたまま寄れる。
  const pointers = useRef(new Map<number, {x: number; y: number}>());
  const pinch = useRef<{dist: number; zoom: number; timeAtCenter: number} | null>(null);
  const [pinching, setPinching] = useState(false);

  // 指が離れたら必ず数える対象から外す（画面の外で離しても届くよう window で受ける）
  useEffect(() => {
    const drop = (e: PointerEvent) => {
      pointers.current.delete(e.pointerId);
      if (pointers.current.size < 2 && pinch.current) {
        pinch.current = null;
        setPinching(false);
      }
    };
    window.addEventListener('pointerup', drop);
    window.addEventListener('pointercancel', drop);
    return () => {
      window.removeEventListener('pointerup', drop);
      window.removeEventListener('pointercancel', drop);
    };
  }, []);

  const onPointerDownCapture = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse') return;
    pointers.current.set(e.pointerId, {x: e.clientX, y: e.clientY});
    if (pointers.current.size !== 2) return;
    const el = scrollerRef.current;
    if (!el) return;
    // 1 本目で始まりかけていた操作は捨てる（ピンチ中に尺が変わったり並べ替わったりしない）
    dragRef.current = null;
    setActiveTrim(null);
    dnd.cancel();
    const [a, b] = [...pointers.current.values()];
    const center = (a.x + b.x) / 2 - el.getBoundingClientRect().left;
    pinch.current = {dist: Math.hypot(a.x - b.x, a.y - b.y), zoom: pxPerSec, timeAtCenter: (el.scrollLeft + center) / pxPerSec};
    setPinching(true);
  };

  useEffect(() => {
    if (!pinching) return;
    const el = scrollerRef.current;
    if (!el) return;
    const move = (e: PointerEvent) => {
      if (!pointers.current.has(e.pointerId)) return;
      pointers.current.set(e.pointerId, {x: e.clientX, y: e.clientY});
      const p = pinch.current;
      if (!p || pointers.current.size < 2) return;
      e.preventDefault();
      const [a, b] = [...pointers.current.values()];
      const center = (a.x + b.x) / 2 - el.getBoundingClientRect().left;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      const {pxPerSec: cur, onPxPerSec: setZoom} = latest.current;
      const next = p.dist > 0 ? clampZoom(p.zoom * (dist / p.dist)) : cur;
      if (next !== cur) setZoom(next);
      // 中身の幅が変わったあとでないと scrollLeft が頭打ちになる
      requestAnimationFrame(() => {
        el.scrollLeft = Math.max(0, p.timeAtCenter * next - center);
      });
    };
    window.addEventListener('pointermove', move, {passive: false});
    return () => window.removeEventListener('pointermove', move);
  }, [pinching]);

  // 再生中に再生ヘッドが画面の外へ出たら追いかける（ドラッグ中は動かさない）
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || dnd.drag || dragRef.current) return;
    const x = (currentFrame / data.fps) * pxPerSec;
    if (x < el.scrollLeft || x > el.scrollLeft + el.clientWidth) el.scrollLeft = Math.max(0, x - el.clientWidth * 0.2);
  }, [currentFrame, data.fps, pxPerSec, dnd.drag]);

  // Alt+←→ で動かしたあと、移動先のブロックにフォーカスを戻す
  useEffect(() => {
    if (focusIdx === null) return;
    scrollerRef.current?.querySelector<HTMLElement>(`[data-dnd-index="${focusIdx}"]`)?.focus();
    setFocusIdx(null);
  }, [focusIdx]);

  // ---- 尺（IN/OUT）のドラッグ・Alt+ドラッグで中身をずらす（スリップ） ----
  const capture = (e: React.PointerEvent) => {
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      /* 捕捉できなくてもトラック上のドラッグは動く */
    }
  };
  const beginTrim = (i: number, handle: TrimHandle) => (e: React.PointerEvent) => {
    if (!cuts || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const c = cuts.cuts[i];
    const clip = clipOf(c.src);
    const base = {inSec: c.inSec, outSec: c.outSec};
    dragRef.current = {kind: 'trim', index: i, handle, startX: e.clientX, base, durationSec: clip?.probe.durationSec ?? fallbackDuration(c), rate: c.playbackRate ?? 1, last: base, pushed: false};
    setActiveTrim({index: i, handle});
    capture(e);
    onSelectQuiet({kind: 'cut', index: i});
  };
  const beginAtDrag = (kind: 'narr' | 'sfx', index: number, baseAt: number) => (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = {kind, index, startX: e.clientX, baseAt, last: baseAt, pushed: false};
    capture(e);
    onSelectQuiet({kind, index});
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    if (d.kind === 'trim' && cuts) {
      const next = applyTrim(d.base, d.handle, trimDeltaSec(e.clientX - d.startX, pxPerSec, d.rate), d.durationSec, data.fps);
      if (next.inSec === d.last.inSec && next.outSec === d.last.outSec) return;
      if (!d.pushed) {
        onStart();
        d.pushed = true;
      }
      d.last = next;
      onCutsChange(setCutRange(cuts, d.index, next));
      onScrub?.(cuts.cuts[d.index].src, d.handle === 'out' ? next.outSec : next.inSec);
      return;
    }
    if ((d.kind === 'narr' || d.kind === 'sfx') && narration) {
      const at = draggedAt(d.baseAt, e.clientX - d.startX, pxPerSec, {maxSec: totalSec, boundaries, snap: snap && !e.altKey});
      if (at === d.last) return;
      if (!d.pushed) {
        onStart();
        d.pushed = true;
      }
      d.last = at;
      onNarrationChange(d.kind === 'narr' ? setNarrationAt(narration, d.index, at) : setSfxAt(narration, d.index, at));
      return;
    }
    if (d.kind === 'scrub') seekAtPointer(e.clientX);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (dragRef.current) {
      dragRef.current = null;
      setActiveTrim(null);
    }
    try {
      (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    } catch {
      /* すでに解放済みでも問題ない */
    }
  };

  // ---- 目盛りのクリック／ドラッグでシーク ----
  const seekAtPointer = (clientX: number) => {
    const inner = innerRef.current;
    if (!inner) return;
    onSeek(frameAtX(clientX - inner.getBoundingClientRect().left, pxPerSec, data.fps));
  };
  const beginScrub = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragRef.current = {kind: 'scrub'};
    capture(e);
    seekAtPointer(e.clientX);
  };

  // ---- キーボード（映像段のカードにフォーカスがあるとき） ----
  const nudge = (i: number, dir: -1 | 1) => {
    if (!cuts) return;
    const to = dir < 0 ? i - 1 : i + 2;
    if (to < 0 || to > cuts.cuts.length) return;
    onStart();
    onCutsChange(moveCuts(cuts, [i, i], to));
    const dest = destIndexOf([i, i], to);
    onSelectQuiet({kind: 'cut', index: dest});
    setFocusIdx(dest);
  };
  const onKeyDown = (e: React.KeyboardEvent, i: number) => {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      onRemoveCut(i);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
      const dir = e.key === 'ArrowLeft' ? -1 : 1;
      e.preventDefault();
      if (e.altKey) nudge(i, dir);
      else {
        const n = Math.max(0, Math.min(data.cuts.length - 1, i + dir));
        onSelect({kind: 'cut', index: n});
        setFocusIdx(n);
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      onSelect({kind: 'cut', index: i});
    } else if (e.key === 's' || e.key === 'S') {
      e.preventDefault();
      onSplitCut(i);
    }
  };

  // IN を引いている間は、掴んでいる端だけが指に付いてきて残り（右側）は動かさない。離した瞬間に詰まる
  const trimOffset = (() => {
    const d = dragRef.current;
    if (!activeTrim || !d || d.kind !== 'trim' || d.handle !== 'in' || !cuts) return 0;
    const c = cuts.cuts[d.index];
    return c ? ((c.inSec - d.base.inSec) / d.rate) * pxPerSec : 0;
  })();
  const trimIndex = activeTrim && dragRef.current?.kind === 'trim' ? dragRef.current.index : -1;
  const trimStartSec = trimIndex >= 0 ? (blocks[trimIndex]?.startSec ?? 0) : Infinity;

  const playheadX = playheadSec * pxPerSec;

  // ---- サムネイルのピン：クリックで編集を開く・横にドラッグで背景のコマを変える ----
  const pinDrag = useRef<{startX: number; moved: boolean} | null>(null);
  const [pinSec, setPinSec] = useState<number | null>(null);
  const secAtClientX = (clientX: number) => {
    const inner = innerRef.current;
    if (!inner) return 0;
    return Math.max(0, Math.min(totalSec - 1 / data.fps, (clientX - inner.getBoundingClientRect().left) / pxPerSec));
  };
  const onPinDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    pinDrag.current = {startX: e.clientX, moved: false};
    try {
      (e.currentTarget as Element).setPointerCapture(e.pointerId);
    } catch {
      /* 取れなくてもクリックは効く */
    }
  };
  const onPinMove = (e: React.PointerEvent) => {
    const d = pinDrag.current;
    if (!d) return;
    if (!d.moved && Math.abs(e.clientX - d.startX) < 4) return;
    d.moved = true;
    const sec = secAtClientX(e.clientX);
    setPinSec(sec);
    // 動かしている間はそのコマをプレビューに出す
    onSeek(Math.round(sec * data.fps));
  };
  const onPinUp = (e: React.PointerEvent) => {
    const d = pinDrag.current;
    pinDrag.current = null;
    setPinSec(null);
    if (!d) return;
    if (d.moved) onThumbnailSec?.(secAtClientX(e.clientX));
    else onSelect({kind: 'thumbnail'});
  };
  const shownPinSec = pinSec ?? thumbnailSec ?? null;
  const isSel = (s: Selection) => sameSelection(selection, s);
  const rowsShown = 1 + (tracks.telop ? 1 : 0) + (tracks.narr ? 1 : 0) + (tracks.sfx ? 1 : 0);

  return (
    <div className={`tl${activeTrim ? ' trimming' : ''}`} data-rows={rowsShown}>
      <div className="tl-labels" aria-hidden>
        <div className="tl-label tl-label-ruler" />
        <div className="tl-label tl-label-v" title="映像：両端で尺、中を掴んで並べ替え、Alt+ドラッグで中身をずらす">
          V
        </div>
        {tracks.telop && (
          <div className="tl-label tl-label-t" title="テロップ：同じ文言が続く範囲。クリックで文言を直す">
            T
          </div>
        )}
        {tracks.narr && (
          <div className="tl-label tl-label-n" title="ナレーション：ドラッグで配置秒を動かす">
            N
            <button className="tl-add" title="再生ヘッドの位置にナレーションを追加" onClick={() => onAddNarration(Math.round(playheadSec * 1000) / 1000)} disabled={!cuts}>
              ＋
            </button>
          </div>
        )}
        {tracks.sfx && (
          <div className="tl-label tl-label-s" title="効果音：ドラッグで配置秒を動かす">
            S
            <button className="tl-add" title="再生ヘッドの位置に効果音を追加" onClick={() => onAddSfx(Math.round(playheadSec * 1000) / 1000)} disabled={!cuts || !narration}>
              ＋
            </button>
          </div>
        )}
      </div>
      <div
        ref={(el) => {
          scrollerRef.current = el;
          dnd.containerProps.ref(el);
        }}
        className={`tl-scroll${extOver ? ' ext-over' : ''}`}
        onPointerDownCapture={onPointerDownCapture}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div ref={innerRef} className="tl-inner" style={{width}}>
          <div className="tl-ruler" onPointerDown={beginScrub} title="クリック／ドラッグでその位置へ">
            {ticks.map((t) => (
              <div key={t.sec} className={`ctl-tick${t.major ? ' major' : ''}`} style={{left: t.sec * pxPerSec}}>
                {t.major && <span className="ctl-tick-label">{fmtSec(t.sec)}</span>}
              </div>
            ))}
            {shownPinSec !== null && cuts && (
              <div
                className={`tl-thumb-pin${isSel({kind: 'thumbnail'}) ? ' sel' : ''}${pinSec !== null ? ' dragging' : ''}`}
                style={{left: shownPinSec * pxPerSec}}
                title="サムネイルの背景にするコマ。クリックでサムネイルを編集、横にドラッグでコマを変える"
                onPointerDown={onPinDown}
                onPointerMove={onPinMove}
                onPointerUp={onPinUp}
                onPointerCancel={() => {
                  pinDrag.current = null;
                  setPinSec(null);
                }}
              >
                🖼
              </div>
            )}
          </div>

          {/* ── V: 映像 ── */}
          <div
            ref={videoRowRef}
            className="tl-row tl-row-v"
            onPointerDown={(e) => {
              if (e.target === e.currentTarget) beginScrub(e);
            }}
          >
            {blocks.length === 0 && <div className={`ctl-empty${extOver ? ' over' : ''}`}>左の素材をここへドラッグ（またはカードの「＋」）</div>}
            {blocks.map((b) => {
              const c = data.cuts[b.index];
              const clip = clipOf(c.src);
              const i = b.index;
              const shifted = i >= trimIndex && trimIndex >= 0 ? trimOffset : 0;
              const w = b.width;
              const cells = clip ? filmCells(clip.thumbs.strip, clip.probe.durationSec, c.inSec, c.outSec, Math.max(1, Math.floor(w / 28))) : [];
              const sev = issueOf?.get(i);
              const role = slotRole(c);
              return (
                <div
                  key={c.id ?? i}
                  className={['ctl-clip', isSel({kind: 'cut', index: i}) ? 'selected' : '', i === currentCut ? 'current' : '', dnd.isDragging(i) ? 'dragging' : '', i === activeTrim?.index ? 'trim-active' : ''].filter(Boolean).join(' ')}
                  style={{left: b.left + shifted, width: w}}
                  title={`${i + 1}. ${descOf(clip, c)}\n${c.inSec.toFixed(2)}〜${c.outSec.toFixed(2)}s（${cutDurationSec(c).toFixed(2)}s）${role ? `\n役割: ${ROLE_LABEL[role as keyof typeof ROLE_LABEL] ?? role}` : ''}\n両端をドラッグ＝尺／中をドラッグ＝並べ替え／Alt+ドラッグ＝中身をずらす`}
                  tabIndex={0}
                  {...dnd.itemProps(i)}
                  onPointerDown={(e) => {
                    if (e.altKey) beginTrim(i, 'move')(e);
                    else dnd.handleProps(i).onPointerDown(e);
                  }}
                  onClick={() => onSelect({kind: 'cut', index: i})}
                  onKeyDown={(e) => onKeyDown(e, i)}
                >
                  <div className="ctl-film" aria-hidden>
                    {mediaBase && cells.length > 0
                      ? cells.map((cell) => <img key={cell.src} src={`${mediaBase}/studio/${cell.src}`} alt="" draggable={false} style={{left: `${cell.left}%`, width: `${cell.width}%`}} />)
                      : slug && <CutThumb slug={slug} src={c.src} inSec={c.inSec} width={160} className="ctl-film-fallback" />}
                  </div>
                  <span className="ctl-no">{i + 1}</span>
                  <span className="ctl-flags">
                    {c.playbackRate && c.playbackRate !== 1 && <span className="sb-flag rate">{c.playbackRate}x</span>}
                    {sev && (
                      <span className={`sb-flag ${sev === 'E' ? 'err' : 'warn'}`} title={sev === 'E' ? 'エラーあり（右の検証で確認）' : '警告あり（右の検証で確認）'}>
                        {sev === 'E' ? '!' : '?'}
                      </span>
                    )}
                  </span>
                  <span className="ctl-desc">{descOf(clip, c)}</span>
                  <span className="ctl-dur">{cutDurationSec(c).toFixed(2)}s</span>
                  <div className={`ctl-handle in${activeTrim?.index === i && activeTrim.handle === 'in' ? ' on' : ''}`} onPointerDown={beginTrim(i, 'in')} title="頭（IN）をドラッグして尺を決める" />
                  <div className={`ctl-handle out${activeTrim?.index === i && activeTrim.handle === 'out' ? ' on' : ''}`} onPointerDown={beginTrim(i, 'out')} title="尻（OUT）をドラッグして尺を決める" />
                </div>
              );
            })}
          </div>

          {/* ── T: テロップ ── */}
          {tracks.telop && (
            <div
              className="tl-row tl-row-t"
              onPointerDown={(e) => {
                if (e.target === e.currentTarget) beginScrub(e);
              }}
            >
              {tBlocks.map((b) => {
                const shifted = trimIndex >= 0 && b.startSec >= trimStartSec - 1e-6 ? trimOffset : 0;
                if (b.kind === 'group') {
                  const color = groupColors[b.group % groupColors.length];
                  const sel = isSel({kind: 'telop', group: b.group});
                  return (
                    <div
                      key={`g${b.group}`}
                      className={`tl-telop${sel ? ' selected' : ''}${b.placeholder ? ' placeholder' : ''}${b.orientation === 'horizontal' ? ' horizontal' : ''}`}
                      style={{left: b.left + shifted, width: b.width, borderColor: color, ['--gcolor' as string]: color}}
                      title={`${b.text || '（無し）'}\n${b.startSec.toFixed(2)}〜${b.endSec.toFixed(2)}s（カット ${b.cutIndices.map((x) => x + 1).join('・')}）${b.badge ? `\nバッジ: ${b.badge}` : ''}\nクリックで文言を直す`}
                      onPointerDown={stop}
                      onClick={() => onSelect({kind: 'telop', group: b.group})}
                    >
                      {b.badge && <span className="tl-badge">{b.badge}</span>}
                      <span className="tl-telop-text">{b.text || '（無し）'}</span>
                      {b.orientation === 'horizontal' && <span className="tl-mini">横</span>}
                    </div>
                  );
                }
                if (b.kind === 'subs') {
                  return (
                    <div key={`s${b.cut}`} className={`tl-telop subs${isSel({kind: 'cut', index: b.cut}) ? ' selected' : ''}`} style={{left: b.left + shifted, width: b.width}} title={`会話字幕: ${b.text}`} onPointerDown={stop} onClick={() => onSelect({kind: 'cut', index: b.cut})}>
                    <span className="tl-mini">字幕</span>
                    <span className="tl-telop-text">{b.text}</span>
                  </div>
                  );
                }
                return (
                  <div key={`n${b.cut}`} className="tl-telop none" style={{left: b.left + shifted, width: b.width}} title="テロップ無し（クリックでこのカットを選び、右で文言を入れる）" onPointerDown={stop} onClick={() => onSelect({kind: 'cut', index: b.cut})}>
                    <span className="tl-mini">＋</span>
                  </div>
                );
              })}
            </div>
          )}

          {/* ── N: ナレーション ── */}
          {tracks.narr && (
            <div
              className="tl-row tl-row-n"
              onPointerDown={(e) => {
                if (e.target === e.currentTarget) beginScrub(e);
              }}
            >
              {!narration && cuts && <div className="tl-row-hint">ナレーション原稿はまだありません（AI ▾ → ナレーション原稿、または左の ＋）</div>}
              {nBlocks.map((b) => (
                <div
                  key={b.id + b.index}
                  className={['tl-narr', isSel({kind: 'narr', index: b.index}) ? 'selected' : '', b.needsTts ? 'needs-tts' : '', b.estimated ? 'estimated' : '', b.overlap ? 'overlap' : '', b.overrun ? 'overrun' : ''].filter(Boolean).join(' ')}
                  style={{left: b.left, width: b.width}}
                  title={`${b.id}  ${b.at.toFixed(2)}s〜${b.endSec.toFixed(2)}s${b.estimated ? '（見積）' : ''}${b.needsTts ? '・要再生成' : ''}${b.overlap ? '・前と重なる' : ''}${b.overrun ? '・尺をはみ出す' : ''}\n${b.text}\nドラッグで配置秒を動かす（Alt で吸着なし）`}
                  onPointerDown={beginAtDrag('narr', b.index, b.at)}
                  onClick={() => onSelect({kind: 'narr', index: b.index})}
                >
                  <span className="tl-narr-id">{b.id}</span>
                  <span className="tl-narr-text">{b.text}</span>
                </div>
              ))}
            </div>
          )}

          {/* ── S: 効果音 ── */}
          {tracks.sfx && (
            <div
              className="tl-row tl-row-s"
              onPointerDown={(e) => {
                if (e.target === e.currentTarget) beginScrub(e);
              }}
            >
              {sMarkers.map((m) => (
                <div
                  key={m.id + m.index}
                  className={`tl-sfx${isSel({kind: 'sfx', index: m.index}) ? ' selected' : ''}${m.missing ? ' missing' : ''}`}
                  style={{left: m.left, width: m.width}}
                  title={`${m.id}${m.role ? `（${m.role}）` : ''}  ${m.at.toFixed(2)}s\n${m.label}${m.missing ? '\n音源がライブラリにありません' : ''}\nドラッグで配置秒を動かす`}
                  onPointerDown={beginAtDrag('sfx', m.index, m.at)}
                  onClick={() => onSelect({kind: 'sfx', index: m.index})}
                >
                  <span className="tl-sfx-text">{m.role ?? m.id}</span>
                </div>
              ))}
            </div>
          )}

          <div className="tl-playhead" style={{left: playheadX}} />
        </div>
        {dnd.drag?.caret && <div className="dnd-caret" style={dnd.drag.caret} />}
        {extCaret && <div className="dnd-caret ext" style={extCaret} />}
      </div>

      {dnd.drag && (
        <div className="dnd-ghost text-only" style={{left: dnd.drag.x, top: dnd.drag.y}}>
          <span className="dnd-ghost-label">
            カット {dnd.drag.block[0] + 1}
            {dnd.drag.to !== null ? ` → ${destIndexOf(dnd.drag.block, dnd.drag.to) + 1} 番目` : ' 位置はそのまま'}
          </span>
        </div>
      )}
    </div>
  );
});
Timeline.displayName = 'Timeline';
