// @vitest-environment jsdom
import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
const mocked = vi.hoisted(() => ({store: null as any, get: vi.fn()}));
vi.mock('../src/state/store', () => ({useStudio: () => mocked.store}));
vi.mock('../src/api', () => ({api: {get: mocked.get}}));
import {LockedScriptContinuation} from '../src/components/LockedScriptContinuation';
Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const source = {id: 'source', type: 'ai-mimic', slug: 'test', params: {model: 'gpt-6-sol'}, status: 'done', result: {textConfirmation: {fingerprint: 'old'}}};
beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {configurable: true, value() {this.setAttribute('open', '');}});
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {configurable: true, value() {this.removeAttribute('open');}});
  mocked.get.mockResolvedValue({data: {data: '保存済み台本'}});
  mocked.store = {active: 'test', jobs: [source], files: {cuts: {data: {fps: 30, meta: {orderLocked: true}, cuts: [{id: 'c2', src: 'b.mov', inSec: 0, outSec: 2}]}, dirty: false}, narration: {data: null, dirty: false}, brief: {dirty: false}, catalog: {dirty: false}}, supportsJob: vi.fn(() => true), addJob: vi.fn(async () => ({id: 'next'})), loadFile: vi.fn()};
  host = document.createElement('div');document.body.append(host);root = createRoot(host);
});
afterEach(() => {act(() => root.unmount());host.remove();});
const render = async () => {await act(async () => root.render(React.createElement(LockedScriptContinuation)));};
const button = (label: string) => [...host.querySelectorAll('button')].find(b => b.textContent === label)!;
it('自動では生成せず、現在の構成への承認後に元のモデルで続行する', async () => {
  await render();
  expect(host.querySelector('dialog[open]')).not.toBeNull();
  expect(host.textContent).toContain('1 カット・2.0 秒');
  expect(mocked.store.addJob).not.toHaveBeenCalled();
  await act(async () => button('今の並びでテロップ・原稿を生成').click());
  expect(mocked.store.addJob).toHaveBeenCalledWith('ai-script-text', {confirmed: true, fingerprint: expect.any(String), fromJob: 'source', model: 'gpt-6-sol'});
});
it('取消時は生成しないが、後から確認を開き直せる', async () => {
  await render();
  act(() => button('今回は生成しない').click());
  expect(host.querySelector('dialog')).toBeNull();
  expect(mocked.store.addJob).not.toHaveBeenCalled();
  await act(async () => button('生成するか確認').click());
  expect(host.querySelector('dialog[open]')).not.toBeNull();
});
it('旧版のロックエラーも再開でき、未保存の編集がある間は生成を止める', async () => {
  mocked.store.jobs = [{...source, status: 'failed', result: undefined, error: '並び順がロックされています'}];
  mocked.store.files.cuts.dirty = true;
  await render();
  expect(host.textContent).toContain('未保存の編集');
  expect(button('今の並びでテロップ・原稿を生成').disabled).toBe(true);
  expect(mocked.store.addJob).not.toHaveBeenCalled();
});
it('続行の失敗後は再確認でき、進行中・完了済みなら重ねて確認しない', async () => {
  const next = {id: 'next', type: 'ai-script-text', slug: 'test', params: {fromJob: 'source'}, status: 'failed', error: '確認後に手動変更されました'};
  mocked.store.jobs = [next, source];
  await render();
  expect(host.textContent).toContain(next.error);
  mocked.store.jobs = [{...next, status: 'running'}, source];
  await render();
  expect(host.querySelector('dialog')).toBeNull();
});
it('別案件のジョブやロック解除済みの案件では確認しない', async () => {
  mocked.store.jobs = [{...source, slug: 'other'}];
  await render();expect(host.querySelector('dialog')).toBeNull();
  mocked.store.jobs = [source];mocked.store.files.cuts.data.meta.orderLocked = false;
  await render();expect(host.querySelector('dialog')).toBeNull();
});
