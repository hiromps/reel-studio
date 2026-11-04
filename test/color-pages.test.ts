// @vitest-environment jsdom
import React, {act, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {makeCatalog, richClips} from './helpers';
import {CatalogSchema, ReelDataSchema, type Catalog, type ReelData} from '../shared/schema';
import {colorFilter} from '../shared/color';
import {useUndo} from '../src/hooks/useUndo';

const mocked = vi.hoisted(() => ({store: null as any}));
vi.mock('../src/state/store', () => ({useStudio: () => mocked.store}));
vi.mock('../src/hooks/useAiModel', () => ({useAiModel: () => ['test', () => {}], AiModelSelect: () => null}));
vi.mock('../src/api', () => ({api: {get: vi.fn(async () => ({data: {ok: false, providers: []}}))}}));
import {MaterialsPage} from '../src/pages/Materials';
import {CutInspector} from '../src/editor/Inspector';
import {useEditorModel, type EditorModel} from '../src/editor/useEditorModel';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let model: EditorModel;
let initialCatalog: Catalog;
let initialCuts: ReelData;
let saved: Catalog | ReelData | undefined;
function Harness({page}: {page: 'materials' | 'timeline'}) {
  const [catalog, setCatalog] = useState(initialCatalog);
  const [cuts, setCuts] = useState(initialCuts);
  const [catalogDirty, setCatalogDirty] = useState(false);
  const [cutsDirty, setCutsDirty] = useState(false);
  const history = useUndo<{cuts: ReelData | null; narration: null}>();
  mocked.store = {
    active: 'test', mediaBase: '/p/test/public', isCloud: false, jobs: [], supportsJob: () => true, config: {fonts: [], uploadsFolders: []}, editorHistory: history, toast: vi.fn(),
    files: {catalog: {data: catalog, dirty: catalogDirty}, cuts: {data: cuts, dirty: cutsDirty, loading: false}, narration: {data: null, loading: false}, brief: {data: null}},
    setFile: (name: string, value: any, opt?: {dirty?: boolean}) => {
      if (name === 'catalog') {setCatalog(value); setCatalogDirty(opt?.dirty ?? true);}
      if (name === 'cuts') {setCuts(value); setCutsDirty(opt?.dirty ?? true);}
    },
    saveFile: async (name: string) => {
      saved = name === 'catalog' ? CatalogSchema.parse(JSON.parse(JSON.stringify(catalog))) : ReelDataSchema.parse(JSON.parse(JSON.stringify(cuts)));
      if (name === 'catalog') setCatalogDirty(false); else setCutsDirty(false);
    },
  };
  model = useEditorModel(null);
  return page === 'materials' ? React.createElement(MaterialsPage, {onTab: vi.fn()}) : React.createElement(CutInspector, {m: model, index: 0, onSeekCut: vi.fn(), onSplit: vi.fn()});
}
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  initialCatalog = makeCatalog('test', richClips().slice(0, 2));
  initialCatalog.clips[0].color = {exposure: 0.5, brightness: 1.1, contrast: 1.2, saturation: 0.7};
  initialCuts = {fps: 30, cuts: [{id: 'c01', src: 'alias.mp4', inSec: 0, outSec: 1}, {id: 'c02', src: initialCatalog.clips[1].src, inSec: 0, outSec: 1}], meta: {aliases: [{from: initialCatalog.clips[0].src, to: 'alias.mp4', applied: true}]}};
  saved = undefined;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => {act(() => root.unmount()); host.remove(); vi.unstubAllGlobals();});
const type = (el: HTMLInputElement, value: string) => act(() => {
  el.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', {bubbles: true}));
});
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === text)!;
it('Materialsの詳細で素材を補正し、動画・サムネイル・保存・取り消しに反映する', async () => {
  act(() => root.render(React.createElement(Harness, {page: 'materials'})));
  act(() => host.querySelector<HTMLElement>('.clip-card')!.click());
  type(host.querySelector<HTMLInputElement>('.clip-color input[type="range"]')!, '-1');
  const color = mocked.store.files.catalog.data.clips[0].color;
  expect(color.exposure).toBe(-1);
  expect(mocked.store.files.catalog.dirty).toBe(true);
  expect(host.querySelector('video')!.style.filter).toBe(colorFilter(color));
  expect(host.querySelector<HTMLImageElement>('.clip-card img')!.style.filter).toBe(colorFilter(color));
  expect(mocked.store.files.cuts.data.cuts[0].color).toBeUndefined();
  await act(async () => button('catalog.json を保存 *').click());
  expect((saved as Catalog).clips[0].color).toEqual(color);
  expect(mocked.store.files.catalog.dirty).toBe(false);
  act(() => host.querySelector<HTMLButtonElement>('button[title="直前の編集を取り消す（Ctrl+Z）"]')!.click());
  expect(mocked.store.files.catalog.data.clips[0].color).toEqual(initialCatalog.clips[0].color);
  expect(host.querySelector('video')!.style.filter).toBe(colorFilter(initialCatalog.clips[0].color));
});
it('Timelineの選択カットだけを補正し、保存と取り消しに反映する', async () => {
  act(() => root.render(React.createElement(Harness, {page: 'timeline'})));
  type(host.querySelector<HTMLInputElement>('.insp-color input[type="number"][aria-label="彩度（%）"]')!, '0');
  expect(model.cuts!.cuts[0].color?.saturation).toBe(0);
  expect(model.cuts!.cuts[1].color).toBeUndefined();
  expect(mocked.store.files.cuts.dirty).toBe(true);
  await act(async () => mocked.store.saveFile('cuts'));
  expect((saved as ReelData).cuts[0].color?.saturation).toBe(0);
  act(() => model.undo());
  expect(model.cuts!.cuts[0].color).toBeUndefined();
  expect(host.querySelector<HTMLInputElement>('.insp-color input[type="number"][aria-label="彩度（%）"]')!.value).toBe('100');
  act(() => model.redo());
  expect(model.cuts!.cuts[0].color?.saturation).toBe(0);
});
it('別名コピーでも素材の補正を取り込め、全カットへの適用とリセットも取り消せる', () => {
  act(() => root.render(React.createElement(Harness, {page: 'timeline'})));
  act(() => button('素材の補正を取り込む').click());
  expect(model.cuts!.cuts[0].color).toEqual(initialCatalog.clips[0].color);
  act(() => button('この補正を全カットに適用').click());
  expect(model.cuts!.cuts.map((c) => c.color)).toEqual([initialCatalog.clips[0].color, initialCatalog.clips[0].color]);
  act(() => model.undo());
  expect(model.cuts!.cuts[1].color).toBeUndefined();
  act(() => button('色・明るさをリセット').click());
  expect(model.cuts!.cuts[0].color).toBeUndefined();
  act(() => model.undo());
  expect(model.cuts!.cuts[0].color).toEqual(initialCatalog.clips[0].color);
});
