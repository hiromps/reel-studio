// 取り消し・やり直しの履歴。中身は呼び出し側が決める（編集画面では cuts と narration の組）。
// 純粋なスタック操作は undoStack.ts にあり、ここは React に束ねるだけ。
import {useCallback, useEffect, useRef, useState} from 'react';
import {UNDO_LIMIT, pushSnapshot, redoSnapshot, undoSnapshot, type UndoStack} from './undoStack';

export const useUndo = <T,>(opt: {limit?: number; resetKey?: unknown} = {}) => {
  const limit = opt.limit ?? UNDO_LIMIT;
  const stack = useRef<UndoStack<T>>({past: [], future: []});
  const [flags, setFlags] = useState({canUndo: false, canRedo: false});
  const sync = () => setFlags({canUndo: stack.current.past.length > 0, canRedo: stack.current.future.length > 0});

  /** 変更の直前に、変更前の状態を積む */
  const push = useCallback(
    (snapshot: T) => {
      stack.current = pushSnapshot(stack.current, snapshot, limit);
      sync();
    },
    [limit],
  );
  /** 1 手戻す。戻す先が無ければ null。current は「今の状態」（やり直し用に積む） */
  const undo = useCallback((current: T): T | null => {
    const r = undoSnapshot(stack.current, current);
    stack.current = r.stack;
    sync();
    return r.snapshot;
  }, []);
  const redo = useCallback((current: T): T | null => {
    const r = redoSnapshot(stack.current, current);
    stack.current = r.stack;
    sync();
    return r.snapshot;
  }, []);
  const clear = useCallback(() => {
    stack.current = {past: [], future: []};
    sync();
  }, []);

  // 案件を切り替えたら履歴は捨てる（別案件の配列を復元してしまわないように）
  useEffect(() => {
    stack.current = {past: [], future: []};
    sync();
  }, [opt.resetKey]);

  return {push, undo, redo, clear, canUndo: flags.canUndo, canRedo: flags.canRedo};
};
