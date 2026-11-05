import {z} from 'zod';
import {ReelDataSchema} from './schema/cuts';
import {calcTotalFrames} from './timeline';
import {stableHash} from './hash';

export const MODAL_UPLOAD_CHUNK = 2 * 1024 ** 2;
export const MODAL_PROJECT_BYTES = 1024 ** 3;
export const MODAL_FILE_BYTES = 512 * 1024 ** 2;
export const MODAL_RENDER_SECONDS = 180;
export const MODAL_RENDER_KINDS = ['remotion-render', 'prepare-media'] as const;
const assetExtensions: Record<string, RegExp> = {uploads: /\.(mp4|mov|m4v|webm)$/i, fonts: /\.(ttf|otf|woff|woff2)$/i, narration: /\.wav$/i, sfx: /\.(wav|mp3|m4a|aac|ogg|flac)$/i, studio: /\.(jpg|png)$/i};
export const safeModalAsset = (name: string): boolean => name.length <= 240 && !/[\\\x00-\x1f\x7f:%?#"'`$<>|]/.test(name) && !name.startsWith('/') && name.split('/').every(p => !!p && p !== '.' && p !== '..') && !!assetExtensions[name.split('/')[0]]?.test(name);
export const ModalAssetPathSchema = z.string().refine(safeModalAsset, '素材パスが不正です');
export const ModalSessionInputSchema = z.object({
  id: z.string().uuid(),
  files: z.array(z.object({id: z.string().uuid(), path: ModalAssetPathSchema, size: z.number().int().positive().max(MODAL_FILE_BYTES)}).strict()).min(1).max(128),
  allowUpload: z.literal(true),
  reuseSessionId: z.string().uuid().optional(),
}).strict().superRefine((v, ctx) => {
  if (v.files.reduce((n, f) => n + f.size, 0) > MODAL_PROJECT_BYTES || new Set(v.files.map(f => f.id)).size !== v.files.length || new Set(v.files.map(f => f.path)).size !== v.files.length) ctx.addIssue({code: 'custom', message: '案件の素材は合計1GiBまで、重複のない128ファイルまでです'});
});
const finiteTime = z.number().finite().min(0).max(3600);
export const ModalRenderNarrationSchema = z.object({
  voice: z.string().max(300).optional(),
  speed: z.number().positive().max(4).optional(),
  narrationGainDb: z.number().min(-12).max(12).default(8),
  ambientGain: z.number().min(0).max(1).default(0.22),
  sfxGainDb: z.number().min(-30).max(12).default(0),
  segments: z.array(z.object({id: z.string().regex(/^[\w-]{1,80}$/), at: finiteTime, durSec: z.number().positive().max(3600), trimSec: z.number().positive().max(3600).optional(), text: z.string().max(10000).default(''), emotion_tag: z.string().nullable().optional(), needsTts: z.literal(false).optional()})).max(100),
  sfx: z.array(z.object({id: z.string().max(80), at: finiteTime, file: z.string().max(200).refine(f => safeModalAsset('sfx/' + f)), trimSec: z.number().positive().max(180).optional(), fadeOutSec: z.number().min(0).max(10).optional(), gainDb: z.number().min(-30).max(12).optional()})).max(100).default([]),
});
export const ModalRenderInputSchema = z.object({
  kind: z.enum(MODAL_RENDER_KINDS), sessionId: z.string().uuid(),
  cuts: ReelDataSchema.optional(), narration: ModalRenderNarrationSchema.nullable().optional(),
  draft: z.boolean().default(false), maxSeconds: z.number().int().min(30).max(600).optional(),
  requestId: z.string().uuid(), allowGpu: z.literal(true),
}).strict().superRefine((v, ctx) => {
  if (v.kind !== 'remotion-render') {
    if (v.cuts || v.narration) ctx.addIssue({code: 'custom', message: 'プレビュー作成には編集データを指定できません'});
    return;
  }
  const c = v.cuts;
  if (!c || c.cuts.length > 120 || !Number.isInteger(c.fps) || c.fps > 60 || calcTotalFrames(c) / c.fps > MODAL_RENDER_SECONDS || c.cuts.some(cut => !safeModalAsset(cut.src) || !cut.src.startsWith('uploads/') || !Number.isFinite(cut.inSec) || !Number.isFinite(cut.outSec) || cut.inSec < 0 || cut.outSec <= cut.inSec || cut.outSec > 3600 || !Number.isFinite(cut.playbackRate ?? 1) || (cut.playbackRate ?? 1) < 0.1 || (cut.playbackRate ?? 1) > 10) || (c.font && (!safeModalAsset('fonts/' + c.font) || c.font.includes('/')))) ctx.addIssue({code: 'custom', message: '書き出しは180秒・120カット・60fps以内です。素材とフォントのパスも確認してください'});
  if (v.kind === 'remotion-render' && v.narration?.segments.some(s => s.at >= MODAL_RENDER_SECONDS)) ctx.addIssue({code: 'custom', message: '音声の配置位置を確認してください'});
  if (JSON.stringify(v).length > 512 * 1024) ctx.addIssue({code: 'custom', message: '編集データが大きすぎます'});
});
export type ModalRenderInput = z.infer<typeof ModalRenderInputSchema>;
export type ModalRenderNarration = z.infer<typeof ModalRenderNarrationSchema>;
export type ModalRenderInfo = {remotion: string; encoder: 'h264_nvenc' | 'libx264'; width: number; height: number; fps: number; frames: number; durationSec: number; audio: boolean; warnings: string[]};
export type ModalSessionFile = {id: string; path: string; size: number; complete: boolean; sha256?: string; probe?: {codec: string; width: number; height: number; rotation: number; fps: number; durationSec: number; hasAudio: boolean; pixFmt: string}};
export type ModalSession = {id: string; files: ModalSessionFile[]; prepared: boolean; expiresAt: string; totalBytes: number};
export type ModalRenderProject = {sessionId: string; uploadedAt: string; lastJobId?: string; audioFingerprint?: string};
/** Timing, trimming and gain changes reuse the same audio; generation changes need a fresh upload. */
export const modalAudioFingerprint = (n: ModalRenderNarration | null | undefined) => stableHash({voice: n?.voice, speed: n?.speed, segments: n?.segments.map(s => ({id: s.id, text: s.text, durSec: s.durSec, emotion_tag: s.emotion_tag})), sfx: n?.sfx.map(s => s.file).sort()});
export type ModalRenderDashboard = {project: ModalRenderProject | null; session: ModalSession | null; expired: boolean; usage: import('./modal').ModalUsage; jobs: import('./modal').ModalJob[]; maxJobSeconds: number};
export type ModalRenderEstimate = {estimatedCostUsd: number; [key: string]: unknown};
