// ナレーション合成（mix）：out/final.mp4 に narration/*.wav と効果音を混ぜて out/final_narration.mp4 を作る。
// 実体は同梱の scripts/mix-narration.cjs（speechnorm＋リミッターで -14 LUFS。映像は -c:v copy）。
import fs from 'node:fs';
import path from 'node:path';
import {exec} from './exec';
import {readNarration} from './project';
import {studioConfig} from '../studio.config';
import type {Narration} from '../shared/schema/narration';

export type MixOptions = {
  /** 案件相対。既定 out/final.mp4 */
  input?: string;
  /** 案件相対。既定 out/final_narration.mp4 */
  output?: string;
  onLine?: (line: string) => void;
  signal?: AbortSignal;
};

export const mixScriptPath = () => studioConfig.mixScript;

/** 効果音の探索起点。mix-narration.cjs の SFX_ROOT（spec.sfxDir ?? REEL_SFX_DIR）と同じ決め方 */
const sfxRootOf = (narration: Narration): string => (narration as {sfxDir?: string}).sfxDir || studioConfig.sfxDir || '';

/**
 * mix が使う素材（ナレーション wav・効果音ファイル）のうち、足りないものを日本語で返す。
 * narration.json をそのまま混ぜる mixNarration だけでなく、トライアル・二次活用版が
 * その場で組み立てた narration にも使えるよう、ディスクではなくオブジェクトを受け取る。
 * `ignoreWavIds` には「このあと必ず TTS で作る wav」を渡す（フック差し替え・締めの差し替え）。
 */
export const missingMixAssets = (dir: string, narration: Narration, opt: {ignoreWavIds?: string[]} = {}): string[] => {
  const problems: string[] = [];
  const ignore = new Set(opt.ignoreWavIds ?? []);
  const noWav = narration.segments.filter((seg) => !ignore.has(seg.id) && !fs.existsSync(path.join(dir, 'narration', `${seg.id}.wav`))).map((seg) => seg.id);
  if (noWav.length) problems.push(`ナレーション音声が無いブロックがあります: ${noWav.join(', ')} → 「音声を生成」を実行してください`);
  const sfx = narration.sfx ?? [];
  const root = sfxRootOf(narration);
  if (sfx.length && !root) problems.push('効果音の置き場が分かりません（Settings の「フォルダ」で効果音フォルダを設定してください）');
  else {
    const noSfx = [...new Set(sfx.filter((s) => !fs.existsSync(path.resolve(root, s.file))).map((s) => s.file))];
    if (noSfx.length) problems.push(`効果音が見つかりません: ${noSfx.join(', ')} → ${root} に置くか、Render の「効果音」で選び直してください`);
  }
  return problems;
};

/** 足りないものは ffmpeg の生エラーではなく日本語で止める */
export const mixPreconditions = (dir: string, inputRel = 'out/final.mp4'): string | null => {
  const n = readNarration(dir);
  if (!n) return 'narration.json が無い（先に「AI にナレーションを書いてもらう」）';
  if (!fs.existsSync(path.join(dir, inputRel))) return `${inputRel} が無いので合成できません。先に「本番レンダー」を実行してください`;
  const problems = missingMixAssets(dir, n);
  return problems.length ? problems.join('\n') : null;
};

export const mixNarration = async (dir: string, opt: MixOptions = {}): Promise<{outRel: string}> => {
  const inputRel = opt.input ?? 'out/final.mp4';
  const outputRel = opt.output ?? 'out/final_narration.mp4';
  const why = mixPreconditions(dir, inputRel);
  if (why) throw new Error(why);
  const input = path.join(dir, inputRel);
  const output = path.join(dir, outputRel);
  // 効果音の置き場はスクリプトに環境変数で渡す（スクリプト側に既定の場所は無い）
  const r = await exec(process.execPath, [mixScriptPath(), path.join(dir, 'narration.json'), path.join(dir, 'narration'), input, output], {
    cwd: dir,
    env: {...process.env, REEL_SFX_DIR: studioConfig.sfxDir},
    onLine: opt.onLine,
    signal: opt.signal,
  });
  if (r.code !== 0) throw new Error(`mix に失敗 (exit ${r.code})`);
  return {outRel: outputRel.replace(/\\/g, '/')};
};
