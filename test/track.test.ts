// Materials のタイムラインの純粋ロジック（配置・挿入位置・既定区間・cuts.json の書き換え）。DOM 側は目視確認。
import {describe, expect, it} from 'vitest';
import type {Clip, ReelData} from '@shared/schema';
import {ReelDataSchema} from '@shared/schema';
import {stripFps, stripStepSec} from '@shared/strip';
import {
  PX_PER_SEC_MAX,
  PX_PER_SEC_MIN,
  clampZoom,
  createReel,
  defaultRangeFor,
  filmCells,
  fitPxPerSec,
  fmtSec,
  frameAtX,
  insertCutAt,
  insertIndexAtX,
  layoutBlocks,
  makeCut,
  moveCuts,
  newCutId,
  removeCutAt,
  rulerStep,
  rulerTicks,
  setCutRange,
  sourceSecAt,
  splitCutAt,
  trackWidth,
  trimDeltaSec,
  usageBySrc,
} from '../src/components/track';
import {MIN_CUT_SEC} from '../src/components/trim';

const FPS = 60;

const clip = (over: Partial<Clip> & {durationSec?: number} = {}): Clip => {
  const {durationSec = 10, ...rest} = over;
  return {
    id: 'c1',
    original: 'IMG_0001.MOV',
    slug: 'steak',
    src: 'uploads/01_steak.mp4',
    probe: {codec: 'h264', width: 1080, height: 1920, rotation: 0, fps: 60, durationSec, hasAudio: true, pixFmt: 'yuv420p'},
    thumbs: {sheet: 'thumbs/c1.jpg', strip: Array.from({length: Math.max(1, Math.ceil(durationSec * stripFps(durationSec)))}, (_, k) => `strips/c1/${String(k + 1).padStart(2, '0')}.jpg`)},
    usableRanges: [],
    user: {hook: false, ng: false, orderHint: null, lock: false},
    ...rest,
  };
};

const reel = (): ReelData => ({
  fps: FPS,
  cuts: [
    {id: 'c01', src: 'uploads/01.mp4', inSec: 0, outSec: 2}, // 2.0s
    {id: 'c02', src: 'uploads/02.mp4', inSec: 1, outSec: 4, playbackRate: 1.5}, // 2.0s（3 秒を 1.5 倍速）
    {id: 'c03', src: 'uploads/03.mp4', inSec: 0.5, outSec: 1.5}, // 1.0s
  ],
  meta: {slots: [{cutId: 'c01', segment: '1_hook', role: 'hook', clipId: 'a', textStatus: 'placeholder', locked: false, qc: []}]},
});

describe('配置（秒 → px）', () => {
  it('幅は実時間に比例し、倍速カットは縮む', () => {
    const b = layoutBlocks(reel(), 100);
    expect(b.map((x) => x.left)).toEqual([0, 200, 400]);
    expect(b.map((x) => x.width)).toEqual([200, 200, 100]);
    expect(b[2].endSec).toBeCloseTo(5, 6);
  });

  it('極端に短いカットでも最低 2px は確保する', () => {
    const b = layoutBlocks({fps: FPS, cuts: [{src: 'a', inSec: 0, outSec: 1 / 60}]}, 24);
    expect(b[0].width).toBe(2);
  });

  it('トラック幅は末尾に余白を足す', () => {
    const b = layoutBlocks(reel(), 100);
    expect(trackWidth(b, 100)).toBe(600);
    expect(trackWidth([], 100)).toBe(100);
  });

  it('拡大率は範囲に収まり、全体表示は幅から逆算する', () => {
    expect(clampZoom(1)).toBe(PX_PER_SEC_MIN);
    expect(clampZoom(9999)).toBe(PX_PER_SEC_MAX);
    expect(clampZoom(NaN)).toBeGreaterThan(0);
    expect(fitPxPerSec(9, 1016)).toBe(100); // (1016-16) / (9 + 余白 1)
    expect(fitPxPerSec(0, 500)).toBe(PX_PER_SEC_MAX);
  });
});

describe('挿入位置とフレーム', () => {
  const b = layoutBlocks(reel(), 100);

  it('ブロックの中央より左なら手前、右なら次', () => {
    expect(insertIndexAtX(b, 0)).toBe(0);
    expect(insertIndexAtX(b, 99)).toBe(0);
    expect(insertIndexAtX(b, 101)).toBe(1);
    expect(insertIndexAtX(b, 449)).toBe(2);
    expect(insertIndexAtX(b, 451)).toBe(3);
    expect(insertIndexAtX(b, 9999)).toBe(3);
  });

  it('空のトラックは常に 0', () => {
    expect(insertIndexAtX([], 123)).toBe(0);
  });

  it('x → フレームは 0 未満にならない', () => {
    expect(frameAtX(150, 100, 60)).toBe(90);
    expect(frameAtX(-50, 100, 60)).toBe(0);
  });

  it('ドラッグ量は倍速ぶんだけ素材の秒に換算される', () => {
    expect(trimDeltaSec(100, 100)).toBeCloseTo(1, 6);
    expect(trimDeltaSec(100, 100, 1.5)).toBeCloseTo(1.5, 6);
    expect(trimDeltaSec(100, 100, 0)).toBeCloseTo(1, 6); // 不正な倍速は 1 扱い
  });
});

describe('目盛り', () => {
  it('主目盛りの間隔が 64px 以上になる最小の刻みを選ぶ', () => {
    expect(rulerStep(400)).toBe(0.2);
    expect(rulerStep(100)).toBe(1);
    expect(rulerStep(24)).toBe(5);
  });

  it('副目盛りを挟み、終端の少し先まで出す', () => {
    const t = rulerTicks(2, 100);
    expect(t[0]).toEqual({sec: 0, major: true});
    expect(t[1]).toEqual({sec: 0.5, major: false});
    expect(t[t.length - 1].sec).toBeGreaterThanOrEqual(2);
  });

  it('秒の表記', () => {
    expect(fmtSec(0)).toBe('0s');
    expect(fmtSec(1.5)).toBe('1.5s');
    expect(fmtSec(0.25)).toBe('0.25s');
    expect(fmtSec(12)).toBe('12s');
  });
});

describe('フィルムのコマ', () => {
  it('採用区間に掛かるコマを素材の時間位置どおりに置く（1 秒刻み）', () => {
    const c = clip({durationSec: 10});
    const cells = filmCells(c.thumbs.strip, 10, 1.5, 3.5, 10);
    expect(cells.map((x) => x.src)).toEqual(['strips/c1/02.jpg', 'strips/c1/03.jpg', 'strips/c1/04.jpg']);
    expect(cells[0].left).toBeCloseTo(-25, 6); // 1.0 秒のコマは 0.5 秒ぶん左にはみ出す
    expect(cells[0].width).toBeCloseTo(50, 6);
    expect(cells[2].left).toBeCloseTo(75, 6);
  });

  it('短いクリップは細かい刻み（生成側と同じ式）', () => {
    expect(stripFps(1)).toBe(3);
    expect(stripStepSec(1)).toBeCloseTo(1 / 3, 6);
    const c = clip({durationSec: 1});
    const cells = filmCells(c.thumbs.strip, 1, 0, 1, 10);
    expect(cells).toHaveLength(3);
  });

  it('細いブロックは先頭のコマ 1 枚で埋める', () => {
    const c = clip({durationSec: 10});
    expect(filmCells(c.thumbs.strip, 10, 2, 8, 2)).toEqual([{src: 'strips/c1/03.jpg', left: 0, width: 100}]);
  });

  it('ストリップが無い・区間が反転していれば空', () => {
    expect(filmCells([], 10, 0, 1, 5)).toEqual([]);
    expect(filmCells(['a'], 10, 2, 1, 5)).toEqual([]);
  });
});

describe('落としたときの既定区間', () => {
  it('usableRanges が無い長回しは頭尾 0.2 秒を避け、maxSec で切る', () => {
    expect(defaultRangeFor(clip({durationSec: 10}), FPS, 3)).toEqual({inSec: 0.2, outSec: 3.2});
  });

  it('短いクリップは全尺', () => {
    expect(defaultRangeFor(clip({durationSec: 1.5}), FPS, 3)).toEqual({inSec: 0, outSec: 1.5});
  });

  it('usableRanges は best を優先し avoid を無視する', () => {
    const c = clip({durationSec: 10, usableRanges: [{inSec: 0, outSec: 1, label: 'avoid'}, {inSec: 4, outSec: 9, label: 'ok'}, {inSec: 6, outSec: 7.5, label: 'best'}]});
    expect(defaultRangeFor(c, FPS, 3)).toEqual({inSec: 6, outSec: 7.5});
  });

  it('会話クリップは maxSec で切らない', () => {
    const c = clip({durationSec: 8, tags: {kind: 'conversation', signage: false, signageSize: 'none', angle: 'mid', motion: 'static', sizzleScore: 2, quality: 3, hasSpeech: true, subject: '', description: '', source: 'user', taggedAt: ''}});
    expect(defaultRangeFor(c, FPS, 3)).toEqual({inSec: 0.2, outSec: 7.8});
  });

  it('フレームグリッドに乗り、極端に短い素材でも最小尺を確保しようとする', () => {
    const r = defaultRangeFor(clip({durationSec: 0.3}), 30, 3);
    expect(r.outSec - r.inSec).toBeGreaterThanOrEqual(MIN_CUT_SEC - 1e-9);
    expect(Math.round(r.inSec * 30) / 30).toBeCloseTo(r.inSec, 6);
  });
});

describe('cuts.json の書き換え', () => {
  it('id は空いている最小番号', () => {
    expect(newCutId(reel().cuts)).toBe('c04');
    expect(newCutId([{id: 'c02', src: 'a', inSec: 0, outSec: 1}])).toBe('c01');
  });

  it('makeCut はテロップを付けない（空文字の main を付けない）', () => {
    const c = makeCut(clip(), {inSec: 1, outSec: 2}, 'c09');
    expect(c).toEqual({id: 'c09', src: 'uploads/01_steak.mp4', inSec: 1, outSec: 2});
    expect('main' in c).toBe(false);
  });

  it('createReel はスキーマを満たす', () => {
    const d = createReel(60, 'pop', makeCut(clip(), {inSec: 0, outSec: 1}, 'c01'));
    expect(ReelDataSchema.safeParse(d).success).toBe(true);
    expect(createReel(60, undefined, d.cuts[0]).theme).toBeUndefined();
  });

  it('挿入は index を範囲に収める', () => {
    const d = reel();
    const cut = makeCut(clip(), {inSec: 0, outSec: 1}, 'c04');
    expect(insertCutAt(d, cut, 1).cuts.map((c) => c.id)).toEqual(['c01', 'c04', 'c02', 'c03']);
    expect(insertCutAt(d, cut, 99).cuts.map((c) => c.id)).toEqual(['c01', 'c02', 'c03', 'c04']);
    expect(insertCutAt(d, cut, -5).cuts.map((c) => c.id)).toEqual(['c04', 'c01', 'c02', 'c03']);
  });

  it('削除は slot も一緒に消し、最後の 1 つは消せない', () => {
    const d = reel();
    const r = removeCutAt(d, 0)!;
    expect(r.cuts.map((c) => c.id)).toEqual(['c02', 'c03']);
    expect(r.meta?.slots).toEqual([]);
    expect(removeCutAt({fps: 60, cuts: [d.cuts[0]]}, 0)).toBeNull();
    expect(removeCutAt(d, 9)).toBeNull();
  });

  it('並べ替えは id と slot を保つ', () => {
    const r = moveCuts(reel(), [2, 2], 0);
    expect(r.cuts.map((c) => c.id)).toEqual(['c03', 'c01', 'c02']);
    expect(r.meta?.slots?.[0].cutId).toBe('c01');
  });

  it('区間の差し替えは他のカットに触らない', () => {
    const r = setCutRange(reel(), 1, {inSec: 2, outSec: 3});
    expect(r.cuts[1]).toMatchObject({id: 'c02', inSec: 2, outSec: 3, playbackRate: 1.5});
    expect(r.cuts[0]).toEqual(reel().cuts[0]);
  });

  it('分割は前半が元の id、後半が新しい id で、テロップは両方に残る', () => {
    const d: ReelData = {fps: FPS, cuts: [{id: 'c01', src: 'a', inSec: 1, outSec: 3, main: {text: 'うまい'}, badge: '梅田'}]};
    const r = splitCutAt(d, 0, 2, FPS)!;
    expect(r.cuts).toHaveLength(2);
    expect(r.cuts[0]).toMatchObject({id: 'c01', inSec: 1, outSec: 2, main: {text: 'うまい'}, badge: '梅田'});
    expect(r.cuts[1]).toMatchObject({id: 'c02', inSec: 2, outSec: 3, main: {text: 'うまい'}});
    expect('badge' in r.cuts[1]).toBe(false);
  });

  it('端に寄りすぎた分割は拒否する', () => {
    const d: ReelData = {fps: FPS, cuts: [{id: 'c01', src: 'a', inSec: 1, outSec: 3}]};
    expect(splitCutAt(d, 0, 1.05, FPS)).toBeNull();
    expect(splitCutAt(d, 0, 2.95, FPS)).toBeNull();
    expect(splitCutAt(d, 5, 2, FPS)).toBeNull();
  });

  it('タイムライン上の経過秒 → 素材内の秒（倍速を掛ける）', () => {
    expect(sourceSecAt({src: 'a', inSec: 1, outSec: 4, playbackRate: 1.5}, 1)).toBeCloseTo(2.5, 6);
    expect(sourceSecAt({src: 'a', inSec: 1, outSec: 4}, -1)).toBe(1);
  });

  it('使用回数は alias を元の src に寄せて数える', () => {
    const d: ReelData = {fps: FPS, cuts: [{src: 'uploads/a.mp4', inSec: 0, outSec: 1}, {src: 'uploads/a__2.mp4', inSec: 0, outSec: 1}, {src: 'uploads/b.mp4', inSec: 0, outSec: 1}]};
    const m = usageBySrc(d, (s) => (s === 'uploads/a__2.mp4' ? 'uploads/a.mp4' : s));
    expect(m.get('uploads/a.mp4')).toBe(2);
    expect(m.get('uploads/b.mp4')).toBe(1);
    expect(usageBySrc(null).size).toBe(0);
  });
});
