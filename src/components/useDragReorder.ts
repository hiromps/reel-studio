// ドラッグ並べ替えの共通フック。Pointer Events だけで作る（外部ライブラリを足さない）。
// 絵コンテ（横・折り返し）とカット詳細リスト（縦）で共用する。
//   - 5px 動くまでドラッグを開始しない → クリック（シーク）と両立する
//   - 挿入位置はキャレットで表示（レイアウトを動かさないので候補が揺れない）
//   - 画面端／コンテナ端でオートスクロール、Esc で取り消し
import {useCallback, useEffect, useRef, useState} from 'react';
import {caretRectFor, insertIndexAt, normalizeTarget, type Caret, type DragAxis, type Rect} from './reorder';

export type DragInfo = {
  /** 掴んでいる連続ブロック [先頭, 末尾]（単体なら [i, i]） */
  block: [number, number];
  /** 挿入先。null は「今の位置と同じ＝動かない」 */
  to: number | null;
  /** ポインタ位置（ゴースト表示用・viewport 基準） */
  x: number;
  y: number;
  caret: Caret | null;
};

type Options = {
  axis: DragAxis;
  /** アイテム間の gap（px）。キャレットを隙間の中央に置くのに使う */
  gap: number;
  onDrop: (block: [number, number], to: number) => void;
  /** i と一緒に動かす連続ブロック。既定は [i, i] */
  blockOf?: (i: number) => [number, number];
  threshold?: number;
};

const EDGE = 72; // オートスクロールを始める端からの距離
const MAX_SPEED = 22; // px / frame

export const useDragReorder = ({axis, gap, onDrop, blockOf, threshold = 5}: Options) => {
  const containerRef = useRef<HTMLElement | null>(null);
  const [drag, setDrag] = useState<DragInfo | null>(null);
  const [pressing, setPressing] = useState(false);
  const press = useRef<{i: number; x0: number; y0: number} | null>(null);
  const info = useRef<DragInfo | null>(null);
  const pointer = useRef({x: 0, y: 0});
  const opts = useRef({axis, gap, onDrop, blockOf, threshold});
  opts.current = {axis, gap, onDrop, blockOf, threshold};

  const setRef = useCallback((el: HTMLElement | null) => {
    containerRef.current = el;
  }, []);

  const measure = useCallback(() => {
    const el = containerRef.current;
    if (!el) return null;
    const nodes = Array.from(el.querySelectorAll<HTMLElement>('[data-dnd-index]')).sort(
      (a, b) => Number(a.dataset.dndIndex) - Number(b.dataset.dndIndex),
    );
    if (nodes.length === 0) return null;
    const rects: Rect[] = nodes.map((n) => {
      const r = n.getBoundingClientRect();
      return {left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height};
    });
    const c = el.getBoundingClientRect();
    return {
      el,
      rects,
      // position:absolute の子は padding box 基準・中身と一緒にスクロールする
      origin: {left: c.left + el.clientLeft - el.scrollLeft, top: c.top + el.clientTop - el.scrollTop},
      width: el.clientWidth,
    };
  }, []);

  const update = useCallback(() => {
    const cur = info.current;
    const m = measure();
    if (!cur || !m) return;
    const {x, y} = pointer.current;
    const to = normalizeTarget(insertIndexAt(m.rects, x, y, opts.current.axis), cur.block);
    const caret = to === null ? null : caretRectFor(m.rects, to, opts.current.axis, m.origin, m.width, opts.current.gap);
    info.current = {...cur, to, x, y, caret};
    setDrag(info.current);
  }, [measure]);

  const begin = useCallback((i: number, e: React.PointerEvent) => {
    if (e.button !== 0) return;
    press.current = {i, x0: e.clientX, y0: e.clientY};
    pointer.current = {x: e.clientX, y: e.clientY};
    // ウィンドウ外で離しても pointerup が届くようにする
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      /* 未対応環境では window リスナだけで動く */
    }
    setPressing(true);
  }, []);

  useEffect(() => {
    if (!pressing) return;
    let raf = 0;

    // 指を離した直後に飛んでくる click（＝シークが暴発する）を 1 回だけ握り潰す。
    // フラグで持つと「掴んだまま外で離した」ときに次の正当なクリックまで食べてしまうので、
    // 一度きりのリスナ＋タイムアウトで必ず後始末する。
    const swallowNextClick = () => {
      const h = (ev: MouseEvent) => {
        ev.stopPropagation();
        ev.preventDefault();
        clearTimeout(timer);
      };
      const timer = setTimeout(() => window.removeEventListener('click', h, true), 350);
      window.addEventListener('click', h, {capture: true, once: true});
    };

    const finish = (commit: boolean) => {
      const cur = info.current;
      if (cur) {
        swallowNextClick();
        if (commit && cur.to !== null) opts.current.onDrop(cur.block, cur.to);
      }
      info.current = null;
      press.current = null;
      setDrag(null);
      setPressing(false);
      document.body.classList.remove('dnd-active');
    };

    // 端に近づいたらスクロール。コンテナがその軸にスクロールできればコンテナを、無理ならウィンドウを動かす
    const autoScroll = () => {
      const el = containerRef.current;
      const {x, y} = pointer.current;
      let moved = false;
      if (el) {
        const r = el.getBoundingClientRect();
        if (el.scrollWidth > el.clientWidth + 1) {
          const d = x < r.left + EDGE ? -(r.left + EDGE - x) : x > r.right - EDGE ? x - (r.right - EDGE) : 0;
          const before = el.scrollLeft;
          if (d) el.scrollLeft += Math.sign(d) * Math.min(MAX_SPEED, Math.abs(d) / 3);
          // 端まで来ていたら「動かせなかった」扱いにして、下のウィンドウスクロールに任せる
          if (el.scrollLeft !== before) moved = true;
        }
        if (el.scrollHeight > el.clientHeight + 1) {
          const d = y < r.top + EDGE ? -(r.top + EDGE - y) : y > r.bottom - EDGE ? y - (r.bottom - EDGE) : 0;
          const before = el.scrollTop;
          if (d) el.scrollTop += Math.sign(d) * Math.min(MAX_SPEED, Math.abs(d) / 3);
          if (el.scrollTop !== before) moved = true;
        }
      }
      if (!moved) {
        const h = window.innerHeight;
        const d = y < EDGE ? -(EDGE - y) : y > h - EDGE ? y - (h - EDGE) : 0;
        if (d) {
          window.scrollBy(0, Math.sign(d) * Math.min(MAX_SPEED, Math.abs(d) / 3));
          moved = true;
        }
      }
      if (moved) update();
      raf = requestAnimationFrame(autoScroll);
    };

    const onMove = (e: PointerEvent) => {
      const p = press.current;
      if (!p) return;
      pointer.current = {x: e.clientX, y: e.clientY};
      if (!info.current) {
        if (Math.hypot(e.clientX - p.x0, e.clientY - p.y0) < opts.current.threshold) return;
        info.current = {block: opts.current.blockOf?.(p.i) ?? [p.i, p.i], to: null, x: e.clientX, y: e.clientY, caret: null};
        document.body.classList.add('dnd-active');
        raf = requestAnimationFrame(autoScroll);
      }
      e.preventDefault();
      update();
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      }
    };

    window.addEventListener('pointermove', onMove, {passive: false});
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey);
      document.body.classList.remove('dnd-active');
    };
  }, [pressing, update]);

  return {
    drag,
    /** コンテナに付ける（キャレットの基準になるので position:relative にしておく） */
    containerProps: {ref: setRef},
    /** 掴める要素に付ける。onPointerDown だけなのでフォーム部品と共存できる（CSS で touch-action:none を当てること） */
    handleProps: (i: number) => ({onPointerDown: (e: React.PointerEvent) => begin(i, e)}),
    /** 位置計測の対象になる要素に付ける */
    itemProps: (i: number) => ({'data-dnd-index': i}),
    isDragging: (i: number) => drag !== null && i >= drag.block[0] && i <= drag.block[1],
  };
};
