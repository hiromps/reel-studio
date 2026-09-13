// フォーマット仕様（F0〜F7）の機械可読版。原典は references/format-patterns.md と edit-pipeline.md のテンポ表。
import {z} from 'zod';
import {ThemeSchema, OrientationSchema} from './cuts';
import {FormatIdSchema} from './brief';
import {ClipKindSchema} from './catalog';

const Range = z.tuple([z.number(), z.number()]);
export type NumRange = [number, number];

export const SegmentRulesSchema = z.object({
  useUserHook: z.boolean().default(false),
  noSignage: z.boolean().default(false),
  requireSignage: z.boolean().default(false),
  preferSignage: z.boolean().default(false),
  preferKinds: z.array(ClipKindSchema).default([]),
  avoidKinds: z.array(ClipKindSchema).default([]),
  alternateAngle: z.boolean().default(true),
  allowSpeech: z.boolean().default(false),
  allowPrice: z.boolean().default(false),
  defaultOrientation: OrientationSchema.default('vertical'),
  closerLastCut: z.boolean().default(false),
});
export type SegmentRules = z.infer<typeof SegmentRulesSchema>;

export const SegmentSchema = z.object({
  id: z.string(),
  label: z.string(),
  timeSec: Range, // nominalSec 基準の区間
  cutSec: Range, // 1 カット尺の下限/上限
  cuts: Range, // カット数の下限/上限
  rolePattern: z.array(z.string()).min(1),
  telopGroups: Range,
  telopSpanCuts: Range.default([1, 1]),
  rules: SegmentRulesSchema.default({}),
});
export type Segment = z.infer<typeof SegmentSchema>;

export const RepeatSchema = z.object({
  segmentId: z.string(), // 展開先の segment id（例 "units"）
  unitLabel: z.string(),
  count: Range,
  order: z.enum(['asGiven', 'desc']).default('asGiven'),
  head: z.object({cutSec: Range}),
  items: z.object({
    cutSec: Range,
    cuts: Range,
    lastUnitCuts: Range.optional(),
    rolePattern: z.array(z.string()).min(1),
  }),
});
export type Repeat = z.infer<typeof RepeatSchema>;

export const FormatSpecSchema = z.object({
  id: FormatIdSchema,
  name: z.string(),
  maxSec: z.number(),
  targetSec: Range,
  nominalSec: z.number(),
  theme: ThemeSchema,
  reveal: z.enum(['afterProof', 'late', 'none']),
  revealPct: Range.optional(),
  // none=使わない / rank=順位（各ブロック頭に必須）/ shop=店名（同上）/ area=エリア名（任意。付けても付けなくてよい）
  /**
   * この型が**構造として要求する**バッジ。rank(F2の順位) / shop(F6の店名) は無いと構造が崩れるので
   * BADGE_MISSING で催促する。none / area は「型としては要求しない」という意味でしかなく、
   * **どの型でもバッジを置いてよい**（エリア名バッジ等の演出。2026-09-12 にユーザー指示で型による禁止を廃止）
   */
  badge: z.enum(['none', 'rank', 'shop', 'area']).default('none'),
  repeat: RepeatSchema.optional(),
  segments: z.array(SegmentSchema).min(1),
  tempo: z.object({
    totalCuts: Range,
    maxCutSec: z.number().default(3.0),
    playbackRateRange: Range.default([1.25, 1.5]),
  }),
  telop: z.object({
    maxChars: z.number().default(13),
    secPerChar: z.number().default(0.25),
    floorSec: z.number().default(1.2),
    groupSecTarget: Range.default([1.8, 2.0]),
    maxEllipsis: z.number().default(3),
  }),
});
export type FormatSpec = z.infer<typeof FormatSpecSchema>;
