// @vitest-environment jsdom
import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {telopNarrationConfirmation} from '../shared/telop-narration';
import {TelopNarrationDialog} from '../src/editor/TelopNarrationDialog';

const mocked = vi.hoisted(() => ({store: null as any}));
vi.mock('../src/state/store', () => ({useStudio: () => mocked.store}));
const defaults = {voice: 'default', voiceTitle: '既定', speed: 1.2};
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const record = vi.fn();
const capture = vi.fn(() => record);
const close = vi.fn();

beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  mocked.store = {active: 'test', jobs: [], config: {tts: true}, supportsJob: () => true,
    files: {cuts: {dirty: false, data: {fps: 30, cuts: [{src: 'a', inSec: 0, outSec: 2, main: {text: 'そのままの\n文言！'}}]}},
      narration: {dirty: false, data: {voice: 'chosen', voiceTitle: '選んだ声', speed: 1.4, segments: [{id: 'old', at: 0, text: '旧原稿'}]}}, brief: {dirty: false}},
    saveFile: vi.fn(async () => true), addJob: vi.fn(async () => ({id: 'job1'})),
  };
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals();});
const render = async () => act(async () => root.render(React.createElement(TelopNarrationDialog, {defaults, capture, onClose: close})));
const generate = () => Array.from(host.querySelectorAll('button')).find(b => b.textContent?.includes('音声を生成'))!;

it('確認画面に元の文言・声と置き換え対象を表示し、確認した指紋で音声化を開始する', async () => {
  await render();
  expect(host.querySelector('ol')!.textContent).toContain('そのままの\n文言！');
  expect(host.textContent).toContain('選んだ声'); expect(host.textContent).toContain('既存のナレーション 1 本');
  expect(mocked.store.addJob).not.toHaveBeenCalled();
  const expected = telopNarrationConfirmation(mocked.store.files.cuts.data, mocked.store.files.narration.data, defaults).fingerprint;
  await act(async () => generate().click());
  expect(mocked.store.addJob).toHaveBeenCalledWith('telop-tts', {fingerprint: expected});
  expect(record).toHaveBeenCalledWith('job1'); expect(close).toHaveBeenCalledTimes(1);
});

it('未保存の編集を保存してから音声化を開始する', async () => {
  mocked.store.files.cuts.dirty = true; mocked.store.files.narration.dirty = true;
  await render(); expect(generate().textContent).toBe('保存して音声を生成');
  await act(async () => generate().click());
  expect(mocked.store.saveFile.mock.calls).toEqual([['cuts'], ['narration']]);
  expect(mocked.store.saveFile.mock.invocationCallOrder[1]).toBeLessThan(mocked.store.addJob.mock.invocationCallOrder[0]);
});

it('保存が失敗した場合は原稿を上書きするジョブを投入しない', async () => {
  mocked.store.files.cuts.dirty = true; mocked.store.saveFile.mockResolvedValue(false);
  await render(); await act(async () => generate().click());
  expect(mocked.store.addJob).not.toHaveBeenCalled(); expect(close).not.toHaveBeenCalled();
  expect(host.querySelector('[role="alert"]')!.textContent).toContain('音声化を開始していません');
});

it.each(['old-server', 'missing-key', 'busy'])('実行できない場合 %s は理由を表示して生成を止める', async mode => {
  if (mode === 'old-server') mocked.store.supportsJob = () => false;
  if (mode === 'missing-key') mocked.store.config.tts = false;
  if (mode === 'busy') mocked.store.jobs = [{slug: 'test', status: 'running'}];
  await render(); expect(generate().disabled).toBe(true); expect(host.querySelector('[role="status"]')).not.toBeNull();
  expect(mocked.store.addJob).not.toHaveBeenCalled();
});

it('キャンセルでは原稿・音声・ジョブを変更しない', async () => {
  await render();
  await act(async () => Array.from(host.querySelectorAll('button')).find(b => b.textContent === 'キャンセル')!.click());
  expect(close).toHaveBeenCalledTimes(1); expect(mocked.store.addJob).not.toHaveBeenCalled(); expect(mocked.store.saveFile).not.toHaveBeenCalled();
});
