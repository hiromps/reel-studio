import {z} from 'zod';
import {CutSchema} from './cuts';
import {EmotionValueSchema} from '../emotion-tags';

/** These are footage roles, independent of the legacy FormatSpec slot roles. */
export const ReelSlotSchema = z.enum(['self_eat', 'shop_highlight', 'dish', 'crowd', 'entrance', 'serve', 'sizzle', 'eating', 'interior', 'exterior']);
export type ReelSlot = z.infer<typeof ReelSlotSchema>;

export const LocalClipPathSchema = z.string().trim().min(1).refine((value) => {
  if (/[\x00-\x1f]/.test(value) || value.includes('://') || /^(?:data:|blob:|file:|https?:|\\\\|\/\/)/i.test(value)) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) return false;
  return !value.split(/[\\/]/).includes('..');
}, 'clip_path must be a local file path without traversal or a URL');

// Fixed API limits belong in the schema; creative defaults belong in oc-eat.json.
export const ReelSpeechSchema = z.object({
  line: z.string(),
  intensity: z.number().int().min(1).max(5),
  emotion_tag: EmotionValueSchema,
  speed: z.number().finite().min(0.5).max(2),
  pause_after: z.number().finite().nonnegative(),
  emphasis: z.array(z.string().trim().min(1)),
});

export const ReelCutSchema = ReelSpeechSchema.extend({
  // Optional on import; assigned once on save so reordering never changes WAV IDs.
  id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/).optional(),
  slot: ReelSlotSchema,
  clip_path: LocalClipPathSchema,
  start: z.number().finite().nonnegative(),
  /** Output timeline seconds, including pause_after; start is source-file seconds. */
  duration: z.number().finite().positive(),
  // Preserve the existing editor's crop, zoom, color and telops in this same source.
  editor: CutSchema.omit({id: true, src: true, inSec: true, outSec: true}).strict().optional(),
}).strict().superRefine((cut, ctx) => {
  if (cut.pause_after > cut.duration || (cut.line.trim() && cut.pause_after >= cut.duration)) {
    ctx.addIssue({code: 'custom', path: ['pause_after'], message: 'pause_after must leave time for the line inside duration'});
  }
  if (!Number.isFinite(cut.start + cut.duration * (cut.editor?.playbackRate ?? 1))) {
    ctx.addIssue({code: 'custom', path: ['duration'], message: 'Source end time is out of range'});
  }
  for (const word of cut.emphasis) {
    if (!cut.line.includes(word)) ctx.addIssue({code: 'custom', path: ['emphasis'], message: `Emphasis word is absent from line: ${word}`});
  }
});
export const ReelCutsSchema = z.array(ReelCutSchema).min(1).superRefine((cuts, ctx) => {
  const seen = new Set<string>();
  cuts.forEach((cut, i) => {
    if (cut.id && seen.has(cut.id)) ctx.addIssue({code: 'custom', path: [i, 'id'], message: 'Duplicate cut id'});
    if (cut.id) seen.add(cut.id);
  });
  if (!Number.isFinite(cuts.reduce((sum, cut) => sum + cut.duration, 0))) ctx.addIssue({code: 'custom', message: 'Timeline duration is out of range'});
});
export type ReelCut = z.infer<typeof ReelCutSchema>;
export type ReelCuts = z.infer<typeof ReelCutsSchema>;
