// Materials のタイムライン：カットを横一列・時間比例のブロックで並べ、端をつまんで尺を決め、ブロックをドラッグして順番を変える。
// 素材グリッドからのドロップ（挿入）は親が useBinDrag でポインタを追い、ここは「その点なら何番目か」を答える（insertIndexAtPoint）。
// 秒 ⇄ px や cuts.json の書き換えは track.ts（純粋関数・テストあり）。並べ替えの DnD は絵コンテと同じ useDragReorder。
import React, {forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState} from 'react';
import type {Clip, Cut, ReelData} from '@shared/schema';
import {cutDurationSec} from '@shared/timeline';
import {useDragReorder} from './useDragReorder';
import {caretRectFor, destIndexOf, insertIndexAt, type Caret, type Rect} from './reorder';
import {applyTrim, fallbackDuration, nudgeSec, type TrimHandle, type TrimRange} from './trim';
import {CutThumb} from './CutThumb';
import {clampZoom, filmCells, fitPxPerSec, fmtSec, frameAtX, layoutBlocks, moveCuts, rulerTicks, setCutRange, trackWidth, trimDeltaSec} from './track';

export type ClipTimelineHandle = {
  /** viewport 座標の点がトラックの上なら、そこへ落としたときの挿入位置（0〜n）。トラックの外なら null */
  insertIndexAtPoint: (x: number, y: number) => number | null;
  /** そのカットが見える位置まで横スクロール */
  scrollToCut: (i: number) => void;
  /** 全体が収まる拡大率にする */
  fit: () => void;
};

type Props = {
  slug: string | null;
  /** 素材 URL の先頭（`/p/<slug>/<mode>`） */
  mediaBase: string | null;
  /** まだ cuts.json が無い案件は null（空のトラック＝ドロップ先だけ出す） */
  cuts: ReelData | null;
  fps: number;
  clipOf: (src: string) => Clip | undefined;
  selected: number | null;
  onSelect: (i: number) => void;
  /** 再生ヘッド（フレーム） */
  currentFrame: number;
  onSeek: (frame: number) => void;
  pxPerSec: number;
  onPxPerSec: (v: number) => void;
  /** カット index → 一番重い指摘（ブロック右上のバッジ） */
  issueOf?: Map<number, 'E' | 'W'>;
  /** cuts を書き換える直前に 1 度呼ぶ（Ctrl+Z 用に履歴を積む） */
  onStart: () => void;
  onChange: (next: ReelData) => void;
  onRemove: (i: number) => void;
  onSplit: (i: number) => void;
  /** IN/OUT をドラッグ中、その素材のその秒を見せたいとき（親の video を追従させる） */
  onScrub?: (src: string, sec: number) => void;
  /** 素材グリッドからドラッグ中のポインタ（挿入位置のキャレットを出す） */
  external: {x: number; y: number} | null;
};

type TrimState = {index: number; handle: TrimHandle; startX: number; base: TrimRange; durationSec: number; rate: number; last: TrimRange};

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

export const ClipTimeline = forwardRef<ClipTimelineHandle, Props>(
  ({slug, mediaBase, cuts, fps, clipOf, selected, onSelect, currentFrame, onSeek, pxPerSec, onPxPerSec, issueOf, onStart, onChange, onRemove, onSplit, onScrub, external}, ref) => {
    const scrollerRef = useRef<HTMLDivElement | null>(null);
    const innerRef = useRef<HTMLDivElement | null>(null);
    const trimRef = useRef<TrimState | null>(null);
    const scrubbing = useRef(false);
    const [activeTrim, setActiveTrim] = useState<{index: number; handle: TrimHandle} | null>(null);
    const [extCaret, setExtCaret] = useState<Caret | null>(null);
    const [extOver, setExtOver] = useState(false);
    const [focusIdx, setFocusIdx] = useState<number | null>(null);
    const latest = useRef({cuts, fps, pxPerSec, onPxPerSec, onSeek});
    latest.current = {cuts, fps, pxPerSec, onPxPerSec, onSeek};

    const data = useMemo<Pick<ReelData, 'fps' | 'cuts'>>(() => ({fps: cuts?.fps ?? fps, cuts: cuts?.cuts ?? []}), [cuts, fps]);
    const blocks = useMemo(() => layoutBlocks(data, pxPerSec), [data, pxPerSec]);
    const totalSec = blocks.length ? blocks[blocks.length - 1].endSec : 0;
    const width = Math.max(trackWidth(blocks, pxPerSec), 200);
    const ticks = useMemo(() => rulerTicks(totalSec, pxPerSec), [totalSec, pxPerSec]);
    const currentCut = blocks.findIndex((b) => currentFrame / data.fps >= b.startSec && currentFrame / data.fps < b.endSec);

    // ---- 並べ替え（絵コンテと同じフック。横一列なので grid 軸で行が 1 つになるだけ） ----
    const dnd = useDragReorder({
      axis: 'grid',
      gap: 2,
      onDrop: (block, to) => {
        if (!cuts) return;
        onStart();
        onChange(moveCuts(cuts, block, to));
        onSelect(destIndexOf(block, to));
      },
    });

    // ---- 外から（素材グリッド）落とすときの挿入位置 ----
    const insertIndexAtPoint = useCallback((x: number, y: number): number | null => {
      const el = scrollerRef.current;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      if (x < r.left || x > r.right || y < r.top || y > r.bottom) return null;
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

    useImperativeHandle(ref, () => ({insertIndexAtPoint, scrollToCut, fit}), [insertIndexAtPoint, scrollToCut, fit]);

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

    // 再生中に再生ヘッドが画面の外へ出たら追いかける（ドラッグ中は動かさない）
    useEffect(() => {
      const el = scrollerRef.current;
      if (!el || dnd.drag || trimRef.current) return;
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
    const beginTrim = (i: number, handle: TrimHandle) => (e: React.PointerEvent) => {
      if (!cuts || e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const c = cuts.cuts[i];
      const clip = clipOf(c.src);
      const base = {inSec: c.inSec, outSec: c.outSec};
      trimRef.current = {index: i, handle, startX: e.clientX, base, durationSec: clip?.probe.durationSec ?? fallbackDuration(c), rate: c.playbackRate ?? 1, last: base};
      setActiveTrim({index: i, handle});
      try {
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
      } catch {
        /* 捕捉できなくてもトラック上のドラッグは動く */
      }
      onStart();
      onSelect(i);
    };

    const onPointerMove = (e: React.PointerEvent) => {
      const t = trimRef.current;
      if (t && cuts) {
        const next = applyTrim(t.base, t.handle, trimDeltaSec(e.clientX - t.startX, pxPerSec, t.rate), t.durationSec, data.fps);
        if (next.inSec === t.last.inSec && next.outSec === t.last.outSec) return;
        t.last = next;
        onChange(setCutRange(cuts, t.index, next));
        onScrub?.(cuts.cuts[t.index].src, t.handle === 'out' ? next.outSec : next.inSec);
        return;
      }
      if (scrubbing.current) seekAtPointer(e.clientX);
    };
    const onPointerUp = (e: React.PointerEvent) => {
      if (trimRef.current) {
        trimRef.current = null;
        setActiveTrim(null);
      }
      scrubbing.current = false;
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
      scrubbing.current = true;
      try {
        (e.currentTarget as Element).setPointerCapture(e.pointerId);
      } catch {
        /* 捕捉できなくても移動中のシークは動く */
      }
      seekAtPointer(e.clientX);
    };

    // ---- キーボード ----
    const nudge = (i: number, dir: -1 | 1) => {
      if (!cuts) return;
      const to = dir < 0 ? i - 1 : i + 2;
      if (to < 0 || to > cuts.cuts.length) return;
      onStart();
      onChange(moveCuts(cuts, [i, i], to));
      const dest = destIndexOf([i, i], to);
      onSelect(dest);
      setFocusIdx(dest);
    };
    const onKeyDown = (e: React.KeyboardEvent, i: number) => {
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        onRemove(i);
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const dir = e.key === 'ArrowLeft' ? -1 : 1;
        e.preventDefault();
        if (e.altKey) nudge(i, dir);
        else {
          const n = Math.max(0, Math.min(data.cuts.length - 1, i + dir));
          onSelect(n);
          setFocusIdx(n);
        }
      } else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onSelect(i);
      } else if (e.key === 's' || e.key === 'S') {
        e.preventDefault();
        onSplit(i);
      }
    };

    // IN を引いている間は、掴んでいる端だけが指に付いてきて残り（右側）は動かさない。離した瞬間に詰まる
    const trimOffset = (() => {
      const t = trimRef.current;
      if (!activeTrim || !t || t.handle !== 'in' || !cuts) return 0;
      const c = cuts.cuts[t.index];
      return c ? ((c.inSec - t.base.inSec) / t.rate) * pxPerSec : 0;
    })();

    const playheadX = (currentFrame / data.fps) * pxPerSec;
    const sel = selected !== null && cuts ? cuts.cuts[selected] : null;
    const selClip = sel ? clipOf(sel.src) : undefined;
    const selDur = sel ? (selClip?.probe.durationSec ?? fallbackDuration(sel)) : 0;
    const patchSel = (handle: 'in' | 'out', deltaSec: number) => {
      if (!sel || selected === null || !cuts) return;
      onChange(setCutRange(cuts, selected, applyTrim({inSec: sel.inSec, outSec: sel.outSec}, handle, deltaSec, selDur, data.fps)));
    };

    return (
      <div className="ctl">
        <div
          ref={(el) => {
            scrollerRef.current = el;
            dnd.containerProps.ref(el);
          }}
          className={`ctl-scroll${extOver ? ' ext-over' : ''}${activeTrim ? ' trimming' : ''}`}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          <div ref={innerRef} className="ctl-inner" style={{width}}>
            <div className="ctl-ruler" onPointerDown={beginScrub} title="クリック／ドラッグでその位置へ">
              {ticks.map((t) => (
                <div key={t.sec} className={`ctl-tick${t.major ? ' major' : ''}`} style={{left: t.sec * pxPerSec}}>
                  {t.major && <span className="ctl-tick-label">{fmtSec(t.sec)}</span>}
                </div>
              ))}
            </div>
            <div
              className="ctl-track"
              onPointerDown={(e) => {
                if (e.target === e.currentTarget) beginScrub(e);
              }}
            >
              {blocks.length === 0 && <div className={`ctl-empty${extOver ? ' over' : ''}`}>素材のカードをここへドラッグ（またはカードの「＋」）</div>}
              {blocks.map((b) => {
                const c = data.cuts[b.index];
                const clip = clipOf(c.src);
                const i = b.index;
                // b.width は短くなった後の幅なので、左端を shifted だけ右へ寄せれば右端は元の位置のまま
                const shifted = activeTrim && trimRef.current && i >= trimRef.current.index ? trimOffset : 0;
                const w = b.width;
                const cells = clip ? filmCells(clip.thumbs.strip, clip.probe.durationSec, c.inSec, c.outSec, Math.max(1, Math.floor(w / 28))) : [];
                const sev = issueOf?.get(i);
                const text = c.main?.text ?? (c.subs?.length ? c.subs.map((x) => x.text).join(' / ') : '');
                return (
                  <div
                    key={c.id ?? i}
                    className={[
                      'ctl-clip',
                      i === selected ? 'selected' : '',
                      i === currentCut ? 'current' : '',
                      dnd.isDragging(i) ? 'dragging' : '',
                      i === activeTrim?.index ? 'trim-active' : '',
                    ]
                      .filter(Boolean)
                      .join(' ')}
                    style={{left: b.left + shifted, width: w}}
                    title={`${i + 1}. ${descOf(clip, c)}\n${c.inSec.toFixed(2)}〜${c.outSec.toFixed(2)}s（${cutDurationSec(c).toFixed(2)}s）${text ? `\nテロップ: ${text}` : ''}\n両端をドラッグ＝尺／中をドラッグ＝並べ替え／Alt+ドラッグ＝中身をずらす`}
                    tabIndex={0}
                    {...dnd.itemProps(i)}
                    onPointerDown={(e) => {
                      if (e.altKey) beginTrim(i, 'move')(e);
                      else dnd.handleProps(i).onPointerDown(e);
                    }}
                    onClick={() => onSelect(i)}
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
                        <span className={`sb-flag ${sev === 'E' ? 'err' : 'warn'}`} title={sev === 'E' ? 'エラーあり（Timeline で確認）' : '警告あり（Timeline で確認）'}>
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
              <div className="ctl-playhead" style={{left: playheadX}} />
            </div>
          </div>
          {dnd.drag?.caret && <div className="dnd-caret" style={dnd.drag.caret} />}
          {extCaret && <div className="dnd-caret ext" style={extCaret} />}
        </div>

        {sel && selected !== null && (
          <div className="ctl-detail">
            <b>{selected + 1}.</b>
            <span className="ctl-detail-name" title={sel.src}>
              {descOf(selClip, sel)}
            </span>
            <label>
              IN
              <span className="btns">
                <input type="number" step={0.01} value={sel.inSec} onFocus={onStart} onChange={(e) => patchSel('in', Number(e.target.value) - sel.inSec)} />
                <button
                  className="small"
                  onClick={() => {
                    onStart();
                    patchSel('in', nudgeSec(data.fps, -1));
                  }}
                >
                  -1f
                </button>
                <button
                  className="small"
                  onClick={() => {
                    onStart();
                    patchSel('in', nudgeSec(data.fps, 1));
                  }}
                >
                  +1f
                </button>
              </span>
            </label>
            <label>
              OUT
              <span className="btns">
                <input type="number" step={0.01} value={sel.outSec} onFocus={onStart} onChange={(e) => patchSel('out', Number(e.target.value) - sel.outSec)} />
                <button
                  className="small"
                  onClick={() => {
                    onStart();
                    patchSel('out', nudgeSec(data.fps, -1));
                  }}
                >
                  -1f
                </button>
                <button
                  className="small"
                  onClick={() => {
                    onStart();
                    patchSel('out', nudgeSec(data.fps, 1));
                  }}
                >
                  +1f
                </button>
              </span>
            </label>
            <span className="hint">
              尺 <b>{cutDurationSec(sel).toFixed(2)}s</b>
              {selClip ? ` / 素材 ${selClip.probe.durationSec.toFixed(2)}s` : ' / 素材尺は不明（catalog に無い src）'}
              {sel.playbackRate && sel.playbackRate !== 1 ? ` / ${sel.playbackRate}x` : ''}
            </span>
            <span style={{flex: 1}} />
            <button className="small" onClick={() => onSplit(selected)} title="再生ヘッド（赤い線）の位置でこのカットを 2 つに割る（S キー）">
              再生位置で分割
            </button>
            <button className="small danger" onClick={() => onRemove(selected)} title="このカットをタイムラインから外す（Delete キー）。素材は残ります">
              削除
            </button>
          </div>
        )}

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
  },
);
ClipTimeline.displayName = 'ClipTimeline';
