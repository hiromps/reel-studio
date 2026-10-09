// 保存済み台本を、確定したカット構成に合わせて文言だけ生成する。
import {z} from 'zod';
import {ReelDataSchema} from '../shared/schema/cuts';
import {NarrationSchema} from '../shared/schema/narration';
import {cutRanges, totalSec} from '../shared/timeline';
import {countChars, normalizeEllipsis} from '../shared/telop-text';
import {videoStylePrompt} from '../shared/video-style';
import {getPersona} from '../shared/personas';
import {FORMAT_SPECS} from '../shared/format-specs';
import {readBrief, readCuts, readNarration, writeCuts, writeNarration} from './project';
import {readScript, lockedScriptTextConfirmation} from './script';
import {loadCatalog} from './catalog';
import {runAgent} from './agent';
import {agentProgress} from './ai';
import {studioConfig} from '../studio.config';

const TextPlan = z.object({
  telops: z.array(z.object({cutId: z.string(), text: z.string().max(1000), orientation: z.enum(['vertical', 'horizontal']).optional()})),
  narration: z.array(z.object({at: z.number().finite().min(0), text: z.string().trim().min(1).max(3000)})).min(1),
  notes: z.string().max(3000),
});
const TEXT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['telops', 'narration', 'notes'],
  properties: {
    telops: {type: 'array', items: {type: 'object', additionalProperties: false, required: ['cutId', 'text'], properties: {cutId: {type: 'string'}, text: {type: 'string'}, orientation: {type: 'string', enum: ['vertical', 'horizontal']}}}},
    narration: {type: 'array', minItems: 1, items: {type: 'object', additionalProperties: false, required: ['at', 'text'], properties: {at: {type: 'number', minimum: 0}, text: {type: 'string'}}}},
    notes: {type: 'string'},
  },
};

export async function aiScriptText(dir: string, opt: {
  confirmed: boolean; fingerprint: string; model?: string;
  onLine?: (line: string) => void; onProgress?: (done: number, total: number, phase: string) => void; signal?: AbortSignal;
}) {
  if (opt.confirmed !== true || !opt.fingerprint) throw new Error('今の並びでテロップとナレーション原稿を生成するか、画面で確認してください');
  const checkConfirmation = () => {
    const current = lockedScriptTextConfirmation(dir);
    if (!current || current.fingerprint !== opt.fingerprint) throw new Error('確認後に台本・カット・ナレーション、またはロック設定が変わっています。最新の内容で続行を確認してください');
  };
  checkConfirmation();
  const script = readScript(dir)!;
  const cuts = readCuts(dir);
  const oldNarration = readNarration(dir);
  const brief = readBrief(dir);
  const catalog = loadCatalog(dir);
  if (!brief || !catalog) throw new Error('Brief と素材のカタログが必要です');
  const persona = getPersona(brief.persona);
  const spec = FORMAT_SPECS[brief.format ?? persona.defaultFormat];
  const duration = totalSec(cuts);
  const log = opt.onLine ?? (() => {});
  const aliases = new Map((cuts.meta?.aliases ?? []).map(a => [a.to, a.from]));
  const targets = new Map<string, number>();
  const ranges = cutRanges(cuts);
  const rows = cuts.cuts.map((c, i) => {
    const key = 'k' + String(i + 1).padStart(4, '0');
    const clip = catalog.clips.find(cl => cl.src === (aliases.get(c.src) ?? c.src) || cl.proxyOf === (aliases.get(c.src) ?? c.src));
    const {startSec: from, endSec: to} = ranges[i];
    if (!c.subs?.length) targets.set(key, i);
    return JSON.stringify({cutId: key, fromSec: from, toSec: to, what: clip?.tags?.description ?? clip?.slug ?? c.src, telop: c.main?.text ?? '', orientation: c.main?.orientation ?? 'vertical', subtitles: c.subs?.map(s => s.text), writeTelop: !c.subs?.length});
  });
  const facts = [...catalog.facts, ...Object.entries(brief.facts).map(([k, v]) => k + ': ' + v)];
  const prompt = [
    '並び順を確定したショート動画に、保存済みの台本を参考にテロップとナレーション原稿を生成する。ユーザーは文言の更新を承認した。',
    '【最優先】現在のカットの順番・本数・素材・IN/OUT・倍速・画角を変えない。台本のカット割りと秒数より、現在の映像と時間軸を優先する。構成案やファイルの書き換えは返さず文言だけ返す。',
    '店: ' + brief.shop.name + '／エリア: ' + brief.shop.area + '／ジャンル: ' + brief.shop.genre,
    videoStylePrompt(brief.videoStyle),
    '現在の映像（先頭からの順番。cutId はこの一覧のキーをそのまま使う）:', ...rows,
    '保存済み台本（表現・フック・言葉選びの参考。存在しない映像や未確認の料理・人物・数字は書かない）:', script,
    '裏取り済みの事実:', ...facts,
    'テロップ: writeTelop=true の全カットを、一覧の cutId で1回ずつ返す。無言のカットは text を空にする。会話字幕 writeTelop=false は変更しない。隣接するカットで同じ文言を出して読みやすいまとまりにしてよい。',
    '文言はその位置の映像に合わせる。台本の話題を無理に同じ秒に押し込まない。参考の店名・料理・人物を流用しない。',
    'テロップは上限 ' + spec.telop.maxChars + ' 文字、表示尺に収める。句点・半角括弧・絵文字・金額・保存やいいねの誘導は使わない。「・・・」は全角の中黒3文字。',
    'ナレーションは生成したテロップと映像に沿った話し言葉で、人格の文体: ' + persona.tone,
    ...persona.narrationRules,
    'ナレーションの at は現在の動画の先頭からの秒数。話題に対応する映像の区間に置き、重ねず、全体 ' + duration.toFixed(3) + ' 秒以内に読み終える。実測話速 ' + persona.narration.charsPerSecMeasured + ' 文字/秒。固有名詞と読みが割れる漢字はひらがなに開く。',
    'voice や音量などの設定、効果音、フォントや装飾は変えない。ファイルは Read で読むだけ。',
  ].filter(Boolean).join('\n');
  log('並び順を保持して、保存済み台本からテロップとナレーション原稿を生成します（' + cuts.cuts.length + ' カット）');
  const run = await runAgent({cwd: dir, prompt, schema: TEXT_SCHEMA, styleRules: true, model: opt.model ?? studioConfig.agent.model, timeoutMs: studioConfig.agent.timeoutMs, onLine: log, onEvent: agentProgress({log, onProgress: opt.onProgress, labels: {thinking: '今の映像に合わせて文言を考えています', writing: 'テロップと原稿を書き出しています'}}).onEvent, signal: opt.signal});
  const plan = TextPlan.parse(run.data);
  const byKey = new Map(plan.telops.map(t => [t.cutId, t]));
  if (byKey.size !== plan.telops.length || byKey.size !== targets.size || [...byKey.keys()].some(k => !targets.has(k))) throw new Error('テロップのカット指定に重複・不足・不明なキーがあります。構成と原稿は書き換えていません');
  if (plan.narration.some(n => n.at >= duration)) throw new Error('ナレーションの開始位置が動画尺の外にあります。構成と原稿は書き換えていません');
  const changedIds = new Set<string>();
  const nextCuts = ReelDataSchema.parse({...cuts, cuts: cuts.cuts.map((c, i) => {
    const t = byKey.get('k' + String(i + 1).padStart(4, '0'));
    if (!t) return c;
    if (c.id) changedIds.add(c.id);
    const text = normalizeEllipsis(t.text.trim());
    const main = text ? {...c.main, text} : undefined;
    if (main && t.orientation === 'horizontal') main.orientation = 'horizontal';
    else if (main && t.orientation === 'vertical') delete main.orientation;
    return {...c, main};
  })});
  if (nextCuts.meta?.slots) nextCuts.meta = {...nextCuts.meta, slots: nextCuts.meta.slots.map(s => changedIds.has(s.cutId) ? {...s, textStatus: 'draft'} : s)};
  const blocks = [...plan.narration].sort((a, b) => a.at - b.at);
  const narration = NarrationSchema.parse({
    ...(oldNarration ?? {voice: persona.narration.voiceId, voiceTitle: persona.narration.voiceTitle, speed: persona.narration.speed, latency: 'normal'}),
    videoSec: Math.round(duration * 1000) / 1000, note: plan.notes,
    segments: blocks.map((b, i) => ({id: 'n' + String(i + 1).padStart(3, '0'), at: b.at, text: b.text, needsTts: true})),
  });
  const findings: string[] = [];
  const cps = persona.narration.charsPerSecMeasured || persona.narration.charsPerSec;
  blocks.forEach((b, i) => {
    const end = b.at + countChars(b.text) / cps;
    if (end > (blocks[i + 1]?.at ?? duration) + 0.05) findings.push('ナレーション ' + (i + 1) + ' の推定読み終わりが次のブロックまたは動画尺を超えています');
  });
  if (opt.signal?.aborted) throw new Error('生成を中止しました');
  checkConfirmation(); // 待っている間に手動編集・台本更新があれば、古い確認で反映しない。
  writeCuts(dir, nextCuts, {preserveOrder: true});
  writeNarration(dir, narration);
  log('並び順を保持してテロップとナレーション原稿を保存しました。音声は「音声を生成」で作り直してください');
  for (const finding of findings) log('  ! ' + finding);
  return {written: true, cuts: cuts.cuts.length, telops: targets.size, narration: blocks.length, totalSec: duration, findings, costUsd: run.costUsd};
}
