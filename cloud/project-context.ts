// クラウド版の「案件の文脈」。ローカルの core/ が案件フォルダから読むものを、docs テーブルから組み立てる。
//
// 対応表:
//   core/render.ts:validationContext  →  validationContext
//   core/order.ts:loadOrderEnv        →  orderEnv
//   core/script.ts:scriptProposalView →  scriptProposalView
//
// 判断そのもの（validateCuts / planCuts / checkCaption / reviewScriptProposal …）は shared/ の
// 純粋な関数をそのまま呼ぶ。ここがやるのは「材料を揃える」ことだけ。
import type {z, ZodTypeAny} from 'zod';
import {FORMAT_SPECS} from '../shared/format-specs';
import {findPersona, getPersona} from '../shared/personas';
import {stableHash} from '../shared/hash';
import {parseSections, reviewScriptProposal, scriptPlanToCuts, scriptPlanTotalSec, type ScriptProposalReview} from '../shared/script';
import {validateCuts, type ValidationResult} from '../shared/validate';
import {BriefSchema, CatalogSchema, NarrationSchema, ReelDataSchema, type Brief, type Catalog, type Narration, type ReelData} from '../shared/schema';
import {HooksSchema, type Hooks} from '../shared/hooks';
import {ReferenceSchema, type Reference} from '../shared/reference';
import {ScriptProposalSchema, type ScriptProposal} from '../shared/script';
import type {DocName} from '../shared/project';
import {readDocs, type DocRow} from './store';

export type Ctx = {
  slug: string;
  rows: Map<DocName, DocRow>;
  catalog: Catalog | undefined;
  brief: Brief | undefined;
  cuts: ReelData | undefined;
  narration: Narration | undefined;
  caption: string | null;
  script: string | null;
  hooks: Hooks | null;
  scriptPlan: ScriptProposal | null;
  /** 参考動画（型を写す元）の分析。取り込んでいない・墓標（source: null）は null */
  reference: Reference | null;
};

/** 壊れた doc で画面全体が落ちないように、読めないものは undefined にする */
const parse = <S extends ZodTypeAny>(schema: S, v: unknown): z.infer<S> | undefined => {
  if (v === null || v === undefined) return undefined;
  const r = schema.safeParse(v);
  return r.success ? (r.data as z.infer<S>) : undefined;
};

const text = (v: unknown): string | null => {
  const t = (v as {text?: unknown} | null)?.text;
  return typeof t === 'string' ? t : null;
};

export const loadCtx = async (slug: string): Promise<Ctx> => {
  const rows = new Map<DocName, DocRow>();
  for (const r of await readDocs(slug)) rows.set(r.name, r);
  const data = (n: DocName): unknown => rows.get(n)?.data ?? null;
  return {
    slug,
    rows,
    catalog: parse(CatalogSchema, data('catalog')),
    brief: parse(BriefSchema, data('brief')),
    cuts: parse(ReelDataSchema, data('cuts')),
    narration: parse(NarrationSchema, data('narration')),
    caption: text(data('caption')),
    script: text(data('script')),
    hooks: parse(HooksSchema, data('hooks')) ?? null,
    scriptPlan: parse(ScriptProposalSchema, data('scriptPlan')) ?? null,
    reference: (() => {
      const r = parse(ReferenceSchema, data('reference'));
      return r?.source ? r : null;
    })(),
  };
};

export const etagOf = (ctx: Ctx, name: DocName): string | null => ctx.rows.get(name)?.etag ?? null;

/**
 * 検証の文脈。ローカル版（core/render.ts:validationContext）との違いは 2 つだけ:
 * - `srcExists` … 案件フォルダを見る代わりに catalog に載っているかで判定する
 *   （原本はクラウドに無いが、catalog は PC の実ファイルから作られているので同じ意味になる）
 * - `engineStale` … PC 側でしか分からないので呼び出し側が渡す
 */
export const validationContext = (ctx: Ctx, opt: {strictProxy?: boolean; engineStale?: boolean} = {}) => {
  const persona = ctx.brief ? findPersona(ctx.brief.persona) : undefined;
  const spec = ctx.brief ? FORMAT_SPECS[ctx.brief.format ?? persona?.defaultFormat ?? 'F0'] : undefined;
  const srcs = new Set<string>();
  for (const c of ctx.catalog?.clips ?? []) {
    srcs.add(c.src);
    if (c.proxyOf) srcs.add(c.proxyOf);
  }
  return {
    catalog: ctx.catalog,
    brief: ctx.brief,
    persona,
    spec,
    srcExists: (src: string) => srcs.has(src),
    strictProxy: opt.strictProxy,
    engineStale: opt.engineStale,
  };
};

export const validate = (ctx: Ctx, opt: {cuts?: ReelData; strictProxy?: boolean; engineStale?: boolean} = {}): ValidationResult =>
  validateCuts(opt.cuts ?? ctx.cuts ?? {}, validationContext(ctx, opt));

/** core/order.ts:loadOrderEnv のクラウド版。足りないものは例外にして呼び出し側で 400 にする */
export const orderEnv = (ctx: Ctx) => {
  if (!ctx.catalog) throw new Error('catalog.json が無い（先に素材のカタログ化）');
  if (!ctx.brief) throw new Error('brief.json が無い（Brief で保存してください）');
  const persona = getPersona(ctx.brief.persona);
  return {dir: '', slug: ctx.slug, catalog: ctx.catalog, brief: ctx.brief, spec: FORMAT_SPECS[ctx.brief.format ?? persona.defaultFormat], persona};
};

/** core/script.ts:loadScriptEnv のクラウド版 */
export const scriptEnv = (ctx: Ctx) => {
  if (!ctx.script?.trim()) throw new Error('台本がありません（Brief の「台本から組み立てる」に貼ってください）');
  if (!ctx.catalog) throw new Error('catalog.json が無い（先に素材のカタログ化）');
  if (!ctx.brief) throw new Error('brief.json が無い');
  const brief = ctx.brief;
  const catalog = ctx.catalog;
  const persona = getPersona(brief.persona);
  const spec = FORMAT_SPECS[brief.format ?? persona.defaultFormat];
  const sections = parseSections(ctx.script);
  return {
    script: ctx.script,
    catalog,
    brief,
    persona,
    spec,
    sections,
    check: {
      sections,
      clipDurations: new Map(catalog.clips.map((c) => [c.id, c.probe.durationSec])),
      ngClipIds: new Set(catalog.clips.filter((c) => c.user.ng).map((c) => c.id)),
      maxTelopChars: spec.telop.maxChars,
    },
    toCuts: (plan: ScriptProposal['plan']): ReelData =>
      scriptPlanToCuts(plan, {catalog, theme: brief.theme ?? persona.theme, specId: spec.id, briefHash: stableHash(brief), catalogHash: stableHash(catalog)}),
  };
};

/** core/script.ts:scriptProposalView のクラウド版 */
export const scriptProposalView = (ctx: Ctx) => {
  const proposal = ctx.scriptPlan;
  if (!proposal) return null;
  let review: ScriptProposalReview;
  try {
    const env = scriptEnv(ctx);
    review = reviewScriptProposal(proposal, {scriptText: env.script, check: env.check, toCuts: env.toCuts});
  } catch (e) {
    review = {
      canApply: false,
      blockers: [(e as Error).message],
      issues: [],
      fixes: [],
      plan: proposal.plan,
      lines: [],
      totalSec: scriptPlanTotalSec(proposal.plan),
      cutCount: proposal.plan.cuts.length,
      narrationCount: proposal.plan.narration.length,
    };
  }
  // plan そのものは画面に出さない（lines で見せる）
  return {
    canApply: review.canApply,
    blockers: review.blockers,
    issues: review.issues,
    lines: review.lines,
    totalSec: review.totalSec,
    cutCount: review.cutCount,
    narrationCount: review.narrationCount,
    createdAt: proposal.createdAt,
    model: proposal.model,
    costUsd: proposal.costUsd,
    appliedAt: proposal.appliedAt,
    unmatched: proposal.plan.unmatched,
    notes: proposal.plan.notes,
    autoFixes: [...proposal.autoFixes, ...review.fixes],
    current: {cuts: ctx.cuts?.cuts.length ?? null, narration: ctx.narration?.segments.length ?? null, sfx: ctx.narration?.sfx?.length ?? 0},
  };
};
