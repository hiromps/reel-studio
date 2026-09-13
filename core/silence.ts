// 無音検出 → 発話区間。会話クリップの IN/OUT を文の切れ目に置くため（edit-pipeline.md「切れ目の見つけ方」）。
import {exec} from './exec';
import type {SpeechRange} from '../shared/schema/catalog';

export const detectSpeech = async (file: string, durationSec: number, opt: {noiseDb?: number; minSilenceSec?: number} = {}): Promise<SpeechRange[]> => {
  const noise = opt.noiseDb ?? -30;
  const minSil = opt.minSilenceSec ?? 0.4;
  const r = await exec('ffmpeg', ['-nostdin', '-i', file, '-af', `silencedetect=noise=${noise}dB:d=${minSil}`, '-f', 'null', '-']);
  const out = r.stderr + r.stdout;
  const silences: {start: number; end: number}[] = [];
  let cur: number | null = null;
  for (const line of out.split(/\r?\n/)) {
    const s = /silence_start:\s*([0-9.]+)/.exec(line);
    const e = /silence_end:\s*([0-9.]+)/.exec(line);
    if (s) cur = parseFloat(s[1]);
    if (e && cur !== null) {
      silences.push({start: cur, end: parseFloat(e[1])});
      cur = null;
    }
  }
  if (cur !== null) silences.push({start: cur, end: durationSec});
  // 無音の補集合 = 発話
  const speech: SpeechRange[] = [];
  let t = 0;
  for (const s of silences.sort((a, b) => a.start - b.start)) {
    if (s.start - t >= 0.3) speech.push({startSec: Math.round(t * 1000) / 1000, endSec: Math.round(s.start * 1000) / 1000});
    t = Math.max(t, s.end);
  }
  if (durationSec - t >= 0.3) speech.push({startSec: Math.round(t * 1000) / 1000, endSec: Math.round(durationSec * 1000) / 1000});
  return speech;
};
