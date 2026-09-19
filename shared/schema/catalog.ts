// catalog.json のスキーマ。素材の機械的事実（probe/thumbs）＋ Claude/ユーザーのタグ＋ユーザー判断（hook/ng/lock）。
import {z} from 'zod';
import {MosaicInfoSchema} from '../mosaic';
import {CropSchema} from './cuts';

export const ClipKindSchema = z.enum([
  'exterior', // 外観
  'signage', // 看板・店名・ロゴが主役
  'interior', // 店内
  'menu', // メニュー表・POP
  'cooking', // 調理・炎・湯気
  'serving', // 提供・登場・置く
  'eating', // 実食・箸上げ・断面
  'sizzle', // 寄りのシズル（とろける・注ぐ・伸びる）
  'person', // 人物（店主・客）
  'conversation', // 会話・語り（音声に物語がある）
  'detail', // 小物・内装ディテール
  'other',
]);
export type ClipKind = z.infer<typeof ClipKindSchema>;

export const AngleSchema = z.enum(['wide', 'mid', 'close']);
export type Angle = z.infer<typeof AngleSchema>;
export const MotionSchema = z.enum(['static', 'pan', 'handheld', 'action']);

export const ClipTagsSchema = z.object({
  kind: ClipKindSchema,
  signage: z.boolean(), // 店名・ロゴ・看板が読める（F7 温存判定の唯一のキー）
  signageSize: z.enum(['none', 'small', 'large']).default('none'),
  angle: AngleSchema,
  motion: MotionSchema.default('handheld'),
  sizzleScore: z.number().int().min(1).max(5),
  quality: z.number().int().min(1).max(5), // 手ブレ・露出・ピント
  hasSpeech: z.boolean().default(false),
  subject: z.string(), // 被写体（「エッグベネディクト」「ラウンジ」）。同一被写体の連続回避に使う
  description: z.string(), // カタログ表の「内容」列
  source: z.enum(['claude', 'user', 'auto']),
  taggedAt: z.string(),
});
export type ClipTags = z.infer<typeof ClipTagsSchema>;

export const UsableRangeSchema = z.object({
  inSec: z.number().min(0),
  outSec: z.number(),
  label: z.enum(['best', 'ok', 'motion-full', 'avoid']).default('ok'),
  note: z.string().optional(),
});
export type UsableRange = z.infer<typeof UsableRangeSchema>;

export const SpeechRangeSchema = z.object({
  startSec: z.number(),
  endSec: z.number(),
  text: z.string().optional(),
});
export type SpeechRange = z.infer<typeof SpeechRangeSchema>;

export const ProbeSchema = z.object({
  codec: z.string(),
  width: z.number(),
  height: z.number(),
  rotation: z.number().default(0),
  fps: z.number(),
  durationSec: z.number(),
  hasAudio: z.boolean(),
  pixFmt: z.string().default(''),
});
export type Probe = z.infer<typeof ProbeSchema>;

export const ClipUserSchema = z.object({
  hook: z.boolean().default(false),
  ng: z.boolean().default(false),
  orderHint: z.number().nullable().default(null),
  lock: z.boolean().default(false),
  note: z.string().optional(),
});
export type ClipUser = z.infer<typeof ClipUserSchema>;

export const ClipSchema = z.object({
  id: z.string(), // catalog 内で安定。src が変わっても不変
  original: z.string(), // 元ファイル名（元フォルダは触らない）
  slug: z.string(), // 内容 slug（英数字・ハイフン）。リネーム後ファイル名 = NN_<slug>.<ext>
  src: z.string(), // public 相対（プロキシならプロキシのパス）
  proxyOf: z.string().optional(), // src がプロキシのとき、原本コピーの public 相対パス
  probe: ProbeSchema,
  thumbs: z.object({sheet: z.string(), strip: z.array(z.string())}), // .studio 相対
  tags: ClipTagsSchema.optional(),
  usableRanges: z.array(UsableRangeSchema).default([]),
  speech: z.array(SpeechRangeSchema).optional(),
  scenes: z.array(z.number()).optional(),
  user: ClipUserSchema.default({}),
  /**
   * 画面内の切り出し（アスペクト比は変えない）。「この素材はここを見せる」という素材側の決め。
   * 構成を組むときにカット（cuts.json）へ引き継がれ、レンダーで効く。
   */
  crop: CropSchema.optional(),
  /** 顔モザイクの結果（core/mosaic.ts）。無い＝まだ調べていない */
  mosaic: MosaicInfoSchema.optional(),
});
export type Clip = z.infer<typeof ClipSchema>;

export const CatalogSchema = z.object({
  version: z.literal(1),
  slug: z.string(),
  materialsDir: z.string(),
  dominantFps: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  facts: z.array(z.string()).default([]),
  clips: z.array(ClipSchema),
});
export type Catalog = z.infer<typeof CatalogSchema>;
