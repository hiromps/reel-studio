import {z} from 'zod';
import {stableHash} from '../shared/hash';
import {emotionPrompt} from '../shared/emotion-tags';
import {loadEmotionTags} from './emotion-tags';
import {readReelCuts, writeReelCuts} from './reel-cuts';
import {readBrief} from './project';
import {loadCatalog} from './catalog';
import {getPersona} from '../shared/personas';
import {runAgent} from './agent';
import {studioConfig} from '../studio.config';

/** One structured response per existing cut. Never changes timing or footage. */
export const draftReelSpeech = async (dir: string, opt: {request?: string; model?: string; onLine?: (line: string) => void; signal?: AbortSignal}) => {
  const cuts = readReelCuts(dir);
  if (!cuts) throw new Error('共通カットJSONがありません');
  const brief = readBrief(dir);
  if (!brief) throw new Error('Brief を先に保存してください');
  const catalog = loadCatalog(dir);
  const persona = getPersona(brief.persona);
  const emotions = loadEmotionTags();
  const ids = emotions.tags.map(t => t.id);
  const schema = {type: 'object', additionalProperties: false, required: ['cuts', 'notes'], properties: {
    cuts: {type: 'array', minItems: cuts.length, maxItems: cuts.length, items: {type: 'object', additionalProperties: false,
      required: ['id', 'line', 'emotion_tag'], properties: {id: {type: 'string', enum: cuts.map(c => c.id)}, line: {type: 'string'}, emotion_tag: {type: 'string', enum: ids}}}},
    notes: {type: 'string'},
  }};
  const prompt = [
    '@oc.eat のグルメ動画。既存のカット順・尺を保ち、各カットのナレーション line と emotion_tag を作る。',
    opt.request ? `依頼（最優先）: ${opt.request}` : 'テロップに沿って読み上げる文を作る。',
    `店舗: ${JSON.stringify(brief.shop)}。人格: ${persona.label}。文体: ${persona.tone}。`,
    ...persona.narrationRules,
    `発話可能な秒数は duration - pause_after。タグを除いた文字数が ${persona.narration.charsPerSecMeasured} 文字/秒を目安に収まるようにする。`,
    '本文に角括弧タグ・役割名・秒数・改行・金額を含めない。料理名・数字を推測で作らない。声なしのカットは空文字。',
    `確認済み事実: ${JSON.stringify({facts: brief.facts, catalogFacts: catalog?.facts ?? []})}`,
    emotionPrompt(emotions),
    '全カットをID・順序そのままで返す。各カットの slot、テロップ、素材を見て強弱の流れを付ける。',
    JSON.stringify(cuts.map(c => ({id: c.id, slot: c.slot, duration: c.duration, pause_after: c.pause_after, line: c.line, telop: c.editor?.main?.text, material: catalog?.clips.find(cl => cl.src === c.clip_path)?.tags?.description}))),
  ].join('\n');
  const run = await runAgent<unknown>({cwd: dir, prompt, schema, model: opt.model ?? studioConfig.agent.model,
    styleRules: true, timeoutMs: studioConfig.agent.timeoutMs, onLine: opt.onLine, signal: opt.signal});
  const parsed = z.object({cuts: z.array(z.object({id: z.string(), line: z.string().refine(v => !/[\[\]\r\n]/.test(v)),
    emotion_tag: z.enum(ids as [string, ...string[]])}).strict()), notes: z.string()}).strict().parse(run.data);
  if (parsed.cuts.length !== cuts.length || parsed.cuts.some((c, i) => c.id !== cuts[i].id)) throw new Error('AI がカットIDまたは順序を変更したため保存しません');
  if (stableHash(readReelCuts(dir)) !== stableHash(cuts)) throw new Error('生成中にカットが編集されたため保存しません。再実行してください');
  const updated = writeReelCuts(dir, cuts.map((c, i) => ({...c, line: parsed.cuts[i].line,
    emotion_tag: parsed.cuts[i].emotion_tag === 'none' ? null : parsed.cuts[i].emotion_tag,
    emphasis: c.emphasis.filter(w => parsed.cuts[i].line.includes(w))})));
  return {cuts: updated, costUsd: run.costUsd, notes: parsed.notes};
};
