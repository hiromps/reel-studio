import {describe, expect, it} from 'vitest';
import {applyZoomSettings, viralZoom, ZoomConfigSchema, ZoomSchema, zoomEase, zoomScale, zoomStyle, zoomResolutionWarning} from '../shared/zoom';
import {CutSchema, ReelDataSchema} from '../shared/schema/cuts';
import {cutFrames} from '../shared/timeline';
import {validateCuts} from '../shared/validate';
import {makeCatalog, makeClip} from './helpers';

describe('キーフレームズーム', () => {
  it.each(['in_out', 'out', 'linear'] as const)('%s の開始・終了、push/pull と全フレームの下限', (ease) => {
    for (const mode of ['push', 'pull'] as const) {
      const zoom = ZoomSchema.parse({mode, ease});
      expect(zoomEase(0, ease)).toBe(0);
      expect(zoomEase(1, ease)).toBe(1);
      expect(zoomScale(zoom, 0, 23)).toBe(zoom.scale_start);
      expect(zoomScale(zoom, 22, 23)).toBe(zoom.scale_end);
      const values = Array.from({length: 23}, (_, i) => zoomScale(zoom, i, 23));
      expect(values.every((v) => v >= 1)).toBe(true);
      for (let i = 1; i < values.length; i++) expect(mode === 'push' ? values[i] >= values[i - 1] : values[i] <= values[i - 1]).toBe(true);
    }
  });
  it('in_outは中盤の変化量が最大で、両端は対称に緩む', () => {
    const delta = Array.from({length: 22}, (_, i) => zoomEase((i + 1) / 22) - zoomEase(i / 22));
    expect(delta[10]).toBeCloseTo(Math.max(...delta), 12);
    expect(delta[11]).toBeCloseTo(Math.max(...delta), 12);
    expect(delta[0]).toBeLessThan(delta[10]);
    expect(delta[21]).toBeCloseTo(delta[0], 12);
  });
  it('23固定ではなく尺・fps・倍速から算出し、1フレームとpremountも安全', () => {
    const c = {src: 'x.mp4', inSec: 2, outSec: 2 + 23 / 30};
    expect(cutFrames(c, 30)).toBe(23);
    expect(cutFrames({...c, playbackRate: 2}, 60)).toBe(23);
    const zoom = viralZoom(0);
    expect(zoomScale(zoom, 0, 1)).toBe(1);
    expect(zoomScale(zoom, -30, 23)).toBe(1);
    expect(zoomScale(zoom, 100, 23)).toBe(1.45);
    expect(zoomScale(zoom, 44, 45)).toBe(1.45);
  });
  it('アンカーは切り出し式と一致し、映像全体に均一な倍率を適用する', () => {
    const zoom = ZoomSchema.parse({mode: 'push', scale_end: 1.45, anchor_x: 0.7, anchor_y: 0.3});
    const st = zoomStyle(zoom, 22, 23);
    expect(st.transform).toBe('scale(1.45)');
    expect(st.transformOrigin).toBe('70% 30%');
    for (const [size, anchor] of [[1080, 0.7], [1920, 0.3]]) {
      const offset = anchor * (size - size / 1.45);
      expect((anchor * size - offset) * 1.45).toBeCloseTo(anchor * size, 10);
    }
  });
  it('none/省略は倍率1、既存cutsに余分な設定を足さない', () => {
    expect(zoomScale(ZoomSchema.parse({mode: 'none', scale_start: 1.5, scale_end: 1.4}), 12, 23)).toBe(1);
    expect(zoomStyle(undefined, 12, 23).transform).toBeUndefined();
    expect(CutSchema.parse({src: 'x', inSec: 0, outSec: 1}).zoom).toBeUndefined();
  });
  it('倍率、アンカー、方向、有限値を検証し、ease/anchorは既定値を補う', () => {
    expect(ZoomSchema.parse({mode: 'push'})).toEqual({mode: 'push', scale_start: 1, scale_end: 1.18, ease: 'in_out', anchor_x: 0.5, anchor_y: 0.5});
    for (const v of [{scale_start: 0.9}, {scale_end: 1.51}, {anchor_x: -0.1}, {anchor_y: 1.01}, {scale_end: Infinity}, {mode: 'push', scale_start: 1.3, scale_end: 1}, {mode: 'pull', scale_start: 1, scale_end: 1.3}]) {
      expect(ZoomSchema.safeParse(v).success).toBe(false);
    }
  });
});

describe('viral_zoomと個別設定', () => {
  it('先頭1.45倍、約75%push、同方向は3カット以下で再現可能', () => {
    const zooms = Array.from({length: 100}, (_, i) => viralZoom(i));
    expect(zooms[0].scale_end).toBe(1.45);
    expect(zooms.filter((z) => z.mode === 'push')).toHaveLength(75);
    for (let i = 0; i < zooms.length; i++) {
      const z = zooms[i];
      expect(z).toEqual(viralZoom(i));
      expect(z.ease).toBe('in_out'); expect(z.anchor_x).toBe(0.5); expect(z.anchor_y).toBe(0.45);
      if (i && z.mode === 'push') {expect(z.scale_end).toBeGreaterThanOrEqual(1.15); expect(z.scale_end).toBeLessThanOrEqual(1.2);}
      if (i > 2) expect(new Set(zooms.slice(i - 3, i + 1).map((v) => v.mode)).size).toBe(2);
    }
  });
  it('IDまたは番号の個別設定が優先。元のテロップ・音声設定・cutsは変えない', () => {
    const original = ReelDataSchema.parse({fps: 30, cuts: [{id: 'c01', src: 'a', inSec: 1, outSec: 2, playbackRate: 2, main: {text: 'テスト'}}, {src: 'b', inSec: 0, outSec: 1}]});
    const before = JSON.stringify(original);
    const result = applyZoomSettings(original, 'viral_zoom', ZoomConfigSchema.parse({cuts: {c01: {mode: 'none'}, '2': {mode: 'pull', anchor_x: 0.7}}}));
    expect(result.cuts[0].zoom?.mode).toBe('none'); expect(result.cuts[1].zoom?.mode).toBe('pull');
    expect(result.cuts[0].main).toEqual(original.cuts[0].main); expect(result.cuts[0].playbackRate).toBe(2);
    expect(JSON.stringify(original)).toBe(before);
    expect(() => applyZoomSettings(original, 'unknown')).toThrow();
    expect(() => applyZoomSettings(original, undefined, ZoomConfigSchema.parse({cuts: {typo: {mode: 'push'}}}))).toThrow('typo');
  });
  it('回転・静的cropを考慮して素材解像度を警告し、noneは警告しない', () => {
    const z = viralZoom(0);
    expect(zoomResolutionWarning(z, {width: 1080, height: 1920})).toContain('1566×2784');
    expect(zoomResolutionWarning(z, {width: 3840, height: 2160, rotation: 90})).toBeUndefined();
    expect(zoomResolutionWarning(z, {width: 2160, height: 3840}, 2)).toBeDefined();
    expect(zoomResolutionWarning({...z, mode: 'none'}, {width: 100, height: 100})).toBeUndefined();
    expect(zoomResolutionWarning(ZoomSchema.parse({mode: 'push'}), {width: 360, height: 640}, 1, {width: 270, height: 480})).toBeUndefined();
    const clip = makeClip({id: '01', slug: 'dish', dur: 2, fps: 30, kind: 'detail'});
    const result = validateCuts({fps: 30, cuts: [{src: clip.src, inSec: 0, outSec: 23 / 30, zoom: z}]}, {catalog: makeCatalog('zoom', [clip], 30)});
    expect(result.warnings.some((w) => w.code === 'ZOOM_RESOLUTION' && w.cutIndex === 0)).toBe(true);
  });
});
