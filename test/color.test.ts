import {describe, expect, it} from 'vitest';
import {colorFilter, ColorAdjustmentsSchema, DEFAULT_COLOR, isDefaultColor} from '../shared/color';
import {CatalogSchema, ReelDataSchema} from '../shared/schema';
import {makeBrief, makeCatalog, richClips} from './helpers';
import {makeCut, replaceCutSource, splitCutAt} from '../src/components/track';
import {planCuts} from '../shared/plan';
import {scriptPlanToCuts} from '../shared/script';
import {bgFromCut} from '../shared/thumbnail';

const color = {exposure: -0.5, brightness: 1.1, contrast: 1.2, saturation: 0.7};
describe('色・明るさの保存と描画', () => {
  it('旧データは無補正のまま。補正をcatalogとcutsに保存・再読込できる', () => {
    expect(ColorAdjustmentsSchema.parse({})).toEqual(DEFAULT_COLOR);
    expect(isDefaultColor(undefined)).toBe(true);
    const catalog = makeCatalog('test', richClips());
    expect(catalog.clips[0].color).toBeUndefined();
    catalog.clips[0].color = color;
    expect(CatalogSchema.parse(JSON.parse(JSON.stringify(catalog))).clips[0].color).toEqual(color);
    const data = {fps: 30, cuts: [{src: 'a.mp4', inSec: 0, outSec: 1, color}]};
    expect(ReelDataSchema.parse(JSON.parse(JSON.stringify(data))).cuts[0].color).toEqual(color);
  });
  it('範囲外・非有限値は保存しない', () => {
    for (const input of [{exposure: -2.01}, {exposure: 2.01}, {brightness: -1}, {contrast: 2.01}, {saturation: 2.01}, {exposure: NaN}, {brightness: Infinity}]) {
      expect(ColorAdjustmentsSchema.safeParse(input).success).toBe(false);
    }
  });
  it('露出はEVに従って倍率を変え、明るさ・コントラスト・彩度を同じフィルターで適用する', () => {
    expect(colorFilter()).toBeUndefined();
    expect(colorFilter(DEFAULT_COLOR)).toBeUndefined();
    expect(colorFilter({exposure: 1})).toBe('brightness(2.000000) contrast(1.000000) saturate(1.000000)');
    expect(colorFilter({exposure: -1, brightness: 1.2, contrast: 0.8, saturation: 0})).toBe('brightness(0.600000) contrast(0.800000) saturate(0.000000)');
    expect(colorFilter({exposure: Infinity, brightness: NaN})).toBeUndefined();
    expect(colorFilter({exposure: 99, contrast: -3})).toBe('brightness(4.000000) contrast(0.000000) saturate(1.000000)');
  });
});
describe('素材の補正をカットへ引き継ぐ', () => {
  it('追加・分割・カバー画像に引き継ぎ、差し替えでは新しい素材の設定を使う', () => {
    const [clip, replacement] = richClips();
    clip.color = color;
    const cut = makeCut(clip, {inSec: 0, outSec: 2}, 'c01');
    expect(cut.color).toEqual(color);
    expect(cut.color).not.toBe(color);
    const data = {fps: 30, cuts: [cut]};
    expect(splitCutAt(data, 0, 1, 30)!.cuts.map((c) => c.color)).toEqual([color, color]);
    expect(bgFromCut(cut, 0.5).color).toEqual(color);
    expect(replaceCutSource(data, 0, replacement)!.cuts[0].color).toBeUndefined();
    replacement.color = {...color, exposure: 1};
    expect(replaceCutSource(data, 0, replacement)!.cuts[0].color).toEqual(replacement.color);
    expect(cut.color).toEqual(color);
  });
  it('構成プランと台本からの組み立てでも引き継ぐ', () => {
    const clips = richClips().map((c) => c.id === '11' ? {...c, color} : c);
    const catalog = makeCatalog('test', clips);
    const planned = planCuts({catalog, brief: makeBrief({persona: 'standard', format: 'F7', hook: {clipId: '11', text: 'テスト'}}), options: {allowReuse: true}});
    const matching = planned.cuts.cuts.filter((c) => c.src.includes('tea-pour'));
    expect(matching.length).toBeGreaterThan(0);
    for (const c of matching) expect(c.color).toEqual(color);
    const scripted = scriptPlanToCuts({cuts: [{clipId: '11', inSec: 0, outSec: 2, telop: '紅茶', section: '0:00'}, {clipId: '16', inSec: 0, outSec: 2, telop: '黄身', section: '0:02'}], narration: [], unmatched: [], notes: ''}, {catalog, theme: 'pop', specId: 'F0', briefHash: 'x', catalogHash: 'y'});
    expect(scripted.cuts[0].color).toEqual(color);
    expect(scripted.cuts[1].color).toBeUndefined();
  });
});
