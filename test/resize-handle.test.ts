// @vitest-environment jsdom
import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, expect, it, vi} from 'vitest';
import {ResizeHandle} from '../src/editor/ResizeHandle';

const hosts: HTMLElement[] = [];
afterEach(() => {
  for (const host of hosts.splice(0)) host.remove();
});

it('幅の境界をキーボードで変更し、ダブルクリックで戻せる', () => {
  const host = document.createElement('div');
  document.body.append(host);
  hosts.push(host);
  const root = createRoot(host);
  const onChange = vi.fn();
  act(() => root.render(React.createElement(ResizeHandle, {axis: 'x', label: '素材一覧の幅', value: 236, min: 160, max: 500, reset: 236, onChange})));
  const handle = host.querySelector('[role="separator"]') as HTMLElement;
  expect(handle.getAttribute('aria-label')).toBe('素材一覧の幅');
  expect(handle.getAttribute('aria-orientation')).toBe('vertical');
  act(() => handle.dispatchEvent(new KeyboardEvent('keydown', {key: 'ArrowRight', bubbles: true})));
  expect(onChange).toHaveBeenCalledWith(256);
  act(() => handle.dispatchEvent(new KeyboardEvent('keydown', {key: 'End', bubbles: true})));
  expect(onChange).toHaveBeenCalledWith(500);
  act(() => handle.dispatchEvent(new MouseEvent('dblclick', {bubbles: true})));
  expect(onChange).toHaveBeenCalledWith(236);
  act(() => root.unmount());
});

it('境界をドラッグすると幅が変わる', () => {
  const host = document.createElement('div');
  document.body.append(host);
  hosts.push(host);
  const root = createRoot(host);
  const onChange = vi.fn();
  act(() => root.render(React.createElement(ResizeHandle, {axis: 'x', label: '素材一覧の幅', value: 236, min: 160, max: 500, reset: 236, onChange})));
  const handle = host.querySelector('[role="separator"]') as HTMLElement;
  Object.defineProperty(handle, 'setPointerCapture', {value: vi.fn()});
  Object.defineProperty(handle, 'hasPointerCapture', {value: () => true});
  Object.defineProperty(handle, 'releasePointerCapture', {value: vi.fn()});
  const pointer = (type: string, x: number) => {
    const event = new MouseEvent(type, {bubbles: true, button: 0, clientX: x});
    Object.defineProperty(event, 'pointerId', {value: 1});
    act(() => handle.dispatchEvent(event));
  };
  pointer('pointerdown', 100);
  pointer('pointermove', 140);
  expect(onChange).toHaveBeenCalledWith(276);
  pointer('pointerup', 140);
  act(() => root.unmount());
});
