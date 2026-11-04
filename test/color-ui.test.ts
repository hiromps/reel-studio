// @vitest-environment jsdom
import React, {act, useState} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {ColorControls} from '../src/components/ColorControls';
import {colorFilter, type ColorAdjustments} from '../shared/color';
import {useUndo} from '../src/hooks/useUndo';

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const parent = vi.fn();
const Harness = () => {
  const [color, setColor] = useState<ColorAdjustments>();
  const history = useUndo<ColorAdjustments | undefined>();
  return React.createElement('div', {onClick: parent, onPointerDown: parent, onKeyDown: parent},
    React.createElement('video', {style: {filter: colorFilter(color)}}),
    React.createElement(ColorControls, {color, onStart: () => history.push(color), onChange: setColor}),
    React.createElement('button', {onClick: () => {const snapshot = history.undo(color); if (snapshot !== null) setColor(snapshot);}}, 'undo'),
    React.createElement('button', {onClick: () => {const snapshot = history.redo(color); if (snapshot !== null) setColor(snapshot);}}, 'redo'));
};
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  act(() => root.render(React.createElement(Harness)));
});
afterEach(() => {act(() => root.unmount()); host.remove(); vi.unstubAllGlobals();});
const type = (el: HTMLInputElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, value);
  el.dispatchEvent(new Event('input', {bubbles: true}));
});
const button = (text: string) => [...host.querySelectorAll('button')].find((b) => b.textContent === text)!;
it('ラベル付きのスライダーと数値欄で補正し、リセット・取り消し・やり直しをプレビューに反映する', () => {
  expect(host.querySelectorAll('input[type="range"]')).toHaveLength(4);
  expect(host.querySelectorAll('input[type="number"][aria-label]')).toHaveLength(4);
  for (const label of host.querySelectorAll('label')) expect(document.getElementById(label.htmlFor)).not.toBeNull();
  expect(button('色・明るさをリセット').disabled).toBe(true);
  const range = host.querySelector<HTMLInputElement>('input[type="range"]')!;
  act(() => range.focus());
  type(range, '0.5'); type(range, '1');
  expect(host.querySelector('video')!.style.filter).toContain('brightness(2.000000)');
  act(() => button('undo').click());
  expect(host.querySelector('video')!.style.filter).toBe('');
  act(() => button('redo').click());
  expect(host.querySelector('video')!.style.filter).toContain('brightness(2.000000)');
  act(() => button('色・明るさをリセット').click());
  expect(host.querySelector('video')!.style.filter).toBe('');
  act(() => button('undo').click());
  expect(host.querySelector('video')!.style.filter).toContain('brightness(2.000000)');
});
it('空欄や負の数の途中入力を許し、範囲外の値は適用しない', () => {
  const input = host.querySelector<HTMLInputElement>('input[type="number"]')!;
  act(() => input.focus()); type(input, '');
  expect(input.value).toBe('');
  type(input, '-1.5');
  expect(input.value).toBe('-1.5');
  expect(host.querySelector('video')!.style.filter).toContain('brightness(0.353553)');
  type(input, '-3');
  expect(host.querySelector('video')!.style.filter).toContain('brightness(0.353553)');
  act(() => input.blur());
  expect(input.value).toBe('-1.5');
});
it('操作は親のドラッグ・矢印ショートカットを発火させず、Ctrl+Zは通す', () => {
  const el = host.querySelector('input')!;
  act(() => {
    el.dispatchEvent(new Event('pointerdown', {bubbles: true}));
    el.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true}));
    el.click();
  });
  expect(parent).not.toHaveBeenCalled();
  act(() => el.dispatchEvent(new KeyboardEvent('keydown', {key: 'z', ctrlKey: true, bubbles: true})));
  expect(parent).toHaveBeenCalledOnce();
});
