// シーンチェンジ検出（カット済み単一ファイルの境界特定）。edit-pipeline.md Step 1.5 の select='gt(scene,0.25)'。
import {exec} from './exec';

export const detectScenes = async (file: string, threshold = 0.25): Promise<number[]> => {
  const r = await exec('ffmpeg', ['-nostdin', '-i', file, '-vf', `select='gt(scene,${threshold})',showinfo`, '-f', 'null', '-']);
  const out = r.stderr + r.stdout;
  const times: number[] = [];
  for (const m of out.matchAll(/pts_time:([0-9.]+)/g)) times.push(Math.round(parseFloat(m[1]) * 1000) / 1000);
  return [...new Set(times)].sort((a, b) => a - b);
};
