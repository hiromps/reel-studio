import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {loadEmotionTags} from './emotion-tags';
import {fishEmotionTag} from '../shared/emotion-tags';
import {fishEnv, synthOne} from './tts';
import {writeJsonAtomic} from './json-io';

export type EmotionSample = {id: string; label: string; color: string; file: string; duration: number; cached: boolean};
export const generateEmotionAudition = async (dir: string, opt: {voice: string; text?: string; speed?: number; signal?: AbortSignal; onProgress?: (done: number, total: number, phase: string) => void}) => {
  const config = loadEmotionTags();
  const text = (opt.text ?? config.audition.text).trim();
  const speed = opt.speed ?? config.audition.speed;
  if (!text || /[\[\]\r\n]/.test(text) || [...text].length > config.audition.max_chars) throw new Error(`試聴文はタグ・改行を含めず ${config.audition.max_chars} 文字以内で入力してください`);
  if (!opt.voice || speed < 0.5 || speed > 2 || !Number.isFinite(speed)) throw new Error('試聴のボイス・話速を確認してください');
  const env = fishEnv();
  if (!env || !['s2-pro', 's2.1-pro', 's2.1-pro-free'].includes(env.modelId)) throw new Error('Fish Audio の S2 系モデルと API キーを設定してください');
  const folder = path.join(dir, 'narration', 'emotion-tests');
  fs.mkdirSync(folder, {recursive: true});
  const samples: EmotionSample[] = [];
  for (const [index, tag] of config.tags.entries()) {
    opt.signal?.throwIfAborted();
    opt.onProgress?.(index, config.tags.length, tag.label);
    const marker = fishEmotionTag(tag.id, config);
    const speech = (marker ? marker + ' ' : '') + text;
    const hash = createHash('sha256').update(JSON.stringify({speech, voice: opt.voice, speed, model: env.modelId})).digest('hex');
    const file = `${hash}.wav`;
    const target = path.join(folder, file);
    const meta = target + '.json';
    let duration = 0;
    try {
      const st = fs.statSync(target);
      const old = JSON.parse(fs.readFileSync(meta, 'utf8'));
      if (st.isFile() && st.size === old.size && st.mtimeMs === old.mtimeMs && old.duration > 0) duration = old.duration;
    } catch { /* No reusable local sample yet. */ }
    const cached = duration > 0;
    if (!cached) {
      duration = await synthOne(speech, {voice: opt.voice, speed, out: target, signal: opt.signal});
      const st = fs.statSync(target);
      writeJsonAtomic(meta, {duration, size: st.size, mtimeMs: st.mtimeMs});
    }
    samples.push({id: tag.id, label: tag.label, color: tag.color, file: `narration/emotion-tests/${file}`, duration, cached});
  }
  opt.onProgress?.(samples.length, samples.length, '聞き比べ用の音声をローカルに保存しました');
  return {text, speed, voice: opt.voice, model: env.modelId, samples};
};
