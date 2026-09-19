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
import {readBrief, readNarration, writeCuts, writeNarration} from './project';
import {loadCatalog, studioDir} from './catalog';
import {runAgent} from './agent';
import {readJsonFile, writeJsonAtomic} from './json-io';
import {activitySummary, createAgentTracker, progressView} from '../shared/agent-progress';
import {studioConfig} from '../studio.config';
import {type ReelData} from '../shared/schema/cuts';
import {
  ScriptPlanSchema,
  ScriptProposalSchema,
  checkScriptPlan,
  formatScriptPlan,
  parseSections,
  reviewScriptProposal,
  scriptPlanToCuts,
  scriptPlanToNarration,
  scriptPlanTotalSec,
  scriptTextHash,
  scriptTotalSec,
  type ScriptIssue,
  type ScriptPlan,
  type ScriptProposal,
  type ScriptProposalReview,
} from '../shared/script';
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

// ───────────────────────── 案の保存・書き込み ─────────────────────────

/** AI が返した組み立ての保存先。「割り当てを見るだけ」の結果を、承認されたら AI を走らせずに書き込むため */
export const scriptProposalPath = (dir: string) => path.join(studioDir(dir), 'script-plan.json');

export const readScriptProposal = (dir: string): ScriptProposal | null => {
  const p = scriptProposalPath(dir);
  if (!fs.existsSync(p)) return null;
  try {
    return readJsonFile(p, ScriptProposalSchema);
  } catch {
    return null; // 壊れていたら無いのと同じ（もう一度「見るだけ」を走らせればよい）
  }
};

const writeScriptProposal = (dir: string, proposal: ScriptProposal) => writeJsonAtomic(scriptProposalPath(dir), ScriptProposalSchema.parse(proposal));

/** 台本・素材・人格・型を読む。組み立て（AI）と書き込み（承認）で同じものを使う */
const loadScriptEnv = (projectDir: string) => {
  const script = readScript(projectDir);
  if (!script?.trim()) throw new Error('script.md が無い（Brief の「台本から組み立てる」に台本を貼ってください）');
  const catalog = loadCatalog(projectDir);
  if (!catalog) throw new Error('catalog.json が無い（先に素材のカタログ化）');
  const brief = readBrief(projectDir);
  if (!brief) throw new Error('brief.json が無い');
  const persona = getPersona(brief.persona);
  const spec = FORMAT_SPECS[brief.format ?? persona.defaultFormat];
  const sections = parseSections(script);
  const check = {
    sections,
    clipDurations: new Map(catalog.clips.map((c) => [c.id, c.probe.durationSec])),
    ngClipIds: new Set(catalog.clips.filter((c) => c.user.ng).map((c) => c.id)),
    maxTelopChars: spec.telop.maxChars,
  };
  const toCuts = (plan: ScriptPlan): ReelData =>
    scriptPlanToCuts(plan, {catalog, theme: brief.theme ?? persona.theme, specId: spec.id, briefHash: stableHash(brief), catalogHash: stableHash(catalog)});
  return {script, catalog, brief, persona, spec, sections, check, toCuts};
};

/** cuts.json と narration.json を書く（「台本から組み立てる」と「承認して書き込む」の共通部分）。旧版は .studio/backups/ に残る */
const writeScriptOutputs = (projectDir: string, plan: ScriptPlan, cuts: ReelData, persona: ReturnType<typeof getPersona>, log: (l: string) => void) => {
  writeCuts(projectDir, cuts);
  const narration = scriptPlanToNarration(plan, persona.narration);
  if (narration) writeNarration(projectDir, narration);
  log(`cuts.json（${cuts.cuts.length} カット / ${scriptPlanTotalSec(plan).toFixed(2)} 秒）と narration.json（${plan.narration.length} ブロック）を書きました`);
  log('※ 音声はまだありません。Render の「音声を生成」→「ナレーション合成（mix）」で仕上げます');
};

export type ScriptProposalView = ScriptProposalReview & {
  createdAt: string;
  model: string;
  costUsd: number;
  appliedAt?: string;
  unmatched: string[];
  notes: string;
  /** いまの cuts.json / narration.json（承認の確認で「何を置き換えるか」を見せる） */
  current: {cuts: number | null; narration: number | null; sfx: number};
};

/** 画面用：保存してある案を、いまの台本・素材で見直した結果。案が無ければ null */
export const scriptProposalView = (projectDir: string): ScriptProposalView | null => {
  const proposal = readScriptProposal(projectDir);
  if (!proposal) return null;
  let review: ScriptProposalReview;
  try {
    const env = loadScriptEnv(projectDir);
    review = reviewScriptProposal(proposal, {scriptText: env.script, check: env.check, cuts: env.toCuts(proposal.plan)});
  } catch (e) {
    review = {canApply: false, blockers: [(e as Error).message], issues: [], lines: [], totalSec: scriptPlanTotalSec(proposal.plan), cutCount: proposal.plan.cuts.length, narrationCount: proposal.plan.narration.length};
  }
  let currentCuts: number | null = null;
  const cutsFile = path.join(projectDir, 'cuts.json');
  if (fs.existsSync(cutsFile)) {
    try {
      currentCuts = (JSON.parse(fs.readFileSync(cutsFile, 'utf8')) as {cuts?: unknown[]}).cuts?.length ?? 0;
    } catch {
      currentCuts = 0;
    }
  }
  let narration: ReturnType<typeof readNarration> = null;
  try {
    narration = readNarration(projectDir);
  } catch {
    /* 壊れた narration.json は置き換わるだけ */
  }
  return {
    ...review,
    createdAt: proposal.createdAt,
    model: proposal.model,
    costUsd: proposal.costUsd,
    appliedAt: proposal.appliedAt,
    unmatched: proposal.plan.unmatched,
    notes: proposal.plan.notes,
    current: {cuts: currentCuts, narration: narration?.segments.length ?? null, sfx: narration?.sfx?.length ?? 0},
  };
};

/**
 * 保存してある案（「割り当てを見るだけ」の結果）を cuts.json と narration.json に書き込む。**AI は走らせない。**
 * 書く直前に、いまの台本・素材で検算し直す（台本が変わった・E がある なら書かない）。
 */
export const applyScriptProposal = (projectDir: string, opt: {onLine?: (l: string) => void} = {}): {cuts: number; narration: number; totalSec: number; issues: ScriptIssue[]} => {
  const log = opt.onLine ?? (() => {});
  const proposal = readScriptProposal(projectDir);
  if (!proposal) throw new Error('書き込む割り当ての案がありません（先に「割り当てを見るだけ」を実行してください）');
  const env = loadScriptEnv(projectDir);
  const cuts = env.toCuts(proposal.plan);
  const review = reviewScriptProposal(proposal, {scriptText: env.script, check: env.check, cuts});
  if (!review.canApply) throw new Error(`この案は書き込めません:\n${review.blockers.map((b) => `  ${b}`).join('\n')}`);
  writeScriptOutputs(projectDir, proposal.plan, cuts, env.persona, log);
  writeScriptProposal(projectDir, {...proposal, appliedAt: new Date().toISOString()});
  return {cuts: cuts.cuts.length, narration: proposal.plan.narration.length, totalSec: review.totalSec, issues: review.issues};
};

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
  const env = loadScriptEnv(projectDir);
  const {script, catalog, brief, persona, spec, sections} = env;

  const usable = catalog.clips.filter((c) => !c.user.ng);
  if (!usable.length) throw new Error('使える素材がありません（全部 NG になっています）');
  const untagged = usable.filter((c) => !c.tags).length;
  if (untagged) log(`! タグの無い素材が ${untagged} 本あります。先に「AI にタグ付けしてもらう」と当たりが良くなります`);

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

  // 画は見せないので数えられる作業が無い。heartbeat で経過秒・ツール回数・出力文字数を出す
  const tracker = createAgentTracker();
  let lastHb = 0;
  const run = await runAgent<ScriptPlan>({
    cwd: projectDir,
    prompt,
    schema: PLAN_SCHEMA,
    model: opt.model ?? studioConfig.agent.model,
    timeoutMs: studioConfig.agent.timeoutMs,
    onLine: log,
    onEvent: (e) => {
      const step = tracker.onEvent(e);
      const st = tracker.stats;
      if (step === 'init') log(`  claude が起動しました${st.model ? `（${st.model}）` : ''}`);
      else if (step === 'tool') log(`  ▸ ${st.lastTool}${st.lastTarget ? ` ${st.lastTarget}` : ''}`);
      else if (step === 'writing') log(`  組み立てを書き出しています（${activitySummary(st)}）`);
      else if (step === 'heartbeat' && st.elapsedSec - lastHb >= 30) {
        lastHb = st.elapsedSec;
        log(`  … 動いています（${activitySummary(st)}）`);
      }
      const v = progressView(st, {thinking: '台本と素材を突き合わせています', writing: '組み立てを書き出しています'});
      opt.onProgress?.(v.done, v.total, v.phase);
    },
    signal: opt.signal,
  });
  opt.onProgress?.(0, 0, '検算しています');

  const plan = ScriptPlanSchema.parse(run.data);
  const issues = checkScriptPlan(plan, env.check);
  const cuts = env.toCuts(plan);
  const total = scriptPlanTotalSec(plan);

  // 結果は必ず残す。「見るだけ」で確かめて、承認されたら AI を走らせずにこれを書き込む（1 回 5〜7 分・課金があるため）
  const proposal: ScriptProposal = {version: 1, createdAt: new Date().toISOString(), scriptHash: scriptTextHash(script), model: opt.model ?? studioConfig.agent.model, costUsd: run.costUsd, plan};
  writeScriptProposal(projectDir, proposal);

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
      writeScriptOutputs(projectDir, plan, cuts, persona, log);
      writeScriptProposal(projectDir, {...proposal, appliedAt: new Date().toISOString()});
      written = true;
    }
  } else {
    log(
      errors.length
        ? `E が ${errors.length} 件あるので、この案は書き込めません`
        : 'まだ書き込んでいません。Brief の「割り当ての結果」で確かめて「この割り当てで書き込む」を押すと、この案がそのまま入ります（AI はもう走らせません）',
    );
  }
  return {plan, issues, cuts, totalSec: total, costUsd: run.costUsd, written, lines};
}
