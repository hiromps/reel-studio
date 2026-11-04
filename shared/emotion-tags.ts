import {z} from 'zod';
import bundled from './config/emotion_tags.json';

// String IDs, rather than a hardcoded enum, leave the storage contract extensible.
export const EmotionValueSchema = z.union([
  z.string().regex(/^(?:[a-z][a-z0-9_-]{0,63}|(?:\[[^\[\]\r\n]+\]\s*)+)$/),
  z.literal('').transform(() => null), z.null(),
]);
export const EmotionTagsSchema = z.object({
  version: z.literal(1),
  tags: z.array(z.object({id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/), label: z.string().min(1),
    fish_tag: z.string().refine(v => v === '' || /^\[[^\[\]\r\n]+\]$/.test(v)), note: z.string(), color: z.string().regex(/^#[a-f0-9]{6}$/i)}).strict()).min(2),
  flow: z.object({peak_slots: z.array(z.string()), peak_ids: z.array(z.string()), calm_slots: z.array(z.string()), calm_id: z.string(), ending_id: z.string()}).strict(),
  audition: z.object({text: z.string().min(1), speed: z.number().min(0.5).max(2), max_chars: z.number().int().min(1).max(300)}).strict(),
  sources: z.array(z.string().url()),
}).strict().superRefine((value, ctx) => {
  const ids = value.tags.map(t => t.id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({code: 'custom', message: 'Duplicate emotion ID'});
  if (value.tags.filter(t => !t.fish_tag).length !== 1 || !value.tags.some(t => t.id === 'none' && !t.fish_tag)) ctx.addIssue({code: 'custom', message: 'Exactly one none tag is required'});
  for (const id of [...value.flow.peak_ids, value.flow.calm_id, value.flow.ending_id]) if (!ids.includes(id)) ctx.addIssue({code: 'custom', message: `Unknown flow tag: ${id}`});
});
export type EmotionTags = z.infer<typeof EmotionTagsSchema>;
export type EmotionTag = EmotionTags['tags'][number];
export const defaultEmotionTags = (): EmotionTags => EmotionTagsSchema.parse(bundled);
export const emotionId = (value: unknown, config: EmotionTags): string | null => {
  if (value == null || value === '' || value === 'none') return null;
  return config.tags.find(t => t.id === value || t.fish_tag === value)?.id ?? String(value);
};
export const fishEmotionTag = (value: unknown, config: EmotionTags): string => {
  const id = emotionId(value, config);
  if (!id) return '';
  const tag = config.tags.find(t => t.id === id);
  if (tag) return tag.fish_tag;
  // Existing bracket strings are preserved for compatibility; no free-text UI.
  if (typeof value === 'string' && /^(?:\[[^\[\]\r\n]+\]\s*)+$/.test(value)) return value;
  throw new Error(`感情タグ「${id}」が emotion_tags.json にありません`);
};
export const emotionPrompt = (config: EmotionTags): string => [
  'emotion_tag は次のIDだけから選ぶ。本文にはタグ・注釈を含めない。none はタグなし。',
  ...config.tags.map(t => `${t.id}: ${t.label} — ${t.note}`),
  `流れ: ${config.flow.peak_slots.join('/')} のピークは ${config.flow.peak_ids.join('/')}。${config.flow.calm_slots.join('/')} は ${config.flow.calm_id}。締めは ${config.flow.ending_id} または ${config.flow.calm_id}。全カット同じ強さにしない。`,
].join('\n');
