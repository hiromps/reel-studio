import {z} from 'zod';
import type {Zoom} from '../../engine/src/zoom';

export const ZoomSchema = z.object({
  mode: z.enum(['none', 'push', 'pull']).default('none'),
  scale_start: z.number().finite().min(1).max(1.5).optional(),
  scale_end: z.number().finite().min(1).max(1.5).optional(),
  ease: z.enum(['in_out', 'out', 'linear']).default('in_out'),
  anchor_x: z.number().finite().min(0).max(1).default(0.5),
  anchor_y: z.number().finite().min(0).max(1).default(0.5),
}).strict().transform((v): Zoom => ({
  ...v,
  scale_start: v.scale_start ?? (v.mode === 'pull' ? 1.2 : 1),
  scale_end: v.scale_end ?? (v.mode === 'push' ? 1.18 : 1),
})).superRefine((v, ctx) => {
  if ((v.mode === 'push' && v.scale_end < v.scale_start) || (v.mode === 'pull' && v.scale_end > v.scale_start)) {
    ctx.addIssue({code: z.ZodIssueCode.custom, path: ['scale_end'], message: '倍率の方向が mode と一致しません'});
  }
});
export type {Zoom};
