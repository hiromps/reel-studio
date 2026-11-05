import express from 'express';
import type {AddressInfo} from 'node:net';
import {get} from 'node:http';
import {afterAll, beforeAll, expect, it, vi} from 'vitest';
import {modalRouter} from '../server/routes/modal';

vi.mock('../core/modal-client', async original => ({
  ...await original<typeof import('../core/modal-client')>(),
  modalJson: vi.fn(async () => ({ok: true, gpu: 'RTX-PRO-6000', jobs: [], usage: {budgetUsd: 25, committedUsd: 0, overheadReserveUsd: 7.7}})),
}));
vi.mock('../core/modal-vault', () => ({modalConfig: () => ({monthlyBudgetUsd: 25, maxJobSeconds: 300}), modalSettingsView: () => ({configured: false, secrets: {tokenId: true, tokenSecret: true, proxyTokenId: true, proxyTokenSecret: true}}), saveModalSettings: vi.fn()}));

let server: ReturnType<express.Express['listen']>, base: string, token: string;
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use('/api/modal', modalRouter);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/modal`;
  const r = await fetch(`${base}/session`, {headers: {'X-Reel-Modal-Client': 'reel-studio'}});
  token = (await r.json() as {token: string}).token;
});
afterAll(async () => {server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));});

it('すべてのModal操作にセッション認証が必要', async () => {
  for (const route of ['/settings', '/health', '/gpu/info', '/jobs/not-a-job', '/jobs/not-a-job/result']) expect((await fetch(base + route)).status).toBe(401);
  expect((await fetch(`${base}/session`)).status).toBe(401);
  expect((await fetch(`${base}/settings`, {headers: {'X-Reel-Modal-Session': 'z'.repeat(64)}})).status).toBe(401);
  const view = await (await fetch(`${base}/settings`, {headers: {'X-Reel-Modal-Session': token}})).json();
  expect(view.secrets.tokenSecret).toBe(true);
});

it('別オリジンと不正Hostからはセッションを作れない', async () => {
  for (const headers of [{Origin: 'https://evil.example'}, {'Sec-Fetch-Site': 'cross-site'}, {Host: 'evil.example'}]) {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      const req = get(`${base}/session`, {headers: {'X-Reel-Modal-Client': 'reel-studio', ...headers}}, res => {res.resume(); resolve(res.statusCode);});
      req.on('error', reject);
    });
    expect(status).toBe(403);
  }
});

it('明示許可なし・不正入力・過大予算ではGPUに到達しない', async () => {
  const headers = {'X-Reel-Modal-Session': token, 'Content-Type': 'application/json'};
  expect((await fetch(`${base}/jobs`, {method: 'POST', headers, body: JSON.stringify({kind: 'gpu-test', requestId: crypto.randomUUID()})})).status).toBe(400);
  expect((await fetch(`${base}/settings`, {method: 'PUT', headers, body: JSON.stringify({monthlyBudgetUsd: 26})})).status).toBe(400);
  expect((await fetch(`${base}/jobs/../../health`, {headers})).status).toBe(404);
});
it('古い画面から画像・動画の生成を依頼しても受付前に拒否する', async () => {
  const {modalJson} = await import('../core/modal-client'); vi.mocked(modalJson).mockClear();
  for (const kind of ['text-to-image', 'image-to-image', 'text-to-video', 'image-to-video']) {
    const r = await fetch(`${base}/jobs`, {method:'POST', headers:{'X-Reel-Modal-Session':token,'Content-Type':'application/json'}, body:JSON.stringify({kind,prompt:'test',imageBase64:'AA==',requestId:crypto.randomUUID(),allowGpu:true})});
    expect(r.status).toBe(400); expect((await r.json()).error).toContain('AI生成は受け付けていません');
  }
  expect(modalJson).not.toHaveBeenCalled();
});
