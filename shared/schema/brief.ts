// brief.json のスキーマ。edit-pipeline.md Step 0（A 生素材 9 問／B カット済み 6 問）の回答＝ユーザーの意図。
import {z} from 'zod';
import {ThemeSchema} from './cuts';

export const PersonaIdSchema = z.enum(['hiro', 'nagi', 'sayuri', 'bonjiri']);
export type PersonaId = z.infer<typeof PersonaIdSchema>;

export const FormatIdSchema = z.enum(['F0', 'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7']);
export type FormatId = z.infer<typeof FormatIdSchema>;

export const SavePrioritySchema = z.enum(['access', 'budget', 'menu', 'crowd', 'hours', 'scene', 'howto', 'caution']);
export type SavePriority = z.infer<typeof SavePrioritySchema>;

export const BriefSchema = z.object({
  version: z.literal(1),
  persona: PersonaIdSchema,
  shop: z.object({
    name: z.string(),
    area: z.string(),
    station: z.string().optional(),
    genre: z.string().default(''),
    pr: z.boolean().default(false),
  }),
  materialMode: z.enum(['raw', 'precut']),
  format: FormatIdSchema.optional(), // 未指定なら persona 既定
  theme: ThemeSchema.optional(),
  targetSec: z.number().positive().optional(),
  core: z.string().default(''), // 企画の核 1 行
  subject: z.enum(['anomaly', 'human', 'scene', 'ranking', 'verification', 'news', 'list']).default('anomaly'),
  hook: z
    .object({
      clipId: z.string(),
      inSec: z.number().optional(),
      outSec: z.number().optional(),
      text: z.string().optional(), // 確定フック文（あれば final）
    })
    .optional(),
  reveal: z.enum(['afterProof', 'late']).optional(), // 未指定なら spec 既定
  speech: z.object({use: z.boolean().default(false), protect: z.boolean().default(true)}).default({}),
  savePriorities: z.array(SavePrioritySchema).max(4).default([]),
  ngClipIds: z.array(z.string()).default([]),
  order: z
    .object({
      mode: z.enum(['auto', 'hint', 'fixed']).default('auto'),
      fixed: z.array(z.string()).optional(), // clipId の並び
    })
    .default({}),
  units: z
    .array(
      z.object({
        label: z.string(),
        badge: z.string(),
        clipIds: z.array(z.string()),
      }),
    )
    .optional(), // F2（順位）/ F6（店）
  precut: z
    .object({
      keepOrder: z.literal(true).default(true),
      durationPolicy: z.enum(['asIs', 'fit']).default('asIs'),
      fixedTelops: z.array(z.object({atSec: z.number().optional(), text: z.string()})).default([]),
    })
    .optional(),
  facts: z.record(z.string(), z.string()).default({}),
  notes: z.string().optional(),
});
export type Brief = z.infer<typeof BriefSchema>;
