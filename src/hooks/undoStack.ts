// 取り消し・やり直しのスタック（純粋。node 環境でテストできる）。
export const UNDO_LIMIT = 50;

export type UndoStack<T> = {past: T[]; future: T[]};

/**
 * 連続した同じ操作をひとまとめにする窓（ミリ秒）。
 * 帯のドラッグや文字入力は 1 回の操作で何十回も値が変わるので、そのまま積むと
 * 「元に戻す」を何十回押しても元に戻らない。同じ key が続いている間は積まない。
 */
export const COALESCE_MS = 700;

export type PushMark = {key: string; at: number};

/** 直前の積み込みと同じ操作の続きか（＝今回は積まずにまとめるか） */
export const shouldCoalesce = (last: PushMark | null, key: string | undefined, now: number, windowMs = COALESCE_MS): boolean =>
  !!key && !!last && last.key === key && now - last.at < windowMs;

/** 変更前の状態を積む。やり直しの履歴は捨てる（分岐しない） */
export const pushSnapshot = <T,>(s: UndoStack<T>, snapshot: T, limit = UNDO_LIMIT): UndoStack<T> => ({
  past: [...s.past.slice(-(Math.max(1, limit) - 1)), snapshot],
  future: [],
});

export const undoSnapshot = <T,>(s: UndoStack<T>, current: T): {stack: UndoStack<T>; snapshot: T | null} => {
  if (!s.past.length) return {stack: s, snapshot: null};
  const past = s.past.slice(0, -1);
  return {stack: {past, future: [...s.future, current]}, snapshot: s.past[s.past.length - 1]};
};

export const redoSnapshot = <T,>(s: UndoStack<T>, current: T): {stack: UndoStack<T>; snapshot: T | null} => {
  if (!s.future.length) return {stack: s, snapshot: null};
  const future = s.future.slice(0, -1);
  return {stack: {past: [...s.past, current], future}, snapshot: s.future[s.future.length - 1]};
};
