// cuts.json のスキーマ。GourmetReel.tsx の型（ReelData / Cut / MainTelopDef …）を鏡写しにし、
// Remotion が無視する拡張（Cut.id / meta.slots / meta.telopGroups / meta.aliases / meta.generated）を足す。
import {z} from 'zod';

export const OrientationSchema = z.enum(['vertical', 'horizontal']);
export type Orientation = z.infer<typeof OrientationSchema>;

export const ThemeSchema = z.enum(['pop', 'bold', 'human', 'stylish']);
export type ThemeName = z.infer<typeof ThemeSchema>;

export const MainTelopSchema = z.object({
  text: z.string(),
  highlight: z.string().optional(), // 描画では無視（2026-08-12 廃止）。既存データ互換のため残す
  highlightColor: z.enum(['yellow', 'red']).optional(),
  orientation: OrientationSchema.optional(), // 既定 vertical。下部配置は存在しない
});
export type MainTelopDef = z.infer<typeof MainTelopSchema>;

export const SubSchema = MainTelopSchema.extend({
  startSec: z.number(), // 素材内の絶対秒（inSec と同じ時間軸）
  endSec: z.number(),
});
export type SubDef = z.infer<typeof SubSchema>;

export const PriceTelopSchema = z.object({
  text: z.string(),
  side: z.enum(['left', 'right', 'center']).optional(),
});

export const CutSchema = z
  .object({
    id: z.string().optional(), // 拡張。planCuts が "c01" 等を振る。Remotion は無視
    src: z.string().min(1), // public/ からの相対パス
    inSec: z.number().min(0),
    outSec: z.number(),
    playbackRate: z.number().positive().optional(),
    main: MainTelopSchema.optional(),
    price: PriceTelopSchema.optional(),
    badge: z.string().optional(),
    subs: z.array(SubSchema).optional(),
  })
  .passthrough();
export type Cut = z.infer<typeof CutSchema>;

export const SlotRoleSchema = z.enum([
  'hook',
  'proof',
  'tease',
  'reveal',
  'sizzle',
  'info',
  'conversation',
  'badgeHead',
  'cta',
  'filler',
]);
export type SlotRole = z.infer<typeof SlotRoleSchema>;

export const TextStatusSchema = z.enum(['placeholder', 'draft', 'final']);
export type TextStatus = z.infer<typeof TextStatusSchema>;

export const SlotSchema = z.object({
  cutId: z.string(),
  segment: z.string(), // FormatSpec.segments[].id（"1_hook" など）または "unit:1:head"
  role: SlotRoleSchema,
  clipId: z.string(),
  telopGroupId: z.string().optional(),
  textStatus: TextStatusSchema.default('placeholder'),
  locked: z.boolean().default(false), // 再 plan で clip/in/out/text を保持
  qc: z.array(z.string()).default([]), // 'signage-collision' | 'face-collision' | 'head-scene-change'
});
export type Slot = z.infer<typeof SlotSchema>;

export const TelopGroupMetaSchema = z.object({
  id: z.string(), // "g01" …
  cutIds: z.array(z.string()),
  intent: z.string(), // hook | proof | tease | reveal | cta | access | budget | sizzle:<subject> …
  placeholder: z.string(),
  minSec: z.number(),
});
export type TelopGroupMeta = z.infer<typeof TelopGroupMetaSchema>;

export const AliasOpSchema = z.object({
  from: z.string(),
  to: z.string(),
  applied: z.boolean().default(false),
});
export type AliasOp = z.infer<typeof AliasOpSchema>;

export const GeneratedSchema = z.object({
  tool: z.string(),
  at: z.string(),
  briefHash: z.string(),
  catalogHash: z.string(),
  specId: z.string(),
});

export const ReelMetaSchema = z
  .object({
    slots: z.array(SlotSchema).optional(),
    telopGroups: z.array(TelopGroupMetaSchema).optional(),
    aliases: z.array(AliasOpSchema).optional(),
    generated: GeneratedSchema.optional(),
  })
  .passthrough(); // shop / format / winningAngle / reasonToSave / selectedHook / buzzScore / order … は自由項目として通す
export type ReelMeta = z.infer<typeof ReelMetaSchema>;

export const ReelDataSchema = z
  .object({
    fps: z.number().positive(),
    theme: ThemeSchema.optional(),
    tate: z.object({text: z.string(), outlineColor: z.string()}).optional(),
    /** バッジ下地の不透明度（0〜1）。省略時はエンジン既定 0.6。Timeline のスライダーで調整する */
    badgeOpacity: z.number().min(0).max(1).optional(),
    cuts: z.array(CutSchema).min(1),
    meta: ReelMetaSchema.optional(),
  })
  .passthrough();
export type ReelData = z.infer<typeof ReelDataSchema>;
