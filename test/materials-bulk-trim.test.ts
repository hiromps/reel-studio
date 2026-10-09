// @vitest-environment jsdom
import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, expect, it, vi} from 'vitest';
import {MaterialsPage} from '../src/pages/Materials';
import {bulkQuickTrim} from '../src/components/bulkTrim';
import {makeCatalog, makeClip} from './helpers';
import type {Catalog} from '@shared/schema';

const mocks = vi.hoisted(() => ({store: null as any}));
vi.mock('../src/state/store', () => ({useStudio: () => mocks.store}));
vi.mock('../src/hooks/useAiModel', () => ({AiModelSelect: () => null, useAiModel: () => ['test', () => {}]}));
vi.mock('../src/components/MosaicPanel', () => ({MosaicCard: () => null, MosaicClipSection: () => null, mediaVersion: () => '', useMosaicForm: () => [{}, () => {}]}));
vi.mock('../src/components/PreviewReady', () => ({PreviewReady: () => null}));
vi.mock('../src/components/ClipEditor', () => ({ClipEditor: () => null}));

(globalThis as typeof globalThis & {IS_REACT_ACT_ENVIRONMENT: boolean}).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: Array<{root: ReturnType<typeof createRoot>; host: HTMLElement}> = [];
afterEach(() => {
  for (const {root, host} of mounted.splice(0)) {
    act(() => root.unmount());
    host.remove();
  }
  vi.clearAllMocks();
});

const setup = async (catalog: Catalog) => {
  mocks.store = {
    active: catalog.slug, jobs: [], config: null, isCloud: false, mediaBase: null,
    files: {catalog: {data: catalog, dirty: false, etag: 'test'}, cuts: {data: null}},
    supportsJob: () => true, toast: vi.fn(), saveFile: vi.fn(),
    setFile: vi.fn((_name: string, data: Catalog, opt?: {dirty?: boolean}) => {
      mocks.store.files.catalog = {...mocks.store.files.catalog, data, dirty: opt?.dirty ?? true};
    }),
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push({root, host});
  await act(async () => root.render(React.createElement(MaterialsPage, {onTab: () => {}})));
  const button = (text: string) => [...host.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes(text))!;
  return {host, button};
};

it('表示中の素材を一括更新し、短い素材とNGを除外して、1手でUndo/Redoと保存ができる', async () => {
  const main = makeClip({id: '01', slug: 'main', dur: 10, kind: 'serving', fps: 30, ranges: [
    {inSec: 0, outSec: 1, label: 'avoid'},
    {inSec: 2, outSec: 4, label: 'ok', note: '見せ場'},
    {inSec: 5, outSec: 6, label: 'best'},
  ]});
  main.user.lock = true; // lock はAIによる上書きだけを制限する
  const short = makeClip({id: '02', slug: 'short', dur: 0.5, kind: 'serving'});
  const ng = makeClip({id: '03', slug: 'ng', dur: 5, kind: 'serving'});
  ng.user.ng = true;
  const end = makeClip({id: '04', slug: 'end', dur: 10, kind: 'serving', fps: 30, ranges: [{inSec: 9.7, outSec: 10, label: 'best'}]});
  const fresh = makeClip({id: '05', slug: 'fresh', dur: 5, kind: 'serving'});
  const original = makeCatalog('test', [main, short, ng, end, fresh]);
  const {button} = await setup(original);
  act(() => button('一括トリミング（4 本）').click());
  const next: Catalog = mocks.store.files.catalog.data;
  expect(next.clips[0].usableRanges).toEqual([
    main.usableRanges[0], {inSec: 2, outSec: 2.8, label: 'best', note: '見せ場'}, main.usableRanges[2],
  ]);
  expect(next.clips[0].probe).toBe(original.clips[0].probe);
  expect(next.clips[0].src).toBe(main.src);
  expect(next.clips[1]).toBe(original.clips[1]);
  expect(next.clips[2]).toBe(original.clips[2]);
  expect(next.clips[3].usableRanges).toEqual([{inSec: 9.2, outSec: 10, label: 'best'}]);
  expect(next.clips[4].usableRanges).toEqual([{inSec: 0, outSec: 0.8, label: 'best'}]);
  expect(mocks.store.files.catalog.dirty).toBe(true);
  expect(mocks.store.toast).toHaveBeenCalledWith(expect.stringContaining('3 本を0.8秒'), 'ok');
  expect(mocks.store.toast).toHaveBeenCalledWith(expect.stringContaining('1 本を除外'), 'ok');
  expect(mocks.store.setFile).toHaveBeenCalledTimes(1);
  expect(mocks.store.saveFile).not.toHaveBeenCalled();

  act(() => window.dispatchEvent(new KeyboardEvent('keydown', {key: 'z', ctrlKey: true, bubbles: true})));
  expect(mocks.store.files.catalog.data).toBe(original);
  expect(mocks.store.files.catalog.dirty).toBe(false);
  expect(button('↶').disabled).toBe(true);
  act(() => window.dispatchEvent(new KeyboardEvent('keydown', {key: 'y', ctrlKey: true, bubbles: true})));
  expect(mocks.store.files.catalog.data).toBe(next);
  expect(mocks.store.files.catalog.dirty).toBe(true);
  act(() => button('catalog.json を保存').click());
  expect(mocks.store.saveFile).toHaveBeenCalledWith('catalog');
});

it('絞り込み結果だけを対象にし、設定済みなら履歴と未保存状態を増やさない', async () => {
  const hook = makeClip({id: '01', slug: 'hook', dur: 5, kind: 'serving', ranges: [{inSec: 1, outSec: 1.8, label: 'best'}]});
  hook.user.hook = true;
  const other = makeClip({id: '02', slug: 'other', dur: 5, kind: 'serving'});
  const original = makeCatalog('test', [hook, other]);
  const {host, button} = await setup(original);
  const filter = host.querySelector('.materials select') as HTMLSelectElement;
  act(() => {filter.value = 'hook'; filter.dispatchEvent(new Event('change', {bubbles: true}));});
  expect(host.querySelectorAll('.clip-card')).toHaveLength(1);
  act(() => button('一括トリミング（1 本）').click());
  expect(mocks.store.setFile).not.toHaveBeenCalled();
  expect(mocks.store.files.catalog.dirty).toBe(false);
  expect(button('↶').disabled).toBe(true);
  expect(mocks.store.toast).toHaveBeenCalledWith(expect.stringContaining('設定済み 1 本'), 'ok');

  // 絞り込み内の開始位置を変更した場合も、隠れた素材は更新しない。
  original.clips[0].usableRanges[0].outSec = 3;
  act(() => button('一括トリミング（1 本）').click());
  expect(mocks.store.files.catalog.data.clips[0].usableRanges[0]).toEqual({inSec: 1, outSec: 1.8, label: 'best'});
  expect(mocks.store.files.catalog.data.clips[1]).toBe(original.clips[1]);
});

it('対象がなければボタンを無効にし、不明なfpsや短い尺は変更しない', async () => {
  const ng = makeClip({id: '01', slug: 'ng', dur: 5, kind: 'serving'});
  ng.user.ng = true;
  const {button} = await setup(makeCatalog('test', [ng]));
  expect(button('一括トリミング（0 本）').disabled).toBe(true);
  const invalid = makeClip({id: '02', slug: 'invalid', dur: 5, kind: 'serving', fps: 0});
  const short = makeClip({id: '03', slug: 'short', dur: 0.79, kind: 'serving'});
  const catalog = makeCatalog('test', [invalid, short]);
  expect(bulkQuickTrim(catalog, new Set(['02', '03']))).toEqual({catalog, changed: 0, unchanged: 0, skipped: 2});
});
