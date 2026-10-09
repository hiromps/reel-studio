// @vitest-environment jsdom
import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {expect, it, vi} from 'vitest';
const mocked = vi.hoisted(() => ({store: null as any}));
vi.mock('../src/state/store', () => ({useStudio: () => mocked.store}));
vi.mock('../src/hooks/useAiModel', () => ({useAiModel: () => ['test-model', () => {}], AiModelSelect: () => null}));
import {AiMenu} from '../src/editor/AiMenu';
import {OrderLockToggle} from '../src/editor/OrderLockToggle';
Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});

it('Timelineのロックを切り替えられ、ロック中はAI並べ替えだけを無効にする', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const changed = vi.fn();
  mocked.store = {jobs: [], files: {cuts: {dirty: false}, narration: {dirty: false}}, supportsJob: () => true, addJob: vi.fn(async () => ({id: 'j1'})), toast: vi.fn()};
  const render = (locked: boolean) => root.render(React.createElement(React.Fragment, null,
    React.createElement(OrderLockToggle, {locked, onChange: changed}),
    React.createElement(AiMenu, {orderLocked: locked, onJobRequest: () => () => {}, placeholders: 2, cutCount: 2, hasCuts: true, hasOrderCheck: true}),
  ));
  try {
    act(() => render(false));
    const toggle = host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    act(() => toggle.click());
    expect(changed).toHaveBeenCalledWith(true);
    act(() => render(true));
    expect(toggle.checked).toBe(true);
    act(() => host.querySelector<HTMLButtonElement>('.ai-btn')!.click());
    const buttons = () => [...host.querySelectorAll<HTMLButtonElement>('.ai-item')];
    const order = buttons().find(b => b.textContent?.includes('並べ替えてもらう'))!;
    expect(order.disabled).toBe(true);
    act(() => order.click());
    expect(mocked.store.addJob).not.toHaveBeenCalled();
    expect(buttons().find(b => b.textContent?.includes('直してもらう'))!.disabled).toBe(false);
    const telop = buttons().find(b => b.textContent?.includes('テロップを全部書き直す'))!;
    await act(async () => { telop.click(); });
    expect(mocked.store.addJob).toHaveBeenCalledWith('ai-telop', {model: 'test-model', force: true});
    act(() => toggle.click());
    expect(changed).toHaveBeenLastCalledWith(false);
    act(() => render(false));
    act(() => host.querySelector<HTMLButtonElement>('.ai-btn')!.click());
    expect(buttons().find(b => b.textContent?.includes('並べ替えてもらう'))!.disabled).toBe(false);
  } finally {
    act(() => root.unmount());
    host.remove();
  }
});
