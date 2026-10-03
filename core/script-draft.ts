// 依頼文から台本を書く（claude → script.md → 必要なら続けて「台本から組み立てる」）。
// 「こういう動画にしたい」という依頼文を受け取り、手元の素材（AI が映像を言語化したタグ）と案件の事実から、
// 区間・映像・カット割り・テロップ・ナレーションの台本を書く。検算と書き出しは shared/script-draft.ts（純粋・テストあり）
import {studioConfig} from '../studio.config';
import {ensureLooks} from './look';
import {loadCatalog} from './catalog';
import {backupsDir, readBrief} from './project';
import {backupFile} from './json-io';
import {runAgent, type AgentRun} from './agent';
import {agentProgress} from './ai';
import {aiScript, readScript, scriptPath, writeScript, type AiScriptResult} from './script';
import {getPersona} from '../shared/personas';
import {FORMAT_SPECS} from '../shared/format-specs';
import {VARIETY_RULES, shotGroupNote, shotGroups} from '../shared/shot-variety';
import {ScriptDraftSchema, checkScriptDraft, renderScriptDraft, tidyDraft, type ScriptDraft, type ScriptDraftIssue} from '../shared/script-draft';

const DRAFT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sections', 'notes', 'unmatched'],
  properties: {
    sections: {
      type: 'array',
      description: '動画の頭から順に、隙間なく並べた区間',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['fromSec', 'toSec', 'label', 'video', 'cutCount', 'cutSec', 'telop', 'badge', 'orientation', 'narration', 'why'],
        properties: {
          fromSec: {type: 'number', description: '区間の開始秒（前の区間の toSec と同じ。先頭は 0）'},
          toSec: {type: 'number', description: '区間の終了秒'},
          label: {type: 'string', description: '区間名（フック / 証明 / 実食 / 締め …）'},
          video: {type: 'string', description: '映像の指示。手元の素材の id を添えて、どの画をどの順に使うか（例「カニ桶を持ち上げる（id 51）→ 身をつゆに浸ける寄り（id 36）」）'},
          cutCount: {type: 'integer', description: 'この区間のカット数（区間の長さ ÷ 0.75 くらい）'},
          cutSec: {type: 'string', description: '1 カットの尺の目安（0.7〜0.8）'},
          telop: {type: 'string', description: 'この区間に出すテロップの文言だけ。出さない区間は空'},
          badge: {type: 'string', description: '中央上部のラベル（エリア名など）。無ければ空'},
          orientation: {type: 'string', enum: ['vertical', 'horizontal']},
          narration: {type: 'string', description: 'この区間で読み上げる文 1〜2 文（改行なし）。声を入れない区間は空'},
          why: {type: 'string', description: 'この区間の狙いを 1 行'},
        },
      },
    },
    notes: {type: 'string', description: '全体の意図を 1〜3 行'},
    unmatched: {type: 'array', items: {type: 'string'}, description: '台本に入れたいが手元の素材に無い画（撮り足しの候補）'},
  },
} as const;

export type ScriptDraftOptions = {
  /** 依頼文（どんな動画にしたいか。自由な文章でよい） */
  request: string;
  model?: string;
  /** script.md を書いたあと、そのまま「台本から組み立てる」まで行う（既定 false） */
  assemble?: boolean;
  /** 組み立ての結果を cuts.json / narration.json に書く（既定 true） */
  write?: boolean;
  force?: boolean;
  onLine?: (l: string) => void;
  onProgress?: (done: number, total: number, phase: string) => void;
  signal?: AbortSignal;
};

export type ScriptDraftResult = {
  plan: ScriptDraft;
  issues: ScriptDraftIssue[];
  fixes: string[];
  script: string;
  scriptFile: string;
  costUsd: number;
  assembled?: AiScriptResult;
};

/**
 * 依頼文から台本（script.md）を書く。E があれば書かない。前の台本は .studio/backups/ に残す
 */
export async function aiScriptDraft(dir: string, opt: ScriptDraftOptions): Promise<ScriptDraftResult> {
  const log = opt.onLine ?? (() => {});
  const request = opt.request.trim();
  if (!request) throw new Error('依頼文が空です（どんな動画にしたいかを書いてください）');
  const catalog = loadCatalog(dir);
  if (!catalog) throw new Error('catalog.json が無い（先に素材のカタログ化）');
  const brief = readBrief(dir);
  if (!brief) throw new Error('brief.json が無い（Brief で店名・人格を保存してください）');
  const persona = getPersona(brief.persona);
  const spec = FORMAT_SPECS[brief.format ?? persona.defaultFormat];
  const model = opt.model ?? studioConfig.agent.model;
  const ng = new Set(brief.ngClipIds);
  const usable = catalog.clips.filter((c) => !c.user.ng && !ng.has(c.id));
  if (!usable.length) throw new Error('使える素材がありません（全部 NG になっています）');
  const untagged = usable.filter((c) => !c.tags).length;
  if (untagged) log(`! タグの無い素材が ${untagged} 本あります。先に「AI にタグ付けしてもらう」と台本の当たりが良くなります`);
  await ensureLooks(dir, {onLine: log}).catch(() => 0);
  const targetSec = brief.targetSec ?? spec.targetSec[1];

  const groups = shotGroups(usable);
  const clipLines = usable.map((c) => {
    const t = c.tags;
    const ranges = (c.usableRanges ?? []).filter((r) => r.outSec > r.inSec).map((r) => `${r.inSec.toFixed(1)}〜${r.outSec.toFixed(1)}`);
    return [
      `- id ${c.id} / ${c.probe.durationSec.toFixed(2)}秒`,
      t ? `${t.kind}・${t.angle}・シズル${t.sizzleScore}` : 'タグなし',
      t?.subject ? `被写体:${t.subject}` : '',
      ranges.length ? `使える区間 ${ranges.join(' , ')}` : '',
      t?.description ? `／ ${t.description}` : '',
      shotGroupNote(groups, c.id),
    ]
      .filter(Boolean)
      .join(' / ');
  });
  const facts = [...catalog.facts, ...Object.entries(brief.facts).map(([k, v]) => `${k}: ${v}`)];

  const prompt = [
    'グルメのショート動画（縦型）の台本を書いてほしい。下の「依頼」が作り手の希望なので、**依頼を最優先**にする。',
    '依頼に無いことは、この案件の素材・事実・人格の文体から決める。',
    '',
    '## 依頼',
    request,
    '',
    '## この案件',
    `店: ${brief.shop.name}（${brief.shop.area}${brief.shop.station ? `・${brief.shop.station}` : ''}・${brief.shop.genre}）${brief.shop.pr ? '／PR 案件' : ''}`,
    brief.core ? `企画の核: ${brief.core}` : '',
    `尺の目安: ${targetSec} 秒（依頼に尺の指定があればそちらを優先）`,
    `人格: ${persona.label}／文体: ${persona.tone || '-'}／締めの語族: ${persona.cta.join('／')}／実測話速 ${persona.narration.charsPerSecMeasured} 文字/秒`,
    ...persona.narrationRules.map((r) => `ナレーションの禁則: ${r}`),
    persona.hookStyle === 'areaDigit' ? `フックの型: 「エリア＋一桁数字」。**エリア名（${brief.shop.area || 'エリア名'}）は本文に入れず badge に出す**` : '',
    facts.length ? `裏取り済みの事実（ここに無いことは書かない。料理名・数字を推測で作らない）:\n${facts.map((f) => `- ${f}`).join('\n')}` : '裏取り済みの事実は登録されていない。映像から確実に言えることだけ書く（料理名・数字を推測で作らない）',
    brief.notes ? `補足（作り手のメモ）: ${brief.notes}` : '',
    '',
    '## 使える素材（AI が映像を見て書いた説明つき。id は 01 から撮影順）',
    ...clipLines,
    '',
    '## 素材の選び方（必ず守る）',
    ...VARIETY_RULES.map((r) => `- ${r}`),
    '- 冒頭（フック）は外観・店名紹介・挨拶から入らず、最もインパクトのある料理の画から始める（依頼で指定があればそれに従う）',
    '',
    '## 書くもの（区間ごとに 1 件。頭から順に、隙間なく）',
    '- fromSec / toSec: 区間の秒。先頭は 0、次の区間は前の区間の toSec から始める。1 区間 2〜4 秒くらい',
    '- video: 映像の指示。**手元の素材の id を添えて**、どの画をどの順に使うか。無い画は近いもので代え、unmatched にも書く',
    '- cutCount / cutSec: 区間の長さ ÷ 0.75 くらいのカット数、1 カット 0.7〜0.8 秒',
    `- telop: ${spec.telop.maxChars} 文字以内・文末に句点なし・半角括弧と絵文字なし・金額なし・保存やいいねを促さない。三点リーダーは全角 3 文字の「・・・」で書く（「…」は使わない）`,
    '- badge: エリア名など。無ければ空',
    '- orientation: 基本は vertical。人物の顔や看板に重なるときだけ horizontal',
    '- narration: 人格の文体で 1〜2 文（改行なし・固有名詞と数字の単位はひらがなに開く）。区間の長さ × 話速 の文字数に収める。声を入れない区間は空',
    `- 締めの区間の telop は ${persona.cta.join('／')} 系で言い切る`,
    '- why: その区間の狙いを 1 行',
    '',
    'notes に全体の意図を、unmatched に「台本に入れたいが手元の素材に無い画」を書く。',
  ]
    .filter(Boolean)
    .join('\n');

  log(`依頼文から台本を書く: 素材 ${usable.length} 本 / 目安 ${targetSec} 秒（model=${model}）`);
  const {onEvent} = agentProgress({onProgress: opt.onProgress, log, labels: {thinking: '依頼文と素材から台本を考えています', writing: '台本を書き出しています'}});
  const run: AgentRun<unknown> = await runAgent({cwd: dir, prompt, schema: DRAFT_SCHEMA, model, timeoutMs: studioConfig.agent.timeoutMs, onLine: log, onEvent, signal: opt.signal});
  opt.onProgress?.(0, 0, '検算しています');

  const parsed = ScriptDraftSchema.safeParse(run.data);
  if (!parsed.success) throw new Error(`台本の返答が読めませんでした: ${parsed.error.issues[0]?.path.join('.')} ${parsed.error.issues[0]?.message}`);
  const {plan, fixes} = tidyDraft(parsed.data);
  for (const f of fixes) log(`  自動修正: ${f}`);
  const issues = checkScriptDraft(plan, {targetSec, maxTelopChars: spec.telop.maxChars});
  for (const i of issues) log(`  ${i.severity} ${i.code} ${i.message}`);
  for (const u of plan.unmatched) log(`  ? 素材が無い: ${u}`);
  if (plan.notes) log(`意図: ${plan.notes}`);
  const errors = issues.filter((i) => i.severity === 'E');
  if (errors.length) throw new Error(`台本に E が ${errors.length} 件あるので script.md を書いていません:\n${errors.map((e) => `  ${e.message}`).join('\n')}`);

  const script = renderScriptDraft(plan, {request, shopName: brief.shop.name});
  const prev = readScript(dir);
  if (prev?.trim()) backupFile(scriptPath(dir), backupsDir(dir));
  const scriptFile = writeScript(dir, script);
  const total = plan.sections.reduce((n, s) => Math.max(n, s.toSec), 0);
  log(`script.md を書きました（${plan.sections.length} 区間・${total} 秒・$${run.costUsd.toFixed(3)}）${prev?.trim() ? '。前の台本は .studio/backups/ に残っています' : ''}`);

  let assembled: AiScriptResult | undefined;
  if (opt.assemble) {
    log('続けて「台本から組み立てる」を実行します');
    assembled = await aiScript(dir, {model, write: opt.write !== false, force: opt.force, onLine: log, onProgress: opt.onProgress, signal: opt.signal});
  }
  return {plan, issues, fixes, script, scriptFile, costUsd: run.costUsd + (assembled?.costUsd ?? 0), assembled};
}
