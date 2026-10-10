import {describe, expect, it} from 'vitest';
import {addedCutRange, applyPatch, type Patch} from '../core/ai';
import {ZoomSchema} from '../shared/schema/zoom';
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
  it('ズームだけの差分を適用し、尺・音声・テロップ・他のカットを保つ', () => {
    const narr: Narration = {voice: 'v', segments: [{id: 'n01', at: 0, text: 'そのまま'}]};
    const before = JSON.stringify(base);
    const r = apply({cuts: [
      {cutId: 'c01', zoom: {mode: 'push', scale_start: 1, scale_end: 1.1, anchor_x: 0.5, anchor_y: 0.42}},
      {cutId: 'c02', zoom: {mode: 'pull', scale_start: 1.1, scale_end: 1, anchor_x: 0.43, anchor_y: 0.61}},
    ]}, narr);
    expect(r.cuts.cuts[0].zoom).toEqual(ZoomSchema.parse({mode: 'push', scale_start: 1, scale_end: 1.1, anchor_x: 0.5, anchor_y: 0.42}));
    expect(r.cuts.cuts[1].zoom?.mode).toBe('pull');
    expect(r.cuts.cuts.map(({zoom, ...c}) => c)).toEqual(base.cuts);
    expect(r.narration).toBeNull(); expect(r.needsTts).toEqual([]);
    expect(r.applied).toHaveLength(2); expect(r.applied[0]).toContain('ズームイン 1.00→1.10倍');
    expect(r.applied[0]).not.toContain('区間'); expect(r.cutsTouched).toBe(true);
    expect(r.unapplied).toEqual([]); expect(JSON.stringify(base)).toBe(before);
  });

  it('null・省略はズームを維持し、noneだけ明示的に解除する（並び順ロック中も可）', () => {
    const withZoom: ReelData = {...base, meta: {orderLocked: true}, cuts: base.cuts.map(c => ({...c, zoom: ZoomSchema.parse({mode: 'push'})}))};
    const r = applyPatch(withZoom, null, catalog, {summary: '', cuts: [
      {cutId: 'c01', zoom: null}, {cutId: 'c02'}, {cutId: 'c03', zoom: {mode: 'none'}},
    ]}, {maxCutSec: 3});
    expect(r.cuts.cuts.map(c => c.zoom?.mode)).toEqual(['push', 'push', 'none']);
    expect(r.cuts.meta?.orderLocked).toBe(true); expect(r.applied).toEqual(['カット c03: ズームを解除']);
    expect(withZoom.cuts[2].zoom?.mode).toBe('push'); expect(r.unapplied).toEqual([]);
  });

  it('不正な倍率・方向・アンカーは拒否し、有効な別カットのズームは適用する', () => {
    const r = apply({cuts: [
      {cutId: 'c01', zoom: {mode: 'push', scale_end: 1.6}},
      {cutId: 'c02', zoom: {mode: 'pull', scale_start: 1, scale_end: 1.2}},
      {cutId: 'c03', zoom: {mode: 'push', anchor_y: -0.1}},
      {cutId: 'c01', zoom: {mode: 'push', scale_end: 1.08}},
    ]});
    expect(r.unapplied).toHaveLength(3); expect(r.applied).toHaveLength(1);
    expect(r.cuts.cuts[0].zoom?.scale_end).toBe(1.08); expect(r.cuts.cuts[1].zoom).toBeUndefined();
  });

  it('Codexが返す同じ尺・等速・空バッジなどの無変更差分を修正件数に数えない', () => {
    const r = apply({cuts: [{cutId: 'c01', inSec: 0, outSec: 1, playbackRate: 1, badge: '', remove: false, zoom: null}]});
    expect(r.cuts).toEqual(base); expect(r.cutsTouched).toBe(false); expect(r.applied).toEqual([]);
  });

  it('新規カットもrefを使ってズームできる', () => {
    const r = apply({add: [{ref: 'n1', clipId: '08'}], cuts: [{cutId: 'n1', zoom: {mode: 'pull'}}]});
    expect(r.cuts.cuts.at(-1)?.zoom?.mode).toBe('pull'); expect(r.applied).toHaveLength(2);
  });

  it('meta の無い台本カットでも推定した g01 のテロップを更新する', () => {
    const cuts = reel([cut('c01', 'uploads/a.mp4', '旧'), cut('c02', 'uploads/b.mp4', '旧'), cut('c03', 'uploads/c.mp4', '次')]);
    const r = applyPatch(cuts, null, catalog, {summary: '', telops: [{group: 'g01', text: '新しい文言'}]}, {maxCutSec: 3});
    expect(r.cuts.cuts.map((c) => c.main?.text)).toEqual(['新しい文言', '新しい文言', '次']);
    expect(r.unapplied).toEqual([]);
  });

  it('同じグループにカット数だけ文言が来たら各カットへ順に適用する', () => {
    const cuts = reel([cut('c01', 'uploads/a.mp4', '旧'), cut('c02', 'uploads/b.mp4', '旧')]);
    const r = applyPatch(cuts, null, catalog, {summary: '', telops: [{group: 'g01', text: '一つ目'}, {group: 'g01', text: '二つ目'}]}, {maxCutSec: 3});
    expect(r.cuts.cuts.map((c) => c.main?.text)).toEqual(['一つ目', '二つ目']);
    expect(r.unapplied).toEqual([]);
  });

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
