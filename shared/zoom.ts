import {z} from 'zod';
import type {ReelData} from './schema/cuts';
import {ZoomSchema, type Zoom} from './schema/zoom';
export {zoomEase, zoomScale, zoomStyle} from '../engine/src/zoom';
export {ZoomSchema, type Zoom} from './schema/zoom';

export const ZoomPresetSchema = z.enum(['viral_zoom']);
export const ZoomConfigSchema = z.object({
  // キーはcut.id、IDなしは1始まりの番号文字列。個別指定がプリセットより優先。
  cuts: z.record(ZoomSchema),
}).strict();
export type ZoomConfig = z.infer<typeof ZoomConfigSchema>;

/** 再レンダーで変化しないばらつき。3 push + 1 pullで同方向は最大3カット。 */
export const viralZoom = (index: number): Zoom => {
  const pull = index % 4 === 3;
  const strength = [1.18, 1.15, 1.2, 1.17, 1.19, 1.16][index % 6];
  return {
    mode: pull ? 'pull' : 'push',
    scale_start: pull ? 1.2 : 1,
    scale_end: pull ? 1 : index === 0 ? 1.45 : strength,
    ease: 'in_out', anchor_x: 0.5, anchor_y: 0.45,
  };
};

export const applyZoomSettings = (data: ReelData, preset?: string, config?: ZoomConfig): ReelData => {
  if (preset !== undefined) ZoomPresetSchema.parse(preset);
  const parsed = config === undefined ? undefined : ZoomConfigSchema.parse(config);
  const keys = new Set(data.cuts.map((c, i) => c.id ?? String(i + 1)));
  for (const key of Object.keys(parsed?.cuts ?? {})) {
    if (!keys.has(key)) throw new Error(`ズーム設定のカットが見つかりません: ${key}`);
  }
  return {...data, cuts: data.cuts.map((cut, i) => {
    const zoom = parsed?.cuts[cut.id ?? String(i + 1)] ?? (preset ? viralZoom(i) : undefined);
    return zoom ? {...cut, zoom} : cut;
  })};
};

export const zoomResolutionWarning = (zoom: Zoom | undefined, source: {width: number; height: number; rotation?: number}, cropZoom = 1, output = {width: 1080, height: 1920}): string | undefined => {
  if (!zoom || zoom.mode === 'none') return;
  const rotate = Math.abs(source.rotation ?? 0) % 180 === 90;
  const width = rotate ? source.height : source.width;
  const height = rotate ? source.width : source.height;
  const max = Math.max(zoom.scale_start, zoom.scale_end) * cropZoom;
  const requiredWidth = Math.ceil(output.width * max);
  const requiredHeight = Math.ceil(output.height * max);
  if (width < requiredWidth || height < requiredHeight) {
    return `素材 ${width}×${height} はズームに必要な ${requiredWidth}×${requiredHeight} 未満です（最大 ${max.toFixed(2)}倍）。拡大で画質が低下する可能性があります`;
  }
};
