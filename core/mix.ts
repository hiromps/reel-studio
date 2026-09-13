// ナレーション合成（mix）：out/final.mp4 に narration/*.wav と効果音を混ぜて out/final_narration.mp4 を作る。
// 実体は hiro スキル同梱の scripts/mix-narration.js（speechnorm＋リミッターで -14 LUFS。映像は -c:v copy）。
import fs from 'node:fs';
import path from 'node:path';
import {exec} from './exec';
import {readNarration} from './project';
import {studioConfig} from '../studio.config';

export type MixOptions = {
  /** 案件相対。既定 out/final.mp4 */
  input?: string;
  /** 案件相対。既定 out/final_narration.mp4 */
  output?: string;
  onLine?: (line: string) => void;
  signal?: AbortSignal;
};

export const mixScriptPath = () => path.join(studioConfig.repoRoot, '.claude', 'skills', 'hiro-daihon', 'scripts', 'mix-narration.js');

/** 足りないものは ffmpeg の生エラーではなく日本語で止める */
export const mixPreconditions = (dir: string, inputRel = 'out/final.mp4'): string | null => {
  const n = readNarration(dir);
  if (!n) return 'narration.json が無い（先に「AI にナレーションを書いてもらう」）';
  if (!fs.existsSync(path.join(dir, inputRel))) return `${inputRel} が無いので合成できません。先に「本番レンダー」を実行してください`;
  const noWav = n.segments.filter((seg) => !fs.existsSync(path.join(dir, 'narration', `${seg.id}.wav`))).map((seg) => seg.id);
  if (noWav.length) return `ナレーション音声が無いブロックがあります: ${noWav.join(', ')} → 「音声を生成」を実行してください`;
  return null;
};

export const mixNarration = async (dir: string, opt: MixOptions = {}): Promise<{outRel: string}> => {
  const inputRel = opt.input ?? 'out/final.mp4';
  const outputRel = opt.output ?? 'out/final_narration.mp4';
  const why = mixPreconditions(dir, inputRel);
  if (why) throw new Error(why);
  const input = path.join(dir, inputRel);
  const output = path.join(dir, outputRel);
  // 効果音の置き場はスクリプト側の既定（repoRoot/sfx）と同じだが、明示して渡す
  const r = await exec(process.execPath, [mixScriptPath(), path.join(dir, 'narration.json'), path.join(dir, 'narration'), input, output], {
    cwd: dir,
    env: {...process.env, REEL_SFX_DIR: studioConfig.sfxDir},
    onLine: opt.onLine,
    signal: opt.signal,
  });
  if (r.code !== 0) throw new Error(`mix に失敗 (exit ${r.code})`);
  return {outRel: outputRel.replace(/\\/g, '/')};
};
