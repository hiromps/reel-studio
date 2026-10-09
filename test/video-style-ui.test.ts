// @vitest-environment jsdom
import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, expect, it, vi} from 'vitest';
import {VideoStyleCard} from '../src/components/VideoStyleCard';
import {makeBrief} from './helpers';

const mocks = vi.hoisted(() => ({store: null as any, get: vi.fn()}));
vi.mock('../src/state/store', () => ({useStudio: () => mocks.store}));
vi.mock('../src/api', () => ({api: {get: mocks.get}}));
vi.mock('../src/hooks/useAiModel', () => ({AiModelSelect: () => null}));
const draft = {
  label: '提供から断面へ', summary: '提供と寄りのテンポに統一感',
  rules: {hook: '体験から始める', words: '短い体言止め', cutting: '1秒と2秒の強弱', sequence: '提供→断面', telop: '声で補う', ending: '余韻を残す'},
  source: {slug: 'past-reel', shop: '過去の店', capturedAt: '2026-10-09T00:00:00Z'},
  referenceCuts: [{durationSec: 1, role: 'hook', kind: 'serving', angle: 'close', subject: '看板料理', telop: 'この一皿', narration: ''}], instruction: '',
};
const snapshot = {...draft, id: 'style-1234567890abcdef', revision: 1, savedAt: '2026-10-09T00:00:00Z'};
(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: Array<{root: ReturnType<typeof createRoot>; host: HTMLElement}> = [];
afterEach(() => {for(const {root, host} of mounted.splice(0)) {act(() => root.unmount()); host.remove();} localStorage.clear(); vi.clearAllMocks();});
const setup = async (applied = false) => {
  mocks.get.mockResolvedValue({data: {entries: []}});
  mocks.store = {
    active: 'new-reel', projects: [{slug: 'past-reel', has: {cuts: true}}], jobs: [],
    files: {brief: {data: makeBrief({persona: 'standard', ...(applied ? {videoStyle: snapshot} : {})}), dirty: false}, cuts: {data: null, dirty: false}, narration: {data: null, dirty: false}, catalog: {data: {clips: []}}},
    supportsJob: () => true, setFile: vi.fn(), toast: vi.fn(), addJob: vi.fn(async () => ({id: 'job-1'})),
  };
  const host = document.createElement('div');document.body.append(host);const root = createRoot(host);mounted.push({root, host});
  const render = async () => {await act(async () => root.render(React.createElement(VideoStyleCard, {aiModel: 'test', onModel: () => {}, onScript: () => {}})));};
  await render();
  const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes(text))!;
  return {host, render, button};
};

it('過去案件で型を作って保存し、コピー先に素材や店情報を移さず型だけ設定する', async () => {
  const {host, render, button} = await setup();
  const select = host.querySelector('.video-style-create select') as HTMLSelectElement;
  act(() => {select.value = 'past-reel'; select.dispatchEvent(new Event('change', {bubbles: true}));});
  await act(async () => button('この案件から型の案').click());
  expect(mocks.store.addJob).toHaveBeenCalledWith('ai-video-style', {model: 'test'}, 'past-reel');
  mocks.store.jobs = [{id: 'job-1', type: 'ai-video-style', status: 'done', result: {draft}}];
  await render();
  expect(host.querySelectorAll('.video-style-rules textarea')).toHaveLength(6);
  mocks.store.addJob.mockResolvedValueOnce({id: 'job-2'});
  await act(async () => button('新しい型として保存').click());
  expect(mocks.store.addJob).toHaveBeenLastCalledWith('video-style-save', expect.objectContaining({draft}), undefined);
  mocks.store.jobs = [{id: 'job-2', type: 'video-style-save', status: 'done', result: {snapshot}}];
  await render();
  act(() => button('この版を案件に設定').click());
  expect(mocks.store.setFile).toHaveBeenCalledWith('brief', expect.objectContaining({videoStyle: snapshot, shop: expect.objectContaining({name: 'テスト食堂'})}));
});

it('Brief が未保存なら生成を止め、保存済みの案件の型で台本生成へ進める', async () => {
  const {render, button} = await setup(true);
  mocks.store.files.brief.dirty = true;
  await render();
  expect(button('この案件の型で台本').disabled).toBe(true);
  mocks.store.files.brief.dirty = false;
  await render();
  await act(async () => button('この案件の型で台本').click());
  expect(mocks.store.addJob).toHaveBeenCalledWith('ai-script-draft', expect.objectContaining({model: 'test', request: expect.any(String)}));
});
