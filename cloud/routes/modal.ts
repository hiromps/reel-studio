import {Router, type RequestHandler} from 'express';
import {createModalRenderRouter} from '../../core/modal-render-router';
import {cloudModalRender} from '../modal-render';
import {createHmac, timingSafeEqual} from 'node:crypto';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {z} from 'zod';
import {ModalConfigSchema, ModalJobInputSchema, ModalSettingsPatchSchema, MODAL_SECRET_KEYS, type ModalDashboard, type ModalJob, type ModalSecrets} from '../../shared/modal';
import {ModalError, validateModalEndpoint} from '../../core/modal-client';
import {cloudModalConnection, cloudModalFetch, cloudModalJson, cloudModalView, saveCloudModal} from '../modal';
import {addJob, kvGet, listJobs, readDoc} from '../store';
import {normalizeSlug} from '../../shared/project';

// Parent app requires its existing authenticated owner cookie before this router.
// A deterministic, domain-separated CSRF capability works across serverless instances.
const capability = () => {
  const secret = process.env.AUTH_JWT_SECRET;
  if (!secret || secret.length < 32) throw new ModalError('クラウド認証が未設定です', 503);
  return createHmac('sha256', secret).update('reel-studio-modal-csrf-v1').digest('hex');
};
export const cloudModalRouter = Router();
cloudModalRouter.use((req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store');
  if (req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).json({error: '同じReel Studio画面から操作してください'});
  const origin = req.headers.origin;
  if (origin) {
    try {if (new URL(origin).host !== req.get('host')) return res.status(403).json({error: '別のサイトから操作できません'});} catch {return res.status(403).json({error: 'オリジンが不正です'});}
  }
  if (req.path === '/session' && req.method === 'GET') {
    if (req.headers['x-reel-modal-client'] !== 'reel-studio') return res.status(401).json({error: '認証が必要です'});
    return res.json({token: capability()});
  }
  const supplied = req.headers['x-reel-modal-session'];
  if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(capability()))) return res.status(401).json({error: 'Modal操作の認証が必要です'});
  next();
});
const wrap = (handler: RequestHandler): RequestHandler => (req, res, next) => {
  Promise.resolve().then(() => handler(req, res, next)).catch(error => {
    if (res.headersSent) return res.end();
    res.status(error instanceof ModalError ? error.status : 500).json({error: error instanceof ModalError ? error.message : 'クラウドのModal処理に失敗しました。設定と接続状態を確認してください'});
  });
};
let windowStart = 0, requests = 0;
cloudModalRouter.use((_req, res, next) => {
  if (Date.now() - windowStart > 60_000) {windowStart = Date.now(); requests = 0;}
  if (++requests > 600) return res.status(429).json({error: '操作が多すぎます。少し待ってください'});
  next();
});
cloudModalRouter.use('/render', createModalRenderRouter(cloudModalRender));
const jobId = (id: string): string => {
  if (!z.string().uuid().safeParse(id).success) throw new ModalError('ジョブIDが不正です', 400);
  return id;
};
cloudModalRouter.get('/settings', wrap(async (_req, res) => {res.json(await cloudModalView());}));
cloudModalRouter.put('/settings', wrap(async (req, res) => {
  const parsed = ModalSettingsPatchSchema.safeParse(req.body);
  if (!parsed.success) throw new ModalError('Modal設定の入力が不正です', 400);
  const {clearCredentials, ...patch} = parsed.data;
  const {config: previous} = await cloudModalConnection();
  const config = ModalConfigSchema.parse({...previous, ...Object.fromEntries(Object.entries(patch).filter(([k]) => !MODAL_SECRET_KEYS.includes(k as typeof MODAL_SECRET_KEYS[number])))});
  config.endpointUrl = validateModalEndpoint(config.endpointUrl);
  const secrets: ModalSecrets = {};
  for (const k of MODAL_SECRET_KEYS) if (patch[k]) secrets[k] = patch[k];
  res.json(await saveCloudModal(config, secrets, clearCredentials));
}));
cloudModalRouter.post('/test-sdk', wrap(async (_req, res) => {
  const result = await cloudModalJson<ModalDashboard>('/health');
  res.json({ok: result.ok, message: 'ModalのHTTP認証・接続を確認しました。SDK用APIトークンの検証はPC版で行えます。GPUは起動していません。'});
}));
cloudModalRouter.get('/health', wrap(async (_req, res) => {
  const result = await cloudModalJson<ModalDashboard>('/health');
  const {config} = await cloudModalConnection();
  result.usage.budgetUsd = Math.min(config.monthlyBudgetUsd, result.usage.budgetUsd);
  result.usage.remainingUsd = Math.max(0, result.usage.budgetUsd - result.usage.committedUsd - result.usage.overheadReserveUsd);
  res.json(result);
}));
cloudModalRouter.get('/gpu/info', wrap(async (_req, res) => {res.json(await cloudModalJson('/gpu/info'));}));
for (const route of ['/estimate', '/jobs']) cloudModalRouter.post(route, wrap(async (req, res) => {
  const parsed = ModalJobInputSchema.safeParse(req.body);
  if (!parsed.success || (parsed.data?.imageBase64?.length ?? 0) > 3 * 1024 ** 2) throw new ModalError('ジョブ入力が不正です。Web版の入力画像は2MB以下にしてください', 400);
  const {config} = await cloudModalConnection();
  const maxSeconds = Math.min(parsed.data.maxSeconds ?? config.maxJobSeconds, config.maxJobSeconds);
  const result = await cloudModalJson(route, {method: 'POST', body: {...parsed.data, maxSeconds, budgetUsd: config.monthlyBudgetUsd}, timeoutMs: 45_000});
  res.status(route === '/jobs' ? 202 : 200).json(result);
}));
cloudModalRouter.get('/jobs/:id', wrap(async (req, res) => {res.json(await cloudModalJson(`/jobs/${jobId(req.params.id)}`));}));
cloudModalRouter.post('/jobs/:id/cancel', wrap(async (req, res) => {res.json(await cloudModalJson(`/jobs/${jobId(req.params.id)}/cancel`, {method: 'POST'}));}));
export const cloudModalResultHandler = wrap(async (req, res) => {
  const id = jobId(req.params.id);
  const job = await cloudModalJson<ModalJob>(`/jobs/${id}`);
  if (job.status !== 'completed' || !['video/mp4', 'image/png'].includes(job.resultType ?? '')) throw new ModalError('結果はまだありません', 409);
  const response = await cloudModalFetch(`/jobs/${id}/result`, {timeoutMs: 45_000});
  if (!response.body || response.headers.get('content-type')?.split(';')[0] !== job.resultType) throw new ModalError('結果の形式が不正です');
  res.type(job.resultType!);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.flushHeaders(); // Stream large MP4s; never buffer them in the DB or Vercel filesystem.
  let bytes = 0;
  async function* bounded() {
    for await (const chunk of Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0])) {
      bytes += chunk.length;
      if (bytes > 64 * 1024 ** 2) throw new ModalError('結果のサイズ上限を超えています');
      yield chunk;
    }
  }
  await pipeline(bounded(), res);
});
cloudModalRouter.get('/jobs/:id/result', cloudModalResultHandler);
cloudModalRouter.post('/jobs/:id/import', wrap(async (req, res) => {
  const parsed = z.object({slug: z.string().min(1).max(150)}).strict().safeParse(req.body);
  if (!parsed.success) throw new ModalError('案件を指定してください', 400);
  const slug = normalizeSlug(parsed.data.slug);
  if (!await readDoc(slug, 'brief')) throw new ModalError('案件が見つかりません', 404);
  const id = jobId(req.params.id);
  const modalJob = await cloudModalJson<ModalJob>(`/jobs/${id}`);
  if (modalJob.status !== 'completed' || !modalJob.resultType) throw new ModalError('生成結果はまだありません', 409);
  // The actual media remains on the user's PC; no proxy credential or binary is queued.
  const running = (await listJobs()).find(j => j.type === 'modal-import' && j.slug === slug && j.params.id === id && ['queued', 'running'].includes(j.status));
  const worker = await kvGet<{seenAt?: string}>('worker');
  res.json({catalogJob: running ?? await addJob('modal-import', slug, {id}), queuedForPc: true, workerSeenAt: worker?.seenAt ?? null});
}));
