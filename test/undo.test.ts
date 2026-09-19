// 取り消し・やり直しのスタックと、連続操作のまとめ（src/hooks/undoStack.ts）。
import {describe, expect, it} from 'vitest';
import {COALESCE_MS, pushSnapshot, redoSnapshot, shouldCoalesce, undoSnapshot, type UndoStack} from '../src/hooks/undoStack';

const empty = <T,>(): UndoStack<T> => ({past: [], future: []});

describe('undoStack', () => {
  it('積んだ順に 1 手ずつ戻り、やり直しで元へ進む', () => {
    let s = empty<string>();
    s = pushSnapshot(s, 'a'); // 'a' → 'b' にする直前
    s = pushSnapshot(s, 'b'); // 'b' → 'c' にする直前
    const u1 = undoSnapshot(s, 'c');
    expect(u1.snapshot).toBe('b');
    const u2 = undoSnapshot(u1.stack, 'b');
    expect(u2.snapshot).toBe('a');
    expect(undoSnapshot(u2.stack, 'a').snapshot).toBeNull();

    const r = redoSnapshot(u2.stack, 'a');
    expect(r.snapshot).toBe('b');
    expect(redoSnapshot(r.stack, 'b').snapshot).toBe('c');
  });

  it('新しく積むとやり直しの履歴は捨てる（分岐しない）', () => {
    const s = pushSnapshot(pushSnapshot(empty<string>(), 'a'), 'b');
    const u = undoSnapshot(s, 'c');
    expect(u.stack.future).toEqual(['c']);
    expect(pushSnapshot(u.stack, 'b2').future).toEqual([]);
  });

  it('上限を超えたら古いものから捨てる', () => {
    let s = empty<number>();
    for (let i = 0; i < 5; i++) s = pushSnapshot(s, i, 3);
    expect(s.past).toEqual([2, 3, 4]);
  });
});

describe('shouldCoalesce', () => {
  const now = 1_000_000;

  it('key が無い操作（チェック・ボタン）は毎回積む', () => {
    expect(shouldCoalesce({key: 'trim:c01', at: now}, undefined, now + 1)).toBe(false);
  });

  it('同じ key が窓の内なら積まない＝1 手にまとまる', () => {
    expect(shouldCoalesce({key: 'trim:c01', at: now}, 'trim:c01', now + COALESCE_MS - 1)).toBe(true);
  });

  it('窓を過ぎたら別の操作として積む', () => {
    expect(shouldCoalesce({key: 'trim:c01', at: now}, 'trim:c01', now + COALESCE_MS)).toBe(false);
  });

  it('別のクリップ・別の項目は続きにしない', () => {
    expect(shouldCoalesce({key: 'trim:c01', at: now}, 'trim:c02', now + 1)).toBe(false);
    expect(shouldCoalesce({key: 'trim:c01', at: now}, 'crop:c01', now + 1)).toBe(false);
  });

  it('直前に積んでいなければ（取り消し直後など）積む', () => {
    expect(shouldCoalesce(null, 'trim:c01', now)).toBe(false);
  });
});
