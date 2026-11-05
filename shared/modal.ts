import {z} from 'zod';

export const MODAL_GPU = 'RTX-PRO-6000' as const;
export const ModalConfigSchema = z.object({
  endpointUrl: z.string().max(300).default(''),
  gpu: z.literal(MODAL_GPU).default(MODAL_GPU),
  monthlyBudgetUsd: z.number().min(0).max(25).default(25),
  maxJobSeconds: z.number().int().min(30).max(600).default(300),
}).strict();
export type ModalConfig = z.infer<typeof ModalConfigSchema>;
export const MODAL_SECRET_KEYS = ['tokenId', 'tokenSecret', 'proxyTokenId', 'proxyTokenSecret'] as const;
export type ModalSecrets = Partial<Record<typeof MODAL_SECRET_KEYS[number], string>>;
export type ModalSettingsView = ModalConfig & {secrets: Record<typeof MODAL_SECRET_KEYS[number], boolean>; encryption: string; configured: boolean};
export const ModalSettingsPatchSchema = ModalConfigSchema.partial().extend({
  tokenId: z.string().trim().regex(/^ak-[\w-]+$/).max(300).optional(),
  tokenSecret: z.string().trim().regex(/^as-[\w-]+$/).max(300).optional(),
  proxyTokenId: z.string().trim().regex(/^wk-[\w-]+$/).max(300).optional(),
  proxyTokenSecret: z.string().trim().regex(/^ws-[\w-]+$/).max(300).optional(),
  clearCredentials: z.boolean().optional(),
}).strict();

export const MODAL_TASKS = ['gpu-test', 'text-to-image', 'image-to-image', 'image-to-video', 'text-to-video'] as const;
export type ModalTask = typeof MODAL_TASKS[number];
export const MODAL_TASK_LABEL: Record<ModalTask | 'remotion-render' | 'prepare-media', string> = {'gpu-test': 'GPU接続テスト', 'text-to-image': 'Text to Image', 'image-to-image': 'Image to Image', 'image-to-video': 'Image to Video', 'text-to-video': 'Text to Video', 'remotion-render': 'クラウド書き出し', 'prepare-media': '軽量プレビュー作成'};
export const MODAL_STATUS_LABEL = {queued: '待機中', loading: '実行環境の準備中', running: '処理中', completed: '完了', failed: 'エラー', cancelling: '中止処理中', cancelled: '中止'} as const;
export type ModalJobStatus = keyof typeof MODAL_STATUS_LABEL;
export const ModalJobInputSchema = z.object({
  kind: z.enum(MODAL_TASKS),
  prompt: z.string().trim().max(2000).default(''),
  negativePrompt: z.string().trim().max(1000).default(''),
  width: z.number().int().min(256).max(768).multipleOf(32).default(512),
  height: z.number().int().min(256).max(768).multipleOf(32).default(512),
  steps: z.number().int().min(1).max(40).default(12),
  frames: z.number().int().min(5).max(49).refine(v => (v - 1) % 4 === 0, 'フレーム数は4n+1').default(17),
  seed: z.number().int().min(0).max(2147483647).default(42),
  strength: z.number().min(0.1).max(0.95).default(0.7),
  imageBase64: z.string().max(8 * 1024 * 1024).optional(),
  maxSeconds: z.number().int().min(30).max(600).optional(),
  allowGpu: z.literal(true),
  requestId: z.string().uuid(),
}).strict().superRefine((v, ctx) => {
  if (v.kind !== 'gpu-test' && !v.prompt) ctx.addIssue({code: 'custom', path: ['prompt'], message: 'プロンプトが必要です'});
  if ((v.kind === 'image-to-image' || v.kind === 'image-to-video') && !v.imageBase64) ctx.addIssue({code: 'custom', path: ['imageBase64'], message: '入力画像が必要です'});
  if (v.kind.endsWith('video') && (v.width > 640 || v.height > 640)) ctx.addIssue({code: 'custom', path: ['width'], message: '初期検証では動画は640px以下'});
});
export type ModalJobInput = z.infer<typeof ModalJobInputSchema>;
/** Normal exports use the dedicated /render routes; the generic endpoint is diagnostic only. */
export const ModalUtilityJobInputSchema = ModalJobInputSchema.refine(input => input.kind === 'gpu-test', 'Modalは動画の書き出し・軽量プレビュー・接続診断に使用します');
export type ModalGpuInfo = {name: string; memoryTotalMiB: number; memoryUsedMiB: number; cudaAvailable: boolean; cudaVersion: string; torchVersion: string; capability: string; checkedAt: string};
export type ModalJob = {id: string; kind: ModalTask | 'remotion-render' | 'prepare-media'; status: ModalJobStatus; progress: number; createdAt: string; endedAt?: string; estimatedCostUsd: number; maxSeconds: number; model?: string; error?: string; resultType?: 'image/png' | 'video/mp4' | 'application/json'; gpuInfo?: ModalGpuInfo; sessionId?: string; phase?: string; renderInfo?: import('./modal-render').ModalRenderInfo};
export type ModalUsage = {month: string; budgetUsd: number; committedUsd: number; overheadReserveUsd: number; remainingUsd: number; activeJobId: string | null; source: 'estimate'; billingUrl: string; note: string};
export type ModalDashboard = {ok: boolean; gpu: string; config: {monthlyBudgetUsd: number; maxJobSeconds: number}; usage: ModalUsage; jobs: ModalJob[]; gpuInfo: ModalGpuInfo | null; scaling: {minContainers: number; maxContainers: number; scaledownSeconds: number}};
