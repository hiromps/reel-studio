import {Router, type Request, type Response, type RequestHandler} from 'express';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {z} from 'zod';
import {normalizeSlug} from '../shared/project';
import {ModalRenderInputSchema, ModalSessionInputSchema, MODAL_UPLOAD_CHUNK, safeModalAsset, modalAudioFingerprint, type ModalRenderProject, type ModalSession} from '../shared/modal-render';
import type {ModalConfig, ModalDashboard, ModalJob} from '../shared/modal';
import {ModalError, type modalFetchWith} from './modal-client';

export type RenderProvider = {config: ModalConfig; json: <T>(route: string, opt?: Parameters<typeof modalFetchWith>[3]) => Promise<T>; fetch: (route: string, opt?: Parameters<typeof modalFetchWith>[3]) => Promise<globalThis.Response>};
export type ModalRenderAdapter = {
  provider: () => Promise<RenderProvider>;
  exists: (slug: string) => Promise<boolean>;
  get: (slug: string) => Promise<ModalRenderProject | null>;
  set: (slug: string, value: ModalRenderProject | null) => Promise<void>;
  activate?: (slug: string, session: ModalSession, expected: {catalogEtag?: string | null; cutsEtag?: string | null}) => Promise<unknown>;
  preferLocal?: (slug: string, logical: string) => boolean;
};
const uuid = (value: string) => {if (!z.string().uuid().safeParse(value).success) throw new ModalError('IDが不正です', 400); return value;};
const wrap = (handler: RequestHandler): RequestHandler => (req, res, next) => {
  Promise.resolve(handler(req, res, next)).catch(e => {
    if (res.headersSent) {res.destroy(); return;}
    res.status(e instanceof ModalError ? e.status : 500).json({error: e instanceof ModalError ? e.message : 'クラウド書き出し処理を完了できませんでした'});
  });
};
export const createModalRenderRouter = (adapter: ModalRenderAdapter) => {
  const router = Router();
  const requireProject = async (raw: string) => {const slug = normalizeSlug(raw); if (!await adapter.exists(slug)) throw new ModalError('案件がありません', 404); return slug;};
  router.get('/projects/:slug', wrap(async (req, res) => {
    const slug = await requireProject(req.params.slug);
    const project = await adapter.get(slug);
    const provider = await adapter.provider();
    const health = await provider.json<ModalDashboard>('/health');
    let session: ModalSession | null = null, expired = false;
    if (project) {
      try {session = await provider.json(`/render/sessions/${uuid(project.sessionId)}`);} catch (e) {if (e instanceof ModalError && [404, 410].includes(e.status)) expired = true; else throw e;}
    }
    res.json({project, session, expired, usage: {...health.usage, budgetUsd: provider.config.monthlyBudgetUsd, remainingUsd: Math.max(0, provider.config.monthlyBudgetUsd - health.usage.committedUsd - health.usage.overheadReserveUsd)}, jobs: health.jobs.filter(j => j.sessionId === project?.sessionId || j.id === project?.lastJobId), maxJobSeconds: provider.config.maxJobSeconds});
  }));
  router.post('/projects/:slug/sessions', wrap(async (req, res) => {
    const slug = await requireProject(req.params.slug);
    const input = ModalSessionInputSchema.safeParse(req.body);
    if (!input.success) throw new ModalError('素材は1ファイル512MiB、案件合計1GiB、128ファイル以内です', 400);
    const provider = await adapter.provider();
    const session = await provider.json<ModalSession>('/render/sessions', {method: 'POST', body: input.data, timeoutMs: 60_000});
    res.json(session);
  }));
  router.post('/projects/:slug/commit-session', wrap(async (req, res) => {
    const slug = await requireProject(req.params.slug);
    const input = z.object({sessionId: z.string().uuid(), expectedSessionId: z.string().uuid().nullable()}).strict().safeParse(req.body);
    if (!input.success) throw new ModalError('素材の転送情報が不正です', 400);
    const p = await adapter.provider(), session = await p.json<ModalSession>(`/render/sessions/${input.data.sessionId}`);
    if (!session.files.every(f => f.complete)) throw new ModalError('素材転送が完了していません', 409);
    const old = await adapter.get(slug);
    if (old?.sessionId !== input.data.sessionId && (old?.sessionId ?? null) !== input.data.expectedSessionId) throw new ModalError('別の画面で素材が更新されました。再読み込みしてください', 409);
    const project = {sessionId: session.id, uploadedAt: new Date().toISOString(), lastJobId: old?.lastJobId, audioFingerprint: old?.audioFingerprint};
    await adapter.set(slug, project);
    res.json({project, session});
  }));
  router.get('/sessions/:id', wrap(async (req, res) => {const p = await adapter.provider(); res.json(await p.json(`/render/sessions/${uuid(req.params.id)}`));}));
  router.post('/sessions/:id/files/:file/chunks/:index', wrap(async (req, res) => {
    const {id, file, index} = req.params;
    const parsed = z.object({data: z.string().max(Math.ceil(MODAL_UPLOAD_CHUNK / 3) * 4).regex(/^[A-Za-z0-9+/]+={0,2}$/), sha256: z.string().regex(/^[a-f0-9]{64}$/)}).strict().safeParse(req.body);
    if (!parsed.success || !/^\d{1,3}$/.test(index) || Number(index) > 255) throw new ModalError('素材の転送データが不正です', 400);
    const p = await adapter.provider(); res.json(await p.json(`/render/sessions/${uuid(id)}/files/${uuid(file)}/chunks/${index}`, {method: 'POST', body: parsed.data, timeoutMs: 60_000}));
  }));
  router.post('/sessions/:id/files/:file/complete', wrap(async (req, res) => {const p = await adapter.provider(); res.json(await p.json(`/render/sessions/${uuid(req.params.id)}/files/${uuid(req.params.file)}/complete`, {method: 'POST', timeoutMs: 60_000}));}));
  for (const operation of ['jobs', 'estimate']) router.post(`/projects/:slug/${operation}`, wrap(async (req, res) => {
    const slug = await requireProject(req.params.slug), input = ModalRenderInputSchema.safeParse(req.body);
    if (!input.success) throw new ModalError('編集データを確認してください。180秒・120カット以内で、未生成の音声を含めないでください', 400);
    const project = await adapter.get(slug);
    if (project?.sessionId !== input.data.sessionId) throw new ModalError('この案件の素材を先にアップロードしてください', 409);
    if (input.data.kind === 'remotion-render' && input.data.narration?.segments.length && project.audioFingerprint !== modalAudioFingerprint(input.data.narration)) throw new ModalError('音声が転送後に変更されています。PC版から素材をアップロードし直してください', 409);
    const p = await adapter.provider();
    const payload = {...input.data, maxSeconds: Math.min(input.data.maxSeconds ?? p.config.maxJobSeconds, p.config.maxJobSeconds), budgetUsd: p.config.monthlyBudgetUsd};
    const result = await p.json<ModalJob>(operation === 'jobs' ? '/jobs' : '/estimate', {method: 'POST', body: payload, timeoutMs: 45_000});
    if (operation === 'jobs' && input.data.kind === 'remotion-render') await adapter.set(slug, {...project, lastJobId: result.id});
    res.status(operation === 'jobs' ? 202 : 200).json(result);
  }));
  router.post('/projects/:slug/activate', wrap(async (req, res) => {
    const slug = await requireProject(req.params.slug), project = await adapter.get(slug);
    if (!adapter.activate || !project) throw new ModalError('クラウド素材を準備してください', 409);
    const input = z.object({catalogEtag: z.string().nullable().optional(), cutsEtag: z.string().nullable().optional()}).strict().safeParse(req.body);
    if (!input.success) throw new ModalError('編集データの版が不正です', 400);
    const p = await adapter.provider(), session = await p.json<ModalSession>(`/render/sessions/${uuid(project.sessionId)}`);
    if (!session.prepared) throw new ModalError('軽量プレビューの作成が完了していません', 409);
    res.json(await adapter.activate(slug, session, input.data));
  }));
  router.delete('/projects/:slug', wrap(async (req, res) => {
    const slug = await requireProject(req.params.slug), project = await adapter.get(slug);
    if (project) {const p = await adapter.provider(); await p.json(`/render/sessions/${uuid(project.sessionId)}`, {method: 'DELETE', timeoutMs: 60_000});}
    await adapter.set(slug, null); res.json({ok: true});
  }));
  return router;
};

/** Cookie/desktop authentication is provided by the outer /p media route. */
export async function serveModalRenderMedia(req: Request, res: Response, adapter: ModalRenderAdapter): Promise<boolean> {
  const slug = normalizeSlug(req.params.slug), project = await adapter.get(slug);
  if (!project) return false;
  const {kind, mode} = req.params;
  const rel = (req.params as Record<string, string>)[0] ?? '';
  if (!['full', 'light'].includes(mode)) return false;
  const match = kind === 'out' ? /^modal-([a-f0-9-]{36})\.mp4$/.exec(rel) : null;
  const logical = `${kind}/${rel}`;
  if (!match && (!safeModalAsset(logical) || adapter.preferLocal?.(slug, logical))) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new ModalError('同じReel Studioから開いてください', 403);
  const p = await adapter.provider();
  let route: string;
  if (match) {
    const id = uuid(match[1]), job = await p.json<ModalJob>(`/jobs/${id}`);
    if (job.kind !== 'remotion-render' || (job.sessionId !== project.sessionId && id !== project.lastJobId)) return false;
    if (job.status !== 'completed') throw new ModalError('動画はまだ書き出し中です', 409);
    route = `/jobs/${id}/result`;
  } else {
    // The shipped font is also available at the same-origin public font URL.
    if (logical === 'fonts/NotoSerifJP-Bold.ttf') {res.redirect(307, '/fonts/NotoSerifJP-Bold.ttf'); return true;}
    route = `/render/sessions/${uuid(project.sessionId)}/assets/${mode === 'light' && kind === 'uploads' ? 'light/' : ''}${logical.split('/').map(encodeURIComponent).join('/')}`;
  }
  const range = req.headers.range;
  if (range && (!/^bytes=(\d*)-(\d*)$/.test(range) || range.length > 80)) throw new ModalError('動画の読込範囲が不正です', 416);
  const upstream = await p.fetch(route, {headers: range ? {Range: range} : undefined, timeoutMs: 60_000});
  res.status(upstream.status);
  for (const header of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges']) {const value = upstream.headers.get(header); if (value) res.setHeader(header, value);}
  res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('Cross-Origin-Resource-Policy', 'same-origin'); res.setHeader('X-Content-Type-Options', 'nosniff');
  if (req.query.download) res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(slug + (match ? '-final.mp4' : '-' + pathSafeName(rel)))}`);
  if (!upstream.body) {res.end(); return true;}
  res.flushHeaders();
  let size = 0;
  async function* bounded() {for await (const chunk of Readable.fromWeb(upstream.body as Parameters<typeof Readable.fromWeb>[0])) {size += chunk.length; if (size > 512 * 1024 ** 2) throw new ModalError('取得サイズが上限を超えました', 413); yield chunk;}}
  await pipeline(bounded(), res);
  return true;
}
const pathSafeName = (rel: string) => rel.split('/').pop() ?? 'media';
