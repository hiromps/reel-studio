// プレビュー再生に声と効果音を重ねるときの「何を・いつ・どこから」の計算。
import {describe, expect, it} from 'vitest';
import type {Narration} from '@shared/schema';
import {AMBIENT_DEFAULT, dbToGain, driftExceeded, mixClipsOf, pendingNarration, planPlayback} from '../src/editor/mixPreview';

const narr = (): Narration => ({
  voice: 'v',
  narrationGainDb: 6,
  sfxGainDb: -6,
  ambientGain: 0.3,
  segments: [
    {id: '01_hook', at: 0.15, text: 'つかみ', durSec: 1.5},
    {id: '02_box', at: 2, text: '未生成', needsTts: true} as Narration['segments'][number],
    {id: '03_x', at: 3, text: 'wav 無し'},
    {id: '04_y', at: 4, text: '', durSec: 1},
  ],
  sfx: [{id: 'hook', at: 0, file: 'alarm.mp3', trimSec: 1.2, fadeOutSec: 0.3, gainDb: -3}, {id: 'gone', at: 5, file: 'zzz.mp3'}],
});
const lib = {version: 1 as const, sounds: [{file: 'alarm.mp3', label: 'alarm', roles: [], durSec: 3}]};

describe('mixClipsOf', () => {
  it('生成済み（needsTts 無し・durSec あり・本文あり）のブロックと、ライブラリにある効果音だけ', () => {
    const clips = mixClipsOf(narr(), '/p/x/full', lib);
    expect(clips.map((c) => c.id)).toEqual(['hook', '01_hook']);
    const n = clips.find((c) => c.kind === 'narr')!;
    expect(n.url).toBe('/p/x/full/narration/01_hook.wav');
    expect(n.key).toBe('narr:01_hook:1.5');
    expect(n.gain).toBeCloseTo(0.9 * dbToGain(6), 6);
    const s = clips.find((c) => c.kind === 'sfx')!;
    expect(s.url).toBe('/api/sfx/file/alarm.mp3');
    expect(s.trimSec).toBe(1.2);
    expect(s.gain).toBeCloseTo(dbToGain(-6) * dbToGain(-3), 6);
  });
  it('mediaBase が無ければ空。ライブラリ未取得なら効果音は全部候補', () => {
    expect(mixClipsOf(narr(), null, lib)).toEqual([]);
    expect(mixClipsOf(narr(), '/p/x/full', null).filter((c) => c.kind === 'sfx')).toHaveLength(2);
  });
  it('pendingNarration は本文があるのに wav が無いブロックを数える', () => {
    expect(pendingNarration(narr())).toBe(2);
    expect(pendingNarration(null)).toBe(0);
  });
});

describe('planPlayback', () => {
  const clips = mixClipsOf(narr(), '/p/x/full', lib);
  const bufSec = (key: string) => (key.startsWith('narr') ? 1.5 : 3);
  it('先頭からなら全部、配置秒ぶん遅らせて頭から鳴らす', () => {
    const p = planPlayback(clips, bufSec, 0);
    expect(p.map((x) => [x.key.split(':')[1], x.delaySec, x.offsetSec, x.durationSec])).toEqual([
      ['alarm.mp3', 0, 0, 1.2],
      ['01_hook', 0.15, 0, 1.5],
    ]);
    expect(p[0].fadeOutSec).toBe(0.3);
  });
  it('途中からなら offset で頭を飛ばし、鳴り終わったものは省く', () => {
    const p = planPlayback(clips, bufSec, 1.0);
    expect(p).toHaveLength(2);
    const alarm = p.find((x) => x.key.includes('alarm'))!;
    expect(alarm.delaySec).toBe(0);
    expect(alarm.offsetSec).toBe(1);
    expect(alarm.durationSec).toBeCloseTo(0.2, 6);
    expect(alarm.fadeOutSec).toBeCloseTo(0.2, 6); // 残りより長いフェードは残りに合わせる
    const hook = p.find((x) => x.key.includes('01_hook'))!;
    expect(hook.offsetSec).toBeCloseTo(0.85, 6);
    expect(planPlayback(clips, bufSec, 2)).toEqual([]);
  });
  it('バッファが無い（未読込）ものは省く', () => {
    expect(planPlayback(clips, () => undefined, 0)).toEqual([]);
  });
});

describe('driftExceeded', () => {
  it('同期点が無ければずれ扱い。予測と実際が許容内なら鳴らし直さない', () => {
    expect(driftExceeded(null, 0, 0)).toBe(true);
    const anchor = {ctxSec: 10, mediaSec: 2};
    expect(driftExceeded(anchor, 11, 3.1)).toBe(false);
    expect(driftExceeded(anchor, 11, 3.4)).toBe(true);
    expect(driftExceeded(anchor, 11, 0)).toBe(true); // ループで頭に戻った
  });
  it('環境音の既定は mix と同じ 0.22', () => {
    expect(AMBIENT_DEFAULT).toBe(0.22);
  });
});
