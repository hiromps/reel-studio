// トライアルリール（フックだけ違う複数版）の**フック案とパターン別キャプション**を、裏で走らせた Claude に書かせる。
// 勝ちパターンの二次活用（締めの一言とキャプションの書き直し）も同じ作り。
//
// 元になっている運用（ユーザー指示・2026-09-14）:
//   1 本のベース企画から「冒頭のフックだけ異なる 3 パターン」を作り、A/B/C それぞれ違う切り口
//   （疑問形・結果先出し・煽り／警告形 など）にする。本編（フック以降）は共通。
//   キャプションは使い回し検知を避けるためパターンごとに文面を変える。
// hooks.json への反映は必ずこちら側が zod 検証を通してから行う（エージェントはファイルを書かない）。
import path from 'node:path';
import {studioConfig} from '../studio.config';
import {runAgent} from './agent';
import {agentAddDirs, captionGuideLabel, materializePersonaDocs, promptPath} from './persona-docs';
import {agentProgress, captionExamples, type AiProgress} from './ai';
import {loadOrderEnv} from './order';
import {ensureCutFrame} from './cut-frames';
import {backupsDir, readCaption, readCuts, readNarration} from './project';
import {hooksPath, readHooks} from './trial';
import {writeJsonAtomic} from './json-io';
import {checkCaption, formatCaptionIssues, type CaptionIssue} from '../shared/caption';
import {DEFAULT_HOOK_CUTS, HooksSchema, alignedHookCutCount, checkHooks, hookCutIndices, hookNarrationIds, type HookIssue, type HookVariant, type Hooks} from '../shared/hooks';
import {applyHookNarration, applyHookVariant, trialCaptionOf} from '../shared/hooks';
import {tailNarrationBudget, tailTelopOf, lastNarrationId} from '../shared/winner';
import {cutDurationSec, totalSec} from '../shared/timeline';
import {countChars} from '../shared/telop-text';
import type {Cut, ReelData} from '../shared/schema/cuts';
import type {Narration} from '../shared/schema/narration';
import type {Clip} from '../shared/schema/catalog';

const rel = (projectDir: string, p: string) => path.relative(projectDir, p).replace(/\\/g, '/');

/** 前置きやコードフェンスを剥がす */
const stripFences = (s: string) => (s ?? '').replace(/^\s*```[a-z]*\n?/i, '').replace(/\n?```\s*$/, '').trim();

/** テロップとして不正なもの（改行・極端な長さ）を落とし、文末の句点を取る */
const cleanTelop = (s: string, maxChars: number): string => {
  const t = (s ?? '').trim().replace(/[。]+$/, '');
  if (!t || /[\r\n]/.test(t) || countChars(t) > maxChars * 2) return '';
  return t;
};

/** ナレーション 1 文に整える（改行は読点でつなぐ） */
const cleanNarration = (s: string): string =>
  (s ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .join('、');

const HOOKS_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['baselineAngle', 'variants'],
  properties: {
    baselineAngle: {type: 'string', description: '今のフック（基準）の切り口を短く（例「煽り・警告形」「エリア＋数字型」）'},
    variants: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['id', 'angle', 'telops', 'narration', 'caption', 'why'],
        properties: {
          id: {type: 'string', description: '渡された id（B / C など）。変えない'},
          angle: {type: 'string', description: '切り口（疑問形／結果先出し／煽り・警告形／共感型／逆張り型 など）。基準とも他のパターンとも重ねない'},
          label: {type: 'string', description: '何を試すパターンかの短いメモ（20 文字以内）'},
          telops: {type: 'array', items: {type: 'string'}, description: '差し替え範囲のカットごとの文言。i 番目が i 枚目のカット。隣り合うカットに同じ文言を繰り返して「1 文言 2 カット」にしてよい。画面に出す文字だけ（役割名・注釈・改行は入れない）'},
          badge: {type: 'string', description: '1 枚目のバッジ（エリア名）。今のままでよければ空文字'},
          narration: {type: 'string', description: '差し替え範囲のナレーション。読み上げる文そのものだけ・1 文・改行なし'},
          caption: {type: 'string', description: 'このパターン専用の Instagram キャプション。改行込みの完成形だけ（前置き・見出し・コードブロックは付けない）'},
          why: {type: 'string', description: 'このフックが効くと考える理由を 1 行で'},
        },
      },
    },
    notes: {type: 'string', description: '全体の意図を 1〜2 行で'},
  },
} as const;

type HooksResponse = {
  baselineAngle: string;
  variants: {id: string; angle: string; label?: string; telops: string[]; badge?: string; narration: string; caption: string; why: string}[];
  notes?: string;
};

export type AiHooksResult = {
  hooks: Hooks;
  file: string;
  cutCount: number;
  spanSec: number;
  issues: HookIssue[];
  captionIssues: Record<string, CaptionIssue[]>;
  why: Record<string, string>;
  costUsd: number;
  notes?: string;
};

const NEXT_IDS = ['A', 'B', 'C', 'D', 'E', 'F'];

const clipFinder = (cuts: ReelData, clips: Clip[]) => {
  const alias = new Map((cuts.meta?.aliases ?? []).map((a) => [a.to, a.from]));
  return (c: Cut): Clip | undefined => {
    const real = alias.get(c.src) ?? c.src;
    return clips.find((x) => x.src === real || x.proxyOf === real);
  };
};

/**
 * hooks.json を Claude に書かせる。既定では**今のフックを A（基準）として残し**、B / C を別の切り口で書かせる。
 * `fresh` なら全部を新しく書かせる。差し替え範囲はテロップの切れ目に合わせて決める（alignedHookCutCount）。
 */
export async function aiHooks(
  projectDir: string,
  opt: {
    /** 作るパターン数（基準を含む）。既定 3 */
    count?: number;
    /** 差し替える冒頭カット数の下限。テロップの切れ目まで自動で伸びる */
    cutCount?: number;
    /** 今のフックを基準として残さず、全部新しく書かせる */
    fresh?: boolean;
    /** hooks.json があっても上書きする（旧版は .studio/backups/ に残る） */
    force?: boolean;
    model?: string;
    instruction?: string;
    onLine?: (l: string) => void;
    onProgress?: AiProgress;
    signal?: AbortSignal;
  } = {},
): Promise<AiHooksResult> {
  const log = opt.onLine ?? (() => {});
  const env = loadOrderEnv(projectDir);
  const {spec, persona, brief, catalog} = env;
  const cuts = readCuts(projectDir);
  const narration = readNarration(projectDir);
  const common = (readCaption(projectDir) ?? '').trim();
  const existing = readHooks(projectDir);
  if (existing?.variants.length && !opt.force) throw new Error(`hooks.json に ${existing.variants.length} パターン入っています。作り直すなら force（旧版は .studio/backups/ に残ります）`);

  const count = Math.max(2, Math.min(6, opt.count ?? 3));
  const cutCount = alignedHookCutCount(cuts, opt.cutCount ?? existing?.cutCount ?? DEFAULT_HOOK_CUTS);
  const idx = hookCutIndices(cuts, cutCount);
  if (!idx.length) throw new Error('cuts.json にカットがありません');
  const spanSec = idx.reduce((s, i) => s + cutDurationSec(cuts.cuts[i]), 0);
  const videoSec = totalSec(cuts);
  const clipOf = clipFinder(cuts, catalog.clips);
  const maxChars = spec.telop.maxChars;

  // ── 差し替え範囲のカット（画つき） ──
  const frames = await Promise.all(idx.map((i) => ensureCutFrame(projectDir, cuts.cuts[i].src, cuts.cuts[i].inSec + 0.3, 320)));
  let cursor = 0;
  const spanRows = idx.map((i, k) => {
    const c = cuts.cuts[i];
    const dur = cutDurationSec(c);
    const start = cursor;
    cursor += dur;
    const cl = clipOf(c);
    const f = frames[k];
    return `- ${k + 1}枚目（${start.toFixed(2)}〜${(start + dur).toFixed(2)}秒）/ 今の文言「${c.main?.text ?? ''}」${c.badge ? ` / バッジ「${c.badge}」` : ''} / 映像: ${cl?.tags?.description ?? cl?.slug ?? c.src}${f ? ` / 画 ${rel(projectDir, f)}` : ''}`;
  });
  const currentTelops = idx.map((i) => cuts.cuts[i].main?.text ?? '');
  const afterSpan = cuts.cuts.slice(idx.length);
  const bodyTelops = afterSpan.map((c) => c.main?.text ?? (c.subs?.length ? '（会話字幕）' : '')).filter((t, i, a) => t && a.indexOf(t) === i);
  const nextTelop = afterSpan.find((c) => c.main?.text)?.main?.text ?? '';

  // ── ナレーション（差し替え範囲に属するブロックと、その次のブロック） ──
  const cps = persona.narration.charsPerSecMeasured;
  const replacedIds = narration ? hookNarrationIds(narration, spanSec, cps) : [];
  const segs = narration ? [...narration.segments].sort((a, b) => a.at - b.at) : [];
  const replaced = segs.filter((s) => replacedIds.includes(s.id));
  const firstAt = replaced[0]?.at ?? 0;
  const nextSeg = segs.find((s) => !replacedIds.includes(s.id) && s.at > firstAt);
  const budgetSec = (nextSeg?.at ?? spanSec) - firstAt;
  const budgetChars = Math.max(8, Math.floor(budgetSec * cps * 0.85));

  const ids = (opt.fresh ? NEXT_IDS : NEXT_IDS.slice(1)).slice(0, opt.fresh ? count : count - 1);
  const docs = materializePersonaDocs(projectDir, persona);
  const docsToRead = [captionGuideLabel(docs, projectDir), docs.hashtagBank ? promptPath(projectDir, docs.hashtagBank) : null].filter((x): x is string => !!x);
  const examples = common ? [] : captionExamples(brief.persona, projectDir, 1);
  const facts = [...catalog.facts, ...Object.entries(brief.facts).map(([k, v]) => `${k}: ${v}`)];
  const hookHidesShop = !currentTelops.some((t) => brief.shop.name && t.includes(brief.shop.name));

  const prompt = [
    'Instagram リールの**トライアルリール**用に、「冒頭のフックだけが違う複数パターン」の台本を書いてほしい。',
    '1 本のベース動画は完成している。変えるのは冒頭のフック（テロップ・ナレーション）だけで、本編（フック以降）は全パターン共通。',
    'どのフックが効いたかを比べるための運用なので、**パターンごとに切り口を変える**（例：疑問形／結果先出し／煽り・警告形／共感・あるある型／逆張り型）。',
    '',
    `店: ${brief.shop.name}（${brief.shop.area}${brief.shop.station ? `・${brief.shop.station}` : ''}・${brief.shop.genre}）／${brief.shop.pr ? 'PR 案件' : 'PR ではない'}／人格 ${persona.label}／型 ${spec.id}「${spec.name}」／全体 ${videoSec.toFixed(2)} 秒`,
    brief.core ? `企画の核: ${brief.core}` : '',
    '',
    `差し替える範囲は冒頭 ${idx.length} カット（0〜${spanSec.toFixed(2)} 秒）。カットごとに:`,
    ...spanRows,
    '',
    opt.fresh
      ? `いまのフック（参考。これも 1 案として数えてよいが、そのままは使わない）: ${currentTelops.map((t) => `「${t}」`).join(' → ')}`
      : `パターン A（基準）はいまのフックをそのまま残す: ${currentTelops.map((t) => `「${t}」`).join(' → ')}。A の切り口を baselineAngle に書き、**${ids.join(' / ')} は A とも互いとも違う切り口**にする。`,
    replaced.length ? `いまのフック区間のナレーション: ${replaced.map((s) => `「${s.text}」`).join(' ')}` : 'いまのフック区間にナレーションは無い。',
    '',
    `範囲の直後のテロップは「${nextTelop}」。各パターンの最後の文言はここへ自然につながること。`,
    nextSeg ? `範囲の直後のナレーションは「${nextSeg.text}」（${nextSeg.at.toFixed(2)} 秒から）。ナレーションはここへ自然につながること。` : '',
    bodyTelops.length ? `本編のテロップ（共通・変えない）: ${bodyTelops.map((t) => `「${t}」`).join(' → ')}` : '',
    '',
    '各カットの「画」を Read で見て、実際に映っているものと食い違わない文言にすること（1 枚ずつ）。',
    '',
    `書くパターン: ${ids.map((id) => `id ${id}`).join('、')}（${ids.length} パターン）`,
    '',
    'テロップで守ること:',
    `- 文体: ${persona.tone}`,
    `- 1 文言 ${maxChars} 文字以内。文末に句点（。）を付けない。半角括弧 ( ) と絵文字は使わない`,
    '- **金額は書かない**（キャプション側で書く）',
    '- 保存・いいね・シェア・コメントを促す文言は書かない',
    '- 隣り合うカットに同じ文言を繰り返して「1 文言 2 カット（2 秒以上）」にする。1 カット 1 文言だと速すぎて読めない',
    hookHidesShop ? '- 店名はフックに出さない（本編で明かす構成のため）' : '',
    persona.hookStyle === 'areaDigit'
      ? `- エリア名は縦書きの本文に入れず、バッジ（badge）に出す。今のままなら badge は空文字。本文はエリア名が無くても意味が通る言い回しにする（◯「地元の9割が知らない」 ✕「${brief.shop.area || 'エリア名'}、9割が知らない」）`
      : '',
    `- 「・・・」による焦らしは 1 パターン 1 回まで`,
    '- 各パターンで切り口を変える。言い換えただけの同じ角度を 2 つ作らない',
    '',
    'ナレーションで守ること:',
    `- 差し替え範囲ぶんを **1 文**で書く。実測話速 ${cps} 文字/秒で、**${budgetChars} 文字以内**（${budgetSec.toFixed(2)} 秒に収める）`,
    '- そのパターンのテロップの内容に沿う（一字一句同じにはせず、言い回しを変える・主語や理由を補う）',
    ...persona.narrationRules.map((r) => `- ${r}`),
    '- 固有名詞・数字＋単位・読みが割れる漢字はひらがな・カタカナに開く（TTS の誤読対策。「十三」→「じゅうそう」、「350g」→「350グラム」）',
    '- 金額を読み上げない',
    '',
    'キャプションで守ること:',
    docsToRead.length ? `- まず ${docsToRead.join(' と ')} を Read する（型の正はそちら）` : '',
    common
      ? `- 下の「共通のキャプション」を元に、**パターンごとに文面を変えて**書く。事実（店名・住所・営業時間・価格・頂いたもの・Instagram）は一切変えない。変えるのは言い回し・冒頭の一文・語順・強調する点。冒頭の一文はそのパターンのフックに合わせる。同じ文面で複数投稿すると使い回しとして扱われるので、文の大半が違う状態にする`
      : `- 共通のキャプションがまだ無いので、${examples.length ? `${examples.map((f) => promptPath(projectDir, f)).join(' / ')} を手本に` : 'キャプションの型で'}パターンごとに違う文面で書く。裏取りできない項目は ＿＿＿ にする`,
    `- ハッシュタグはちょうど ${persona.caption.hashtags} 個（入れ替えは 1 個まで）。#PR は入れない`,
    '- 保存・いいね・シェア・コメント・フォローを促す文言は入れない（来店を促す一文は可）',
    '- 文末に句点「。」を付けない',
    persona.caption.maxChars ? `- 長さは全体で ${persona.caption.maxChars} 文字程度まで` : '',
    persona.caption.repostAccount ? `- 「他の投稿はコチラ」の誘導は @${persona.caption.repostAccount} で固定` : '',
    '',
    facts.length ? `裏取り済みの事実（ここに無いことは書かない。推測で料理名や数字を作らない）:\n${facts.map((f) => `- ${f}`).join('\n')}` : '裏取り済みの事実は登録されていない。映像から確実に言えることだけ書く。',
    common ? `\n共通のキャプション（パターン A はこれをそのまま使う）:\n${common}` : '',
    opt.instruction?.trim() ? `\nユーザーからの指示（最優先）:\n${opt.instruction.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  log(`AI フック案: ${ids.length} パターン${opt.fresh ? '' : '（＋基準 A）'}／差し替え範囲 冒頭 ${idx.length} カット ${spanSec.toFixed(2)} 秒／ナレーション ${budgetChars} 文字以内（model=${opt.model ?? studioConfig.agent.model}）`);
  const watch = [docs.captionGuide, docs.hashtagBank, ...examples, ...frames].filter((f): f is string => !!f);
  const {onEvent} = agentProgress({watch, onProgress: opt.onProgress, log, labels: {reading: '確認中', thinking: 'フックを考えています', writing: 'パターンを書き出しています'}});
  const run = await runAgent<HooksResponse>({
    cwd: projectDir,
    prompt,
    schema: HOOKS_SCHEMA,
    addDirs: agentAddDirs(docs, projectDir, examples),
    model: opt.model ?? studioConfig.agent.model,
    timeoutMs: studioConfig.agent.timeoutMs,
    onLine: log,
    onEvent,
    signal: opt.signal,
  });
  opt.onProgress?.(watch.length, watch.length, '反映中');

  // ── 反映（こちら側で整形・検証してから書く） ──
  const variants: HookVariant[] = [];
  const why: Record<string, string> = {};
  if (!opt.fresh) {
    variants.push({id: 'A', label: '今の形（基準）', angle: (run.data.baselineAngle ?? '').trim(), telops: currentTelops, clipIds: [], narration: '', caption: ''});
  }
  const wanted = new Set(ids);
  for (const v of run.data.variants ?? []) {
    const id = (v.id ?? '').trim();
    if (!wanted.has(id) || variants.some((x) => x.id === id)) {
      log(`  ! 返ってきた id ${id || '(空)'} は要求していないので捨てました`);
      continue;
    }
    const telops = (v.telops ?? []).slice(0, idx.length).map((t) => cleanTelop(t, maxChars));
    const badge = (v.badge ?? '').trim();
    variants.push({
      id,
      label: (v.label ?? '').trim().slice(0, 40),
      angle: (v.angle ?? '').trim(),
      telops,
      clipIds: [],
      ...(badge ? {badge} : {}),
      narration: cleanNarration(v.narration),
      caption: stripFences(v.caption),
    });
    why[id] = (v.why ?? '').trim();
  }
  const missing = ids.filter((id) => !variants.some((v) => v.id === id));
  if (missing.length) log(`  ! 返ってこなかったパターン: ${missing.join(', ')}`);
  if (variants.length < 2) throw new Error('パターンが 2 つ未満しか作れませんでした（もう一度実行してください）');

  const hooks = HooksSchema.parse({version: 1, cutCount, variants});
  const file = hooksPath(projectDir);
  writeJsonAtomic(file, hooks, {backupDir: backupsDir(projectDir)});

  const issues = checkHooks(hooks, {cuts, maxTelopChars: maxChars, caption: common});
  const captionIssues: Record<string, CaptionIssue[]> = {};
  for (const v of hooks.variants) {
    const cap = trialCaptionOf(v, common);
    if (cap) captionIssues[v.id] = checkCaption(cap, persona, {pr: brief.shop.pr});
  }

  log(`AI フック案完了: ${hooks.variants.length} パターン → hooks.json（$${run.costUsd.toFixed(3)}）`);
  for (const v of hooks.variants) {
    const est = v.narration ? countChars(v.narration) / cps : 0;
    log(`  ${v.id}${v.angle ? `［${v.angle}］` : ''}${v.label ? ` ${v.label}` : ''}`);
    log(`     テロップ: ${v.telops.map((t) => (t ? `「${t}」` : '（今のまま）')).join(' → ')}`);
    if (v.narration) log(`     ナレ: 「${v.narration}」（${countChars(v.narration)} 字／約 ${est.toFixed(1)} 秒${est > budgetSec ? ` ※ ${budgetSec.toFixed(2)} 秒をはみ出す` : ''}）`);
    log(`     キャプション: ${v.caption ? `${countChars(v.caption)} 文字（専用）` : '共通の caption.txt'}`);
    if (why[v.id]) log(`     狙い: ${why[v.id]}`);
    const ci = captionIssues[v.id] ?? [];
    if (ci.length) log(`     キャプション点検:\n${formatCaptionIssues(ci).replace(/^/gm, '     ')}`);
  }
  for (const i of issues) log(`  ${i.severity} ${i.code} ${i.message}`);
  if (run.data.notes) log(`意図: ${run.data.notes}`);
  return {hooks, file, cutCount, spanSec, issues, captionIssues, why, costUsd: run.costUsd, notes: run.data.notes};
}

// ───────────────────────── 勝ちパターンの二次活用 ─────────────────────────

const WINNER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['tailTelop', 'tailNarration', 'caption'],
  properties: {
    tailTelop: {type: 'string', description: '新しい締めのテロップ。画面に出す文字だけ'},
    tailNarration: {type: 'string', description: '新しい締めのナレーション。読み上げる文そのものだけ・1 文・改行なし'},
    caption: {type: 'string', description: '新しいキャプション。改行込みの完成形だけ'},
    notes: {type: 'string', description: '変えた意図を 1〜2 行で'},
  },
} as const;

type WinnerResponse = {tailTelop: string; tailNarration: string; caption: string; notes?: string};

export type AiWinnerResult = {tailTelop: string; tailNarration: string; caption: string; costUsd: number; notes?: string};

/**
 * 伸びたパターンを再投稿するための「締めの一言」と「新しいキャプション」を書かせる。
 * 締め以外は変えない（ユーザーの運用ルール）。指定済みの項目（want に無いもの）は書かせない。
 */
export async function aiWinner(
  projectDir: string,
  opt: {
    /** 伸びたパターンの id（hooks.json）。無ければ元の動画 */
    variantId?: string;
    /** すでに決まっている値（AI には埋めさせない） */
    given?: {tailTelop?: string; tailNarration?: string; caption?: string};
    model?: string;
    instruction?: string;
    onLine?: (l: string) => void;
    onProgress?: AiProgress;
    signal?: AbortSignal;
  } = {},
): Promise<AiWinnerResult> {
  const log = opt.onLine ?? (() => {});
  const env = loadOrderEnv(projectDir);
  const {spec, persona, brief} = env;
  let cuts = readCuts(projectDir);
  let narration: Narration | null = readNarration(projectDir);
  const common = (readCaption(projectDir) ?? '').trim();
  let baseCaption = common;
  let hookLabel = '元の動画';
  if (opt.variantId) {
    const hooks = readHooks(projectDir);
    const v = hooks?.variants.find((x) => x.id === opt.variantId);
    if (!v) throw new Error(`hooks.json にパターン ${opt.variantId} がありません`);
    cuts = applyHookVariant(cuts, v, {count: hooks!.cutCount}).cuts;
    if (narration) narration = applyHookNarration(narration, v, {spanEndSec: hookCutIndices(cuts, hooks!.cutCount).reduce((s, i) => s + cutDurationSec(cuts.cuts[i]), 0), charsPerSec: persona.narration.charsPerSecMeasured}).narration;
    baseCaption = trialCaptionOf(v, common);
    hookLabel = `パターン ${v.id}${v.angle ? `［${v.angle}］` : ''}`;
  }
  const videoSec = totalSec(cuts);
  const prevTelop = tailTelopOf(cuts);
  const lastId = narration ? lastNarrationId(narration) : null;
  const lastSeg = narration?.segments.find((s) => s.id === lastId);
  const budget = narration ? tailNarrationBudget(narration, videoSec, persona.narration.charsPerSecMeasured) : 0;
  const telops = cuts.cuts.map((c) => c.main?.text ?? '').filter((t, i, a) => t && a.indexOf(t) === i);
  const docs = materializePersonaDocs(projectDir, persona);
  const given = opt.given ?? {};
  const want = {telop: !given.tailTelop?.trim(), narration: !given.tailNarration?.trim() && !!lastSeg, caption: !given.caption?.trim()};

  const prompt = [
    `トライアルリールで伸びた ${hookLabel} を、**締めの一言だけ変えて 1.1 倍速で書き出し直し、新しいキャプションで再投稿**する。その文言を書いてほしい。`,
    '映像の並び・素材・締め以外のテロップは変えない。変えるのは締めのテロップ・締めのナレーション・キャプションだけ。',
    '',
    `店: ${brief.shop.name}（${brief.shop.area}・${brief.shop.genre}）／${brief.shop.pr ? 'PR 案件' : 'PR ではない'}／人格 ${persona.label}／型 ${spec.id}／全体 ${videoSec.toFixed(2)} 秒`,
    '',
    `動画のテロップ（先頭から）: ${telops.map((t) => `「${t}」`).join(' → ')}`,
    `いまの締めテロップ: 「${prevTelop}」`,
    lastSeg ? `いまの締めナレーション: 「${lastSeg.text}」（${lastSeg.at.toFixed(2)} 秒から、動画の終わりまで ${(videoSec - lastSeg.at).toFixed(2)} 秒）` : 'ナレーションは無い。',
    '',
    '書くもの:',
    want.telop ? `- tailTelop: 新しい締めのテロップ。いまと違う言い回しで、来店を促す語族（${persona.cta.join('／')}、または ${persona.ctaPatterns.join('／')} を含む）。${spec.telop.maxChars} 文字以内・句点なし・絵文字と半角括弧なし・金額なし・保存やいいねの誘導なし。文体: ${persona.tone}` : `- tailTelop: 「${given.tailTelop?.trim()}」で決まっている。そのまま返す`,
    want.narration
      ? `- tailNarration: 新しい締めのナレーション 1 文。tailTelop の内容に沿って言い換え、**${budget} 文字以内**（実測話速 ${persona.narration.charsPerSecMeasured} 文字/秒）。固有名詞・数字はひらがなに開く。${persona.narrationRules.length ? `${persona.narrationRules.join('。')}。` : ''}金額は読まない`
      : `- tailNarration: ${lastSeg ? `「${given.tailNarration?.trim()}」で決まっている。そのまま返す` : 'ナレーションが無いので空文字'}`,
    want.caption
      ? `- caption: 下の「元のキャプション」と同じ事実（店名・住所・営業時間・価格・頂いたもの・Instagram）で、**文面を全面的に書き換える**（冒頭の一文・語順・言い回し・強調する点）。同じ文面での再投稿は使い回しになるので、文の大半が違う状態にする。${docs.captionGuide ? `型は ${captionGuideLabel(docs, projectDir)} を Read して守る。` : ''}ハッシュタグはちょうど ${persona.caption.hashtags} 個（入れ替えは 1 個まで）・#PR なし・句点なし・保存やいいねの誘導なし${persona.caption.maxChars ? `・${persona.caption.maxChars} 文字程度まで` : ''}${persona.caption.repostAccount ? `・誘導は @${persona.caption.repostAccount} で固定` : ''}`
      : '- caption: 決まっているので空文字を返す',
    '',
    baseCaption ? `元のキャプション:\n${baseCaption}` : '元のキャプションは無い（caption.txt が無い）。',
    opt.instruction?.trim() ? `\nユーザーからの指示（最優先）:\n${opt.instruction.trim()}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  log(`AI 二次活用: ${hookLabel}／締め「${prevTelop}」を書き換え（model=${opt.model ?? studioConfig.agent.model}）`);
  const {onEvent} = agentProgress({watch: want.caption && docs.captionGuide ? [docs.captionGuide] : [], onProgress: opt.onProgress, log, labels: {reading: '確認中', thinking: '締めとキャプションを考えています', writing: '書き出しています'}});
  const run = await runAgent<WinnerResponse>({
    cwd: projectDir,
    prompt,
    schema: WINNER_SCHEMA,
    addDirs: agentAddDirs(docs, projectDir),
    model: opt.model ?? studioConfig.agent.model,
    timeoutMs: studioConfig.agent.timeoutMs,
    onLine: log,
    onEvent,
    signal: opt.signal,
  });
  const tailTelop = want.telop ? cleanTelop(run.data.tailTelop, spec.telop.maxChars) : given.tailTelop!.trim();
  const tailNarration = want.narration ? cleanNarration(run.data.tailNarration) : (given.tailNarration ?? '').trim();
  const caption = want.caption ? stripFences(run.data.caption) : given.caption!.trim();
  if (!tailTelop) throw new Error('締めのテロップが返ってきませんでした');
  log(`  締めテロップ: 「${prevTelop}」→「${tailTelop}」`);
  if (tailNarration) log(`  締めナレ: 「${lastSeg?.text ?? ''}」→「${tailNarration}」（${countChars(tailNarration)} 字／目安 ${budget} 字）`);
  if (caption) {
    log(`  キャプション: ${countChars(caption)} 文字（新規）`);
    log(formatCaptionIssues(checkCaption(caption, persona, {pr: brief.shop.pr})));
  }
  if (run.data.notes) log(`意図: ${run.data.notes}`);
  return {tailTelop, tailNarration, caption, costUsd: run.costUsd, notes: run.data.notes};
}
