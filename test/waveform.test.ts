import {describe, expect, it} from 'vitest';
import {barsFor, computePeaks} from '../src/editor/waveform';

// 1 秒目だけ音がある 3 秒の録音（頭と終わりは無音）
const rate = 8000;
const voiceInMiddle = Float32Array.from({length: rate * 3}, (_, i) => (i >= rate && i < rate * 2 ? Math.sin(i / 5) * 0.4 : 0));

describe('波形', () => {
  it('区間ごとの最大振幅を取り、全体の最大も持つ', () => {
    const w = computePeaks([voiceInMiddle], rate, 10);
    expect(w.peaks.length).toBe(30);
    expect(w.durSec).toBe(3);
    expect(w.max).toBeCloseTo(0.4, 2);
    expect(w.peaks[5]).toBe(0);
    expect(w.peaks[15]).toBeGreaterThan(0.3);
  });

  it('ステレオは両チャンネルの大きい方を取る', () => {
    const left = new Float32Array(rate);
    const right = Float32Array.from({length: rate}, () => 0.5);
    expect(computePeaks([left, right], rate, 4).peaks[0]).toBe(0.5);
  });

  it('描く範囲に合わせて棒にまとめ、最大で 1 に正規化する（小さい録音も見える）', () => {
    const w = computePeaks([voiceInMiddle], rate);
    const all = barsFor(w, 0, 3, 30);
    expect(all.length).toBe(30);
    expect(Math.max(...all)).toBeCloseTo(1, 2);
    // 頭の 1 秒・終わりの 1 秒は無音、真ん中に声
    expect(Math.max(...all.slice(0, 9))).toBe(0);
    expect(Math.min(...all.slice(11, 19))).toBeGreaterThan(0.5);
    expect(Math.max(...all.slice(21))).toBe(0);
  });

  it('頭を削った範囲だけを描くと、声が左端から始まる', () => {
    const w = computePeaks([voiceInMiddle], rate);
    const used = barsFor(w, 1, 2, 10);
    expect(Math.min(...used)).toBeGreaterThan(0.5);
  });

  it('拡大して棒が区間より細くなっても途切れない', () => {
    const w = computePeaks([voiceInMiddle], rate, 10);
    const zoomed = barsFor(w, 1.2, 1.3, 50);
    expect(Math.min(...zoomed)).toBeGreaterThan(0.5);
  });
});
