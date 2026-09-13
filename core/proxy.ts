// H.264 プロキシ。HEVC（GOP 境界で破損フレーム）と 4K（レンダー数十分・一時領域不足）を 1080x1920 H.264 に変換する。
// Player（ブラウザ再生）とレンダーの両方で同じファイルを使う。
import fs from 'node:fs';
import path from 'node:path';
import {execOk} from './exec';
import {effectiveSize} from './ffprobe';
import type {Probe} from '../shared/schema/catalog';

export const needsProxy = (p: Probe): {needed: boolean; reason?: string} => {
  const codec = p.codec.toLowerCase();
  if (codec === 'hevc' || codec === 'h265') return {needed: true, reason: 'HEVC'};
  const {width, height} = effectiveSize(p);
  if (Math.max(width, height) > 1920) return {needed: true, reason: `${width}x${height}`};
  if (!['h264'].includes(codec)) return {needed: true, reason: codec};
  return {needed: false};
};

/**
 * 実効サイズが横長なら中央 9:16 クロップ→1080x1920、縦長なら 1080x1920 へスケール。
 * fps は素材準拠（-r を付けない）。-g 30 で GOP を短くし OffthreadVideo のシーク破損を避ける。
 */
export const makeProxy = async (input: string, output: string, probe: Probe, opt: {preset?: string; crf?: number; onLine?: (l: string) => void} = {}): Promise<void> => {
  fs.mkdirSync(path.dirname(output), {recursive: true});
  const {width, height} = effectiveSize(probe);
  const vf = width > height ? 'crop=ih*9/16:ih,scale=1080:1920:flags=lanczos' : 'scale=1080:1920:flags=lanczos';
  const args = ['-y', '-nostdin', '-v', 'error', '-stats', '-i', input, '-vf', vf, '-c:v', 'libx264', '-preset', opt.preset ?? 'medium', '-crf', String(opt.crf ?? 16), '-g', '30', '-keyint_min', '30', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
  if (probe.hasAudio) args.push('-c:a', 'aac', '-b:a', '192k');
  else args.push('-an');
  args.push(output);
  await execOk('ffmpeg', args, {onLine: opt.onLine ? (l) => opt.onLine!(l) : undefined});
};

/** プレビュー用の軽量プロキシ（540x960）。URL は変えずサーバー側で差し替える */
export const makePreviewProxy = async (input: string, output: string, probe: Probe): Promise<void> => {
  fs.mkdirSync(path.dirname(output), {recursive: true});
  const {width, height} = effectiveSize(probe);
  const vf = width > height ? 'crop=ih*9/16:ih,scale=540:960' : 'scale=540:960';
  const args = ['-y', '-nostdin', '-v', 'error', '-i', input, '-vf', vf, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-g', '30', '-pix_fmt', 'yuv420p', '-movflags', '+faststart'];
  if (probe.hasAudio) args.push('-c:a', 'aac', '-b:a', '96k');
  else args.push('-an');
  args.push(output);
  await execOk('ffmpeg', args);
};
