// ドラッグ並べ替えの純粋ロジック。DOM に依存しないのでここで押さえる（GUI 側は目視確認）。
import {describe, expect, it} from 'vitest';
import {caretRectFor, destIndexOf, insertIndexAt, normalizeTarget, reorderBlock, rowsOf, type Rect} from '../src/components/reorder';

const rect = (left: number, top: number, w = 100, h = 150): Rect => ({left, top, right: left + w, bottom: top + h, width: w, height: h});

/** 3 列 × 2 行（gap 8）に折り返した絵コンテ */
const grid: Rect[] = [rect(0, 0), rect(108, 0), rect(216, 0), rect(0, 158), rect(108, 158)];
/** 縦一列のカット行（gap 4） */
const list: Rect[] = [rect(0, 0, 800, 100), rect(0, 104, 800, 100), rect(0, 208, 800, 100)];

describe('reorderBlock', () => {
  const arr = ['a', 'b', 'c', 'd', 'e'];

  it('単体を前へ動かす', () => {
    expect(reorderBlock(arr, [3, 3], 1)).toEqual(['a', 'd', 'b', 'c', 'e']);
  });

  it('単体を後ろへ動かす（to は削除前の index）', () => {
    expect(reorderBlock(arr, [1, 1], 4)).toEqual(['a', 'c', 'd', 'b', 'e']);
  });

  it('末尾へ動かす', () => {
    expect(reorderBlock(arr, [0, 0], 5)).toEqual(['b', 'c', 'd', 'e', 'a']);
  });

  it('連続ブロックを丸ごと動かす（順序は保つ）', () => {
    expect(reorderBlock(arr, [1, 2], 5)).toEqual(['a', 'd', 'e', 'b', 'c']);
    expect(reorderBlock(arr, [2, 3], 0)).toEqual(['c', 'd', 'a', 'b', 'e']);
  });

  it('ブロックの内側へ動かしても並びは変わらない', () => {
    expect(reorderBlock(arr, [1, 2], 1)).toEqual(arr);
    expect(reorderBlock(arr, [1, 2], 3)).toEqual(arr);
  });

  it('要素数は常に保たれる', () => {
    for (const to of [0, 1, 2, 3, 4, 5]) expect(reorderBlock(arr, [1, 2], to)).toHaveLength(arr.length);
  });
});

describe('destIndexOf', () => {
  it('移動後のブロック先頭 index を返す', () => {
    expect(destIndexOf([3, 3], 1)).toBe(1);
    expect(destIndexOf([1, 1], 4)).toBe(3);
    expect(destIndexOf([1, 2], 5)).toBe(3);
  });

  it('reorderBlock の結果と一致する', () => {
    const arr = ['a', 'b', 'c', 'd', 'e'];
    for (const [block, to] of [
      [[1, 2], 5],
      [[3, 3], 0],
      [[0, 1], 4],
    ] as [[number, number], number][]) {
      expect(reorderBlock(arr, block, to)[destIndexOf(block, to)]).toBe(arr[block[0]]);
    }
  });
});

describe('normalizeTarget', () => {
  it('ブロックの内側なら null（＝動かさない）', () => {
    expect(normalizeTarget(1, [1, 2])).toBeNull();
    expect(normalizeTarget(2, [1, 2])).toBeNull();
    expect(normalizeTarget(3, [1, 2])).toBeNull();
  });

  it('外側はそのまま通す', () => {
    expect(normalizeTarget(0, [1, 2])).toBe(0);
    expect(normalizeTarget(4, [1, 2])).toBe(4);
  });
});

describe('insertIndexAt: 縦一列', () => {
  it('行の上半分なら手前、下半分なら次', () => {
    expect(insertIndexAt(list, 100, 10, 'y')).toBe(0);
    expect(insertIndexAt(list, 100, 90, 'y')).toBe(1);
    expect(insertIndexAt(list, 100, 160, 'y')).toBe(2);
  });

  it('一番下より下は末尾', () => {
    expect(insertIndexAt(list, 100, 999, 'y')).toBe(3);
  });
});

describe('insertIndexAt: 折り返しグリッド', () => {
  it('行を分けて認識する', () => {
    expect(rowsOf(grid)).toEqual([[0, 1, 2], [3, 4]]);
  });

  it('同じ行の中で左右を見る', () => {
    expect(insertIndexAt(grid, 40, 75, 'grid')).toBe(0);
    expect(insertIndexAt(grid, 120, 75, 'grid')).toBe(1);
    expect(insertIndexAt(grid, 300, 75, 'grid')).toBe(3); // 1 行目の右端＝2 行目の先頭
  });

  it('2 行目を狙える', () => {
    expect(insertIndexAt(grid, 40, 200, 'grid')).toBe(3);
    expect(insertIndexAt(grid, 300, 200, 'grid')).toBe(5);
  });

  it('どの行からも外れたら一番近い行に寄せる', () => {
    expect(insertIndexAt(grid, 40, -500, 'grid')).toBe(0);
    expect(insertIndexAt(grid, 300, 999, 'grid')).toBe(5);
  });

  it('空なら 0', () => {
    expect(insertIndexAt([], 10, 10, 'grid')).toBe(0);
  });
});

describe('caretRectFor', () => {
  const origin = {left: 0, top: 0};

  it('グリッドではカードの隙間に縦棒を置く', () => {
    const c = caretRectFor(grid, 1, 'grid', origin, 400, 8)!;
    expect(c.left).toBe(102); // 108 - gap/2 - 太さ/2
    expect(c.top).toBe(0);
    expect(c.height).toBe(150);
  });

  it('末尾は最後のカードの右に置く', () => {
    const c = caretRectFor(grid, grid.length, 'grid', origin, 400, 8)!;
    expect(c.left).toBe(210); // 208 + gap/2 - 太さ/2
  });

  it('縦一列では行間に横棒を置く（コンテナ幅いっぱい）', () => {
    const c = caretRectFor(list, 1, 'y', origin, 800, 4)!;
    expect(c).toEqual({left: 0, top: 100, width: 800, height: 4});
  });

  it('要素が無ければ null', () => {
    expect(caretRectFor([], 0, 'grid', origin, 400, 8)).toBeNull();
  });
});
