// 並び順（構成）を Claude に決めてもらうための純粋ロジック。
// 役割分担：Claude は「どのクリップを何番目に置くか」だけを決め、
// 尺・役割・テロップグループは planCuts（型どおり・決定論）が決める。
// 原典: format-patterns.md（区間テンプレ・全フォーマット共通の規則）、edit-pipeline.md（テンポ・保護規則）。
import {z} from 'zod';
import type {Catalog, Clip} from './schema/catalog';
import type {Brief} from './schema/brief';
import type {FormatSpec} from './schema/format-spec';
import type {ReelData} from './schema/cuts';
import type {Persona} from './personas';

export type OrderFinding = {code: string; severity: 'E' | 'W'; index?: number; clipId?: string; message: string};

export type OrderCheck = {
  ok: boolean;
  findings: OrderFinding[];
  summary: {
    count: number;
    /** spec.tempo.totalCuts を targetSec に合わせて伸縮した推奨カット数 */
    recommendedCount: [number, number];
    targetSec: number;
    untagged: number;
    /** 並びに入らなかった見せ場つきクリップ */
    unusedGood: string[];
    /** 看板・店名が読めるクリップの位置（0 始まり） */
    signageAt: number[];
  };
};

export type OrderContext = {catalog: Catalog; brief: Brief; spec: FormatSpec; persona?: Persona};

/** Claude が返す並び替え案 */
export const OrderProposalSchema = z.object({
  order: z.array(z.string()).min(1), // clipId の並び（＝カットの並び。同じ id を隣接で 2 回書けば 2 カットになる）
  hook: z.object({clipId: z.string(), inSec: z.number().optional(), outSec: z.number().optional(), text: z.string().optional()}).optional(),
  ngClipIds: z.array(z.string()).optional(),
  targetSec: z.number().positive().optional(),
  notes: z.string().optional(),
  reasons: z.array(z.object({clipId: z.string(), why: z.string()})).optional(),
});
export type OrderProposal = z.infer<typeof OrderProposalSchema>;

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** 冒頭に置くと「店紹介から入る」ことになる種別（format-patterns.md 全フォーマット共通の規則） */
const NON_FOOD_OPENING = new Set(['exterior', 'signage', 'interior', 'person', 'menu', 'other']);

/** 採用できる最長区間の秒数。usableRanges が無いときは plan.ts の既定区間と同じ計算 */
export const longestUsableSec = (c: Clip): number => {
  const rs = c.usableRanges.filter((r) => r.label !== 'avoid' && r.outSec > r.inSec);
  if (rs.length) return Math.max(...rs.map((r) => Math.min(r.outSec, c.probe.durationSec) - r.inSec));
  const margin = c.probe.durationSec >= 2.5 ? 0.2 : 0;
  return Math.max(0, c.probe.durationSec - margin * 2);
};

/** targetSec に合わせた推奨カット数 */
export const recommendedCutCount = (spec: FormatSpec, targetSec: number): [number, number] => {
  const k = targetSec / spec.nominalSec;
  return [Math.max(1, Math.floor(spec.tempo.totalCuts[0] * k)), Math.ceil(spec.tempo.totalCuts[1] * k)];
};

export const orderTargetSec = (brief: Brief, spec: FormatSpec): number => clamp(brief.targetSec ?? spec.targetSec[1], spec.targetSec[0], spec.maxSec);

/** cuts.json の並び → clipId の並び（alias とプロキシを辿って catalog に対応付ける） */
export const orderFromCuts = (cuts: ReelData, catalog: Catalog): string[] => {
  const alias = new Map((cuts.meta?.aliases ?? []).map((a) => [a.to, a.from]));
  const bySrc = new Map<string, string>();
  for (const c of catalog.clips) {
    bySrc.set(c.src, c.id);
    if (c.proxyOf) bySrc.set(c.proxyOf, c.id);
  }
  return cuts.cuts.map((c) => bySrc.get(alias.get(c.src) ?? c.src)).filter((x): x is string => !!x);
};

/**
 * 並び順そのものの構成チェック。plan する前に Claude の案を弾くために使う。
 * cuts.json ができたあとの検証は validateCuts が行う（こちらは並びだけを見る軽い前段）。
 */
export const checkOrder = (ids: string[], ctx: OrderContext): OrderCheck => {
  const {catalog, brief, spec} = ctx;
  const findings: OrderFinding[] = [];
  const add = (severity: 'E' | 'W', code: string, message: string, extra: {index?: number; clipId?: string} = {}) => findings.push({code, severity, message, ...extra});
  const E = (code: string, message: string, extra?: {index?: number; clipId?: string}) => add('E', code, message, extra);
  const W = (code: string, message: string, extra?: {index?: number; clipId?: string}) => add('W', code, message, extra);

  const byId = new Map(catalog.clips.map((c) => [c.id, c]));
  const ngIds = new Set(brief.ngClipIds);
  const targetSec = orderTargetSec(brief, spec);
  const recommendedCount = recommendedCutCount(spec, targetSec);
  const isNg = (c: Clip) => c.user.ng || ngIds.has(c.id);

  const summary: OrderCheck['summary'] = {count: ids.length, recommendedCount, targetSec, untagged: 0, unusedGood: [], signageAt: []};
  if (!ids.length) {
    E('ORDER_EMPTY', '並びが空（order に clipId を 1 つ以上入れる）');
    return {ok: false, findings, summary};
  }

  // ── クリップ単位 ──
  const untagged: string[] = [];
  ids.forEach((id, i) => {
    const c = byId.get(id);
    if (!c) return E('ORDER_UNKNOWN_CLIP', `catalog に無い clipId: ${id}`, {index: i, clipId: id});
    if (isNg(c)) E('ORDER_NG_CLIP', `NG 指定のクリップ ${id}（${c.tags?.subject ?? c.slug}）が並びに入っている`, {index: i, clipId: id});
    if (!c.tags && !untagged.includes(id)) untagged.push(id);
    if (longestUsableSec(c) < 0.8) E('ORDER_CLIP_UNUSABLE', `${id} に 0.8 秒以上使える区間が無い（素材 ${c.probe.durationSec.toFixed(2)}s）`, {index: i, clipId: id});
    if (c.tags?.signage) summary.signageAt.push(i);
  });
  summary.untagged = untagged.length;
  if (untagged.length) W('ORDER_UNTAGGED', `未タグのまま並べている: ${untagged.join(' ')}（先に reel tag で中身を見る）`);

  // ── フック（先頭） ──
  const first = byId.get(ids[0]);
  if (brief.materialMode === 'raw' && brief.hook?.clipId && ids[0] !== brief.hook.clipId)
    E('ORDER_HOOK_FIRST', `先頭が brief.hook（${brief.hook.clipId}）ではなく ${ids[0]}。フック素材はユーザーが選ぶ規則なので勝手に変えない`, {index: 0, clipId: ids[0]});
  if (first?.tags?.signage) E('ORDER_HOOK_SIGNAGE', `先頭に店名・看板が映る ${first.id}（フックで店名は出さない）`, {index: 0, clipId: first.id});
  else if (first?.tags && NON_FOOD_OPENING.has(first.tags.kind))
    W('ORDER_OPENING_NOT_FOOD', `先頭が ${first.tags.kind}（${first.tags.subject || first.slug}）。冒頭は店紹介から入らず、最もインパクトのある料理映像から始める`, {index: 0, clipId: first.id});

  // ── 店名リビールの位置 ──
  const hasSignageInCatalog = catalog.clips.some((c) => c.tags?.signage && !isNg(c));
  if (spec.reveal === 'late') {
    for (const i of summary.signageAt)
      if (i < ids.length - 2) E('ORDER_SIGNAGE_EARLY', `看板クリップ ${ids[i]} が ${i + 1} 番目（${spec.id} は最後の 2 カットまで温存する）`, {index: i, clipId: ids[i]});
    if (!summary.signageAt.length && hasSignageInCatalog) W('ORDER_REVEAL_MISSING', '看板クリップが catalog にあるのに並びに入っていない（店名リビールができない）');
  } else if (spec.reveal === 'afterProof') {
    if (!summary.signageAt.length && hasSignageInCatalog) W('ORDER_REVEAL_MISSING', '看板クリップが catalog にあるのに並びに入っていない（②の直後に店名リビールを置く）');
    else if (summary.signageAt.length && !summary.signageAt.some((i) => i >= 1 && i <= 4))
      W('ORDER_REVEAL_POSITION', `店名リビールが ${summary.signageAt[0] + 1} 番目（${spec.id} は 2〜5 番目）`, {index: summary.signageAt[0], clipId: ids[summary.signageAt[0]]});
  }

  // ── 連続（画角・被写体）と離れた再使用 ──
  let angleRun = 1;
  let subjectRun = 1;
  const lastAt = new Map<string, number>();
  for (let i = 0; i < ids.length; i++) {
    const prev = i > 0 ? byId.get(ids[i - 1])?.tags : undefined;
    const cur = byId.get(ids[i])?.tags;
    const sameClip = i > 0 && ids[i - 1] === ids[i];
    if (!prev || !cur) {
      angleRun = 1;
      subjectRun = 1;
    } else {
      if (cur.angle === prev.angle && !sameClip) {
        angleRun++;
        if (angleRun >= 3) W('ORDER_SAME_ANGLE_RUN', `同じ画角（${cur.angle}）が ${angleRun} カット連続（引き→寄りで交互に）`, {index: i, clipId: ids[i]});
      } else angleRun = 1;
      if (cur.subject && cur.subject === prev.subject && !sameClip) {
        subjectRun++;
        if (subjectRun >= 3) W('ORDER_SAME_SUBJECT_RUN', `同一被写体「${cur.subject}」が ${subjectRun} カット連続`, {index: i, clipId: ids[i]});
      } else subjectRun = 1;
    }
    const p = lastAt.get(ids[i]);
    if (p !== undefined && p !== i - 1)
      W('ORDER_SAME_CLIP_NONCONSECUTIVE', `${ids[i]} を離れた位置で再使用（${p + 1} 番目 → ${i + 1} 番目）。別名コピーが要る（Windows のレンダーが不安定になる）`, {index: i, clipId: ids[i]});
    lastAt.set(ids[i], i);
  }

  // ── 全体（カット数・使い残し） ──
  if (ids.length < recommendedCount[0] || ids.length > recommendedCount[1])
    W('ORDER_CUT_COUNT', `${ids.length} カット（${spec.id} / ${targetSec} 秒なら ${recommendedCount[0]}〜${recommendedCount[1]} カット）`);
  const used = new Set(ids);
  summary.unusedGood = catalog.clips
    .filter((c) => !used.has(c.id) && !isNg(c) && ((c.tags?.sizzleScore ?? 0) >= 4 || c.usableRanges.some((r) => r.label === 'best')))
    .map((c) => c.id);
  if (summary.unusedGood.length)
    W('ORDER_UNUSED_GOOD', `見せ場のある素材が未使用: ${summary.unusedGood.map((id) => `${id}(${byId.get(id)?.tags?.subject ?? byId.get(id)?.slug})`).join(' ')}`);

  return {ok: !findings.some((f) => f.severity === 'E'), findings, summary};
};

/** 型（format-spec）から、並べ方の指示を機械生成する。Claude への export に入れる */
export const orderPrinciples = (spec: FormatSpec, brief: Brief, persona?: Persona): string[] => {
  const targetSec = orderTargetSec(brief, spec);
  const [lo, hi] = recommendedCutCount(spec, targetSec);
  const lines = [
    `${spec.id}「${spec.name}」。全体 ${targetSec} 秒 / ${lo}〜${hi} カット（1 カット平均 ${(targetSec / ((lo + hi) / 2)).toFixed(1)} 秒）。上限 ${spec.maxSec} 秒`,
    '区間の並び（先頭から順に）：' + spec.segments.map((s) => `${s.label}（${s.cuts[0]}〜${s.cuts[1]}カット）`).join(' → '),
    '冒頭は外観・店名紹介・挨拶から入らず、最もインパクトのある料理映像から始める（店名は出さない）',
    '同一被写体・同一画角を 3 カット連続させない。引き（wide）→寄り（close）を交互に',
    '同じクリップを離れた位置で 2 回使わない（別名コピーが必要になりレンダーが不安定になる）',
    '見せ場（sizzleScore 4 以上・usableRanges の best）は使い切る',
  ];
  if (brief.materialMode === 'raw' && brief.hook?.clipId) lines.unshift(`先頭は必ず ${brief.hook.clipId}（ユーザーが選んだフック素材。変えない）`);
  if (spec.reveal === 'late') lines.push(`店名・看板が映るクリップ（signage）は最後の 2 カットまで温存する。それより前に 1 つでも出したら型が壊れる`);
  else if (spec.reveal === 'afterProof') lines.push('店名・看板が映るクリップ（signage）は 2〜5 番目に置く（②証明の直後に店名リビール）');
  if (spec.badge !== 'none' && brief.units?.length) lines.push(`${spec.id} は ${brief.units.map((u) => u.label).join('／')} のブロック順に並べる（各ブロックの頭は看板・外観・提供）`);
  if (brief.speech.use) lines.push('会話クリップは発話の途中で切らない。並べ替えで会話の順序を入れ替えて意味を変えない');
  if (persona) lines.push(`人格は ${persona.label}：${persona.tone}`);
  if (brief.core) lines.push(`企画の核：${brief.core}`);
  if (brief.savePriorities.length) lines.push(`保存される理由として入れたい実用情報：${brief.savePriorities.join(' / ')}`);
  return lines;
};

/** CLI・GUI 共通の整形 */
export const formatOrderCheck = (r: OrderCheck): string => {
  const s = r.summary;
  const head = `${r.ok ? 'OK' : 'NG'}  ${s.count} カット（推奨 ${s.recommendedCount[0]}〜${s.recommendedCount[1]} / ${s.targetSec}s）${s.signageAt.length ? ` / 看板 ${s.signageAt.map((i) => i + 1).join(',')} 番目` : ''}${s.untagged ? ` / 未タグ ${s.untagged}` : ''}`;
  return [head, ...r.findings.map((f) => `  ${f.severity} ${f.code}${f.index !== undefined ? ` [${f.index + 1}番目]` : ''} ${f.message}`)].join('\n');
};
