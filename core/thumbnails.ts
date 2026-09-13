// サムネイル生成。1 クリップ = 1 枚のコンタクトシート（fps=1 タイル）＋ 1 秒刻みのストリップ JPG。
// 複数ソースの xstack 合成は対応関係がズレるため使わない（edit-pipeline.md の教訓）。
import fs from 'node:fs';
import path from 'node:path';
import {execOk} from './exec';
import {stripFps} from '../shared/strip';

export type ThumbResult = {sheet: string; strip: string[]};

export {stripFps} from '../shared/strip';

// -pix_fmt yuvj420p: フレームが 0 枚でもエンコーダ初期化が range で失敗しないようにする（上記 -22 対策）
const JPEG_ARGS = ['-pix_fmt', 'yuvj420p', '-q:v', '4'];

/**
 * @param input 素材ファイル（絶対パス）
 * @param outDirSheet コンタクトシートの出力ディレクトリ
 * @param outDirStrip ストリップの出力ディレクトリ（クリップごとのサブフォルダを作る）
 * @param id クリップ id（ファイル名に使う）
 * @param durationSec 素材尺（タイルの列数を決める）
 */
export const makeThumbnails = async (input: string, outDirSheet: string, outDirStrip: string, id: string, durationSec: number): Promise<ThumbResult> => {
  fs.mkdirSync(outDirSheet, {recursive: true});
  const stripDir = path.join(outDirStrip, id);
  fs.mkdirSync(stripDir, {recursive: true});
  for (const f of fs.readdirSync(stripDir)) fs.rmSync(path.join(stripDir, f), {force: true});

  // ストリップ：1 秒ごと（短いクリップは最低 3 枚になるまで細かくする）
  const fps = stripFps(durationSec);
  const jpgs = () => fs.readdirSync(stripDir).filter((f) => f.endsWith('.jpg')).sort();
  await execOk('ffmpeg', ['-y', '-nostdin', '-v', 'error', '-i', input, '-vf', `fps=${fps},scale=180:-2`, ...JPEG_ARGS, path.join(stripDir, '%02d.jpg')]);
  // 1 コマしか無い等で 0 枚になったら先頭フレームだけ落とす
  if (!jpgs().length) await execOk('ffmpeg', ['-y', '-nostdin', '-v', 'error', '-i', input, '-vf', 'scale=180:-2', '-frames:v', '1', ...JPEG_ARGS, path.join(stripDir, '01.jpg')]);
  const strip = jpgs().map((f) => path.posix.join('strips', id, f));

  // コンタクトシート：ストリップと同じ間引きを 6 列でタイル（行数は枚数から）
  const frames = Math.max(1, strip.length || Math.ceil(durationSec * fps));
  const cols = Math.min(6, frames);
  const rows = Math.max(1, Math.ceil(frames / cols));
  const sheet = path.join(outDirSheet, `${id}.jpg`);
  await execOk('ffmpeg', ['-y', '-nostdin', '-v', 'error', '-i', input, '-vf', `fps=${fps},scale=270:-2,tile=${cols}x${rows}`, '-frames:v', '1', ...JPEG_ARGS, sheet]);
  if (!fs.existsSync(sheet)) await execOk('ffmpeg', ['-y', '-nostdin', '-v', 'error', '-i', input, '-vf', 'scale=270:-2', '-frames:v', '1', ...JPEG_ARGS, sheet]);
  return {sheet: path.posix.join('thumbs', `${id}.jpg`), strip};
};

/** レンダー結果の QC タイル（fps=1/3, 4x3）。出力は png なので JPEG_ARGS は付けない */
export const makeQcTile = async (video: string, out: string): Promise<string> => {
  fs.mkdirSync(path.dirname(out), {recursive: true});
  await execOk('ffmpeg', ['-y', '-nostdin', '-v', 'error', '-i', video, '-vf', 'fps=1/3,scale=270:-2,tile=4x3', '-frames:v', '1', '-q:v', '4', out]);
  return out;
};
