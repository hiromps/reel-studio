// 取り消し・やり直しの履歴。中身は呼び出し側が決める（編集画面では cuts と narration の組）。
// 純粋なスタック操作は undoStack.ts にあり、ここは React に束ねるだけ。
import {useCallback, useEffect, useRef, useState} from 'react';
import {UNDO_LIMIT, pushSnapshot, redoSnapshot, shouldCoalesce, undoSnapshot, type PushMark, type UndoStack} from './undoStack';

export const useUndo = <T,>(opt: {limit?: number; resetKey?: unknown} = {}) => {
  const limit = opt.limit ?? UNDO_LIMIT;
  const stack = useRef<UndoStack<T>>({past: [], future: []});
  const lastPush = useRef<PushMark | null>(null);
  const [flags, setFlags] = useState({canUndo: false, canRedo: false});
  const sync = () => setFlags({canUndo: stack.current.past.length > 0, canRedo: stack.current.future.length > 0});

  /**
   * 変更の直前に、変更前の状態を積む。
   * key を渡すと、同じ key の変更が続いている間は積み直さない（ドラッグ・文字入力が 1 手になる）。
   */
  const push = useCallback(
    (snapshot: T, key?: string) => {
      const now = Date.now();
      if (shouldCoalesce(lastPush.current, key, now)) {
        lastPush.current = {key: key as string, at: now};
        return;
      }
      lastPush.current = key ? {key, at: now} : null;
      stack.current = pushSnapshot(stack.current, snapshot, limit);
      sync();
    },
    [limit],
  );
  /** 1 手戻す。戻す先が無ければ null。current は「今の状態」（やり直し用に積む） */
  const undo = useCallback((current: T): T | null => {
    const r = undoSnapshot(stack.current, current);
    stack.current = r.stack;
    lastPush.current = null; // 戻した直後の変更は、戻す前の操作の続きにしない
    sync();
    return r.snapshot;
  }, []);
  const redo = useCallback((current: T): T | null => {
    const r = redoSnapshot(stack.current, current);
    stack.current = r.stack;
    lastPush.current = null;
    sync();
    return r.snapshot;
  }, []);
  const clear = useCallback(() => {
    stack.current = {past: [], future: []};
    lastPush.current = null;
    sync();
  }, []);

  // 案件を切り替えたら履歴は捨てる（別案件の配列を復元してしまわないように）
  useEffect(() => {
    stack.current = {past: [], future: []};
    lastPush.current = null;
    sync();
  }, [opt.resetKey]);

  return {push, undo, redo, clear, canUndo: flags.canUndo, canRedo: flags.canRedo};
};
