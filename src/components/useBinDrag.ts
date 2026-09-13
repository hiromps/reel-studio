// 素材グリッド（bin）のカードを掴んでタイムラインへ運ぶドラッグ。並べ替え（useDragReorder）と違い、
// 落とし先の判定は受け手（ClipTimeline の insertIndexAtPoint）に任せ、ここはポインタを追うだけ。
//   - 5px 動くまでドラッグを開始しない → クリック（選択）と両立する
//   - 画面の上下端でウィンドウをオートスクロール、Esc で取り消し
import {useCallback, useEffect, useRef, useState} from 'react';

export type BinDrag<T> = {payload: T; x: number; y: number};

type Options<T> = {
  onDrop: (payload: T, x: number, y: number) => void;
  threshold?: number;
};

const EDGE = 72;
const MAX_SPEED = 22;

export const useBinDrag = <T,>({onDrop, threshold = 5}: Options<T>) => {
  const [drag, setDrag] = useState<BinDrag<T> | null>(null);
  const [pressing, setPressing] = useState(false);
  const press = useRef<{payload: T; x0: number; y0: number} | null>(null);
  const info = useRef<BinDrag<T> | null>(null);
  const opts = useRef({onDrop, threshold});
  opts.current = {onDrop, threshold};

  const begin = useCallback((payload: T, e: React.PointerEvent) => {
    if (e.button !== 0) return;
    press.current = {payload, x0: e.clientX, y0: e.clientY};
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
    const pointer = {x: 0, y: 0};

    // 指を離した直後の click（＝カードの選択が暴発する）を 1 回だけ握り潰す
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
        if (commit) opts.current.onDrop(cur.payload, cur.x, cur.y);
      }
      info.current = null;
      press.current = null;
      setDrag(null);
      setPressing(false);
      document.body.classList.remove('dnd-active');
    };

    const autoScroll = () => {
      const h = window.innerHeight;
      const {y} = pointer;
      const d = y < EDGE ? -(EDGE - y) : y > h - EDGE ? y - (h - EDGE) : 0;
      if (d) window.scrollBy(0, Math.sign(d) * Math.min(MAX_SPEED, Math.abs(d) / 3));
      raf = requestAnimationFrame(autoScroll);
    };

    const onMove = (e: PointerEvent) => {
      const p = press.current;
      if (!p) return;
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      if (!info.current) {
        if (Math.hypot(e.clientX - p.x0, e.clientY - p.y0) < opts.current.threshold) return;
        document.body.classList.add('dnd-active');
        raf = requestAnimationFrame(autoScroll);
      }
      e.preventDefault();
      info.current = {payload: p.payload, x: e.clientX, y: e.clientY};
      setDrag(info.current);
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
  }, [pressing]);

  return {
    drag,
    /** 掴める要素に付ける（onPointerDown だけ。CSS で touch-action:none を当てること） */
    handleProps: (payload: T) => ({onPointerDown: (e: React.PointerEvent) => begin(payload, e)}),
  };
};
