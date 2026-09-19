// 画面内の切り出し（アスペクト比を変えない拡大・位置）。
//
// 大事なのは 2 つだけ:
//   1. **比率が絶対に崩れないこと**（出来上がりは常に 9:16）
//   2. **編集中に見えているものが、そのまま書き出されること**
// 2 を担保するため、当て方（cropStyle）はレンダーに使うエンジンの関数をそのままテストする。
import {describe, expect, it} from 'vitest';
import {MAX_CROP_ZOOM, cropStyle} from '../engine/src/GourmetReel';
import {CropSchema, CutSchema, DEFAULT_CROP, isDefaultCrop} from '@shared/schema/cuts';

describe('切り出しの当て方（エンジンと画面で共通）', () => {
  it('比率は常に cover のまま。枠いっぱいに出す指定は変えない', () => {
    for (const c of [undefined, {zoom: 1}, {zoom: 2, x: 0, y: 1}, {zoom: 3, x: 0.25, y: 0.75}]) {
      const st = cropStyle(c);
      expect(st.objectFit).toBe('cover');
      expect(st.width).toBe('100%');
      expect(st.height).toBe('100%');
      // 幅と高さを別々に伸ばす指定（＝比率が崩れる）は出さない
      expect(String(st.transform ?? '')).not.toMatch(/scaleX|scaleY|matrix/);
    }
  });

  it('既定（寄り 1・中央）は、これまでとまったく同じ見え方になる', () => {
    const st = cropStyle(undefined);
    expect(st.transform).toBeUndefined();
    expect(st.objectPosition).toBe('50.000% 50.000%');
  });

  it('寄ると scale が付き、寄る中心が transform-origin になる', () => {
    const st = cropStyle({zoom: 2, x: 0.25, y: 0.8});
    expect(st.transform).toBe('scale(2.0000)');
    expect(st.transformOrigin).toBe('25.000% 80.000%');
    expect(st.objectPosition).toBe('25.000% 80.000%');
  });

  it('寄りは 1 未満にならない（縮小して余白が出るのを防ぐ）', () => {
    expect(cropStyle({zoom: 0.5}).transform).toBeUndefined();
    expect(cropStyle({zoom: -3}).transform).toBeUndefined();
  });

  it('寄りには上限がある（素材より大きく引き伸ばして粗くしない）', () => {
    expect(cropStyle({zoom: 99}).transform).toBe(`scale(${MAX_CROP_ZOOM.toFixed(4)})`);
  });

  it('位置は 0〜1 の外に出さない。壊れた値は中央に倒す', () => {
    expect(cropStyle({zoom: 2, x: -1, y: 5}).transformOrigin).toBe('0.000% 100.000%');
    expect(cropStyle({zoom: 2, x: Number.NaN}).transformOrigin).toBe('50.000% 50.000%');
  });
});

describe('切り出しのスキーマ', () => {
  it('既定は「そのまま・中央」', () => {
    expect(CropSchema.parse({})).toEqual(DEFAULT_CROP);
    expect(isDefaultCrop(DEFAULT_CROP)).toBe(true);
    expect(isDefaultCrop(undefined)).toBe(true);
    expect(isDefaultCrop({zoom: 1.5, x: 0.5, y: 0.5})).toBe(false);
  });

  it('範囲の外は受け付けない（壊れた cuts.json を書かせない）', () => {
    expect(CropSchema.safeParse({zoom: 0.5}).success).toBe(false);
    expect(CropSchema.safeParse({zoom: 4}).success).toBe(false);
    expect(CropSchema.safeParse({x: 1.2}).success).toBe(false);
  });

  it('カットに載せられる。無くても従来どおり通る', () => {
    const base = {src: 'uploads/01.mp4', inSec: 0, outSec: 2};
    expect(CutSchema.parse(base).crop).toBeUndefined();
    expect(CutSchema.parse({...base, crop: {zoom: 2, x: 0.3, y: 0.4}}).crop).toEqual({zoom: 2, x: 0.3, y: 0.4});
  });
});

describe('切り出しの引き継ぎ（素材 → 構成）', () => {
  it('構成プランは、素材に付けた切り出しをカットへ持っていく', async () => {
    const {planCuts} = await import('@shared/plan');
    const {makeBrief, makeCatalog, richClips} = await import('./helpers');
    const clips = richClips();
    // 「11（紅茶を注ぐ）」だけ寄せてある状態にする
    const zoomed = clips.map((c) => (c.id === '11' ? {...c, crop: {zoom: 1.8, x: 0.4, y: 0.3}} : c));
    const r = planCuts({
      catalog: makeCatalog('reunion', zoomed),
      brief: makeBrief({persona: 'standard', format: 'F7', hook: {clipId: '11', text: 'テスト'}}),
      options: {allowReuse: true},
    });
    const fromZoomed = r.cuts.cuts.filter((c) => c.src.includes('tea-pour'));
    expect(fromZoomed.length).toBeGreaterThan(0);
    for (const c of fromZoomed) expect(c.crop).toEqual({zoom: 1.8, x: 0.4, y: 0.3});
    // 触っていない素材には付けない（cuts.json を余計な値で汚さない）
    for (const c of r.cuts.cuts.filter((x) => !x.src.includes('tea-pour'))) expect(c.crop).toBeUndefined();
  });

  it('台本からの組み立てでも引き継ぐ', async () => {
    const {scriptPlanToCuts} = await import('@shared/script');
    const {makeCatalog, richClips} = await import('./helpers');
    const clips = richClips().map((c) => (c.id === '16' ? {...c, crop: {zoom: 2.2, x: 0.6, y: 0.2}} : c));
    const catalog = makeCatalog('reunion', clips);
    const cuts = scriptPlanToCuts(
      {
        cuts: [
          {clipId: '16', inSec: 0, outSec: 2, telop: '黄身', section: '0:00'},
          {clipId: '17', inSec: 0, outSec: 2, telop: 'スコーン', section: '0:02'},
        ],
        narration: [],
        unmatched: [],
        notes: '',
      },
      {catalog, theme: 'pop', specId: 'F0', briefHash: 'x', catalogHash: 'y'},
    );
    expect(cuts.cuts[0].crop).toEqual({zoom: 2.2, x: 0.6, y: 0.2});
    expect(cuts.cuts[1].crop).toBeUndefined();
  });
});
