// 編集画面の多段トラック（テロップ / ナレーション / 効果音）の配置と吸着。
import {describe, expect, it} from 'vitest';
import type {Narration, ReelData} from '@shared/schema';
import {cutBoundaries, cutIndexAtSec, cutStartSec, draggedAt, narrationBlocks, setNarrationAt, setSfxAt, sfxMarkers, snapToBoundaries, telopBlocks} from '../src/editor/tracks';
import {selectionAfterRemove, sameSelection} from '../src/editor/selection';

const reel = (): ReelData => ({
  fps: 30,
  cuts: [
    {id: 'c01', src: 'uploads/a.mp4', inSec: 0, outSec: 1, main: {text: 'つかみ'}, badge: '生野区'},
    {id: 'c02', src: 'uploads/b.mp4', inSec: 0, outSec: 1, main: {text: 'つかみ'}},
    {id: 'c03', src: 'uploads/c.mp4', inSec: 0, outSec: 2},
    {id: 'c04', src: 'uploads/d.mp4', inSec: 0, outSec: 1, main: {text: '{{g02:proof}}'}},
    {id: 'c05', src: 'uploads/e.mp4', inSec: 0, outSec: 3, subs: [{text: 'うまい', startSec: 0, endSec: 3}]},
  ],
});

describe('telopBlocks', () => {
  it('同じ文言の連続は 1 ブロック、無しのカットと字幕は別種で出す', () => {
    const b = telopBlocks(reel(), 100);
    expect(b.map((x) => x.kind)).toEqual(['group', 'none', 'group', 'subs']);
    const g = b[0];
    if (g.kind !== 'group') throw new Error();
    expect(g.cutIndices).toEqual([0, 1]);
    expect(g.left).toBe(0);
    expect(g.width).toBe(200);
    expect(g.badge).toBe('生野区');
    expect(g.placeholder).toBe(false);
    const p = b[2];
    if (p.kind !== 'group') throw new Error();
    expect(p.placeholder).toBe(true);
    expect(p.startSec).toBe(4);
    const none = b[1];
    if (none.kind !== 'none') throw new Error();
    expect(none.cut).toBe(2);
    expect(none.width).toBe(200);
  });
});

describe('narrationBlocks', () => {
  const narr = (): Narration => ({
    voice: 'v',
    segments: [
      {id: 'n02', at: 3, text: 'あいうえおかきくけこ', durSec: 1.0},
      {id: 'n01', at: 0.5, text: 'あいうえお'},
      {id: 'n03', at: 3.5, text: 'さしすせそ', durSec: 2, needsTts: true},
    ],
  });
  it('at 順に並び、index は元の添字のまま。durSec が無ければ見積もり', () => {
    const b = narrationBlocks(narr(), (s) => [...s.text].length / 10, 100, 5);
    expect(b.map((x) => x.id)).toEqual(['n01', 'n02', 'n03']);
    expect(b.map((x) => x.index)).toEqual([1, 0, 2]);
    expect(b[0].estimated).toBe(true);
    expect(b[0].width).toBeCloseTo(50, 5);
    expect(b[1].estimated).toBe(false);
  });
  it('重なりとはみ出しを印にする', () => {
    const b = narrationBlocks(narr(), () => 1, 100, 5);
    expect(b[2].overlap).toBe(true); // n02 は 4.0 まで、n03 は 3.5 から
    expect(b[2].overrun).toBe(true); // 3.5 + 2 = 5.5 > 5
    expect(b[2].needsTts).toBe(true);
    expect(b[1].overlap).toBe(false);
  });
  it('narration が無ければ空', () => {
    expect(narrationBlocks(null, () => 1, 100)).toEqual([]);
  });
});

describe('sfxMarkers', () => {
  it('trim か素材尺の短い方で幅を決め、ライブラリに無い音は missing', () => {
    const lib = {version: 1 as const, sounds: [{file: 'a.mp3', label: 'A', roles: [], durSec: 3}]};
    const m = sfxMarkers([{id: 'hook', at: 0, file: 'a.mp3', trimSec: 1.2}, {id: 'x', at: 2, file: 'zzz.mp3'}], 100, lib);
    expect(m[0].width).toBeCloseTo(120, 5);
    expect(m[0].missing).toBe(false);
    expect(m[1].missing).toBe(true);
    expect(m[1].width).toBe(10); // 長さ不明でも掴める幅は確保
  });
});

describe('吸着とドラッグ', () => {
  it('カット境界を候補にする', () => {
    expect(cutBoundaries(reel())).toEqual([0, 1, 2, 4, 5, 8]);
  });
  it('閾値内なら吸着、外ならそのまま', () => {
    expect(snapToBoundaries(1.03, [0, 1, 2], 0.08)).toBe(1);
    expect(snapToBoundaries(1.5, [0, 1, 2], 0.08)).toBe(1.5);
  });
  it('draggedAt は範囲に収めて境界に吸着し、snap:false なら吸着しない', () => {
    const b = cutBoundaries(reel());
    expect(draggedAt(0.5, 55, 100, {maxSec: 8, boundaries: b})).toBe(1); // 1.05 → 1.0 に吸着（8px = 0.08s）
    expect(draggedAt(0.5, 55, 100, {maxSec: 8, boundaries: b, snap: false})).toBe(1.05);
    expect(draggedAt(0.5, -500, 100, {maxSec: 8, boundaries: b})).toBe(0);
    expect(draggedAt(7, 500, 100, {maxSec: 8, boundaries: b})).toBe(8);
  });
  it('setNarrationAt / setSfxAt は該当だけ差し替える', () => {
    const n: Narration = {voice: 'v', segments: [{id: 'a', at: 0, text: 'x'}, {id: 'b', at: 1, text: 'y'}], sfx: [{id: 's', at: 0, file: 'f.mp3'}]};
    expect(setNarrationAt(n, 1, 2.3456).segments[1].at).toBe(2.346);
    expect(setNarrationAt(n, 1, 2).segments[0].at).toBe(0);
    expect(setSfxAt(n, 0, 1.5).sfx?.[0].at).toBe(1.5);
  });
  it('cutStartSec / cutIndexAtSec', () => {
    expect(cutStartSec(reel(), 2)).toBe(2);
    expect(cutIndexAtSec(reel(), 4.5)).toBe(3);
    expect(cutIndexAtSec(reel(), 99)).toBe(-1);
  });
});

describe('selection', () => {
  it('同じ選択かどうか', () => {
    expect(sameSelection({kind: 'cut', index: 1}, {kind: 'cut', index: 1})).toBe(true);
    expect(sameSelection({kind: 'cut', index: 1}, {kind: 'narr', index: 1})).toBe(false);
    expect(sameSelection({kind: 'telop', group: 0}, {kind: 'telop', group: 0})).toBe(true);
    expect(sameSelection(null, null)).toBe(true);
  });
  it('削除後の選択の追従', () => {
    expect(selectionAfterRemove({kind: 'cut', index: 3}, 'cut', 3)).toBeNull();
    expect(selectionAfterRemove({kind: 'cut', index: 3}, 'cut', 1)).toEqual({kind: 'cut', index: 2});
    expect(selectionAfterRemove({kind: 'cut', index: 0}, 'cut', 1)).toEqual({kind: 'cut', index: 0});
    expect(selectionAfterRemove({kind: 'narr', index: 0}, 'cut', 0)).toEqual({kind: 'narr', index: 0});
  });
});
