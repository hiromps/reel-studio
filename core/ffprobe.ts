// ffprobe ラッパ。映像ストリームの codec / 解像度 / 回転 / fps / 尺 / 音声有無を取る。
import {execOk} from './exec';
import type {Probe} from '../shared/schema/catalog';

type FfprobeStream = {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  duration?: string;
  pix_fmt?: string;
  tags?: Record<string, string>;
  side_data_list?: {rotation?: number}[];
  nb_read_frames?: string;
  nb_frames?: string;
};
type FfprobeOut = {streams?: FfprobeStream[]; format?: {duration?: string}};

const parseRate = (s: string | undefined): number => {
  if (!s) return 0;
  const [a, b] = s.split('/').map(Number);
  if (!b) return a || 0;
  return a / b;
};

/** 60000/1001 → 60、30000/1001 → 30 のように、cuts.json の fps に使う整数へ丸める */
export const nominalFps = (fps: number): number => {
  const candidates = [24, 25, 30, 50, 60, 120];
  let best = candidates[0];
  for (const c of candidates) if (Math.abs(c - fps) < Math.abs(best - fps)) best = c;
  return Math.abs(best - fps) <= 1 ? best : Math.round(fps);
};

export const ffprobe = async (file: string): Promise<Probe> => {
  const r = await execOk('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', file]);
  const json = JSON.parse(r.stdout) as FfprobeOut;
  const v = json.streams?.find((s) => s.codec_type === 'video');
  if (!v) throw new Error(`映像ストリームが無い: ${file}`);
  const a = json.streams?.find((s) => s.codec_type === 'audio');
  let rotation = 0;
  const sd = v.side_data_list?.find((d) => typeof d.rotation === 'number');
  if (sd?.rotation !== undefined) rotation = sd.rotation;
  else if (v.tags?.rotate) rotation = Number(v.tags.rotate) || 0;
  // iPhone の可変フレームレート素材は avg_frame_rate が 56 等になるため、公称値 r_frame_rate（60000/1001）を優先する
  const fpsRaw = parseRate(v.r_frame_rate) || parseRate(v.avg_frame_rate);
  const durationSec = Number(v.duration) || Number(json.format?.duration) || 0;
  return {
    codec: v.codec_name ?? '',
    width: v.width ?? 0,
    height: v.height ?? 0,
    rotation,
    fps: Math.round(fpsRaw * 1000) / 1000,
    durationSec: Math.round(durationSec * 1000) / 1000,
    hasAudio: !!a,
    pixFmt: v.pix_fmt ?? '',
  };
};

/** 回転メタデータを考慮した実効サイズ */
export const effectiveSize = (p: Probe): {width: number; height: number} => {
  const rot = Math.abs(p.rotation) % 180;
  return rot === 90 ? {width: p.height, height: p.width} : {width: p.width, height: p.height};
};

/** 出力 mp4 のフレーム数（count_frames）。レンダー後検証用 */
export const countFrames = async (file: string): Promise<{frames: number; durationSec: number}> => {
  const r = await execOk('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames,duration', '-of', 'json', file]);
  const json = JSON.parse(r.stdout) as FfprobeOut;
  const v = json.streams?.[0];
  return {frames: Number(v?.nb_read_frames ?? v?.nb_frames ?? 0), durationSec: Number(v?.duration ?? 0)};
};
