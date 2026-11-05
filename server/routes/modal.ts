import {Router, type RequestHandler} from 'express';
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {z} from 'zod';
import {ModalConfigSchema, ModalJobInputSchema, ModalSettingsPatchSchema, MODAL_SECRET_KEYS, type ModalDashboard, type ModalJob, type ModalSecrets} from '../../shared/modal';
import {modalConfig, modalSettingsView, saveModalSettings} from '../../core/modal-vault';
import {ModalError, modalJson, testModalSdk, validateModalEndpoint} from '../../core/modal-client';
import {downloadModalResult} from '../../core/modal-results';
import {resolveProjectDirStrict} from '../../core/project';
import {jobs} from '../jobs';
import {createModalRenderRouter} from '../../core/modal-render-router';
import {localModalRender} from '../modal-render';
import {localRenderSnapshot, publishLocalModalProject} from '../../core/modal-render';

// Local same-origin capability, required for EVERY Modal route after bootstrap.
// Never persisted, placed in a URL, logged, or accepted from cross-origin pages.
const sessionToken = randomBytes(32).toString('hex');
const auth: RequestHandler = (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  const fetchSite = req.headers['sec-fetch-site'];
  if (fetchSite === 'cross-site') return res.status(403).json({error: '同じReel Studio画面から操作してください'});
  const host = req.hostname;
  if (!['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host)) return res.status(403).json({error: 'Modal設定はローカルPCから操作してください'});
  const origin = req.headers.origin;
  if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)) return res.status(403).json({error: 'オリジンが不正です'});
  const supplied = req.headers['x-reel-modal-session'];
  if (req.path === '/session' && req.method === 'GET') {
    // Custom header forces cross-origin browsers through a denied CORS preflight.
    if (req.headers['x-reel-modal-client'] !== 'reel-studio') return res.status(401).json({error: '認証が必要です'});
    return res.json({token: sessionToken});
  }
  if (typeof supplied !== 'string' || !/^[a-f0-9]{64}$/.test(supplied) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(sessionToken))) return res.status(401).json({error: 'Modal操作の認証が必要です'});
  next();
};

export const modalRouter = Router();
modalRouter.use(auth);
let windowStart = 0, requests = 0;
modalRouter.use((_req, res, next) => {
  if (Date.now() - windowStart > 60_000) {windowStart = Date.now(); requests = 0;}
  if (++requests > 600) return res.status(429).json({error: 'アクセスが多すぎます。少し待ってください'});
  next();
});
modalRouter.use('/render', createModalRenderRouter(localModalRender));
const wrap = (handler: RequestHandler): RequestHandler => (req, res, next) => {
  Promise.resolve().then(() => handler(req, res, next)).catch(error => {
    if (res.headersSent) return res.end();
    // Do not reflect SDK/fetch/crypto/validation error input.
    res.status(error instanceof ModalError ? error.status : 500).json({error: error instanceof ModalError ? error.message : 'Modal処理に失敗しました。接続設定とサーバーの状態を確認してください'});
  });
};
const jobId = (id: string) => {
  if (!z.string().uuid().safeParse(id).success) throw new ModalError('ジョブIDが不正です', 400);
  return id;
};
modalRouter.post('/render/projects/:slug/upload-local', wrap((req, res) => {
  const input = z.object({sessionId: z.string().uuid(), allowUpload: z.literal(true)}).strict().safeParse(req.body);
  if (!input.success) throw new ModalError('素材アップロードを許可してください', 400);
  const dir = resolveProjectDirStrict(req.params.slug);
  localRenderSnapshot(dir); // Reject missing media/audio before queueing anything.
  const existing = jobs.list().find(j => j.type === 'modal-upload' && j.slug === path.basename(dir) && j.params.sessionId === input.data.sessionId);
  res.status(202).json(existing ?? jobs.publicJob(jobs.add('modal-upload', path.basename(dir), input.data)));
}));
modalRouter.post('/render/projects/:slug/publish', wrap(async (req, res) => {
  const dir = resolveProjectDirStrict(req.params.slug);
  res.json(await publishLocalModalProject(path.basename(dir)));
}));

modalRouter.get('/settings', wrap((_req, res) => {res.json(modalSettingsView());}));
modalRouter.put('/settings', wrap((req, res) => {
  const parsed = ModalSettingsPatchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({error: 'Modal設定の入力が不正です（予算は$0〜25、上限時間は30〜600秒）'});
  const {clearCredentials, ...patch} = parsed.data;
  const config = ModalConfigSchema.parse({...modalConfig(), ...Object.fromEntries(Object.entries(patch).filter(([k]) => !MODAL_SECRET_KEYS.includes(k as typeof MODAL_SECRET_KEYS[number])))});
  config.endpointUrl = validateModalEndpoint(config.endpointUrl);
  const secrets: ModalSecrets = {};
  for (const k of MODAL_SECRET_KEYS) if (patch[k]) secrets[k] = patch[k];
  res.json(saveModalSettings(config, secrets, clearCredentials));
}));
modalRouter.post('/test-sdk', wrap(async (_req, res) => {res.json(await testModalSdk());}));
modalRouter.get('/health', wrap(async (_req, res) => {
  const dashboard = await modalJson<ModalDashboard>('/health');
  dashboard.usage.budgetUsd = Math.min(dashboard.usage.budgetUsd, modalConfig().monthlyBudgetUsd);
  dashboard.usage.remainingUsd = Math.max(0, dashboard.usage.budgetUsd - dashboard.usage.committedUsd - dashboard.usage.overheadReserveUsd);
  res.json(dashboard);
}));
modalRouter.get('/gpu/info', wrap(async (_req, res) => {res.json(await modalJson('/gpu/info'));}));

for (const route of ['/estimate', '/jobs']) modalRouter.post(route, wrap(async (req, res) => {
  const parsed = ModalJobInputSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({error: 'ジョブ入力が不正です。GPU実行の許可・プロンプト・画像・サイズを確認してください'});
  const config = modalConfig();
  const maxSeconds = Math.min(parsed.data.maxSeconds ?? config.maxJobSeconds, config.maxJobSeconds);
  const result = await modalJson(route, {method: 'POST', body: {...parsed.data, maxSeconds, budgetUsd: config.monthlyBudgetUsd}, timeoutMs: 45_000});
  res.status(route === '/jobs' ? 202 : 200).json(result);
}));
modalRouter.get('/jobs/:id', wrap(async (req, res) => {res.json(await modalJson(`/jobs/${jobId(req.params.id)}`));}));
modalRouter.post('/jobs/:id/cancel', wrap(async (req, res) => {res.json(await modalJson(`/jobs/${jobId(req.params.id)}/cancel`, {method: 'POST'}));}));

modalRouter.get('/jobs/:id/result', wrap(async (req, res) => {
  const result = await downloadModalResult(req.params.id);
  res.type(result.type).sendFile(result.file);
}));
modalRouter.post('/jobs/:id/import', wrap(async (req, res) => {
  const parsed = z.object({slug: z.string().min(1).max(150)}).strict().safeParse(req.body);
  if (!parsed.success) throw new ModalError('取り込み先の案件を選んでください', 400);
  let dir: string;
  try {dir = resolveProjectDirStrict(parsed.data.slug);} catch {throw new ModalError('案件名が不正です', 400);}
  if (!fs.existsSync(dir)) throw new ModalError('取り込み先の案件がありません', 404);
  if (jobs.list().some(j => j.slug === parsed.data.slug && ['queued', 'running'].includes(j.status))) throw new ModalError('案件の処理が終わってから取り込んでください', 409);
  const catalogJob = jobs.add('modal-import', path.basename(dir), {id: jobId(req.params.id)});
  res.json({catalogJob: jobs.publicJob(catalogJob)});
}));
