// 並び替え（構成）の入出力。Claude が素材を 1 本ずつ見て並び順を決め、それを brief.order.fixed に
// 取り込んで再 plan する。Claude が決めるのは「どのクリップを何番目に置くか」だけで、
// 尺・役割・テロップグループは planCuts が型どおりに決める。
import path from 'node:path';
import {FORMAT_SPECS} from '../shared/format-specs';
import {getPersona, type Persona} from '../shared/personas';
import {planCuts, type PlanResult} from '../shared/plan';
import {
  OrderProposalSchema,
  checkOrder,
  formatOrderCheck,
  longestUsableSec,
  orderFromCuts,
  orderPrinciples,
  orderTargetSec,
  recommendedCutCount,
  type OrderCheck,
  type OrderProposal,
} from '../shared/order';
import {isPlaceholder} from '../shared/telop-text';
import type {Brief} from '../shared/schema/brief';
import type {Catalog} from '../shared/schema/catalog';
import type {FormatSpec} from '../shared/schema/format-spec';
import type {ReelData} from '../shared/schema/cuts';
import type {ValidationResult} from '../shared/validate';
import {loadCatalog, studioDir} from './catalog';
import {projectSlug, readBrief, readCuts, writeBrief, writeCuts} from './project';
import {applyAliases} from './alias';
import {validateProject} from './render';
import {writeJsonAtomic} from './json-io';
import {loadSettings} from './settings';

export type OrderEnv = {dir: string; slug: string; catalog: Catalog; brief: Brief; spec: FormatSpec; persona: Persona};

export const loadOrderEnv = (dir: string): OrderEnv => {
  const catalog = loadCatalog(dir);
  if (!catalog) throw new Error('catalog.json が無い（先に reel catalog）');
  const brief = readBrief(dir);
  if (!brief) throw new Error('brief.json が無い（reel new で雛形を作るか GUI の Brief で保存）');
  const persona = getPersona(brief.persona);
  return {dir, slug: projectSlug(dir), catalog, brief, spec: FORMAT_SPECS[brief.format ?? persona.defaultFormat], persona};
};

export const orderExportPath = (dir: string) => path.join(studioDir(dir), 'order-export.json');
export const orderLastPath = (dir: string) => path.join(studioDir(dir), 'order-last.json');

/** 現在の cuts.json の並びと、その構成チェック。cuts.json が無ければ null */
export const currentOrder = (env: OrderEnv): {order: string[]; check: OrderCheck} | null => {
  let cuts: ReelData;
  try {
    cuts = readCuts(env.dir);
  } catch {
    return null;
  }
  const order = orderFromCuts(cuts, env.catalog);
  if (!order.length) return null;
  return {order, check: checkOrder(order, env)};
};

export type OrderExport = ReturnType<typeof buildOrderExport>;

/** Claude に渡す判断材料。サムネイルの場所・タグ・型の要求・今の並びを 1 ファイルにまとめる */
export const buildOrderExport = (env: OrderEnv) => {
  const {dir, catalog, brief, spec, persona} = env;
  const sdir = studioDir(dir);
  const abs = (p: string) => path.join(sdir, p).replace(/\\/g, '/');
  const targetSec = orderTargetSec(brief, spec);
  const [lo, hi] = recommendedCutCount(spec, targetSec);
  const ngIds = new Set(brief.ngClipIds);
  return {
    project: dir,
    slug: env.slug,
    instructions:
      `clips[].sheet（1 クリップ 1 枚のコンタクトシート）を 1 枚ずつ view して中身を確かめ、principles に沿って order を組み立てる。` +
      `複数ファイルを合成して一度に見ない（対応がズレる）。order は clipId の配列で、そのまま cuts の並び順になる` +
      `（同じ id を隣り合わせで 2 回書けば、そのクリップから 2 カット取る。離れた位置での再使用は避ける）。` +
      `尺・IN/OUT・役割・テロップは書かない——reel plan が型どおりに決める。見せ場の区間を指定したいときは reel tag の usableRanges（label: best）に書く。` +
      `書けたら reel order --project ${env.slug} --import <file> --write。E が出たら order を直してやり直す。`,
    format: {
      id: spec.id,
      name: spec.name,
      targetSec,
      maxSec: spec.maxSec,
      recommendedCuts: [lo, hi],
      reveal: spec.reveal,
      revealPct: spec.revealPct,
      segments: spec.segments.map((s) => ({
        id: s.id,
        label: s.label,
        cuts: s.cuts,
        cutSec: s.cutSec,
        rolePattern: s.rolePattern,
        preferKinds: s.rules.preferKinds,
        avoidKinds: s.rules.avoidKinds,
        noSignage: s.rules.noSignage,
        requireSignage: s.rules.requireSignage,
      })),
    },
    persona: {id: persona.id, label: persona.label, tone: persona.tone},
    shop: brief.shop,
    core: brief.core,
    subject: brief.subject,
    savePriorities: brief.savePriorities,
    hook: brief.hook ?? null,
    principles: orderPrinciples(spec, brief, persona),
    current: currentOrder(env),
    response: {
      shape: {order: ['<clipId>', '<clipId>', '…'], hook: {clipId: '<clipId>'}, ngClipIds: [], notes: '', reasons: [{clipId: '<clipId>', why: '<なぜここに置いたか>'}]},
      required: ['order'],
      note: 'hook / ngClipIds / targetSec は変えたいときだけ書く（省略すれば brief.json の値のまま）。reasons と notes は任意で、ユーザーへの説明に使う',
    },
    clips: catalog.clips.map((c) => ({
      id: c.id,
      slug: c.slug,
      description: c.tags?.description ?? '',
      subject: c.tags?.subject ?? '',
      kind: c.tags?.kind ?? null,
      angle: c.tags?.angle ?? null,
      motion: c.tags?.motion ?? null,
      signage: c.tags?.signage ?? null,
      signageSize: c.tags?.signageSize ?? null,
      sizzleScore: c.tags?.sizzleScore ?? null,
      quality: c.tags?.quality ?? null,
      hasSpeech: c.tags?.hasSpeech ?? (c.speech?.length ?? 0) > 0,
      durationSec: c.probe.durationSec,
      usableSec: Math.round(longestUsableSec(c) * 100) / 100,
      usableRanges: c.usableRanges,
      speech: c.speech ?? null,
      ng: c.user.ng || ngIds.has(c.id),
      lock: c.user.lock,
      orderHint: c.user.orderHint,
      note: c.user.note ?? '',
      sheet: abs(c.thumbs.sheet),
      strip: c.thumbs.strip.map(abs),
    })),
  };
};

export const exportOrder = (env: OrderEnv, outFile?: string): {file: string; payload: OrderExport} => {
  const payload = buildOrderExport(env);
  const file = outFile ? path.resolve(outFile) : orderExportPath(env.dir);
  writeJsonAtomic(file, payload);
  return {file, payload};
};

export type OrderImportResult = {
  check: OrderCheck;
  applied: boolean;
  /** 並びを反映した brief（applied=false のときは書き込んでいない） */
  brief: Brief;
  plan?: PlanResult;
  validation?: ValidationResult;
  written: boolean;
  aliasesApplied: number;
  /** 書き込みで消える確定済みテロップの数（fixed 再 plan はテロップを作り直す） */
  losesFinalTelops: number;
  reasons: {clipId: string; why: string}[];
};

/** 提案を brief に反映した形（書き込みはしない） */
export const briefWithOrder = (brief: Brief, p: OrderProposal): Brief => ({
  ...brief,
  order: {mode: 'fixed', fixed: [...p.order]},
  hook: p.hook ? {...(brief.hook ?? {}), ...p.hook} : brief.hook,
  ngClipIds: p.ngClipIds ?? brief.ngClipIds,
  targetSec: p.targetSec ?? brief.targetSec,
  notes: p.notes ? p.notes : brief.notes,
});

/** 既に埋まっているテロップ（プレースホルダでない main / subs）の数 */
const finalTelopCount = (dir: string): number => {
  try {
    const cuts = readCuts(dir);
    return cuts.cuts.filter((c) => (c.main && c.main.text.trim() && !isPlaceholder(c.main.text)) || c.subs?.some((s) => s.text.trim() && !isPlaceholder(s.text))).length;
  } catch {
    return 0;
  }
};

/**
 * 並び替え案の取り込み。E が 1 つでもあれば（force でない限り）何も書かずに返す。
 * write=true のときだけ cuts.json まで書く（brief.json は取り込み時点で書く）。
 */
export const importOrder = (env: OrderEnv, raw: unknown, opt: {write?: boolean; copy?: boolean; force?: boolean; allowReuse?: boolean; now?: string} = {}): OrderImportResult => {
  const parsed = OrderProposalSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(`並び替え案の形式が不正: ${first?.path.join('.') || '(root)'} ${first?.message}`);
  }
  const proposal = parsed.data;
  const nextBrief = briefWithOrder(env.brief, proposal);
  const check = checkOrder(proposal.order, {...env, brief: nextBrief});
  const reasons = proposal.reasons ?? [];
  const losesFinalTelops = finalTelopCount(env.dir);
  if (!check.ok && !opt.force) return {check, applied: false, brief: nextBrief, written: false, aliasesApplied: 0, losesFinalTelops, reasons};

  writeBrief(env.dir, nextBrief);
  writeJsonAtomic(orderLastPath(env.dir), {at: new Date().toISOString(), proposal, check});

  let existing: ReelData | undefined;
  try {
    existing = readCuts(env.dir);
  } catch {
    existing = undefined;
  }
  const plan = planCuts({catalog: env.catalog, brief: nextBrief, existing, options: {allowReuse: opt.allowReuse ?? true, now: opt.now, font: loadSettings().telop.font}});
  let aliasesApplied = 0;
  let validation: ValidationResult | undefined;
  if (opt.write) {
    writeCuts(env.dir, plan.cuts);
    if (opt.copy !== false) {
      aliasesApplied = applyAliases(env.dir, plan.cuts).length;
      if (aliasesApplied) writeCuts(env.dir, plan.cuts);
    }
    validation = validateProject(env.dir);
  }
  return {check, applied: true, brief: nextBrief, plan, validation, written: !!opt.write, aliasesApplied, losesFinalTelops, reasons};
};

export {formatOrderCheck};
