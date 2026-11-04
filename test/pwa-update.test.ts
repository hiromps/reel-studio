// @vitest-environment jsdom
import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';

Object.assign(globalThis, {IS_REACT_ACT_ENVIRONMENT: true});
let cleanup = () => {};
beforeEach(() => {vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(100_000); vi.spyOn(document, 'readyState', 'get').mockReturnValue('complete'); vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');});
afterEach(() => {cleanup(); cleanup = () => {}; vi.restoreAllMocks(); vi.useRealTimers();});
const setup = async (controlled = true) => {
  const sw = Object.assign(new EventTarget(), {controller: controlled ? {} : null, register: vi.fn()});
  const update = vi.fn().mockResolvedValue(undefined);
  sw.register.mockResolvedValue({update});
  const pwa = await import('../src/pwa');
  cleanup = pwa.startPwaRegistration(sw as unknown as ServiceWorkerContainer);
  await Promise.resolve();
  return {sw, update, pwa};
};

it('first installation does not announce an update; a replacement controller does', async () => {
  const {sw, pwa} = await setup(false);
  const listener = vi.fn();
  const unsubscribe = pwa.onPwaUpdate(listener);
  expect(sw.register).toHaveBeenCalledWith('/sw.js', {updateViaCache: 'none'});
  sw.dispatchEvent(new Event('controllerchange'));
  expect(pwa.hasPwaUpdate()).toBe(false);
  sw.dispatchEvent(new Event('controllerchange'));
  expect(pwa.hasPwaUpdate()).toBe(true);
  expect(listener).toHaveBeenCalledTimes(1);
  unsubscribe();
  sw.dispatchEvent(new Event('controllerchange'));
  expect(listener).toHaveBeenCalledTimes(1);
});

it('checks on return and reconnect, throttles requests, and ignores hidden windows', async () => {
  const {update} = await setup();
  window.dispatchEvent(new Event('focus'));
  expect(update).not.toHaveBeenCalled();
  vi.advanceTimersByTime(60_000);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  window.dispatchEvent(new Event('online'));
  expect(update).not.toHaveBeenCalled();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  update.mockRejectedValueOnce(new Error('offline'));
  document.dispatchEvent(new Event('visibilitychange'));
  await Promise.resolve();
  window.dispatchEvent(new Event('focus'));
  expect(update).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(60_000);
  window.dispatchEvent(new Event('online'));
  expect(update).toHaveBeenCalledTimes(2);
  cleanup();
  vi.advanceTimersByTime(60_000);
  window.dispatchEvent(new Event('focus'));
  expect(update).toHaveBeenCalledTimes(2);
});

it('registers once after loading when the document is not ready', async () => {
  vi.spyOn(document, 'readyState', 'get').mockReturnValue('loading');
  const {sw} = await setup();
  expect(sw.register).not.toHaveBeenCalled();
  window.dispatchEvent(new Event('load'));
  window.dispatchEvent(new Event('load'));
  expect(sw.register).toHaveBeenCalledTimes(1);
});

it('announces updates without reloading and blocks the reload action while work is unsaved', async () => {
  const {sw} = await setup();
  const {PwaUpdateNotice} = await import('../src/components/PwaUpdateNotice');
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  try {
    act(() => root.render(React.createElement(PwaUpdateNotice, {hasUnsavedChanges: true})));
    expect(host.textContent).toBe('');
    act(() => sw.dispatchEvent(new Event('controllerchange')));
    expect(host.querySelector('aside[role="status"]')).not.toBeNull();
    expect(host.querySelector<HTMLButtonElement>('button.primary')!.disabled).toBe(true);
    act(() => root.render(React.createElement(PwaUpdateNotice, {hasUnsavedChanges: false})));
    expect(host.querySelector<HTMLButtonElement>('button.primary')!.disabled).toBe(false);
    act(() => host.querySelectorAll<HTMLButtonElement>('button')[1].click());
    expect(host.textContent).toBe('');
  } finally {act(() => root.unmount()); host.remove();}
});

it('makes secondary editor tools available through an accessible disclosure', async () => {
  const {EditorMoreActions} = await import('../src/editor/EditorMoreActions');
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const action = vi.fn();
  try {
    act(() => root.render(React.createElement(EditorMoreActions, null, React.createElement('button', {onClick: action}, 'Audio'))));
    const toggle = host.querySelector<HTMLButtonElement>('button')!;
    const secondary = host.querySelector('.ed-secondary')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe(secondary.id);
    act(() => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(secondary.classList.contains('open')).toBe(true);
    act(() => secondary.querySelector<HTMLButtonElement>('button')!.click());
    expect(action).toHaveBeenCalledTimes(1);
    act(() => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  } finally {act(() => root.unmount()); host.remove();}
});
