import {describe, expect, it} from 'vitest';
import {MIN_CUT_SEC, applyTrim, fallbackDuration, nudgeSec, ratioOf, secAtX} from '../src/components/trim';

const FPS = 60;
const base = {inSec: 1.0, outSec: 3.0};

describe('applyTrim — 頭・尻・窓ごとのドラッグ', () => {
  it('頭を右へ引くと inSec だけ動く', () => {
    expect(applyTrim(base, 'in', 0.5, 10, FPS)).toEqual({inSec: 1.5, outSec: 3.0});
  });

  it('尻を左へ引くと outSec だけ動く', () => {
    expect(applyTrim(base, 'out', -0.5, 10, FPS)).toEqual({inSec: 1.0, outSec: 2.5});
  });

  it('窓ごと動かすと尺が変わらない', () => {
    const r = applyTrim(base, 'move', 2, 10, FPS);
    expect(r).toEqual({inSec: 3.0, outSec: 5.0});
    expect(r.outSec - r.inSec).toBeCloseTo(base.outSec - base.inSec, 3);
  });

  it('フレームグリッドに丸める（60fps なら 1/60 秒刻み）', () => {
    const r = applyTrim(base, 'in', 0.008, 10, FPS); // 1.008 → 1.0 でも 1.0167 でもなく最寄りのフレーム
    expect(Math.round(r.inSec * FPS) / FPS).toBeCloseTo(r.inSec, 6);
  });

  describe('はみ出さない', () => {
    it('頭は 0 より前に行かない', () => {
      expect(applyTrim(base, 'in', -5, 10, FPS).inSec).toBe(0);
    });

    it('尻は素材尺を超えない', () => {
      expect(applyTrim(base, 'out', 99, 10, FPS).outSec).toBe(10);
    });

    it('頭は尻を追い越さない（最小尺を残す）', () => {
      const r = applyTrim(base, 'in', 99, 10, FPS);
      expect(r.inSec).toBeCloseTo(base.outSec - MIN_CUT_SEC, 3);
      expect(r.outSec - r.inSec).toBeGreaterThanOrEqual(MIN_CUT_SEC - 0.001);
    });

    it('尻は頭を追い越さない（最小尺を残す）', () => {
      const r = applyTrim(base, 'out', -99, 10, FPS);
      expect(r.outSec).toBeCloseTo(base.inSec + MIN_CUT_SEC, 3);
      expect(r.outSec - r.inSec).toBeGreaterThanOrEqual(MIN_CUT_SEC - 0.001);
    });

    it('窓ごと動かしても素材の外に出ない', () => {
      expect(applyTrim(base, 'move', -99, 10, FPS)).toEqual({inSec: 0, outSec: 2.0});
      const right = applyTrim(base, 'move', 99, 10, FPS);
      expect(right.outSec).toBeLessThanOrEqual(10.001);
      expect(right.outSec - right.inSec).toBeCloseTo(2.0, 3);
    });

    it('窓を右端まで寄せたら末尾にぴったり付く（フレーム丸めで余らせない）', () => {
      // 4.043 秒はフレームグリッドに乗らない尺
      const r = applyTrim({inSec: 1.0, outSec: 2.2}, 'move', 99, 4.043, FPS);
      expect(r.outSec).toBe(4.043);
      expect(r.outSec - r.inSec).toBeCloseTo(1.2, 3);
    });

    it('素材尺が最小尺より短くても壊れない', () => {
      const tiny = {inSec: 0, outSec: 0.1};
      const r = applyTrim(tiny, 'out', -99, 0.1, FPS);
      expect(r.inSec).toBe(0);
      expect(r.outSec).toBeGreaterThan(0);
      expect(r.outSec).toBeLessThanOrEqual(0.1);
    });
  });
});

describe('座標と秒の変換', () => {
  it('secAtX は幅に対する比で秒を返し、範囲外は挟む', () => {
    expect(secAtX(50, 100, 10)).toBeCloseTo(5, 6);
    expect(secAtX(-20, 100, 10)).toBe(0);
    expect(secAtX(500, 100, 10)).toBe(10);
    expect(secAtX(50, 0, 10)).toBe(0); // 幅 0 で割らない
  });

  it('ratioOf は 0〜1 に収まる', () => {
    expect(ratioOf(5, 10)).toBeCloseTo(0.5, 6);
    expect(ratioOf(-1, 10)).toBe(0);
    expect(ratioOf(99, 10)).toBe(1);
    expect(ratioOf(5, 0)).toBe(0); // 素材尺 0 で割らない
  });
});

describe('補助', () => {
  it('nudgeSec は fps 基準のフレーム数', () => {
    expect(nudgeSec(60, 1)).toBeCloseTo(1 / 60, 6);
    expect(nudgeSec(30, -10)).toBeCloseTo(-1 / 3, 6);
  });

  it('fallbackDuration は今の OUT より広い', () => {
    expect(fallbackDuration({inSec: 0, outSec: 2})).toBeGreaterThan(2);
    expect(fallbackDuration({inSec: 0, outSec: 0.1})).toBeGreaterThanOrEqual(1);
  });
});
