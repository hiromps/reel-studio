import {describe, expect, it} from 'vitest';
import {addedCutRange, applyPatch, type Patch} from '../core/ai';
import type {Clip} from '../shared/schema/catalog';
import type {Cut, ReelData} from '../shared/schema/cuts';
import type {Narration} from '../shared/schema/narration';

const FPS = 30;
const clip = (id: string, durationSec: number, extra: Partial<Clip> = {}): Clip =>
  ({
    id,
    original: `${id}.mp4`,
    slug: id,
    src: `uploads/${id}_x.mp4`,
    probe: {codec: 'h264', width: 1080, height: 1920, rotation: 0, fps: FPS, durationSec, hasAudio: true, pixFmt: ''},
    thumbs: {sheet: '', strip: []},
    usableRanges: [],
    user: {hook: false, ng: false, orderHint: null, lock: false},
    ...extra,
  }) as Clip;
const cut = (id: string, src: string, telop?: string): Cut => ({id, src, inSec: 0, outSec: 1, ...(telop ? {main: {text: telop}} : {})});
const reel = (cuts: Cut[]): ReelData => ({fps: FPS, cuts});
const catalog = {
  clips: [
    clip('08', 2.886),
    clip('11', 4, {usableRanges: [{inSec: 2, outSec: 3, label: 'ok'}, {inSec: 0.18, outSec: 1.57, label: 'best'}]}),
    clip('99', 3, {user: {hook: false, ng: true, orderHint: null, lock: false}}),
  ],
};
const base = reel([cut('c01', 'uploads/a.mp4', 'フック'), cut('c02', 'uploads/b.mp4'), cut('c03', 'uploads/c.mp4')]);
const apply = (patch: Omit<Patch, 'summary'>, narration: Narration | null = null) =>
  applyPatch(base, narration, catalog, {summary: '', ...patch}, {maxCutSec: 3});

describe('addedCutRange', () => {
  it('省略時は best 区間を使う', () => {
    expect(addedCutRange(catalog.clips[1], FPS, 3)).toEqual({inSec: 0.167, outSec: 1.567});
  });
  it('区間が無ければ頭尾 0.2 秒を避け、maxSec で切る', () => {
    expect(addedCutRange(clip('x', 10), FPS, 3)).toEqual({inSec: 0.2, outSec: 3.2});
  });
  it('素材の外や短すぎる区間は null', () => {
    expect(addedCutRange(catalog.clips[0], FPS, 3, 2.8, 5)).toBeNull();
  });
});

describe('applyPatch', () => {
  it('素材からカットを足し、ref で並べ替えとテロップを指せる', () => {
    const r = apply({
      add: [
        {ref: 'n1', clipId: '08', inSec: 0.3, outSec: 2.1, text: '全120席の夜景'},
        {ref: 'n2', clipId: '11'},
      ],
      order: ['c01', 'n1', 'c03', 'n2', 'c02'],
      telops: [{cutId: 'n2', text: '前菜は升に八種…'}],
    });
    expect(r.cuts.cuts.map((c) => c.id)).toEqual(['c01', 'c04', 'c03', 'c05', 'c02']);
    expect(r.cuts.cuts[1]).toMatchObject({src: 'uploads/08_x.mp4', inSec: 0.3, outSec: 2.1, main: {text: '全120席の夜景'}});
    expect(r.cuts.cuts[3].main?.text).toBe('前菜は升に八種・・・');
    expect(r.cutsTouched).toBe(true);
    expect(r.unapplied).toEqual([]);
  });

  it('order に足したカットが抜けていたら並べ替えは見送り、理由を返す', () => {
    const r = apply({add: [{ref: 'n1', clipId: '08'}], order: ['c03', 'c02', 'c01']});
    expect(r.cuts.cuts.map((c) => c.id)).toEqual(['c01', 'c02', 'c03', 'c04']);
    expect(r.unapplied[0]).toContain('抜けている c04');
  });

  it('order が無ければ after の後ろに入れる', () => {
    const r = apply({add: [{ref: 'n1', clipId: '08', after: 'c01'}, {ref: 'n2', clipId: '08', after: '^'}]});
    expect(r.cuts.cuts.map((c) => c.id)).toEqual(['c05', 'c01', 'c04', 'c02', 'c03']);
  });

  it('NG 素材・知らない素材は足さずに unapplied へ。他の変更は適用する', () => {
    const r = apply({add: [{ref: 'n1', clipId: '99'}, {ref: 'n2', clipId: 'zz'}], order: ['c03', 'c02', 'c01']});
    expect(r.cuts.cuts.map((c) => c.id)).toEqual(['c03', 'c02', 'c01']);
    expect(r.unapplied).toHaveLength(2);
  });

  it('削除したカットは meta のスロットとテロップグループから外す', () => {
    const withMeta: ReelData = {
      ...base,
      meta: {
        slots: [{cutId: 'c02', segment: 's', role: 'sizzle', clipId: 'b', textStatus: 'draft', locked: false, qc: []}],
        telopGroups: [{id: 'g01', cutIds: ['c02'], intent: 'body', placeholder: '', minSec: 1}],
      },
    };
    const r = applyPatch(withMeta, null, catalog, {summary: '', cuts: [{cutId: 'c02', remove: true}]}, {maxCutSec: 3});
    expect(r.cuts.meta?.slots).toEqual([]);
    expect(r.cuts.meta?.telopGroups).toEqual([]);
    expect(withMeta.meta?.telopGroups?.[0].cutIds).toEqual(['c02']);
  });

  it('ナレーションのブロックを足す・消す・動かす', () => {
    const narr: Narration = {voice: 'v', segments: [{id: 'n01', at: 0, text: 'あ'}, {id: 'n02', at: 3, text: 'い'}]};
    const r = apply({narration: [{id: 'n03', add: true, at: 1.5, text: 'う'}, {id: 'n02', remove: true}, {id: 'n01', at: 0.2}, {id: 'n01', add: true, at: 1, text: 'x'}]}, narr);
    expect(r.narration?.segments.map((s) => [s.id, s.at])).toEqual([['n01', 0.2], ['n03', 1.5]]);
    expect(r.needsTts).toEqual(['n03']);
    expect(r.unapplied[0]).toContain('n01 はもうある');
    expect(narr.segments).toHaveLength(2);
  });
});
