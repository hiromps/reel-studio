// 自然言語の台本 → cuts.json + narration.json。
//
// これまでの組み立て（planCuts）は「型（F0/F7…）に素材を流し込む」やり方で、尺も構成も型が決める。
// こちらは逆で、**人が書いた台本が正**。台本の区間・尺・テロップ・ナレーションに素材を合わせる。
// 90 秒の企画のように型に収まらないものはこちらで作る。
//
// 素材の選定には **catalog のタグ（AI が映像を言語化した description）** を使う。
// 画（フレーム）は見せない：50 本の素材に画を付けると重いうえ、description があれば
// 「黒毛和牛大満足盛りをテーブルに置くシーン」のような台本の指示には十分に当たるため。
import fs from 'node:fs';
import path from 'node:path';
import {readCuts, readBrief, writeCuts, writeNarration, backupsDir} from './project';
import {loadCatalog} from './catalog';
import {runAgent} from './agent';
import {studioConfig} from '../studio.config';
import {ReelDataSchema, type Cut, type ReelData} from '../shared/schema/cuts';
import {NarrationSchema} from '../shared/schema/narration';
import {ScriptPlanSchema, checkScriptPlan, formatScriptPlan, parseSections, scriptTotalSec, type ScriptIssue, type ScriptPlan} from '../shared/script';
import {getPersona} from '../shared/personas';
import {FORMAT_SPECS} from '../shared/format-specs';
import {stableHash} from '../shared/hash';

export const scriptPath = (dir: string) => path.join(dir, 'script.md');
export const readScript = (dir: string): string | null => (fs.existsSync(scriptPath(dir)) ? fs.readFileSync(scriptPath(dir), 'utf8') : null);
export const writeScript = (dir: string, text: string) => {
  fs.mkdirSync(dir, {recursive: true});
  fs.writeFileSync(scriptPath(dir), text.replace(/\r\n/g, '\n').replace(/\s*$/, '\n'), 'utf8');
  return scriptPath(dir);
};

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['cuts', 'narration'],
  properties: {
    cuts: {
      type: 'array',
      description: '再生順。台本の区間の順に並べる',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['clipId', 'inSec', 'outSec', 'section'],
        properties: {
          clipId: {type: 'string', description: '素材一覧の id（変えない）'},
          inSec: {type: 'number', description: '素材の中の開始秒。使える区間（usable）から選ぶ'},
          outSec: {type: 'number', description: '素材の中の終了秒。素材の長さを超えない'},
          telop: {type: 'string', description: '画面に出す文言。出さないカットは空文字。台本のテロップ指示をそのまま or 収まる形に'},
          orientation: {type: 'string', enum: ['vertical', 'horizontal'], description: '既定は縦書き。人物の顔や看板に重なるときだけ horizontal'},
          badge: {type: 'string', description: '中央上部のラベル。エリア名はここに出す（本文には入れない）'},
          section: {type: 'string', description: '台本の見出し行をそのまま（例「【0〜3秒】フック」）'},
        },
      },
    },
    narration: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'at', 'text'],
        properties: {
          id: {type: 'string', description: '連番＋内容の短い英字（例 01_hook）'},
          at: {type: 'number', description: '動画の先頭からの配置秒'},
          text: {type: 'string', description: '読み上げる文だけ。改行・注釈は入れない'},
        },
      },
    },
    unmatched: {type: 'array', items: {type: 'string'}, description: '台本にあるが合う素材が無かったもの（撮り足しの指示になる）'},
    notes: {type: 'string', description: '割り当ての意図を 1〜3 行で'},
  },
} as const;

export type AiScriptResult = {
  plan: ScriptPlan;
  issues: ScriptIssue[];
  cuts: ReelData;
  totalSec: number;
  costUsd: number;
  written: boolean;
  lines: string[];
};

/**
 * 台本から cuts.json と narration.json を作る。
 * E が出たら**何も書かない**（壊れた構成で上書きしない）。force で W だけ無視できる。
 */
export async function aiScript(
  projectDir: string,
  opt: {model?: string; write?: boolean; force?: boolean; onLine?: (l: string) => void; onProgress?: (d: number, t: number, p: string) => void; signal?: AbortSignal} = {},
): Promise<AiScriptResult> {
  const log = opt.onLine ?? (() => {});
  const script = readScript(projectDir);
  if (!script?.trim()) throw new Error('script.md が無い（Brief の「台本から組み立てる」に台本を貼ってください）');
  const catalog = loadCatalog(projectDir);
  if (!catalog) throw new Error('catalog.json が無い（先に素材のカタログ化）');
  const brief = readBrief(projectDir);
  if (!brief) throw new Error('brief.json が無い');
  const persona = getPersona(brief.persona);
  const spec = FORMAT_SPECS[brief.format ?? persona.defaultFormat];

  const usable = catalog.clips.filter((c) => !c.user.ng);
  if (!usable.length) throw new Error('使える素材がありません（全部 NG になっています）');
  const untagged = usable.filter((c) => !c.tags).length;
  if (untagged) log(`! タグの無い素材が ${untagged} 本あります。先に「AI にタグ付けしてもらう」と当たりが良くなります`);

  const sections = parseSections(script);
  const wantTotal = scriptTotalSec(sections);
  log(`台本から組み立て: 区間 ${sections.length} 個${wantTotal ? ` / 想定 ${wantTotal} 秒` : ''} / 素材 ${usable.length} 本（model=${opt.model ?? studioConfig.agent.model}）`);

  // 素材一覧。**AI が映像を言語化した description が選定の主材料**
  const clipLines = usable.map((c) => {
    const t = c.tags;
    const ranges = (c.usableRanges ?? []).filter((r) => r.outSec > r.inSec).map((r) => `${r.inSec.toFixed(1)}〜${r.outSec.toFixed(1)}`);
    return [
      `- id ${c.id} / ${c.probe.durationSec.toFixed(2)}秒`,
      t ? `${t.kind}・${t.angle}・シズル${t.sizzleScore}` : 'タグなし',
      t?.subject ? `被写体:${t.subject}` : '',
      ranges.length ? `使える区間 ${ranges.join(' , ')}` : '',
      t?.description ? `／ ${t.description}` : '',
    ]
      .filter(Boolean)
      .join(' / ');
  });

  const facts = [...catalog.facts, ...Object.entries(brief.facts).map(([k, v]) => `${k}: ${v}`)];

  const prompt = [
    '人が書いた台本があります。**台本が正**なので、それに合うように手元の素材を並べて動画の構成を作ってください。',
    '',
    '## 台本',
    script.trim(),
    '',
    '## 使える素材（AI が映像を見て書いた説明つき）',
    ...clipLines,
    '',
    '## やること',
    '1. 台本の区間（【0〜3秒】など）を順に見て、その「映像：」の指示に合う素材を選ぶ',
    '2. 各カットの `inSec`〜`outSec` を決める。**「使える区間」の中から取る**（無い素材は頭を少し避けて取る）',
    '3. **その区間のカットの合計尺を、台本の区間の長さに合わせる**（ここがずれると書いたナレーションが入らない）',
    '4. 台本の「テロップ：」を該当カットに入れる。指示が無いカットは空文字',
    '5. 台本の「ナレーション：」を `narration` に入れる。**台本の文をそのまま使う**（勝手に書き換えない）',
    '',
    '## 守ること',
    `- テロップは ${spec.telop.maxChars} 文字まで。文末に句点（。）を付けない。長い指示は意味を保って縮める`,
    `- **エリア名（${brief.shop.area || '—'}）は縦書き本文ではなく badge に出す。** 本文はエリア名が無くても通る言い回しに`,
    '- 同じ素材を連続で使わない（切り替わって見えない）。引き（wide/mid）と寄り（close）を交互に',
    '- 台本に無いテロップを足さない。台本に無い情報をナレーションに足さない',
    '- **合う素材が無い区間は、無理に別の素材を当てずに `unmatched` に書く**（撮り足しの指示になる）',
    `- ナレーションの \`at\` は、その文が指す映像が出ている間に置く。実測話速は ${persona.narration.charsPerSecMeasured} 文字/秒`,
    '- ナレーションは 1 ブロック 1 文（改行を入れない）。長い文は文単位で分ける',
    '',
    facts.length ? `## 裏取り済みの事実（台本の数字と食い違ったら台本を優先。ただし notes に書く）\n${facts.map((f) => `- ${f}`).join('\n')}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  opt.onProgress?.(0, 3, '台本を読んでいます');
  const run = await runAgent<ScriptPlan>({
    cwd: projectDir,
    prompt,
    schema: PLAN_SCHEMA,
    model: opt.model ?? studioConfig.agent.model,
    timeoutMs: studioConfig.agent.timeoutMs,
    onLine: log,
    onEvent: (e) => e.kind === 'tool' && opt.onProgress?.(1, 3, '素材を確認しています'),
    signal: opt.signal,
  });
  opt.onProgress?.(2, 3, '検算しています');

  const plan = ScriptPlanSchema.parse(run.data);
  const durations = new Map(catalog.clips.map((c) => [c.id, c.probe.durationSec]));
  const issues = checkScriptPlan(plan, {
    sections,
    clipDurations: durations,
    ngClipIds: new Set(catalog.clips.filter((c) => c.user.ng).map((c) => c.id)),
    maxTelopChars: spec.telop.maxChars,
  });

  // ── cuts.json を組み立てる ──
  const byId = new Map(catalog.clips.map((c) => [c.id, c]));
  const cutList: Cut[] = plan.cuts.map((c, i) => {
    const clip = byId.get(c.clipId);
    const cut: Cut = {
      id: `c${String(i + 1).padStart(2, '0')}`,
      src: clip?.src ?? c.clipId,
      inSec: Math.max(0, Math.round(c.inSec * 1000) / 1000),
      outSec: Math.round(c.outSec * 1000) / 1000,
    };
    if (c.telop.trim()) cut.main = {text: c.telop.trim(), ...(c.orientation === 'horizontal' ? {orientation: 'horizontal' as const} : {})};
    if (c.badge?.trim()) cut.badge = c.badge.trim();
    return cut;
  });
  const cuts: ReelData = ReelDataSchema.parse({
    fps: catalog.dominantFps,
    theme: brief.theme ?? persona.theme,
    cuts: cutList,
    meta: {
      slots: plan.cuts.map((c, i) => ({cutId: `c${String(i + 1).padStart(2, '0')}`, segment: c.section, role: 'info', clipId: c.clipId, textStatus: 'draft', locked: false, qc: []})),
      generated: {tool: 'reel-studio/script', at: new Date().toISOString(), briefHash: stableHash(brief), catalogHash: stableHash(catalog), specId: spec.id},
    },
  });
  const total = cutList.reduce((n, c) => n + (c.outSec - c.inSec), 0);

  const lines = formatScriptPlan(plan, sections, cuts);
  for (const l of lines) log(l);
  for (const i of issues) log(`  ${i.severity} ${i.code} ${i.message}`);
  for (const u of plan.unmatched) log(`  ? 素材が無い: ${u}`);
  if (plan.notes) log(`意図: ${plan.notes}`);

  const errors = issues.filter((i) => i.severity === 'E');
  let written = false;
  if (opt.write !== false) {
    if (errors.length && !opt.force) {
      log(`E が ${errors.length} 件あるので何も書いていません（--force で W だけ無視できます。E は無視できません）`);
    } else {
      writeCuts(projectDir, cuts);
      if (plan.narration.length) {
        writeNarration(projectDir, {
          voice: persona.narration.voiceId,
          voiceTitle: persona.narration.voiceTitle,
          latency: 'normal',
          speed: persona.narration.speed,
          videoSec: Math.round(total * 1000) / 1000,
          note: plan.notes,
          segments: plan.narration.map((n) => ({id: n.id, at: Math.round(n.at * 1000) / 1000, text: n.text.trim(), needsTts: true})),
        });
      }
      written = true;
      log(`cuts.json（${cutList.length} カット / ${total.toFixed(2)} 秒）と narration.json（${plan.narration.length} ブロック）を書きました`);
      log('※ 音声はまだありません。Render の「音声を生成」→「ナレーション合成（mix）」で仕上げます');
    }
  }
  return {plan, issues, cuts, totalSec: total, costUsd: run.costUsd, written, lines};
}
