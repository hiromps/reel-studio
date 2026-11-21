// ナレーションのブロックごとの再生速度（rate）と、外部音声の読み込みで使う ID の受け付け
import {describe, expect, it} from 'vitest';
import {narrationRate, narrationUsedSec, trimNarrationHead} from '../shared/narration';
import {NarrationSegmentSchema} from '../shared/schema/narration';
import {mixClipsOf, planPlayback} from '../src/editor/mixPreview';
import {timeStretch} from '../src/editor/timeStretch';

describe('narrationRate', () => {
  it('未指定・範囲外は 1 倍', () => {
    expect(narrationRate({})).toBe(1);
    expect(narrationRate({rate: 3})).toBe(1);
    expect(narrationRate({rate: 1.5})).toBe(1.5);
  });
  it('スキーマは 0.5〜2 倍だけ通す', () => {
    expect(NarrationSegmentSchema.safeParse({id: 'a', at: 0, text: '', rate: 2}).success).toBe(true);
    expect(NarrationSegmentSchema.safeParse({id: 'a', at: 0, text: '', rate: 2.5}).success).toBe(false);
  });
});

describe('動画上の長さは 使う範囲 ÷ 速度', () => {
  it('narrationUsedSec', () => {
    expect(narrationUsedSec({durSec: 3, rate: 1.5})).toBeCloseTo(2);
    expect(narrationUsedSec({durSec: 3, startSec: 1, trimSec: 2, rate: 0.5})).toBeCloseTo(2);
  });
  it('頭のカットは動画上の秒でずらす', () => {
    // 元音声で 1 秒飛ばす＝2 倍速なら動画上は 0.5 秒
    expect(trimNarrationHead({durSec: 3, at: 2, rate: 2}, 1)).toEqual({startSec: 1, at: 2.5});
  });
});

describe('プレビュー', () => {
  it('速度つきブロックは伸縮後の秒で鳴らす', () => {
    const clips = mixClipsOf({voice: '', segments: [{id: 'a', at: 1, text: 'x', durSec: 4, startSec: 1, trimSec: 3, rate: 2}]}, '/m');
    expect(clips[0].rate).toBe(2);
    expect(clips[0].key).toContain(':x2');
    // 伸縮後のバッファは 2 秒。使う範囲は 0.5〜1.5 秒 → 動画の 1〜2 秒に鳴る
    const plan = planPlayback(clips, () => 2, 0);
    expect(plan[0].offsetSec).toBeCloseTo(0.5);
    expect(plan[0].durationSec).toBeCloseTo(1);
    expect(plan[0].delaySec).toBeCloseTo(1);
  });
  it('timeStretch は長さを 1/rate にする', () => {
    const sr = 8000;
    const src = new Float32Array(sr).map((_, i) => Math.sin((2 * Math.PI * 220 * i) / sr));
    expect(timeStretch([src], sr, 2)[0].length).toBe(sr / 2);
    expect(timeStretch([src], sr, 0.5)[0].length).toBe(sr * 2);
    const out = timeStretch([src], sr, 1.5)[0];
    // 振幅が保たれている（窓の重ね足しで潰れていない）
    const peak = out.slice(500, out.length - 500).reduce((m, x) => Math.max(m, Math.abs(x)), 0);
    expect(peak).toBeGreaterThan(0.8);
    expect(peak).toBeLessThan(1.2);
  });
});
