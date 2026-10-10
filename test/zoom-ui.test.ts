// @vitest-environment jsdom
import React, {act, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {ZoomControls} from '../src/components/ZoomControls';
import type {Zoom} from '../shared/zoom';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const change = vi.fn();
const start = vi.fn();
const parent = vi.fn();
const Harness = () => {
  const [zoom, setZoom] = useState<Zoom>();
  return React.createElement('div', {onClick: parent, onPointerDown: parent, onKeyDown: parent}, React.createElement(ZoomControls, {
    zoom, onStart: start, onChange: (next) => {change(next); setZoom(next);},
  }));
};
beforeEach(async () => {
  vi.clearAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(React.createElement(Harness)));
});
afterEach(async () => {await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals();});
const select = async (index: number, value: string) => {
  const el = host.querySelectorAll('select')[index];
  await act(async () => {el.value = value; el.dispatchEvent(new Event('change', {bubbles: true}));});
};
const input = async (label: string, value: string) => {
  const el = Array.from(host.querySelectorAll('label')).find((l) => l.textContent?.startsWith(label))!.querySelector('input')!;
  await act(async () => {
    el.focus();
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event('input', {bubbles: true}));
  });
};

it('各入力に見えるラベルがあり、なしでは入力を無効にする', () => {
  expect(host.querySelectorAll('label')).toHaveLength(7);
  expect(host.querySelector('input[type="range"]')!.hasAttribute('disabled')).toBe(true);
  expect(host.querySelectorAll('select')[1].disabled).toBe(true);
});
it('モード・強さ・イージング・アンカー・両端を編集でき、なしで解除する', async () => {
  await select(0, 'push');
  expect(change.mock.lastCall?.[0].scale_end).toBe(1.18);
  await input('強さ', '1.45');
  expect(change.mock.lastCall?.[0].scale_end).toBe(1.45);
  await select(1, 'out');
  await input('アンカーX', '0.7');
  await input('アンカーY', '0.3');
  await input('開始倍率', '1.1');
  expect(change.mock.lastCall?.[0]).toMatchObject({mode: 'push', ease: 'out', anchor_x: 0.7, anchor_y: 0.3, scale_start: 1.1, scale_end: 1.45});
  await select(0, 'pull');
  expect(change.mock.lastCall?.[0]).toMatchObject({mode: 'pull', scale_start: 1.45, scale_end: 1});
  await select(0, 'none');
  expect(change.mock.lastCall?.[0]).toBeUndefined();
  expect(start).toHaveBeenCalled();
});
it('ズーム編集でカードの選択・ドラッグ・キーボード操作を発火しない', async () => {
  const el = host.querySelector('select')!;
  await act(async () => {
    el.dispatchEvent(new Event('pointerdown', {bubbles: true}));
    el.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true}));
    el.click();
  });
  expect(parent).not.toHaveBeenCalled();
});
it('Ctrl+Zや保存などのアプリショートカットは遮らない', async () => {
  await act(async () => host.querySelector('select')!.dispatchEvent(new KeyboardEvent('keydown', {key: 'z', ctrlKey: true, bubbles: true})));
  expect(parent).toHaveBeenCalledTimes(1);
});
