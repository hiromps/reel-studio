import {describe, expect, it} from 'vitest';
import type {Narration, ReelData} from '../shared/schema';
import {narrationFromTelops, spokenTelops, telopNarrationConfirmation} from '../shared/telop-narration';

const defaults = {voice: 'default-voice', voiceTitle: '既定の声', speed: 1.2};
const reel = (): ReelData => ({fps: 30, cuts: [
  {id: 'c01', src: 'a', inSec: 0, outSec: 1, main: {text: '牛タン、最高！'}},
  {id: 'c02', src: 'b', inSec: 1, outSec: 3, main: {text: '牛タン、最高！'}},
  {id: 'c03', src: 'c', inSec: 0, outSec: 1, main: {text: '次の\nひと皿'}},
]});

describe('テロップからナレーション', () => {
  it('同じテロップが続くカットは1回だけ読み、文言と開始位置を保つ', () => {
    expect(spokenTelops(reel()).entries).toEqual([
      {text: '牛タン、最高！', at: 0, endSec: 3, kind: 'main'},
      {text: '次の\nひと皿', at: 3, endSec: 4, kind: 'main'},
    ]);
    const n = narrationFromTelops(reel(), null, defaults, 'batch');
    expect(n.segments.map(s => s.text)).toEqual(['牛タン、最高！', '次の\nひと皿']);
    expect(n.segments.map(s => s.at)).toEqual([0, 3]);
    expect(n).toMatchObject({voice: defaults.voice, voiceTitle: defaults.voiceTitle, speed: 1.2, videoSec: 4});
  });

  it('離れた位置で再登場する同じ文言は省略しない', () => {
    const d = reel(); d.cuts[1].main = {text: '別の文言'}; d.cuts[2].main = d.cuts[0].main;
    expect(spokenTelops(d).entries.map(e => e.text)).toEqual(['牛タン、最高！', '別の文言', '牛タン、最高！']);
  });

  it('空欄とプレースホルダーは音声化せず、バッジと価格は原稿に混ぜない', () => {
    const d = reel(); d.cuts[0].main = {text: ' '}; d.cuts[1].main = {text: '{{g01:proof}}'}; d.cuts[2].badge = '大阪'; d.cuts[2].price = {text: '1000円'};
    expect(spokenTelops(d)).toMatchObject({skipped: 2, entries: [{text: '次の\nひと皿'}]});
    d.cuts[2].main = undefined;
    expect(() => narrationFromTelops(d, null, defaults, 'batch')).toThrow('音声化できるテロップがありません');
  });

  it('倍速・トリミング済みの字幕の絶対秒をタイムライン位置に変換する', () => {
    const d: ReelData = {fps: 30, cuts: [
      {src: 'a', inSec: 0, outSec: 1},
      {src: 'b', inSec: 10, outSec: 14, playbackRate: 2, subs: [
        {text: '範囲外', startSec: 0, endSec: 5},
        {text: '前から続く', startSec: 9, endSec: 11},
        {text: '途中', startSec: 11, endSec: 13},
        {text: '最後', startSec: 13, endSec: 15},
      ]},
    ]};
    expect(spokenTelops(d).entries).toEqual([
      {text: '前から続く', at: 1, endSec: 1.5, kind: 'sub'},
      {text: '途中', at: 1.5, endSec: 2.5, kind: 'sub'},
      {text: '最後', at: 2.5, endSec: 3, kind: 'sub'},
    ]);
  });

  it('クリップ分割で境界をまたぐ字幕も1度だけ読み上げる', () => {
    const d: ReelData = {fps: 30, cuts: [
      {src: 'a', inSec: 0, outSec: 1, subs: [{text: '続く字幕', startSec: 0, endSec: 1}]},
      {src: 'a', inSec: 1, outSec: 2, subs: [{text: '続く字幕', startSec: 1, endSec: 2}]},
    ]};
    expect(spokenTelops(d).entries).toEqual([{text: '続く字幕', at: 0, endSec: 2, kind: 'sub'}]);
  });

  it('字幕の開始位置を表示フレームに合わせ、画面の尺より外にある字幕は読まない', () => {
    const d: ReelData = {fps: 30, cuts: [{src: 'a', inSec: 0, outSec: 1.01, subs: [
      {text: '途中', startSec: 0.117, endSec: 0.49},
      {text: '画面外', startSec: 1.001, endSec: 1.01},
    ]}]};
    expect(spokenTelops(d).entries).toEqual([{text: '途中', at: 0.133, endSec: 0.5, kind: 'sub'}]);
  });

  it('声・話速・音量・効果音を引き継ぎ、元の音声IDと原稿を変更しない', () => {
    const old: Narration = {voice: 'chosen', voiceTitle: '選んだ声', speed: 1.4, latency: 'balanced', ambientGain: 0.1,
      narrationGainDb: 6, sfxGainDb: 2, segments: [{id: 'old', at: 0, text: '旧原稿', durSec: 1}],
      sfx: [{id: 's1', at: 0, file: 'a.wav'}]};
    const n = narrationFromTelops(reel(), old, defaults, 'newbatch');
    expect(n).toMatchObject({voice: 'chosen', voiceTitle: '選んだ声', speed: 1.4, latency: 'balanced', ambientGain: 0.1, narrationGainDb: 6, sfxGainDb: 2, sfx: old.sfx});
    expect(n.segments.every(s => s.id.startsWith('telop_newbatch_') && s.needsTts && s.fromTelop && s.durSec === undefined)).toBe(true);
    expect(old.segments).toEqual([{id: 'old', at: 0, text: '旧原稿', durSec: 1}]);
  });

  it('テロップ・原稿・声の変更で確認の指紋が変わり、JSON往復では変わらない', () => {
    const d = reel(); const a = telopNarrationConfirmation(d, null, defaults).fingerprint;
    expect(telopNarrationConfirmation(JSON.parse(JSON.stringify(d)), null, defaults).fingerprint).toBe(a);
    expect(telopNarrationConfirmation(d, {voice: 'v', segments: []}, defaults).fingerprint).not.toBe(a);
    expect(telopNarrationConfirmation(d, null, {...defaults, voice: 'other'}).fingerprint).not.toBe(a);
    d.cuts[0].main!.text = '変更';
    expect(telopNarrationConfirmation(d, null, defaults).fingerprint).not.toBe(a);
  });
});
