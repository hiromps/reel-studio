// 取り消し・やり直しのスタック（純粋。node 環境でテストできる）。
export const UNDO_LIMIT = 50;

export type UndoStack<T> = {past: T[]; future: T[]};

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
