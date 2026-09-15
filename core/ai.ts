// タグ付けと並べ替えを、裏で走らせた Claude Code に代行させる。
// エージェントは「サムネイルを見て JSON を返す」だけ。catalog.json / brief.json / cuts.json への
// 反映は必ずこちら側が zod 検証を通してから行う（importTags / importOrder）。
import fs from 'node:fs';
import path from 'node:path';
import {studioConfig} from '../studio.config';
import {ClipKindSchema, AngleSchema, MotionSchema} from '../shared/schema/catalog';
import type {Clip} from '../shared/schema/catalog';
import {ReelDataSchema, type Cut, type ReelData} from '../shared/schema/cuts';
import {NarrationSchema} from '../shared/schema/narration';
import type {ValidationResult} from '../shared/validate';
import {checkOrder, formatOrderCheck, orderPrinciples} from '../shared/order';
import {checkCaption, formatCaptionIssues, type CaptionIssue} from '../shared/caption';
import {cutDurationSec, telopGroupsOf, totalSec} from '../shared/timeline';
import {countChars, isPlaceholder, minDisplaySec} from '../shared/telop-text';
import {importTags, loadCatalog, saveCatalog, studioDir, type TagImport} from './catalog';
import {buildOrderExport, exportOrder, importOrder, loadOrderEnv, type OrderEnv, type OrderImportResult} from './order';
import {ensureCutFrame} from './cut-frames';
import {readBrief, readCaption, readCuts, readNarration, writeBrief, writeCaption, writeCuts, writeNarration} from './project';
import {validateProject} from './render';
import {runAgent, type AgentEvent, type AgentRun} from './agent';
import {activitySummary, createAgentTracker, fmtElapsed, progressView, type ProgressLabels} from '../shared/agent-progress';

const enumOf = (v: readonly string[]) => ({type: 'string', enum: [...v]});

/** 1 クリップ分のタグ。catalog.ts の ClipTagsSchema と同じ語彙 */
const TAG_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'slug', 'kind', 'signage', 'signageSize', 'angle', 'motion', 'sizzleScore', 'quality', 'hasSpeech', 'subject', 'description'],
  properties: {
    id: {type: 'string', description: 'クリップ id（渡された一覧のもの。変えない）'},
    slug: {type: 'string', description: '内容が分かる英数字とハイフンだけの短い名前（例 ami-kemuri-hiki）'},
    kind: enumOf(ClipKindSchema.options),
    signage: {type: 'boolean', description: '店名・ロゴ・看板の文字が読めるか'},
    signageSize: enumOf(['none', 'small', 'large']),
    angle: enumOf(AngleSchema.options),
    motion: enumOf(MotionSchema.options),
    sizzleScore: {type: 'integer', minimum: 1, maximum: 5, description: '食欲をそそる度合い'},
    quality: {type: 'integer', minimum: 1, maximum: 5, description: '手ブレ・露出・ピントの良さ'},
    hasSpeech: {type: 'boolean', description: '人が喋っていそうか（音は聞こえないので映像から推測）'},
    subject: {type: 'string', description: '被写体の短い名前（例「うちひら」「店員」）。同一被写体の連続回避に使う'},
    description: {type: 'string', description: '何が映っているかを 1 行で。読み取れた文字はそのまま引用する'},
  },
} as const;

const TAG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['clips'],
  properties: {
    clips: {type: 'array', items: TAG_ITEM_SCHEMA},
    facts: {type: 'array', items: {type: 'string'}, description: '看板・のぼり・メニューから読み取れた事実（店名・価格・営業時間・部位名など）。読めたものだけ'},
  },
} as const;

const ORDER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['order'],
  properties: {
    order: {type: 'array', items: {type: 'string'}, description: 'clipId の並び。そのままカットの並び順になる'},
    notes: {type: 'string', description: 'この構成にした理由を 1〜2 行で'},
    reasons: {
      type: 'array',
      items: {type: 'object', additionalProperties: false, required: ['clipId', 'why'], properties: {clipId: {type: 'string'}, why: {type: 'string'}}},
      description: '要所のカットだけ、なぜそこに置いたか',
    },
  },
} as const;

type TagResponse = {clips: (NonNullable<TagImport['clips'][number]['tags']> & {id: string; slug: string})[]; facts?: string[]};
type OrderResponse = {order: string[]; notes?: string; reasons?: {clipId: string; why: string}[]};

export type AiProgress = (done: number, total: number, label: string) => void;

export type AiTagResult = {
  tagged: string[];
  skipped: string[];
  batches: number;
  costUsd: number;
  facts: string[];
};

const sheetPath = (c: Clip) => path.posix.join(studioConfig.studioDirName, c.thumbs.sheet);

/** ログを 30 秒に 1 行だけ「動いています」で埋める間隔 */
const HEARTBEAT_LOG_SEC = 30;

/**
 * エージェントの稼働状況（起動・画の確認・ツール・書き出し・heartbeat）を進捗とログにする。
 * watch に入っているファイル名だけを「確認済み」と数えるので、cuts.json 等の Read は混ざらない。
 * 画を 1 枚も見ずに考えている間も、heartbeat で経過秒・ツール回数・出力文字数が更新される
 * （以前は Read の回数しか見ていなかったので、ナレーション原稿などで 0/N のまま止まって見えた）。
 */
export const agentProgress = (o: {watch?: string[]; onProgress?: AiProgress; log?: (l: string) => void; prefix?: string; labels?: ProgressLabels}) => {
  const tr = createAgentTracker(o.watch ?? []);
  const p = o.prefix ? `${o.prefix} ` : '';
  let lastHbLog = 0;
  const emit = () => {
    if (!o.onProgress) return;
    const v = progressView(tr.stats, o.labels);
    o.onProgress(v.done, v.total, v.phase);
  };
  const onEvent = (e: AgentEvent) => {
    const step = tr.onEvent(e);
    const st = tr.stats;
    if (step === 'init') o.log?.(`  ${p}claude が起動しました${st.model ? `（${st.model}）` : ''}`);
    else if (step === 'watched') o.log?.(`  ${p}${o.labels?.reading ?? '画を確認中'} ${st.watched.done}/${st.watched.total}（${st.watched.last}）`);
    else if (step === 'tool') o.log?.(`  ${p}▸ ${st.lastTool}${st.lastTarget ? ` ${st.lastTarget}` : ''}`);
    else if (step === 'writing') o.log?.(`  ${p}${o.labels?.writing ?? '結果を書き出しています'}（${activitySummary(st)}）`);
    else if (step === 'heartbeat' && st.elapsedSec - lastHbLog >= HEARTBEAT_LOG_SEC) {
      lastHbLog = st.elapsedSec;
      o.log?.(`  ${p}… 動いています（${activitySummary(st)}${st.lastTool ? `・直前 ${st.lastTool}` : ''}）`);
    }
    emit();
  };
  emit();
  return {onEvent, stats: tr.stats};
};

const TAG_RULES = [
  'kind: exterior(外観) / signage(店名・ロゴ・看板が主役) / interior(店内) / menu(メニュー表・POP) / cooking(調理・炎・湯気) / serving(提供・登場・置く) / eating(実食・箸上げ・断面) / sizzle(寄りのシズル) / person(人物) / conversation(会話・語り) / detail(小物・内装) / other',
  'signage は「店名・ロゴ・看板の文字が読めるか」だけで判断する。料理の札やメニューの品名は signage ではない（それは menu）',
  'angle: wide(引き) / mid(中) / close(寄り)。sizzleScore と quality は 1〜5',
  'subject は同じ被写体には同じ語を使う（連続を避ける判定に使うため）。「うちひら」「店員」「網焼き」のように短く',
  'description には読み取れた文字（看板・のぼり・メニュー・肉の札）をそのまま引用して入れる',
  'slug は英数字とハイフンだけ。内容が分かる短い名前にする（gaikan-kanban / ami-kemuri-hiki / menu-daimanzoku など）',
  '分からないものは推測で品名を断定しない。読めない文字は description に書かない',
].join('\n- ');

/** 未タグのクリップに Claude がタグを付ける（バッチごとに catalog.json へ反映） */
export async function aiTag(
  projectDir: string,
  opt: {force?: boolean; batchSize?: number; concurrency?: number; model?: string; onLine?: (l: string) => void; onProgress?: AiProgress; signal?: AbortSignal} = {},
): Promise<AiTagResult> {
  const log = opt.onLine ?? (() => {});
  const catalog = loadCatalog(projectDir);
  if (!catalog) throw new Error('catalog.json が無い（先に reel catalog）');
  const targets = catalog.clips.filter((c) => !c.user.lock && (opt.force || !c.tags));
  const skipped = catalog.clips.filter((c) => c.user.lock).map((c) => c.id);
  if (!targets.length) return {tagged: [], skipped, batches: 0, costUsd: 0, facts: catalog.facts};

  const size = Math.max(1, opt.batchSize ?? studioConfig.agent.tagBatchSize);
  const batches: Clip[][] = [];
  for (let i = 0; i < targets.length; i += size) batches.push(targets.slice(i, i + size));

  const tagged: string[] = [];
  const facts = new Set(catalog.facts);
  let costUsd = 0;
  const conc = Math.max(1, Math.min(opt.concurrency ?? studioConfig.agent.tagConcurrency, batches.length));
  log(`AI タグ付け: ${targets.length} 本を ${batches.length} 回に分けて見る（${conc} 本並列 / model=${opt.model ?? studioConfig.agent.model}）`);

  let cursor = 0;
  let finished = 0;
  // catalog.json への反映は直列化する（同時に読み書きすると片方のタグが消える）
  let applyChain: Promise<void> = Promise.resolve();

  const worker = async (): Promise<void> => {
    for (;;) {
      const b = cursor++;
      if (b >= batches.length || opt.signal?.aborted) return;
      const batch = batches[b];
      const tag = `[${b + 1}/${batches.length}]`;
      const list = batch.map((c) => `- id ${c.id} / 尺 ${c.probe.durationSec.toFixed(2)}秒 / シート ${sheetPath(c)}`).join('\n');
    const prompt = [
      'グルメのショート動画に使う素材をカタログ化している。次のクリップ 1 本ずつについて、コンタクトシート（横に並んだコマ）を Read で 1 枚ずつ見て、内容のタグを付けてほしい。',
      '',
      list,
      '',
      '守ること:',
      `- ${TAG_RULES}`,
      '- シートは 1 枚ずつ Read する。複数を一度に見て取り違えない',
      '- 一覧に無い id を作らない。渡した id すべてに答える',
      '',
      'あわせて、看板・のぼり・メニュー・肉の札から読み取れた事実（店名・価格・営業時間・部位名など）があれば facts に入れてほしい。読めたものだけでよい。',
    ].join('\n');

      let run: AgentRun<TagResponse>;
      try {
        run = await runAgent<TagResponse>({
          cwd: projectDir,
          prompt,
          schema: TAG_SCHEMA,
          model: opt.model ?? studioConfig.agent.model,
          timeoutMs: studioConfig.agent.timeoutMs,
          onLine: (l) => log(`${tag} ${l}`),
          onEvent: agentProgress({watch: batch.map((c) => sheetPath(c)), log, prefix: tag, labels: {reading: '画'}}).onEvent,
          signal: opt.signal,
        });
      } catch (e) {
        log(`  ! ${tag} 失敗（このバッチだけ飛ばす）: ${e instanceof Error ? e.message : String(e)}`);
        finished++;
        opt.onProgress?.(finished, batches.length, `${finished}/${batches.length} 完了`);
        continue;
      }
      costUsd += run.costUsd;
      const known = new Set(batch.map((c) => c.id));
      const clips = (run.data.clips ?? []).filter((t) => known.has(t.id));
      for (const f of run.data.facts ?? []) if (f.trim()) facts.add(f.trim());
      if (!clips.length) log(`  ! ${tag} 有効なタグが 0 件だった`);
      else {
        const data: TagImport = {clips: clips.map(({id, slug, ...tags}) => ({id, slug, tags: {...tags, source: 'claude' as const}}))};
        applyChain = applyChain.then(() => {
          const r = importTags(projectDir, loadCatalog(projectDir)!, data, 'claude');
          tagged.push(...r.updated);
          if (r.skipped.length) log(`  ${tag} skipped: ${r.skipped.join('; ')}`);
          log(`  ${tag} ${r.updated.length} 本（$${run.costUsd.toFixed(3)} / ${(run.durationMs / 1000).toFixed(0)}秒）`);
        });
        await applyChain;
      }
      finished++;
      opt.onProgress?.(finished, batches.length, `${finished}/${batches.length} 完了`);
    }
  };
  await Promise.all(Array.from({length: conc}, () => worker()));

  // facts はまとめて最後に保存（importTags は clips 単位で保存する）
  const final = loadCatalog(projectDir)!;
  final.facts = [...facts];
  saveCatalog(projectDir, final);
  opt.onProgress?.(batches.length, batches.length, 'done');
  log(`AI タグ付け完了: ${tagged.length} 本 / 合計 $${costUsd.toFixed(3)}`);
  return {tagged, skipped, batches: batches.length, costUsd, facts: final.facts};
}

export type AiOrderResult = OrderImportResult & {costUsd: number; notes?: string; exportFile: string};

/** Claude が素材を見て並び順を決め、brief.order.fixed に取り込む */
export async function aiOrder(
  projectDir: string,
  opt: {write?: boolean; copy?: boolean; force?: boolean; model?: string; onLine?: (l: string) => void; onProgress?: AiProgress; signal?: AbortSignal} = {},
): Promise<AiOrderResult> {
  const log = opt.onLine ?? (() => {});
  const env: OrderEnv = loadOrderEnv(projectDir);
  const {file} = exportOrder(env);
  const payload = buildOrderExport(env);
  const untagged = payload.clips.filter((c) => !c.kind).length;
  if (untagged) log(`※ 未タグが ${untagged} 本あります。先に AI タグ付けをすると精度が上がります`);

  const rel = path.relative(projectDir, file).replace(/\\/g, '/');
  const usable = payload.clips.filter((c) => !c.ng);
  const prompt = [
    `グルメのショート動画の構成を決めてほしい。素材の一覧と、この型が要求する構成は ${rel} に入っている。まずそれを Read で読むこと。`,
    '',
    `型: ${payload.format.id}「${payload.format.name}」/ 全体 ${payload.format.targetSec} 秒 / ${payload.format.recommendedCuts[0]}〜${payload.format.recommendedCuts[1]} カット`,
    `店: ${env.brief.shop.name}（${env.brief.shop.area}・${env.brief.shop.genre}）`,
    '',
    '守ること:',
    ...orderPrinciples(env.spec, env.brief, env.persona).map((p) => `- ${p}`),
    `- ng が true のクリップは使わない（使えるのは ${usable.length} 本）`,
    '- 迷ったら clips[].sheet を Read で 1 枚ずつ見て中身を確かめる。1 枚ずつ見ること',
    '',
    '決めるのは並び順だけ。尺・IN/OUT・役割・テロップは書かない（別の工程が型どおりに決める）。',
    'order は clipId の配列で、そのままカットの並びになる。同じ id を隣り合わせで 2 回書けばそのクリップから 2 カット取れるが、離れた位置での再使用は避けること。',
  ].join('\n');

  log(`AI 並べ替え: ${usable.length} 本から ${payload.format.recommendedCuts[0]}〜${payload.format.recommendedCuts[1]} カットを選ぶ（model=${opt.model ?? studioConfig.agent.model}）`);
  const run = await runAgent<OrderResponse>({
    cwd: projectDir,
    prompt,
    schema: ORDER_SCHEMA,
    model: opt.model ?? studioConfig.agent.model,
    timeoutMs: studioConfig.agent.timeoutMs,
    onLine: log,
    onEvent: agentProgress({watch: payload.clips.map((c) => c.sheet), onProgress: opt.onProgress, log, labels: {thinking: '並び順を考えています', writing: '並び順を書き出しています'}}).onEvent,
    signal: opt.signal,
  });
  log(`AI の案: ${run.data.order.join(' → ')}（$${run.costUsd.toFixed(3)} / ${(run.durationMs / 1000).toFixed(0)}秒）`);
  if (run.data.notes) log(`理由: ${run.data.notes}`);

  // 取り込む前に並びだけ検査して、E があれば書かずに返す（importOrder も同じ検査をする）
  const pre = checkOrder(run.data.order, env);
  if (!pre.ok && !opt.force) log(formatOrderCheck(pre));
  const r = importOrder(env, run.data, {write: opt.write, copy: opt.copy, force: opt.force});
  return {...r, costUsd: run.costUsd, notes: run.data.notes, exportFile: file};
}

// ───────────────────────── テロップ ─────────────────────────

const TELOP_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['groups'],
  properties: {
    groups: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'text'],
        properties: {
          id: {type: 'string', description: 'グループ id（渡された一覧のもの。変えない）'},
          text: {type: 'string', description: '画面に出す文言そのものだけ。役割名・文字数・秒数・映像の説明・記号・改行は入れない（例:「生野区で好みが分かれた」）'},
          orientation: {type: 'string', enum: ['vertical', 'horizontal'], description: '既定は縦書き（vertical）。人物の顔や看板の文字に縦書きが重なるときだけ horizontal にする'},
          badge: {type: 'string', description: 'そのグループの先頭カットに出す短いラベル（中央上部）。フックのエリア名はここに入れる。空文字で消す'},
        },
      },
    },
    notes: {type: 'string', description: '流れの意図を 1〜2 行で'},
  },
} as const;

type TelopResponse = {groups: {id: string; text: string; orientation?: 'vertical' | 'horizontal'; badge?: string}[]; notes?: string};

export type AiTelopResult = {
  filled: {id: string; before: string; text: string}[];
  skipped: string[];
  costUsd: number;
  notes?: string;
  validation?: ValidationResult;
};

type TelopTarget = {
  id: string;
  intent: string;
  cuts: number[];
  text: string;
  shownSec: number;
  orientation: 'vertical' | 'horizontal';
  frame: string | null;
  what: string;
};

/** cuts.json のテロップグループ（meta.telopGroups があればそれ、無ければ同一文言の連続から作る） */
const telopTargets = (cuts: ReelData): {id: string; intent: string; cuts: number[]}[] => {
  const byId = new Map<string, number>();
  cuts.cuts.forEach((c, i) => c.id && byId.set(c.id, i));
  const meta = cuts.meta?.telopGroups ?? [];
  const groups = meta.length
    ? meta
        .map((g) => ({id: g.id, intent: g.intent, cuts: g.cutIds.map((cid) => byId.get(cid)).filter((i): i is number => i !== undefined)}))
        .filter((g) => g.cuts.length)
    : telopGroupsOf(cuts).map((g, i) => ({id: `g${String(i + 1).padStart(2, '0')}`, intent: 'body', cuts: g.cutIndices}));

  // ── どのグループにも入っていないカットを拾う ──────────────────────
  // telopGroupsOf は **main を持つカットしか見ない**（エンジンのグループ化と同じ判定のため）。
  // あとから足したカットや、構成の都合でテロップを付けなかったカットは main が無く、
  // そのままだと「AI にテロップを書いてもらう」の対象に永久に入らない
  // （18 カットあるのに 11 グループしか出ない、という形で表面化した）。
  // 会話字幕（subs）のカットだけは対象外のまま（あちらは別の作り）。
  const covered = new Set<number>(groups.flatMap((g) => g.cuts));
  cuts.cuts.forEach((c, i) => {
    if (covered.has(i) || c.subs?.length) return;
    groups.push({id: `g-${c.id ?? String(i + 1).padStart(2, '0')}`, intent: 'body', cuts: [i]});
  });
  return groups.sort((a, b) => (a.cuts[0] ?? 0) - (b.cuts[0] ?? 0));
};

/** {{gNN:intent}} が残っているテロップを Claude に書かせる */
export async function aiTelop(
  projectDir: string,
  opt: {force?: boolean; model?: string; onLine?: (l: string) => void; onProgress?: AiProgress; signal?: AbortSignal} = {},
): Promise<AiTelopResult> {
  const log = opt.onLine ?? (() => {});
  const env = loadOrderEnv(projectDir);
  const cuts = readCuts(projectDir);
  const {spec, persona, brief, catalog} = env;
  const rule = spec.telop;

  const alias = new Map((cuts.meta?.aliases ?? []).map((a) => [a.to, a.from]));
  const clipOf = (c: Cut): Clip | undefined => {
    const real = alias.get(c.src) ?? c.src;
    return catalog.clips.find((x) => x.src === real || x.proxyOf === real);
  };

  const all = telopTargets(cuts);
  const skipped: string[] = [];
  const cleared: string[] = [];
  const targets: TelopTarget[] = [];
  for (const g of all) {
    const first = cuts.cuts[g.cuts[0]];
    const text = first.main?.text ?? '';
    if (first.subs?.length) {
      skipped.push(`${g.id}: 会話字幕（subs）なので触らない`);
      continue;
    }
    if (!opt.force && !isPlaceholder(text)) {
      skipped.push(`${g.id}: 記入済み（${text || '無言カット'}）`);
      continue;
    }
    const shownSec = g.cuts.reduce((s, i) => s + cutDurationSec(cuts.cuts[i]), 0);
    const what = g.cuts
      .map((i) => {
        const cl = clipOf(cuts.cuts[i]);
        return cl?.tags?.description || cl?.tags?.subject || cl?.slug || cuts.cuts[i].src;
      })
      .filter((v, i, a) => a.indexOf(v) === i)
      .join(' / ');
    const frame = await ensureCutFrame(projectDir, first.src, first.inSec + 0.3, 320);
    targets.push({
      id: g.id,
      intent: g.intent,
      cuts: g.cuts,
      text,
      shownSec,
      orientation: (first.main?.orientation ?? 'vertical') as 'vertical' | 'horizontal',
      frame: frame ? path.relative(projectDir, frame).replace(/\\/g, '/') : null,
      what,
    });
  }
  if (!targets.length) {
    log('書くテロップがありません（未記入なし）');
    return {filled: [], skipped, costUsd: 0};
  }
  log(`テロップの対象: ${targets.length} 件（全 ${cuts.cuts.length} カット）${skipped.length ? ` / 触らない ${skipped.length} 件` : ''}`);

  const facts = [...catalog.facts, ...Object.entries(brief.facts).map(([k, v]) => `${k}: ${v}`)];
  const lines = targets.map((t) => {
    const soft = Math.max(4, Math.min(rule.maxChars, Math.floor(t.shownSec / rule.secPerChar)));
    return `- ${t.id} / 役割 ${t.intent} / 表示 ${t.shownSec.toFixed(1)}秒（目安 ${soft} 文字・上限 ${rule.maxChars} 文字）/ 映っているもの: ${t.what}${t.frame ? ` / 画: ${t.frame}` : ''}`;
  });

  const prompt = [
    `グルメのショート動画のテロップを書いてほしい。${spec.id}「${spec.name}」/ 人格は ${persona.label}。`,
    `店: ${brief.shop.name}（${brief.shop.area}・${brief.shop.genre}）${brief.shop.pr ? '／PR案件' : ''}`,
    brief.core ? `企画の核: ${brief.core}` : '',
    '',
    '書くグループ（各グループは複数カットにまたがることがある。1 グループ＝1 文言）:',
    ...lines,
    '',
    '各グループの「画」を Read で見て、実際に映っているものと食い違わない文言にすること。1 枚ずつ見る。',
    '',
    '守ること:',
    `- 文体: ${persona.tone}`,
    `- ${rule.maxChars} 文字以内。表示秒数に対して長いと読めないので、上の「目安 N 文字」に収める`,
    '- 文末に句点（。）を付けない',
    '- 半角括弧 ( ) と絵文字は使わない',
    '- 金額は書かない（キャプション側で書く）',
    '- 保存・いいね・シェア・コメントを促す文言は書かない',
    `- 「・・・」による焦らしは全体で ${rule.maxEllipsis} 回まで。山場の直前に絞る`,
    '- 同じ言い回し・同じ語尾を続けない',
    persona.id === 'hiro' || persona.id === 'nagi'
      ? [
          '- 役割 hook は「エリア＋一桁数字」型。ただし **エリア名は縦書きの本文に入れず、バッジ（badge）に出す**',
          `  badge に「${brief.shop.area || 'エリア名'}」、本文はエリア名が無くても意味が通る言い回しにする`,
          '  ✕「生野区、9割が知らない」（エリア名が本文に入っている）',
          '  ◯ badge「生野区」＋本文「地元の9割が知らない」／「大阪の9割が知らない」／「9割が素通りする」',
          '  本文はそのまま残さず**言い換えて**よい。主語が消えて意味が通らない断片にしないこと',
          '- 店名は hook に出さない',
        ].join('\n')
      : '',
    `- 役割 reveal は店名「${brief.shop.name}」を出すカット`,
    `- 役割 cta（締め）は ${persona.cta.join('／')} 系で言い切る`,
    '- 役割が access / hours / budget / menu / crowd / scene / howto / caution のものは、その実用情報を書く（保存される理由になる部分）',
    '',
    facts.length ? `裏取り済みの事実（ここに無いことは書かない。推測で料理名や数字を作らない）:\n${facts.map((f) => `- ${f}`).join('\n')}` : '裏取り済みの事実が登録されていないので、映像から確実に言えることだけ書く。料理名や数字を推測で作らない。',
  ]
    .filter(Boolean)
    .join('\n');

  log(`AI テロップ: ${targets.length} グループを書く（model=${opt.model ?? studioConfig.agent.model}）`);
  const {onEvent} = agentProgress({watch: targets.map((t) => t.frame ?? ''), onProgress: opt.onProgress, log, labels: {thinking: 'テロップを考えています', writing: 'テロップを書き出しています'}});
  const run: AgentRun<TelopResponse> = await runAgent<TelopResponse>({
    cwd: projectDir,
    prompt,
    schema: TELOP_SCHEMA,
    model: opt.model ?? studioConfig.agent.model,
    timeoutMs: studioConfig.agent.timeoutMs,
    onLine: log,
    onEvent,
    signal: opt.signal,
  });
  opt.onProgress?.(targets.length, targets.length, '反映中');

  const byIdTarget = new Map(targets.map((t) => [t.id, t]));
  const filled: AiTelopResult['filled'] = [];
  const next = {...cuts, cuts: cuts.cuts.map((c) => ({...c}))};
  for (const g of run.data.groups ?? []) {
    const t = byIdTarget.get(g.id);
    if (!t) {
      skipped.push(`${g.id}: 一覧に無い id`);
      continue;
    }
    const text = g.text.trim();
    if (!text) {
      // 空文字は「このカットにはテロップを出さない」という意思表示として扱う。
      // 速いカット割りではテロップを出さないカットが要る（全カットに文字を置くと読めない）
      for (const i of t.cuts) {
        const {main: _drop, ...rest} = next.cuts[i];
        next.cuts[i] = rest;
      }
      cleared.push(t.id);
      continue;
    }
    // 役割名や文字数の注釈を丸ごと書いてくる場合がある（弱いモデルで起きる）。
    // 明らかにテロップでないものは cuts.json に入れない
    if (/[\r\n]/.test(text) || countChars(text) > rule.maxChars * 2) {
      skipped.push(`${t.id}: テロップとして不正な文字列が返ってきたので書かない（${countChars(text)}文字${/[\r\n]/.test(text) ? '・改行あり' : ''}）: ${text.replace(/\s+/g, ' ').slice(0, 40)}…`);
      continue;
    }
    const orientation = g.orientation ?? t.orientation;
    for (const i of t.cuts) next.cuts[i] = {...next.cuts[i], main: {...(next.cuts[i].main ?? {}), text, ...(orientation === 'horizontal' ? {orientation: 'horizontal' as const} : {})}};
    // バッジはグループの先頭カットだけに付ける（エリア名を本文から出す用途）
    if (g.badge !== undefined && t.cuts.length) {
      const head = t.cuts[0];
      const badge = g.badge.trim();
      if (badge) next.cuts[head] = {...next.cuts[head], badge};
      else {
        const {badge: _drop, ...rest} = next.cuts[head] as typeof next.cuts[number] & {badge?: string};
        next.cuts[head] = rest;
      }
    }
    // 同一グループで orientation を揃える（違うとフェードインが 2 回になる）
    if (orientation === 'vertical') for (const i of t.cuts) if (next.cuts[i].main) delete next.cuts[i].main!.orientation;
    filled.push({id: t.id, before: t.text, text});
    const n = countChars(text);
    const need = minDisplaySec(text, {secPerChar: rule.secPerChar, floorSec: rule.floorSec});
    const warn = [n > rule.maxChars ? `${n}文字` : '', need > t.shownSec + 0.001 ? `表示 ${t.shownSec.toFixed(1)}秒 < 目安 ${need.toFixed(1)}秒` : ''].filter(Boolean).join(' / ');
    log(`  ${t.id} [${t.intent}] ${text}${warn ? `  ※ ${warn}` : ''}`);
  }

  // AI が書いたものは draft 扱い（人が見て直す前提）
  if (next.meta?.slots) {
    const filledCutIds = new Set(filled.flatMap((f) => byIdTarget.get(f.id)!.cuts.map((i) => next.cuts[i].id)));
    next.meta = {...next.meta, slots: next.meta.slots.map((s) => (filledCutIds.has(s.cutId) ? {...s, textStatus: 'draft' as const} : s))};
  }
  writeCuts(projectDir, next);
  const validation = validateProject(projectDir);
  log(`AI テロップ完了: ${filled.length} グループ / $${run.costUsd.toFixed(3)}`);
  if (run.data.notes) log(`意図: ${run.data.notes}`);
  return {filled, skipped, costUsd: run.costUsd, notes: run.data.notes, validation};
}

// ───────────────────────── ナレーション原稿 ─────────────────────────

const NARRATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['blocks'],
  properties: {
    blocks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'at', 'text'],
        properties: {
          id: {type: 'string', description: '連番＋内容の短い英字（例 01_intro / 04_yaki）'},
          at: {type: 'number', description: '動画の先頭からの配置秒。前のブロックの読み終わりより後ろにする'},
          text: {type: 'string', description: '読み上げる文そのものだけ。役割名・秒数・注釈・改行は入れない'},
        },
      },
    },
    notes: {type: 'string', description: '構成の意図を 1〜2 行で'},
  },
} as const;

type NarrationResponse = {blocks: {id: string; at: number; text: string}[]; notes?: string};

export type AiNarrationResult = {
  blocks: {id: string; at: number; text: string; estSec: number}[];
  findings: string[];
  costUsd: number;
  notes?: string;
  videoSec: number;
};

/** cuts.json のテロップと画を見て、ナレーション原稿（narration.json）を書く。音声生成は別工程 */
export async function aiNarration(
  projectDir: string,
  opt: {model?: string; onLine?: (l: string) => void; onProgress?: AiProgress; signal?: AbortSignal} = {},
): Promise<AiNarrationResult> {
  const log = opt.onLine ?? (() => {});
  const env = loadOrderEnv(projectDir);
  const {persona, brief, catalog} = env;
  const cuts = readCuts(projectDir);
  const videoSec = totalSec(cuts);
  const cps = persona.narration.charsPerSec;

  const alias = new Map((cuts.meta?.aliases ?? []).map((a) => [a.to, a.from]));
  const clipOf = (c: Cut) => {
    const real = alias.get(c.src) ?? c.src;
    return catalog.clips.find((x) => x.src === real || x.proxyOf === real);
  };
  const frames = await Promise.all(cuts.cuts.map((c) => ensureCutFrame(projectDir, c.src, c.inSec + 0.3, 320)));

  // カットの累積タイムライン（narration-tts.md §3 の設計手順1）
  let cursor = 0;
  const rows = cuts.cuts.map((c, i) => {
    const dur = cutDurationSec(c);
    const start = cursor;
    cursor += dur;
    const cl = clipOf(c);
    const f = frames[i];
    return `- ${start.toFixed(2)}〜${(start + dur).toFixed(2)}秒（${dur.toFixed(2)}秒）/ テロップ「${c.main?.text ?? (c.subs?.length ? '（会話字幕）' : '無し')}」/ 映像: ${cl?.tags?.description ?? cl?.slug ?? c.src}${f ? ` / 画 ${path.relative(projectDir, f).replace(/\\/g, '/')}` : ''}`;
  });

  const facts = [...catalog.facts, ...Object.entries(brief.facts).map(([k, v]) => `${k}: ${v}`)];
  // キャプション（caption.txt）は店の情報の要約なので、テロップを肉付けする材料として渡す
  const caption = (readCaption(projectDir) ?? '').trim();
  const prompt = [
    `グルメのショート動画のナレーション原稿を書いてほしい。動画は全体 ${videoSec.toFixed(2)} 秒・${cuts.cuts.length} カットで、テロップは入り終わっている。`,
    `店: ${brief.shop.name}（${brief.shop.area}・${brief.shop.genre}）／人格 ${persona.label}／ボイス ${persona.narration.voiceTitle}・speed ${persona.narration.speed}`,
    brief.core ? `企画の核: ${brief.core}` : '',
    '',
    'カットとテロップ（先頭からの秒数）:',
    ...rows,
    '',
    '判断に画が要るカットは「画」のパスを Read で見る（1 枚ずつ）。',
    '',
    '守ること:',
    '- **テロップの内容に沿って書く（最優先）。** 各テロップが出ている区間では、そのテロップが言っていることを話し言葉に言い換えて読む。テロップに無い話題を主役にしない。テロップと矛盾しない',
    '- **一字一句同じ文にはしない。** 言い回しを変える・主語や理由を補う・下のキャプションや裏取り済みの事実で肉付けする（「〜が名物」→「名物の〜は、…」のように）',
    `- **動画の尺に合わせる。** 実測話速は ${persona.narration.charsPerSecMeasured} 文字/秒。各ブロックの文字数は「そのテロップ区間の秒数 × ${cps}」を上限にし、全体では動画尺の 6〜8 割を声で埋める。最後のブロックは ${videoSec.toFixed(2)} 秒までに読み終える`,
    '- ブロックは内容のまとまり（≒テロップの切れ目）で区切る。3〜5 は**下限**であって上限ではない',
    '- **無音を作らない。** テロップがあるのにナレーションが 2 秒以上途切れる箇所を作らない。短いつなぎカットは前後のブロックに含めてよい',
    `- 文体: ${persona.tone}`,
    persona.id === 'hiro' || persona.id === 'sayuri' ? '- 語尾に「〜わ」を使わない。「〜んや」「〜のや」で言い切らない（「〜んやって」「〜んやった」と後ろへ接続するのは可）' : '',
    '- 同じ語尾を続けない（「〜た」「〜た」「〜た」のような単調な連続を避ける）',
    '- **固有名詞・数字＋単位・読みが割れる漢字はひらがな・カタカナに開く**（TTS の誤読対策。「牛すじ」→「ぎゅうすじ」、「350g」→「350グラム」、「大盛り」→「おおもり」、読みが割れる店名は かな書き。テロップは漢字のままでよい）',
    '- 文中の句点（。）は 0.7 秒前後の間を生む。詰めたいときは読点（、）にする',
    `- 締めは来店を促す表現のみ（${persona.cta.join('／')} 系）。保存・いいね・シェア・コメントを促す文言は禁止`,
    '- 金額をナレーションで読み上げない',
    '',
    `at は動画の先頭からの秒数。前のブロックの読み終わり（文字数 ÷ ${cps} 秒）より後ろに置き、重ならないようにする。最後のブロックは ${videoSec.toFixed(2)} 秒までに読み終わるようにする。`,
    '',
    facts.length ? `裏取り済みの事実（ここに無いことは書かない。推測で料理名や数字を作らない）:\n${facts.map((f) => `- ${f}`).join('\n')}` : '裏取り済みの事実が登録されていないので、映像から確実に言えることだけ書く。',
    caption ? `\n投稿キャプション（店の情報の要約。テロップを肉付けする材料にする。金額・ハッシュタグ・URL・住所はナレーションに読まない）:\n${caption.slice(0, 1500)}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  log(`AI ナレーション: ${videoSec.toFixed(1)} 秒 / ${cuts.cuts.length} カット（model=${opt.model ?? studioConfig.agent.model}）${caption ? ' / キャプション参照あり' : ''}`);
  // 画を見ずに原稿を書くことが多い（見るのは任意）。その間も heartbeat で経過秒とツール回数が進む
  const {onEvent} = agentProgress({watch: frames.filter((f): f is string => !!f), onProgress: opt.onProgress, log, labels: {thinking: '原稿を考えています', writing: '原稿を書き出しています'}});
  const run = await runAgent<NarrationResponse>({
    cwd: projectDir,
    prompt,
    schema: NARRATION_SCHEMA,
    model: opt.model ?? studioConfig.agent.model,
    timeoutMs: studioConfig.agent.timeoutMs,
    onLine: log,
    onEvent,
    signal: opt.signal,
  });

  // 見積もり尺で重なり・無音・予算超過を点検する（実尺は音声生成後に測り直す）
  const blocks = [...(run.data.blocks ?? [])]
    .filter((b) => b.text.trim() && !/[\r\n]/.test(b.text))
    .sort((a, b) => a.at - b.at)
    .map((b) => ({...b, text: b.text.trim(), at: Math.max(0, Math.round(b.at * 1000) / 1000), estSec: Math.round((countChars(b.text) / cps) * 1000) / 1000}));
  const findings: string[] = [];
  if (!blocks.length) findings.push('ブロックが 1 つも返ってこなかった');
  blocks.forEach((b, i) => {
    const prev = blocks[i - 1];
    if (prev && b.at < prev.at + prev.estSec - 0.001)
      findings.push(`${b.id}: ${prev.id} の読み終わり（${(prev.at + prev.estSec).toFixed(2)}秒）より前に始まる（at ${b.at.toFixed(2)}）`);
    if (prev && b.at - (prev.at + prev.estSec) >= 2) findings.push(`${prev.id} と ${b.id} の間に ${(b.at - prev.at - prev.estSec).toFixed(1)} 秒の無音`);
  });
  const last = blocks[blocks.length - 1];
  if (last && last.at + last.estSec > videoSec + 0.05) findings.push(`最後の ${last.id} が動画尺 ${videoSec.toFixed(2)} 秒を ${(last.at + last.estSec - videoSec).toFixed(2)} 秒はみ出す`);
  if (blocks.length && blocks[0].at >= 2) findings.push(`冒頭 ${blocks[0].at.toFixed(1)} 秒が無音`);

  // 音声はまだ無いので needsTts を立てる（durSec は生成後に実測して入れる）
  const narration = NarrationSchema.parse({
    voice: persona.narration.voiceId,
    voiceTitle: persona.narration.voiceTitle,
    latency: 'normal',
    speed: persona.narration.speed,
    videoSec: Math.round(videoSec * 1000) / 1000,
    note: run.data.notes,
    segments: blocks.map((b) => ({id: b.id, at: b.at, text: b.text, needsTts: true})),
  });
  writeNarration(projectDir, narration);

  opt.onProgress?.(cuts.cuts.length, cuts.cuts.length, '書き出し完了');
  log(`AI ナレーション完了: ${blocks.length} ブロック / $${run.costUsd.toFixed(3)}`);
  for (const b of blocks) log(`  ${b.at.toFixed(2)}s (${countChars(b.text)}字/約${b.estSec.toFixed(1)}s) ${b.text}`);
  for (const f of findings) log(`  ! ${f}`);
  return {blocks, findings, costUsd: run.costUsd, notes: run.data.notes, videoSec};
}

// ───────────────────────── 店舗情報の裏取り ─────────────────────────

/**
 * 調べさせる項目。**キーを固定する**のは、案件をまたいでキャプションの実用情報ブロックの
 * 並びを揃えるため（統一感）と、既存の brief.facts と突き合わせやすくするため。
 */
export const FACT_KEYS = ['住所', 'アクセス', '営業時間', '定休日', '電話番号', 'Instagram', '予約', '席', '支払い', '備考'] as const;

const FACTS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['facts'],
  properties: {
    facts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'value', 'source'],
        properties: {
          key: {type: 'string', description: '項目名。できるだけ 住所 / アクセス / 営業時間 / 定休日 / 電話番号 / Instagram / 予約 / 席 / 支払い / 備考 から選ぶ'},
          value: {type: 'string', description: 'そのまま書ける値。推測や「〜と思われる」は入れない'},
          source: {type: 'string', enum: ['instagram', 'googlemaps', 'official', 'other'], description: 'どこで確認したか'},
          sourceUrl: {type: 'string', description: '確認したページの URL'},
          confidence: {type: 'string', enum: ['high', 'low'], description: '複数の出典で一致すれば high、1 か所だけ・古そうなら low'},
        },
      },
    },
    instagram: {type: 'string', description: '店の公式 Instagram のハンドル（@なし）。確認できたときだけ'},
    googleMapsUrl: {type: 'string', description: 'Google マップの該当ページ URL'},
    conflicts: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['key', 'chose', 'detail'],
        properties: {key: {type: 'string'}, chose: {type: 'string'}, detail: {type: 'string', description: 'どちらが何と言っていたか'}},
      },
      description: 'Instagram と Google マップ等で食い違った項目',
    },
    unresolved: {type: 'array', items: {type: 'string'}, description: '調べたが確認できなかった項目'},
    notes: {type: 'string'},
  },
} as const;

type FactSource = 'instagram' | 'googlemaps' | 'official' | 'other';

type FactsResponse = {
  facts: {key: string; value: string; source: FactSource; sourceUrl?: string; confidence?: 'high' | 'low'}[];
  instagram?: string;
  googleMapsUrl?: string;
  conflicts?: {key: string; chose: string; detail: string}[];
  unresolved?: string[];
  notes?: string;
};

const SOURCE_LABEL: Record<FactSource, string> = {
  instagram: 'Instagram',
  googlemaps: 'Google マップ',
  official: '公式サイト',
  other: 'その他Web',
};

export type AiFactsResult = {
  facts: Record<string, string>;
  added: string[];
  kept: string[];
  differed: {key: string; before: string; after: string}[];
  conflicts: NonNullable<FactsResponse['conflicts']>;
  unresolved: string[];
  instagram?: string;
  costUsd: number;
  notes?: string;
};

/**
 * 店の住所・営業時間などを Web で裏取りして brief.facts に入れる。
 *
 * 出典の優先順位（上が強い）:
 *   1. 素材映像・店内の掲示から読み取ったもの（catalog.facts）— **Web より強い**。
 *      過去に Web の価格が改定前で、素材のメニュー映像の方が正しかった実例があるため
 *   2. 店の公式 Instagram — **Google マップより強い**（ユーザー指示。実際こちらが正しいことが多い）
 *   3. Google マップ
 *   4. その他（食べログ・ぐるなび等）
 *
 * エージェントには WebSearch / WebFetch を渡すが、書き込み系は渡さない（反映はこの関数が行う）。
 */
export async function aiFacts(
  projectDir: string,
  opt: {model?: string; force?: boolean; onLine?: (l: string) => void; onProgress?: AiProgress; signal?: AbortSignal} = {},
): Promise<AiFactsResult> {
  const log = opt.onLine ?? (() => {});
  const brief = readBrief(projectDir);
  if (!brief) throw new Error('brief.json が無いので店を特定できません');
  const catalog = loadCatalog(projectDir);
  const known = Object.entries(brief.facts);
  const fromFootage = catalog?.facts ?? [];

  const prompt = [
    'グルメ動画のキャプションに載せる店舗情報を、Web で裏取りしてほしい。',
    '',
    `店: ${brief.shop.name}`,
    `エリア: ${brief.shop.area}${brief.shop.station ? `（最寄り ${brief.shop.station}）` : ''}`,
    brief.shop.genre ? `ジャンル: ${brief.shop.genre}` : '',
    '',
    `調べる項目: ${FACT_KEYS.join(' / ')}`,
    '',
    '**出典の優先順位（上が強い。食い違ったら上を採る）:**',
    '1. 下に挙げる「素材映像から読み取った事実」（店内の掲示・メニュー・看板）。Web より強い',
    '2. **店の公式 Instagram**（プロフィール・固定投稿・ハイライト）。**Google マップより優先する**',
    '3. Google マップ',
    '4. その他（食べログ・ぐるなび・ホットペッパー等）',
    '',
    '進め方:',
    '- まず WebSearch で店の公式 Instagram アカウントを探す（「店名 エリア instagram」等）。見つけたら WebFetch でプロフィールを読む',
    '- Instagram のページがログイン壁で読めないことがある。その場合は検索結果のスニペットや、Instagram の投稿を引用している記事から拾ってよい（出典は instagram のままでよいが confidence は low にする）',
    '- Instagram で分からない項目だけ Google マップやその他で補う',
    '- **Instagram と Google マップで食い違ったら Instagram を採り、conflicts に「どちらが何と言っていたか」を残す**',
    '- 同名・近隣の別店舗を掴まないよう、住所かエリアが一致することを必ず確認する',
    '',
    '守ること:',
    '- **確認できなかった項目は書かない。** unresolved に項目名を入れる。推測で埋めない',
    '- 営業時間は表記をそのまま（「17:00〜翌3:00（不定休）」のように）。ランチ・ディナーが分かれているならその通りに',
    '- 値は日本語でそのまま貼れる形にする（「〜と思われる」「要確認」などの断り書きは入れない）',
    '- 1 か所でしか確認できなかった・情報が古そうなものは confidence を low にする',
    '',
    fromFootage.length
      ? `素材映像から読み取った事実（**これと矛盾する Web 情報は採用しない**）:\n${fromFootage.map((f) => `- ${f}`).join('\n')}`
      : '素材映像からの読み取りはまだ無い。',
    '',
    known.length
      ? `すでに brief.json に入っている情報（裏取り済み。基本はこちらが正）:\n${known.map(([k, v]) => `- ${k}: ${v}`).join('\n')}`
      : 'brief.json にはまだ店舗情報が無い。',
  ]
    .filter(Boolean)
    .join('\n');

  log(`店舗情報の裏取り: ${brief.shop.name}（${brief.shop.area}）／Instagram 優先（model=${opt.model ?? studioConfig.agent.model}）`);
  opt.onProgress?.(0, 0, 'claude を起動しています');
  let seen = 0;
  let lastPhase = '検索中';
  const step = (phase: string) => {
    lastPhase = phase;
    opt.onProgress?.(Math.min(++seen, FACT_KEYS.length), FACT_KEYS.length, phase);
  };
  const run = await runAgent<FactsResponse>({
    cwd: projectDir,
    prompt,
    schema: FACTS_SCHEMA,
    model: opt.model ?? studioConfig.agent.model,
    // 調査なので Web を読ませる。書き込み系は渡さない（brief.json への反映はこの関数が行う）
    allowedTools: ['Read', 'Glob', 'WebSearch', 'WebFetch'],
    timeoutMs: studioConfig.agent.timeoutMs,
    onLine: log,
    onEvent: (e) => {
      if (e.kind === 'heartbeat') return opt.onProgress?.(Math.min(seen, FACT_KEYS.length), seen ? FACT_KEYS.length : 0, `${lastPhase}（${fmtElapsed(e.elapsedSec)}）`);
      if (e.kind === 'init') return opt.onProgress?.(0, 0, 'claude が起動しました');
      if (e.kind !== 'tool') return;
      if (e.name === 'WebSearch') step(`検索中「${String((e.input as {query?: string}).query ?? '')}」`.slice(0, 64));
      else if (e.name === 'WebFetch') step(`確認中 ${String((e.input as {url?: string}).url ?? '').replace(/^https?:\/\//, '').slice(0, 44)}`);
      else if (e.name === 'StructuredOutput') step('結果を書き出しています');
    },
    signal: opt.signal,
  });

  // 反映：既存のキーは**上書きしない**（素材やユーザーが直した値の方が強い）。force のときだけ入れ替える
  const facts: Record<string, string> = {...brief.facts};
  const added: string[] = [];
  const kept: string[] = [];
  const differed: {key: string; before: string; after: string}[] = [];
  // 同じキーを 2 回返してくることがある（「備考」など）。2 件目を「既存との食い違い」と
  // 誤判定しないよう、**このレスポンス内の重複はつなげて 1 件にまとめる**
  const incoming = new Map<string, string>();
  for (const f of run.data.facts ?? []) {
    const key = f.key.trim();
    if (!key || !f.value.trim()) continue;
    const value = `${f.value.trim()}（${SOURCE_LABEL[f.source] ?? f.source}${f.confidence === 'low' ? '・要確認' : ''}）`;
    const dup = incoming.get(key);
    incoming.set(key, dup ? `${dup} / ${value}` : value);
  }
  for (const [key, value] of incoming) {
    const before = facts[key];
    if (before === undefined) {
      facts[key] = value;
      added.push(key);
      continue;
    }
    if (before === value) continue;
    if (opt.force) {
      facts[key] = value;
      differed.push({key, before, after: value});
    } else {
      kept.push(key);
      differed.push({key, before, after: value});
    }
  }
  const handle = run.data.instagram?.replace(/^@/, '').trim();
  if (handle && facts['Instagram'] === undefined) {
    facts['Instagram'] = `@${handle}（Instagram）`;
    added.push('Instagram');
  }
  writeBrief(projectDir, {...brief, facts});

  const conflicts = run.data.conflicts ?? [];
  const unresolved = run.data.unresolved ?? [];
  opt.onProgress?.(FACT_KEYS.length, FACT_KEYS.length, '書き出し完了');
  log(`裏取り完了: 追加 ${added.length} 件${kept.length ? ` / 既存を維持 ${kept.length} 件` : ''}（$${run.costUsd.toFixed(3)}）`);
  for (const k of added) log(`  + ${k}: ${facts[k]}`);
  for (const d of differed)
    log(`  ${opt.force ? '↑' : '?'} ${d.key}: ${opt.force ? `${d.before} → ${d.after}` : `Web は「${d.after}」だったが既存の「${d.before}」を残した`}`);
  for (const c of conflicts) log(`  ! 食い違い ${c.key}: ${c.detail} → ${c.chose} を採用`);
  for (const u of unresolved) log(`  ? 確認できず: ${u}`);
  return {facts, added, kept, differed, conflicts, unresolved, instagram: handle, costUsd: run.costUsd, notes: run.data.notes};
}

// ───────────────────────── キャプション ─────────────────────────

const CAPTION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['caption'],
  properties: {
    caption: {type: 'string', description: 'Instagram にそのまま貼れる本文。改行も含めた完成形だけを入れる（前置き・見出し・コードブロックは付けない）'},
    missing: {type: 'array', items: {type: 'string'}, description: '裏取りできず ＿＿＿ で残した項目（品名・価格・住所・営業時間・IG ハンドルなど）'},
    notes: {type: 'string', description: '構成の意図を 1〜2 行で'},
  },
} as const;

type CaptionResponse = {caption: string; missing?: string[]; notes?: string};

export type AiCaptionResult = {caption: string; file: string; issues: CaptionIssue[]; missing: string[]; costUsd: number; notes?: string; research?: AiFactsResult};

/** 同じ人格で過去に書いたキャプションを、書き方の手本として渡す（新しい順に n 件） */
export const captionExamples = (personaId: string, exclude: string, n = 2): string[] => {
  const root = studioConfig.workDir;
  if (!fs.existsSync(root)) return [];
  const found: {file: string; mtime: number}[] = [];
  for (const name of fs.readdirSync(root)) {
    const dir = path.join(root, name);
    if (dir === exclude || !fs.statSync(dir).isDirectory()) continue;
    const file = ['caption.txt', 'caption.md'].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
    if (!file) continue;
    try {
      const b = JSON.parse(fs.readFileSync(path.join(dir, 'brief.json'), 'utf8')) as {persona?: string};
      if (b.persona !== personaId) continue;
    } catch {
      continue; // brief.json が無い＝どの人格のものか分からないので手本にしない
    }
    found.push({file, mtime: fs.statSync(file).mtimeMs});
  }
  return found.sort((a, b) => b.mtime - a.mtime).slice(0, n).map((f) => f.file);
};

/**
 * cuts.json のテロップ・narration.json・裏取り済みの事実から caption.txt を書く。
 * 書き方の規則はコードに写さず、人格の SKILL.md「Step 4」を読ませる（あちらが正）。
 */
export async function aiCaption(
  projectDir: string,
  opt: {
    model?: string;
    instruction?: string;
    /** 書く前に店舗情報を Web で裏取りする（既定 true）。false で手持ちの facts だけで書く */
    research?: boolean;
    /** 裏取りで既存の facts を上書きする */
    researchForce?: boolean;
    onLine?: (l: string) => void;
    onProgress?: AiProgress;
    signal?: AbortSignal;
  } = {},
): Promise<AiCaptionResult> {
  const log = opt.onLine ?? (() => {});
  // キャプションには住所・営業時間が入る。まず裏取りして brief.facts を埋めてから書く
  // （facts に無いことは書かせない作りなので、ここを先にやらないと ＿＿＿ ばかりになる）
  let research: AiFactsResult | undefined;
  if (opt.research !== false) {
    try {
      research = await aiFacts(projectDir, {model: opt.model, force: opt.researchForce, onLine: log, onProgress: opt.onProgress, signal: opt.signal});
    } catch (e) {
      // 裏取りに失敗してもキャプションは書ける（確認できない項目は ＿＿＿ で残る）
      log(`! 店舗情報の裏取りに失敗したので、手持ちの情報だけで書きます: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const env = loadOrderEnv(projectDir);
  const {persona, brief, catalog} = env;
  const cuts = readCuts(projectDir);
  const narration = readNarration(projectDir);
  const existing = readCaption(projectDir);

  const skill = path.join(studioConfig.repoRoot, persona.skillDir, 'SKILL.md');
  const hashtagBank = path.join(studioConfig.repoRoot, persona.skillDir, 'references', 'hashtag-bank.md');
  const examples = captionExamples(brief.persona, projectDir);
  const rel = (p: string) => path.relative(projectDir, p).replace(/\\/g, '/');

  const telops = telopGroupsOf(cuts)
    .map((g) => g.def.text)
    .filter((t) => t && !isPlaceholder(t));
  const facts = [...catalog.facts, ...Object.entries(brief.facts).map(([k, v]) => `${k}: ${v}`)];

  // 「頂いたもの」は値札やメニュー表ではなく、実際に手に持って食べている画で決める。
  // facts（看板・値札の読み取り）だけを渡すと、棚に並んでいただけの品を食べたことにしてしまう
  const alias = new Map((cuts.meta?.aliases ?? []).map((a) => [a.to, a.from]));
  const frames = await Promise.all(cuts.cuts.map((c) => ensureCutFrame(projectDir, c.src, c.inSec + 0.3, 320)));
  const cutRows = cuts.cuts.map((c, i) => {
    const real = alias.get(c.src) ?? c.src;
    const cl = catalog.clips.find((x) => x.src === real || x.proxyOf === real);
    const f = frames[i];
    return `- ${cl?.tags?.description ?? cl?.slug ?? c.src}${f ? ` / 画 ${rel(f)}` : ''}`;
  });

  const prompt = [
    `グルメのショート動画の Instagram キャプションを書いてほしい。動画はもう完成している。`,
    '',
    '**まず次を Read すること（書き方の正はこちら。ここに書いていない型を作らない）:**',
    `1. ${rel(skill)} の「Step 4: キャプションの生成」`,
    `2. ${rel(hashtagBank)}（ハッシュタグはここから ${persona.caption.hashtags} 個ちょうど）`,
    ...examples.map((f, i) => `${i + 3}. ${rel(f)}（同じ人格で過去に書いた実例。型を真似る。中身は流用しない）`),
    '',
    `店: ${brief.shop.name}（${brief.shop.area}${brief.shop.station ? `・${brief.shop.station}` : ''}・${brief.shop.genre}）／${brief.shop.pr ? 'PR 案件' : 'PR ではない'}／人格 ${persona.label}`,
    brief.core ? `企画の核: ${brief.core}` : '',
    '',
    `動画に出ているテロップ（先頭から）:\n${telops.map((t) => `- ${t}`).join('\n')}`,
    narration ? `\nナレーション:\n${narration.segments.map((s) => `- ${s.text}`).join('\n')}` : '',
    '',
    `動画のカット（「頂いたもの」を決める前に、実食・手持ちが映っているカットの「画」を Read で確認する）:\n${cutRows.join('\n')}`,
    '',
    facts.length ? `裏取り済みの事実:\n${facts.map((f) => `- ${f}`).join('\n')}` : '裏取り済みの事実は登録されていない。',
    '',
    '守ること:',
    '- **確認できることだけ書く。** 料理名・価格・住所・営業時間・IG ハンドルを推測で作らない。素材やここに無い項目は行ごと省略するか ＿＿＿ にして、その項目を missing に入れる',
    '- 事実に付いている出典（Instagram / Google マップ 等）はキャプションには書かない。**「要確認」が付いている値は使わず ＿＿＿ にして missing に入れる**',
    '- **「頂いたもの」は素材映像で実食・手持ちが確認できる品だけ。** 値札・メニュー表・棚に並んでいるだけの品は「頂いたもの」に入れない（価格が facts にあることは、その品を食べた証拠にならない）。画で確認できない品は書かず、代わりに店の品ぞろえとして本文で触れる',
    '- 保存・いいね・シェア・コメント・フォローを促す文言は入れない（来店を促す一文は可）',
    '- 文末に句点「。」を付けない',
    `- ハッシュタグはちょうど ${persona.caption.hashtags} 個。#PR は入れない`,
    persona.caption.repostAccount ? `- 「他の投稿はコチラ」の誘導は @${persona.caption.repostAccount} で固定` : '',
    persona.caption.maxChars ? `- 長さは全体で ${persona.caption.maxChars} 文字程度まで` : '',
    existing ? `\nいまの caption.txt（これを踏まえて書き直す）:\n${existing}` : '',
    opt.instruction?.trim() ? `\nユーザーからの指示（最優先）:\n${opt.instruction.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  log(`AI キャプション: ${brief.shop.name}／手本 ${examples.length} 件（model=${opt.model ?? studioConfig.agent.model}）`);
  const watch = [skill, hashtagBank, ...examples, ...frames.filter((f): f is string => !!f)];
  const {onEvent} = agentProgress({watch, onProgress: opt.onProgress, log, labels: {reading: '確認中', thinking: '本文を考えています', writing: '本文を書き出しています'}});
  const run = await runAgent<CaptionResponse>({
    cwd: projectDir,
    prompt,
    schema: CAPTION_SCHEMA,
    model: opt.model ?? studioConfig.agent.model,
    timeoutMs: studioConfig.agent.timeoutMs,
    onLine: log,
    onEvent,
    signal: opt.signal,
  });

  // 前置きやコードフェンスを付けてくることがあるので剥がす
  const caption = (run.data.caption ?? '').replace(/^\s*```[a-z]*\n?/i, '').replace(/\n?```\s*$/, '').trim();
  if (!caption) throw new Error('キャプションが空で返ってきました');
  const file = writeCaption(projectDir, caption);
  const issues = checkCaption(caption, persona, {pr: brief.shop.pr});
  const missing = run.data.missing ?? [];

  opt.onProgress?.(watch.length, watch.length, '書き出し完了');
  const costUsd = run.costUsd + (research?.costUsd ?? 0);
  log(`AI キャプション完了: ${[...caption].length} 文字 / $${costUsd.toFixed(3)}${research ? `（うち裏取り $${research.costUsd.toFixed(3)}）` : ''} → ${path.basename(file)}`);
  log(formatCaptionIssues(issues));
  for (const m of missing) log(`  ? 要確認: ${m}`);
  return {caption, file, issues, missing, costUsd, notes: run.data.notes, research};
}

// ───────────────────────── 自由指示での修正 ─────────────────────────

const PATCH_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['summary'],
  properties: {
    summary: {type: 'string', description: '何をどう変えたかを 1〜3 行で。何も変えないときはその理由'},
    telops: {
      type: 'array',
      description: 'テロップ文言の変更。group（gNN）か cutId のどちらかで指す',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text'],
        properties: {group: {type: 'string'}, cutId: {type: 'string'}, text: {type: 'string'}, orientation: {type: 'string', enum: ['vertical', 'horizontal']}},
      },
    },
    narration: {
      type: 'array',
      description: 'ナレーションの変更。text を変えると音声を作り直す必要がある',
      items: {type: 'object', additionalProperties: false, required: ['id'], properties: {id: {type: 'string'}, text: {type: 'string'}, at: {type: 'number'}}},
    },
    cuts: {
      type: 'array',
      description: 'カットの区間・倍速・削除',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['cutId'],
        properties: {cutId: {type: 'string'}, inSec: {type: 'number'}, outSec: {type: 'number'}, playbackRate: {type: 'number'}, badge: {type: 'string'}, remove: {type: 'boolean'}},
      },
    },
    order: {type: 'array', items: {type: 'string'}, description: 'cutId の並べ替え。全カットを列挙する。並び替えないなら省略'},
    theme: {type: 'string', enum: ['pop', 'bold', 'human', 'stylish']},
    unapplied: {type: 'array', items: {type: 'string'}, description: 'できなかったこと・判断がつかず確認したいこと'},
  },
} as const;

type Patch = {
  summary: string;
  telops?: {group?: string; cutId?: string; text: string; orientation?: 'vertical' | 'horizontal'}[];
  narration?: {id: string; text?: string; at?: number}[];
  cuts?: {cutId: string; inSec?: number; outSec?: number; playbackRate?: number; badge?: string; remove?: boolean}[];
  order?: string[];
  theme?: 'pop' | 'bold' | 'human' | 'stylish';
  unapplied?: string[];
};

export type AiEditResult = {
  summary: string;
  applied: string[];
  unapplied: string[];
  /** text を変えたので音声を作り直す必要があるナレーション id */
  needsTts: string[];
  costUsd: number;
  validation?: ValidationResult;
};

/** 自由文の指示で cuts.json / narration.json を直す。エージェントは差分だけ返し、適用はこちらで行う */
export async function aiEdit(
  projectDir: string,
  instruction: string,
  opt: {model?: string; onLine?: (l: string) => void; onProgress?: AiProgress; signal?: AbortSignal} = {},
): Promise<AiEditResult> {
  const log = opt.onLine ?? (() => {});
  if (!instruction.trim()) throw new Error('指示が空です');
  const env = loadOrderEnv(projectDir);
  const {spec, persona, brief, catalog} = env;
  const cuts = readCuts(projectDir);
  const narration = readNarration(projectDir);

  const alias = new Map((cuts.meta?.aliases ?? []).map((a) => [a.to, a.from]));
  const clipOf = (c: Cut) => {
    const real = alias.get(c.src) ?? c.src;
    return catalog.clips.find((x) => x.src === real || x.proxyOf === real);
  };
  const slotOf = (c: Cut) => cuts.meta?.slots?.find((s) => s.cutId === c.id);
  const groupOf = (c: Cut) => cuts.meta?.telopGroups?.find((g) => c.id && g.cutIds.includes(c.id));

  // カットごとに 1 行。必要な絵だけ Read させるためフレームのパスも添える
  const frames = await Promise.all(cuts.cuts.map((c) => ensureCutFrame(projectDir, c.src, c.inSec + 0.3, 320)));
  const cutLines = cuts.cuts.map((c, i) => {
    const cl = clipOf(c);
    const g = groupOf(c);
    const f = frames[i];
    return `- ${c.id ?? `#${i + 1}`} / ${i + 1}番目 / 役割 ${slotOf(c)?.role ?? '-'} / ${c.inSec.toFixed(2)}〜${c.outSec.toFixed(2)}（${cutDurationSec(c).toFixed(2)}秒）${c.playbackRate ? ` / rate ${c.playbackRate}` : ''} / 素材 ${cl?.tags?.description ?? cl?.slug ?? c.src}${g ? ` / テロップ ${g.id}` : ''}「${c.main?.text ?? (c.subs?.length ? '（会話字幕）' : '（無し）')}」${f ? ` / 画 ${path.relative(projectDir, f).replace(/\\/g, '/')}` : ''}`;
  });

  const narrLines: string[] = [];
  if (narration) {
    const segs = [...narration.segments].sort((a, b) => a.at - b.at);
    segs.forEach((s, i) => {
      const nextAt = segs[i + 1]?.at;
      const room = nextAt === undefined ? totalSec(cuts) - s.at : nextAt - s.at;
      const maxChars = Math.max(1, Math.floor(room * persona.narration.charsPerSec));
      narrLines.push(`- ${s.id} / ${s.at.toFixed(2)}秒〜${s.durSec ? `（実測 ${s.durSec.toFixed(2)}秒）` : ''} / 次まで ${room.toFixed(2)}秒＝目安 ${maxChars} 文字 / ${countChars(s.text)} 文字「${s.text}」`);
    });
  }

  const prompt = [
    'グルメのショート動画の案件を直してほしい。ユーザーの指示は次のとおり:',
    '',
    `『${instruction.trim()}』`,
    '',
    `店: ${brief.shop.name}（${brief.shop.area}・${brief.shop.genre}）／型 ${spec.id}「${spec.name}」／人格 ${persona.label}／theme ${cuts.theme ?? spec.theme}／全体 ${totalSec(cuts).toFixed(2)}秒 ${cuts.cuts.length}カット`,
    '',
    'いまのカット:',
    ...cutLines,
    '',
    narration ? `いまのナレーション（ボイス ${narration.voiceTitle ?? narration.voice} / speed ${narration.speed ?? persona.narration.speed} / 実測 ${persona.narration.charsPerSecMeasured} 文字/秒）:` : 'ナレーションはまだ無い（narration.json 無し）。',
    ...narrLines,
    '',
    '指示に関係するところだけ直す。関係ないところは触らない。返すのは差分だけで、ファイルは自分で書き換えないこと。',
    '判断に絵が要るカットは「画」のパスを Read で見る（1 枚ずつ）。cuts.json / narration.json / brief.json / catalog.json / caption.txt（店の情報の要約。ナレーションを肉付けする材料。金額・ハッシュタグ・URL・住所は読まない）も Read で読める。',
    '',
    '守ること:',
    `- テロップ: ${spec.telop.maxChars} 文字以内・文末に句点を付けない・半角括弧と絵文字は使わない・金額は書かない・保存やいいねを促さない`,
    `- テロップの文体: ${persona.tone}`,
    `- ナレーション: **そのブロックの区間に出ているテロップの内容に沿って書く**（一字一句同じにはせず、言い換え・主語や理由の補足・キャプションや裏取り済みの事実で肉付けする）。上の「目安 N 文字」を超えると次のブロックに食い込む。語尾を連続させない。固有名詞や数字の単位は TTS が誤読しないようひらがなに開く（「牛すじ」→「ぎゅうすじ」、「350g」→「350グラム」。テロップは漢字のままでよい）`,
    persona.id === 'hiro' || persona.id === 'sayuri' ? '- ナレーションで「〜わ」の語尾は使わない' : '',
    '- カットの尺は 3 秒を超えない（会話字幕のカットは例外）',
    '- 同じテロップ文言が続くカットは 1 グループ。group で指すと全部まとめて変わる',
    '',
    'できないこと・判断がつかないことは unapplied に書いて、勝手に決めない。',
  ]
    .filter(Boolean)
    .join('\n');

  log(`AI 修正: 「${instruction.trim()}」（model=${opt.model ?? studioConfig.agent.model}）`);
  // 画を 1 枚も見ずに答えを書くことがあり、その間は tool のイベントが来ない。heartbeat で経過を出す
  const want = frames.filter((f): f is string => !!f);
  const {onEvent: step} = agentProgress({watch: want, onProgress: opt.onProgress, log, labels: {thinking: '直し方を考えています（画を見ずに書くこともあります）', writing: '差分を作っています'}});
  const run: AgentRun<Patch> = await runAgent<Patch>({
    cwd: projectDir,
    prompt,
    schema: PATCH_SCHEMA,
    model: opt.model ?? studioConfig.agent.model,
    timeoutMs: studioConfig.agent.timeoutMs,
    onLine: log,
    onEvent: step,
    signal: opt.signal,
  });
  opt.onProgress?.(want.length, want.length, '差分を適用しています');
  const patch = run.data;
  const applied: string[] = [];
  const unapplied = [...(patch.unapplied ?? [])];
  const needsTts: string[] = [];

  // ── cuts.json ──
  let nextCuts: ReelData = {...cuts, cuts: cuts.cuts.map((c) => ({...c, main: c.main ? {...c.main} : undefined}))};
  const indexOfCut = (id: string) => nextCuts.cuts.findIndex((c) => c.id === id);

  for (const e of patch.cuts ?? []) {
    const i = indexOfCut(e.cutId);
    if (i < 0) {
      unapplied.push(`cuts: ${e.cutId} が無い`);
      continue;
    }
    if (e.remove) {
      applied.push(`カット ${e.cutId} を削除`);
      nextCuts.cuts.splice(i, 1);
      continue;
    }
    const c = nextCuts.cuts[i];
    const before = `${c.inSec.toFixed(2)}〜${c.outSec.toFixed(2)}`;
    if (e.inSec !== undefined) c.inSec = e.inSec;
    if (e.outSec !== undefined) c.outSec = e.outSec;
    if (e.playbackRate !== undefined) {
      if (e.playbackRate === 1) delete c.playbackRate;
      else c.playbackRate = e.playbackRate;
    }
    if (e.badge !== undefined) {
      if (e.badge) c.badge = e.badge;
      else delete c.badge;
    }
    applied.push(`カット ${e.cutId} を ${before} → ${c.inSec.toFixed(2)}〜${c.outSec.toFixed(2)}`);
  }

  if (patch.order?.length) {
    const byId = new Map(nextCuts.cuts.map((c) => [c.id, c]));
    const reordered = patch.order.map((id) => byId.get(id)).filter((c): c is Cut => !!c);
    if (reordered.length !== nextCuts.cuts.length) unapplied.push(`order: ${nextCuts.cuts.length} カットのうち ${reordered.length} 個しか指定されていないので並べ替えは見送り`);
    else if (patch.order.join() !== nextCuts.cuts.map((c) => c.id).join()) {
      nextCuts.cuts = reordered;
      applied.push(`並び替え: ${patch.order.join(' → ')}`);
    }
  }

  for (const t of patch.telops ?? []) {
    const ids = t.group ? (nextCuts.meta?.telopGroups?.find((g) => g.id === t.group)?.cutIds ?? []) : t.cutId ? [t.cutId] : [];
    const idx = ids.map(indexOfCut).filter((i) => i >= 0);
    if (!idx.length) {
      unapplied.push(`telops: ${t.group ?? t.cutId ?? '(指定なし)'} が無い`);
      continue;
    }
    const before = nextCuts.cuts[idx[0]].main?.text ?? '';
    for (const i of idx) {
      const c = nextCuts.cuts[i];
      c.main = {...(c.main ?? {}), text: t.text};
      if (t.orientation === 'horizontal') c.main.orientation = 'horizontal';
      else if (t.orientation === 'vertical') delete c.main.orientation;
    }
    applied.push(`テロップ ${t.group ?? t.cutId}「${before}」→「${t.text}」`);
  }

  if (patch.theme && patch.theme !== (nextCuts.theme ?? spec.theme)) {
    nextCuts.theme = patch.theme;
    applied.push(`theme を ${patch.theme} に`);
  }

  const parsedCuts = ReelDataSchema.safeParse(nextCuts);
  let validation: ValidationResult | undefined;
  const cutsTouched = (patch.cuts?.length ?? 0) + (patch.telops?.length ?? 0) + (patch.order?.length ?? 0) > 0 || !!patch.theme;
  if (cutsTouched) {
    if (!parsedCuts.success) {
      unapplied.push(`cuts.json の形が壊れるので書いていない: ${parsedCuts.error.issues[0]?.message ?? ''}`);
    } else {
      nextCuts = parsedCuts.data;
      writeCuts(projectDir, nextCuts);
      validation = validateProject(projectDir);
    }
  }

  // ── narration.json ──
  if (patch.narration?.length) {
    if (!narration) unapplied.push('narration: narration.json が無いので変更できない');
    else {
      const next = {...narration, segments: narration.segments.map((s) => ({...s}))};
      for (const e of patch.narration) {
        const seg = next.segments.find((s) => s.id === e.id);
        if (!seg) {
          unapplied.push(`narration: ${e.id} が無い`);
          continue;
        }
        if (e.at !== undefined && e.at !== seg.at) {
          applied.push(`ナレーション ${e.id} の位置を ${seg.at.toFixed(2)} → ${e.at.toFixed(2)} 秒`);
          seg.at = e.at;
        }
        if (e.text !== undefined && e.text !== seg.text) {
          applied.push(`ナレーション ${e.id}「${seg.text}」→「${e.text}」`);
          seg.text = e.text;
          // 文言が変わった＝既存の wav は使えない。実測尺も無効にする
          delete (seg as Record<string, unknown>).durSec;
          (seg as Record<string, unknown>).needsTts = true;
          needsTts.push(e.id);
        }
      }
      const parsedNarr = NarrationSchema.safeParse(next);
      if (!parsedNarr.success) unapplied.push(`narration.json の形が壊れるので書いていない: ${parsedNarr.error.issues[0]?.message ?? ''}`);
      else writeNarration(projectDir, parsedNarr.data);
    }
  }

  log(`AI 修正完了: ${applied.length} 件 / $${run.costUsd.toFixed(3)}`);
  for (const a of applied) log(`  ${a}`);
  for (const u of unapplied) log(`  ! ${u}`);
  if (needsTts.length) log(`※ ナレーション ${needsTts.join(', ')} は文言が変わりました。音声を作り直さないと古い wav のまま混ざります`);
  return {summary: patch.summary, applied, unapplied, needsTts, costUsd: run.costUsd, validation};
}

export {studioDir};
