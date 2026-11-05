// @vitest-environment jsdom
import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {CloudRenderCard} from '../src/components/CloudRender';
import {modalApi} from '../src/modal-api';
import {useStudio} from '../src/state/store';
import type {ModalRenderDashboard} from '../shared/modal-render';
vi.mock('../src/state/store', () => ({useStudio: vi.fn()}));
vi.mock('../src/modal-api', () => ({modalApi: {get: vi.fn(), post: vi.fn(), del: vi.fn()}}));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: {root: ReturnType<typeof createRoot>; host: HTMLElement}[] = [];
let studio: any, dashboard: ModalRenderDashboard;
beforeEach(() => {
  vi.clearAllMocks();
  studio = {active: 'test-reel', isCloud: true, files: {catalog: {dirty: false, etag: null}, cuts: {dirty: false, data: {fps: 30, cuts: [{src: 'uploads/a.mp4', inSec: 0, outSec: 1}]}}, narration: {dirty: false, data: null}}, setLight: vi.fn(), reloadActive: vi.fn(), refreshProjects: vi.fn()};
  vi.mocked(useStudio).mockImplementation(() => studio);
  const id = crypto.randomUUID();
  dashboard = {project: {sessionId: id, uploadedAt: new Date().toISOString()}, session: {id, prepared: false, files: [{id: crypto.randomUUID(), path: 'uploads/a.mp4', size: 1, complete: true}], totalBytes: 1, expiresAt: '2026-12-01T00:00:00Z'}, expired: false, jobs: [], maxJobSeconds: 120, usage: {budgetUsd: 25, remainingUsd: 10} as any};
  vi.mocked(modalApi.get).mockImplementation(async () => structuredClone(dashboard) as any);
  vi.mocked(modalApi.post).mockImplementation(async route => route.endsWith('/estimate') ? {estimatedCostUsd: 0.4} as any : {id: crypto.randomUUID(), status: 'queued'} as any);
});
afterEach(() => {for (const {root, host} of mounted.splice(0)) {act(() => root.unmount()); host.remove();}});
async function setup(materials = false) {
  const host = document.createElement('div'); document.body.append(host); const root = createRoot(host); mounted.push({root, host});
  const render = async () => {await act(async () => root.render(React.createElement(CloudRenderCard, {materials})));};
  await render();
  const button = (label: string) => [...host.querySelectorAll('button')].find(b => b.textContent === label)!;
  const click = async (label: string) => {await act(async () => button(label).click());};
  const consent = async () => {await act(async () => host.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());};
  return {host, render, button, click, consent};
}
it('概算と明示許可の後だけGPUを実行でき、未保存・編集変更で許可を無効にする', async () => {
  const {host, render, button, click, consent} = await setup();
  expect(host.textContent).toContain('端末のGPUは不要');
  await click('概算を確認');
  expect(button('クラウドで書き出す').disabled).toBe(true);
  expect(vi.mocked(modalApi.post).mock.calls.map(c => c[0])).toEqual(['/render/projects/test-reel/estimate']);
  await consent(); expect(button('クラウドで書き出す').disabled).toBe(false);
  studio.files.cuts.dirty = true; await render(); expect(button('クラウドで書き出す').disabled).toBe(true);
  studio.files.cuts.dirty = false; studio.files.cuts.data.cuts[0].outSec = 2; await render();
  expect(host.textContent).not.toContain('今回の予約額');
});
it('送信応答が失われても同じrequestIdで再送する', async () => {
  const {click, consent} = await setup();
  const post = vi.mocked(modalApi.post);
  post.mockImplementation(async route => {if (route.endsWith('/estimate')) return {estimatedCostUsd: 0.4} as any; throw new Error('通信が途切れました');});
  await click('概算を確認'); await consent(); await click('クラウドで書き出す'); await click('クラウドで書き出す');
  const calls = post.mock.calls.filter(c => c[0].endsWith('/jobs'));
  expect(calls).toHaveLength(2); expect(calls[0][1]).toEqual(calls[1][1]);
});
it('予算不足と期限切れではGPUを実行できない', async () => {
  dashboard.usage.remainingUsd = 0;
  const {host, click, button} = await setup(); await click('概算を確認');
  expect(host.textContent).toContain('今月の予約上限を超えます'); expect(button('クラウドで書き出す').disabled).toBe(true);
  dashboard.expired = true;
  await click('状態を更新'); expect(button('概算を確認').disabled).toBe(true);
});
it('軽量プレビュー完了後の取り込みは保存版を渡し、軽量表示を有効にする', async () => {
  dashboard.session!.prepared = true;
  const {click} = await setup(true); await click('編集に取り込む');
  expect(modalApi.post).toHaveBeenCalledWith('/render/projects/test-reel/activate', {catalogEtag: null, cutsEtag: undefined});
  expect(studio.setLight).toHaveBeenCalledWith(true); expect(studio.reloadActive).toHaveBeenCalled();
});
