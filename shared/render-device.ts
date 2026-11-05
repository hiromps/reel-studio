import {stableHash} from './hash';
import {z} from 'zod';

export type RenderDevice = {available: boolean; encoder: 'h264_nvenc' | 'h264_videotoolbox' | null; name: string | null; memoryMiB: number | null; checkedAt: string; reason: string};
export type LocalRenderProject = {slug: string; cutsHash: string; narrationHash: string};
export const RenderDeviceSchema = z.object({available: z.boolean(), encoder: z.enum(['h264_nvenc', 'h264_videotoolbox']).nullable(), name: z.string().max(150).nullable(), memoryMiB: z.number().int().min(0).max(1048576).nullable(), checkedAt: z.string().datetime(), reason: z.string().max(300)}).strict();
export const LocalRenderProjectsSchema = z.array(z.object({slug: z.string().max(200), cutsHash: z.string().regex(/^[a-f0-9]{8}$/), narrationHash: z.string().regex(/^[a-f0-9]{8}$/)}).strict()).max(128);
export function preferredRenderTarget(input: {cloud: boolean; online?: boolean; device?: RenderDevice | null; projects?: LocalRenderProject[]; slug: string | null; cuts: unknown; narration: unknown; dirty: boolean}): 'pc' | 'modal' {
  if (!input.cloud) return 'pc';
  if (!input.online || !input.device?.available || input.dirty) return 'modal';
  const ready = input.projects?.some(p => p.slug === input.slug && p.cutsHash === stableHash(input.cuts) && p.narrationHash === stableHash(input.narration));
  return ready ? 'pc' : 'modal';
}
export const resolveRenderTarget = (choice: string, input: Parameters<typeof preferredRenderTarget>[0]) => choice === 'pc' || choice === 'modal' ? choice : preferredRenderTarget(input);
