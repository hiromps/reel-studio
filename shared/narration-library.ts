import {z} from 'zod';

export const NarrationLibraryEntrySchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).max(80),
  text: z.string().min(1),
  voice: z.string(),
  voiceTitle: z.string().optional(),
  speed: z.number().optional(),
  latency: z.string().optional(),
  durSec: z.number().positive(),
  trimSec: z.number().positive().optional(),
  createdAt: z.string(),
});
export type NarrationLibraryEntry = z.infer<typeof NarrationLibraryEntrySchema>;

export const NarrationLibrarySchema = z.object({version: z.literal(1), entries: z.array(NarrationLibraryEntrySchema)});
