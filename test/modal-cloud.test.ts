import express from 'express';
import type {AddressInfo} from 'node:net';
import {get} from 'node:http';
import {afterAll, beforeAll, beforeEach, expect, it, vi} from 'vitest';
import {cloudModalRouter} from '../cloud/routes/modal';
import {issueSession, requireUser} from '../cloud/auth';
import {cloudModalConnection, cloudModalView, saveCloudModal} from '../cloud/modal';
import {ModalConfigSchema} from '../shared/modal';

const {records, addJob, upstream} = vi.hoisted(() => ({records: new Map<string, unknown>(), addJob: vi.fn(async () => ({id: 'pc-import-job', type: 'modal-import', status: 'queued'})), upstream: vi.fn()}));
vi.mock('../cloud/store', () => ({kvGet: async (k: string) => records.get(k) ?? null, kvSet: async (k: string, v: unknown) => {records.set(k, v);}, readDoc: async () => ({data: {}}), listJobs: async () => [], addJob}));
vi.mock('../core/modal-client', async original => ({...await original<typeof import('../core/modal-client')>(), modalFetchWith: upstream}));

let server: ReturnType<express.Express['listen']>, base: string, cookie: string, token: string;
beforeAll(async () => {
  vi.stubEnv('AUTH_JWT_SECRET', 'test-auth-secret-for-modal-cloud-only-12345');
  const app = express(); app.use(express.json({limit: '4mb'})); app.use('/api/modal', requireUser, cloudModalRouter);
  server = app.listen(0, '127.0.0.1'); await new Promise<void>(r => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/modal`;
  cookie = `rs_session=${await issueSession()}`;
  const session = await fetch(`${base}/session`, {headers: {Cookie: cookie, 'X-Reel-Modal-Client': 'reel-studio'}});
  token = (await session.json() as {token: string}).token;
});
beforeEach(() => {
  records.clear(); addJob.mockClear(); upstream.mockReset();
  vi.stubEnv('REEL_MODAL_ENDPOINT_URL', 'https://test--api.us-east.modal.run');
  vi.stubEnv('REEL_MODAL_PROXY_TOKEN_ID', 'wk-test'); vi.stubEnv('REEL_MODAL_PROXY_TOKEN_SECRET', 'ws-test');
});
afterAll(async () => {server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); vi.unstubAllEnvs();});
const headers = () => ({Cookie: cookie, 'X-Reel-Modal-Session': token, 'Content-Type': 'application/json'});

it('Web/PWAは既存ログインとModal操作認証の両方を必須とする', async () => {
  for (const route of ['/session', '/settings', '/health', '/jobs/123/result']) expect((await fetch(base + route)).status).toBe(401);
  expect((await fetch(`${base}/settings`, {headers: {Cookie: cookie}})).status).toBe(401);
  const r = await fetch(`${base}/settings`, {headers: headers()});
  expect(r.status).toBe(200); expect((await r.json()).configured).toBe(true);
  expect(upstream).not.toHaveBeenCalled();
});
it('保存先DBに秘密値を平文で残さず、UIにも返さない', async () => {
  const view = await saveCloudModal(ModalConfigSchema.parse({endpointUrl: 'https://test--api.modal.run'}), {proxyTokenId: 'wk-new-id', proxyTokenSecret: 'ws-new-secret', tokenId: 'ak-sdk', tokenSecret: 'as-sdk-secret'});
  expect(JSON.stringify(records.get('modal-cloud-settings'))).not.toContain('ws-new-secret');
  expect(JSON.stringify(view)).not.toContain('ws-new-secret');
  expect((await cloudModalConnection()).secrets.proxyTokenSecret).toBe('ws-new-secret');
  expect((await cloudModalView()).secrets.tokenSecret).toBe(true);
});
it('別サイトから操作できず、認証済みでも明示許可のないGPU入力を拒否する', async () => {
  const cross = await new Promise<number | undefined>((resolve, reject) => {
    get(`${base}/session`, {headers: {Cookie: cookie, 'X-Reel-Modal-Client': 'reel-studio', Origin: 'https://evil.test'}}, r => {r.resume(); resolve(r.statusCode);}).on('error', reject);
  });
  expect(cross).toBe(403);
  expect((await fetch(`${base}/jobs`, {method: 'POST', headers: headers(), body: JSON.stringify({kind: 'gpu-test', requestId: crypto.randomUUID()})})).status).toBe(400);
  expect(upstream).not.toHaveBeenCalled();
});
it('Webからの素材追加は秘密値・画像バイナリを含めずPCワーカーへ渡す', async () => {
  const id = crypto.randomUUID();
  upstream.mockResolvedValueOnce(new Response(JSON.stringify({id, status: 'completed', resultType: 'image/png'}), {headers: {'Content-Type': 'application/json'}}));
  const r = await fetch(`${base}/jobs/${id}/import`, {method: 'POST', headers: headers(), body: JSON.stringify({slug: 'shop-reel'})});
  expect(r.status).toBe(200);
  expect(addJob).toHaveBeenCalledWith('modal-import', 'shop-reel', {id});
});
it('生成物をDB保存せずストリームで返す', async () => {
  const id = crypto.randomUUID(), bytes = new Uint8Array(5 * 1024 * 1024).fill(7);
  upstream.mockResolvedValueOnce(new Response(JSON.stringify({id, status: 'completed', resultType: 'video/mp4'})))
    .mockResolvedValueOnce(new Response(bytes, {headers: {'Content-Type': 'video/mp4'}}));
  const r = await fetch(`${base}/jobs/${id}/result`, {headers: headers()});
  expect(r.status).toBe(200); expect(r.headers.get('content-type')).toContain('video/mp4');
  expect((await r.arrayBuffer()).byteLength).toBe(bytes.length);
  expect(records.size).toBe(0);
});
