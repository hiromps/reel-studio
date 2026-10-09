import {describe, expect, it} from 'vitest';
import {fitCutsToNarration} from '../shared/fit';
import {cutFrames} from '../shared/timeline';
import type {ReelData} from '../shared/schema/cuts';
import type {Narration} from '../shared/schema/narration';
import {makeClip} from './helpers';
const clips = ['02', '03', '05', '07', '09'].map(id => makeClip({id, slug: id, dur: 6, kind: 'sizzle'}));
const source = (id: string) => clips.find(c => c.id === id)!.src;
const locked = (): ReelData => ({fps: 30, font: 'custom.otf', meta: {orderLocked: true}, cuts: [
  {id: 'manual-31', src: source('05'), inSec: 1, outSec: 3, playbackRate: 2, crop: {zoom: 1.2, x: 0.3, y: 0.6}, badge: '神戸', main: {text: 'H'}},
  {id: 'manual-09', src: source('03'), inSec: 0, outSec: 1, main: {text: 'H'}},
  {id: 'manual-44', src: source('02'), inSec: 2, outSec: 3, main: {text: 'H'}},
  {id: 'manual-02', src: source('02'), inSec: 4, outSec: 5, main: {text: 'P'}},
]});
const narr = (segments: Narration['segments'], extra: Partial<Narration> = {}): Narration => ({voice: 'v', segments, ...extra});
describe('並び順をロックした尺合わせ', () => {
  it('撮影順と違う並び、似た構図、連続の同素材を残し、尺だけを合わせる', () => {
    const data = locked();const original = JSON.stringify(data);
    const result = fitCutsToNarration(data, narr([{id: 'n1', at: 0, text: 'あ', durSec: 6}]), {clips, clipDurationOf: () => 6});
    expect(result.ok).toBe(true);
    expect(result.cuts.cuts.map(({inSec, outSec, ...rest}) => rest)).toEqual(data.cuts.map(({inSec, outSec, ...rest}) => rest));
    expect(result.cuts.meta).toEqual(data.meta);expect(result.cuts.font).toBe(data.font);
    expect(result.after.cutCount).toBe(4);expect(result.after.totalSec).toBe(6);
    expect(result.merged).toEqual([]);expect(result.supplemented).toEqual([]);
    expect(result.notes[0]).toContain('並び順ロック');expect(JSON.stringify(data)).toBe(original);
  });
  it('会話字幕と個別に固定したカットを保ち、他のカットで音声の尺を受け持つ', () => {
    const data = locked();data.meta!.slots = [{cutId: 'manual-09', segment: 'body', role: 'proof', clipId: '03', textStatus: 'final', locked: true, qc: []}];
    data.cuts[2] = {...data.cuts[2], main: undefined, subs: [{startSec: 2, endSec: 3, text: '会話字幕'}]};
    const result = fitCutsToNarration(data, narr([{id: 'n1', at: 0, text: 'あ', durSec: 5}]), {clips});
    expect(result.ok).toBe(true);expect(result.cuts.cuts[1]).toEqual(data.cuts[1]);expect(result.cuts.cuts[2]).toEqual(data.cuts[2]);
    expect(result.after.totalSec).toBe(5);expect(result.cuts.cuts[0].playbackRate).toBe(2);
  });
  it('複数ブロックの尺と音声・効果音の配置を合わせ、元のカットIDと順序を保つ', () => {
    const data = locked();
    const audio = narr([{id: 'later', at: 2, durSec: 3, trimSec: 2, text: 'い'}, {id: 'first', at: 0, durSec: 3, text: 'あ'}], {sfx: [{id: 's1', at: 3, file: 'ding.mp3'}]});
    const result = fitCutsToNarration(data, audio, {clips});
    expect(result.ok).toBe(true);expect(result.cuts.cuts.map(c => c.id)).toEqual(data.cuts.map(c => c.id));
    expect(result.blocks.map(b => [b.at, b.videoSec, b.cutCount])).toEqual([[0, 3, 2], [3, 2, 2]]);
    expect(result.narration.segments).toEqual([{...audio.segments[0], at: 3}, {...audio.segments[1], at: 0}]);
    expect(result.narration.sfx?.[0].at).toBe(4);
  });
  it('素材が不足しても追加・削除・入れ替えせず、何も変更せず理由を返す', () => {
    const data = locked();const audio = narr([{id: 'n1', at: 0, text: 'あ', durSec: 50}]);
    const result = fitCutsToNarration(data, audio, {clips});
    expect(result.ok).toBe(false);expect(result.blockers.join('')).toContain('並び順ロック');
    expect(result.cuts).toBe(data);expect(result.narration).toBe(audio);
  });
  it('対応するカットの無い音声があっても、素材を借りたり複製したりしない', () => {
    const data = locked();const audio = narr([{id: 'n1', at: 0, text: 'あ', durSec: 1}, {id: 'n2', at: 0, text: 'い', durSec: 1}]);
    const result = fitCutsToNarration(data, audio, {clips});
    expect(result.ok).toBe(false);expect(result.cuts).toBe(data);expect(result.narration).toBe(audio);
  });
  it.each([24, 30, 60])('%s fps で端数と倍速を含めても音声を覆い、素材の範囲を越えない', fps => {
    const data = locked();data.fps = fps;data.cuts[0].playbackRate = 1.7;
    const result = fitCutsToNarration(data, narr([{id: 'n1', at: 0, text: 'あ', durSec: 13.137}]), {clipDurationOf: () => 6.125});
    expect(result.ok).toBe(true);expect(result.after.totalSec).toBeGreaterThanOrEqual(13.137);
    for (const c of result.cuts.cuts) {expect(c.inSec).toBeGreaterThanOrEqual(0);expect(c.outSec).toBeLessThanOrEqual(6.125);expect(cutFrames(c, fps)).toBeGreaterThan(0);}
  });
});
