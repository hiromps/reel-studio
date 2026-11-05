import express from 'express';
import type {AddressInfo} from 'node:net';
import {afterAll, beforeAll, beforeEach, expect, it, vi} from 'vitest';
import {createModalRenderRouter, serveModalRenderMedia, type ModalRenderAdapter} from '../core/modal-render-router';
import {ModalError} from '../core/modal-client';
import {ModalConfigSchema} from '../shared/modal';
import {ModalRenderInputSchema, ModalSessionInputSchema, safeModalAsset, type ModalRenderProject, type ModalSession} from '../shared/modal-render';

const id = crypto.randomUUID(), other = crypto.randomUUID(), file = crypto.randomUUID();
const manifest = {id, allowUpload: true, files: [{id: file, path: 'uploads/test.mp4', size: 4}]};
const input = () => ({kind: 'remotion-render', sessionId: id, requestId: crypto.randomUUID(), allowGpu: true, cuts: {fps: 30, cuts: [{src: 'uploads/test.mp4', inSec: 0, outSec: 1}]}});
let project: ModalRenderProject | null = null;
let session: ModalSession;
const json = vi.fn(), upstream = vi.fn();
const adapter: ModalRenderAdapter = {
  exists: async slug => slug === 'test-reel', get: async () => project, set: async (_slug, value) => {project = value;},
  provider: async () => ({config: ModalConfigSchema.parse({maxJobSeconds: 120, monthlyBudgetUsd: 10}), json, fetch: upstream}),
};
let server: ReturnType<express.Express['listen']>, base: string;
beforeAll(async () => {
  const app = express(); app.use(express.json({limit: '4mb'})); app.use('/render', createModalRenderRouter(adapter));
  app.get('/p/:slug/:mode/:kind/*', (req, res) => {void serveModalRenderMedia(req, res, adapter).then(served => {if (!served) res.status(404).end();}).catch(e => {if (!res.headersSent) res.status(e.status ?? 500).end();});});
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));});
beforeEach(() => {
  project = null; session = {id, files: [{id: file, path: 'uploads/test.mp4', size: 4, complete: false}], prepared: false, expiresAt: new Date(Date.now() + 100000).toISOString(), totalBytes: 4};
  json.mockReset().mockImplementation(async route => route === '/health' ? {jobs: [], usage: {committedUsd: 0, overheadReserveUsd: 1}} : session);
  upstream.mockReset();
});
const post = (route: string, body: unknown) => fetch(base + '/render' + route, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});

it('未完了の転送では案件の素材参照を変更せず、転送完了後に切り替える', async () => {
  project = {sessionId: other, uploadedAt: new Date().toISOString()};
  expect((await post('/projects/test/sessions', manifest)).status).toBe(200);
  expect(project.sessionId).toBe(other);
  expect((await post('/projects/test/commit-session', {sessionId: id, expectedSessionId: other})).status).toBe(409);
  session.files[0].complete = true;
  expect((await post('/projects/test/commit-session', {sessionId: id, expectedSessionId: null})).status).toBe(409);
  expect((await post('/projects/test/commit-session', {sessionId: id, expectedSessionId: other})).status).toBe(200);
  expect(project!.sessionId).toBe(id);
  expect((await post('/projects/test/commit-session', {sessionId: id, expectedSessionId: other})).status).toBe(200);
});

it('不正な編集・別案件の素材はGPUへ送らず、設定の予算と時間を強制する', async () => {
  expect((await post('/projects/test/jobs', input())).status).toBe(409);
  expect(json).not.toHaveBeenCalled();
  project = {sessionId: id, uploadedAt: new Date().toISOString()};
  expect((await post('/projects/test/jobs', {...input(), allowGpu: false})).status).toBe(400);
  expect(json).not.toHaveBeenCalled();
  json.mockResolvedValue({id: other, status: 'queued'});
  expect((await post('/projects/test/jobs', {...input(), maxSeconds: 600})).status).toBe(202);
  expect(json).toHaveBeenLastCalledWith('/jobs', expect.objectContaining({body: expect.objectContaining({budgetUsd: 10, maxSeconds: 120})}));
  expect(project!.lastJobId).toBe(other);
});

it('期限切れを復旧可能な状態として返す', async () => {
  project = {sessionId: id, uploadedAt: new Date().toISOString()};
  json.mockImplementation(async route => {if (route === '/health') return {jobs: [], usage: {committedUsd: 0, overheadReserveUsd: 1}}; throw new ModalError('expired', 410);});
  const r = await fetch(base + '/render/projects/test');
  expect(r.status).toBe(200); expect(await r.json()).toMatchObject({expired: true, session: null, usage: {remainingUsd: 9}});
});

it('認証済み素材のRangeを中継し、不正パスと別案件の結果を拒否する', async () => {
  project = {sessionId: id, uploadedAt: new Date().toISOString()};
  upstream.mockImplementation(async () => new Response('bc', {status: 206, headers: {'Content-Type': 'video/mp4', 'Content-Length': '2', 'Content-Range': 'bytes 1-2/4', 'Accept-Ranges': 'bytes'}}));
  const r = await fetch(base + '/p/test/light/uploads/test.mp4', {headers: {Range: 'bytes=1-2'}});
  expect(r.status).toBe(206); expect(await r.text()).toBe('bc');
  expect(r.headers.get('cache-control')).toBe('private, no-store');
  expect(upstream).toHaveBeenCalledWith(`/render/sessions/${id}/assets/light/uploads/test.mp4`, expect.objectContaining({headers: {Range: 'bytes=1-2'}}));
  expect((await fetch(base + '/p/test/full/uploads/test.mp4', {headers: {Range: 'bytes=1-2,4-5'}})).status).toBe(416);
  json.mockResolvedValue({kind: 'remotion-render', status: 'completed', sessionId: other});
  expect((await fetch(base + `/p/test/full/out/modal-${other}.mp4`)).status).toBe(404);
});

it('素材のパス・容量・尺・速度・未生成音声を受付前に検証する', () => {
  for (const name of ['uploads/../x.mp4', 'uploads/a.m3u8', 'fonts/x.js', 'uploads/a%2f.mp4', 'uploads/C:/x.mp4', 'uploads/a\\b.mp4']) expect(safeModalAsset(name)).toBe(false);
  expect(ModalSessionInputSchema.safeParse({...manifest, files: [manifest.files[0], manifest.files[0]]}).success).toBe(false);
  for (const cuts of [{fps: 30, cuts: [{src: 'uploads/test.mp4', inSec: 0, outSec: 181}]}, {fps: 30, cuts: [{src: 'uploads/test.mp4', inSec: 0, outSec: 1, playbackRate: 0.01}]}]) expect(ModalRenderInputSchema.safeParse({...input(), cuts}).success).toBe(false);
  expect(ModalRenderInputSchema.safeParse({...input(), narration: {segments: [{id: 'a', text: 'test', at: 0, durSec: 1, needsTts: true}]}}).success).toBe(false);
  expect(ModalRenderInputSchema.safeParse({...input(), kind: 'prepare-media'}).success).toBe(false);
});
