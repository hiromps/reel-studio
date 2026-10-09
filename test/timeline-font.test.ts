// @vitest-environment jsdom
import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {expect, it, vi} from 'vitest';
const mocked = vi.hoisted(() => ({store: null as any}));
vi.mock('../src/state/store', () => ({useStudio: () => mocked.store}));
import {TelopInspector} from '../src/editor/Inspector';
import {TelopFontSelect} from '../src/editor/TelopFontSelect';
Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});

it('テロップを選択したままフォントを変更・既定に戻せ、文言とカット順は維持する', () => {
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  mocked.store = {config: {fonts: [{file: 'Gothic.otf', label: 'Gothic'}]}, reloadConfig: vi.fn(), toast: vi.fn()};
  const m: any = {cuts: {fps: 30, meta: {orderLocked: true}, cuts: [{id: 'c02', src: 'b.mp4', inSec: 0, outSec: 1, main: {text: '食欲をそそる'}}, {id: 'c01', src: 'a.mp4', inSec: 0, outSec: 1}]}, groups: [{cutIndices: [0], dur: 30, def: {text: '食欲をそそる'}}], patchReel: vi.fn(), pushHistory: vi.fn()};
  m.patchReel.mockImplementation((patch: any) => {m.cuts = {...m.cuts, ...patch}; render();});
  const render = () => root.render(React.createElement(TelopInspector, {m, group: 0, onSeekCut: vi.fn()}));
  try {
    act(render);
    const select = host.querySelector<HTMLSelectElement>('select[aria-label="テロップのフォント（動画全体）"]')!;
    expect(select).not.toBeNull();
    act(() => {select.value = 'Gothic.otf'; select.dispatchEvent(new Event('change', {bubbles: true}));});
    expect(m.cuts.font).toBe('Gothic.otf');
    expect(select.value).toBe('Gothic.otf');
    expect(m.cuts.cuts.map((c: any) => c.id)).toEqual(['c02', 'c01']);
    expect(m.cuts.cuts[0].main.text).toBe('食欲をそそる');
    expect(m.cuts.meta.orderLocked).toBe(true);
    act(() => {select.value = ''; select.dispatchEvent(new Event('change', {bubbles: true}));});
    expect(m.cuts.font).toBeUndefined();
    expect(m.patchReel).toHaveBeenLastCalledWith({font: undefined});
  } finally {act(() => root.unmount());host.remove();}
});

it('未保存の編集を保ったままフォント一覧を更新し、既存の案件専用フォントも表示する', async () => {
  const host = document.createElement('div');document.body.append(host);
  const root = createRoot(host);
  mocked.store = {config: {fonts: []}, reloadConfig: vi.fn(), toast: vi.fn(), saveFile: vi.fn(), loadFile: vi.fn()};
  const render = () => root.render(React.createElement(TelopFontSelect, {font: 'Given.otf', onChange: vi.fn()}));
  mocked.store.reloadConfig.mockImplementation(async () => {mocked.store.config.fonts = [{file: 'New.otf', label: 'New'}];});
  try {
    act(render);
    expect(host.textContent).toContain('Settings');
    expect(host.querySelector<HTMLSelectElement>('select')!.value).toBe('Given.otf');
    await act(async () => {host.querySelector<HTMLButtonElement>('button')!.click();});
    act(render);
    expect([...host.querySelectorAll('option')].map(o => o.value)).toEqual(['', 'New.otf', 'Given.otf']);
    expect(mocked.store.reloadConfig).toHaveBeenCalledOnce();
    expect(mocked.store.saveFile).not.toHaveBeenCalled();
    expect(mocked.store.loadFile).not.toHaveBeenCalled();
  } finally {act(() => root.unmount());host.remove();}
});
